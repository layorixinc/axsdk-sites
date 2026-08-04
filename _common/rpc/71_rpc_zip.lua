--- The US ZIP ladder, from the runtime.
---
--- The ladder is layered on purpose and only its LAST rungs need the network: an explicit ZIP and a ZIP
--- written inside an address are pure string work. That matters while R1 (outbound HTTP from the runtime)
--- is waiting on infrastructure approval — the two cheap rungs work today, whatever the runtime provides.
---
--- What must not blur is WHY a city did not resolve. "Give me a better address" and "this runtime cannot
--- reach a geocoder" are different instructions to the user, and reporting the second as the first sends
--- them hunting for an address that was never the problem.
---
--- Zippopotam was the durable ladder's old primary and was replaced: it mis-resolved some cities
--- ("San Francisco" -> "South San Francisco"). Photon first, then the Census ZCTA reverse.

AX_RPC_ZIP = AX_RPC_ZIP or {}
local Z = AX_RPC_ZIP

Z.PHOTON_URL = "https://photon.komoot.io/api"
Z.CENSUS_ZCTA_URL = "https://geocoding.geo.census.gov/geocoder/geographies/coordinates"

local function trim(value)
  if type(value) ~= "string" then return nil end
  local text = value:gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", "")
  return text ~= "" and text or nil
end

local function url_encode(value)
  return (tostring(value or ""):gsub("[^%w%-%._~]", function(char)
    return string.format("%%%02X", string.byte(char))
  end))
end

--- Five digits, taking the ZIP part of a ZIP+4.
function Z.extract(value)
  local text = tostring(value or "")
  return text:match("(%d%d%d%d%d)%-%d%d%d%d") or text:match("(%d%d%d%d%d)")
end

--- Whether this runtime can reach the network at all. Checked once per call so a missing capability is one
--- answer rather than a series of failures.
function Z.can_fetch()
  return type(net) == "table" and type(net.fetch) == "function"
end

--- A GET whose failure is a VALUE, not an exception: an HTTP error is normal operation, and the caller has
--- to tell it apart from "the capability is not here".
---
--- Returns `body, err, shape`. `shape` describes what actually came back — the response's type and its
--- top-level keys — because a parse that finds nothing looks exactly like a place that does not exist, and
--- guessing between those costs a live round trip every time.
local function get(url)
  local ok, response = pcall(net.fetch, url, { method = "GET" })
  if not ok then return nil, "unreachable", tostring(response):sub(1, 120) end
  if type(response) ~= "table" then
    return nil, "unreachable", "response is " .. type(response)
  end
  if response.ok == false then
    return nil, "http_error", "status " .. tostring(response.status)
  end
  local keys = {}
  for key in pairs(response) do keys[#keys + 1] = tostring(key) end
  table.sort(keys)
  local shape = "keys[" .. table.concat(keys, ",") .. "] json=" .. type(response.json)
  -- Some transports hand the body back as text; decode it when the runtime can.
  local body = response.json
  if type(body) ~= "table" and type(response.body) == "string"
    and type(json) == "table" and type(json.decode) == "function" then
    local decoded_ok, decoded = pcall(json.decode, response.body)
    if decoded_ok and type(decoded) == "table" then
      body = decoded
      shape = shape .. " decoded=body"
    end
  end
  return body, nil, shape
end

--- Forward geocode: a point for a place name.
function Z.point(address)
  local body, err, shape = get(Z.PHOTON_URL .. "?limit=1&q=" .. url_encode(address))
  if err then return nil, err, shape end
  local features = type(body) == "table" and body.features or nil
  local first = type(features) == "table" and features[1] or nil
  if type(first) ~= "table" then return nil, nil, shape .. " features=" .. type(features) end
  local coordinates = type(first.geometry) == "table" and first.geometry.coordinates or nil
  if type(coordinates) ~= "table" then return nil, nil, shape .. " geometry=missing" end
  -- GeoJSON is [lon, lat].
  return { lon = coordinates[1], lat = coordinates[2] }, nil, shape
end

--- Reverse: the ZIP Code Tabulation Area a point falls in.
---
--- `layers=all` and a SUBSTRING match on the layer key, both copied from the durable ladder. The Census
--- names its layer with a vintage prefix — "2020 Census ZIP Code Tabulation Areas" — which shifts between
--- releases, so an exact key resolves for one census and then silently stops. Measured live: the point
--- resolved and the ZIP still came back empty, for exactly this reason.
function Z.zcta(lat, lon)
  local y, x = tonumber(lat), tonumber(lon)
  if not y or not x then return nil, nil, "bad point" end
  local url = Z.CENSUS_ZCTA_URL .. "?x=" .. tostring(x) .. "&y=" .. tostring(y)
    .. "&benchmark=Public_AR_Current&vintage=Current_Current&layers=all&format=json"
  local body, err, shape = get(url)
  if err then return nil, err, shape end
  local result = type(body) == "table" and body.result or nil
  local geographies = type(result) == "table" and result.geographies or nil
  if type(geographies) ~= "table" then
    return nil, nil, (shape or "") .. " geographies=" .. type(geographies)
  end
  for key, layer in pairs(geographies) do
    if type(key) == "string" and key:lower():find("zip code tabulation", 1, true) and type(layer) == "table" then
      for index = 1, #layer do
        local entry = layer[index]
        local zip = entry and Z.extract(entry.ZCTA5 or entry.BASENAME or entry.NAME)
        if zip then return zip, nil, shape end
      end
    end
  end
  return nil, nil, (shape or "") .. " no zcta layer"
end

--- Resolves a US ZIP from an explicit code, an address that contains one, or a place name.
function Z.resolve(args)
  args = type(args) == "table" and args or {}

  local explicit = Z.extract(args.zip_code)
  if explicit then return { next = "collect", zip_code = explicit, source = "zip_code" } end

  local address = trim(args.address)
  if not address then return { next = "collect", error = "missing_zip_or_address" } end

  local embedded = Z.extract(address)
  if embedded then return { next = "collect", zip_code = embedded, source = "address_text" } end

  if not Z.can_fetch() then
    -- Naming the missing capability is the whole point: the address may be perfectly good.
    return { next = "collect", error = "zip_geocode_unavailable", address = address }
  end

  local point, err, shape = Z.point(address)
  if err then
    return { next = "collect", error = "zip_geocode_unavailable", address = address, observed = shape }
  end
  if not point or not point.lat or not point.lon then
    -- What came back decides whether this is "no such place" or a shape we misread.
    return { next = "collect", error = "resolve_failed", address = address, observed = shape }
  end

  local zip, zcta_err, zcta_shape = Z.zcta(point.lat, point.lon)
  if zcta_err then
    return { next = "collect", error = "zip_geocode_unavailable", address = address, observed = zcta_shape }
  end
  if not zip then
    return { next = "collect", error = "resolve_failed", address = address, observed = zcta_shape }
  end

  return { next = "collect", zip_code = zip, source = "geocode" }
end
