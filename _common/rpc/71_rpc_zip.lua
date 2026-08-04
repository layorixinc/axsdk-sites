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
local function get(url)
  local ok, response = pcall(net.fetch, url, { method = "GET" })
  if not ok then return nil, "unreachable" end
  if type(response) ~= "table" then return nil, "unreachable" end
  if response.ok == false then return nil, "http_error" end
  return response.json, nil
end

--- Forward geocode: a point for a place name.
function Z.point(address)
  local body, err = get(Z.PHOTON_URL .. "?limit=1&q=" .. url_encode(address))
  if err then return nil, err end
  local features = type(body) == "table" and body.features or nil
  local first = type(features) == "table" and features[1] or nil
  if type(first) ~= "table" then return nil, nil end
  local coordinates = type(first.geometry) == "table" and first.geometry.coordinates or nil
  if type(coordinates) ~= "table" then return nil, nil end
  -- GeoJSON is [lon, lat].
  return { lon = coordinates[1], lat = coordinates[2] }, nil
end

--- Reverse: the ZIP Code Tabulation Area a point falls in.
function Z.zcta(lat, lon)
  local url = Z.CENSUS_ZCTA_URL .. "?x=" .. tostring(lon) .. "&y=" .. tostring(lat)
    .. "&benchmark=Public_AR_Current&vintage=Current_Current&layers=ZIP+Code+Tabulation+Areas&format=json"
  local body, err = get(url)
  if err then return nil, err end
  local result = type(body) == "table" and body.result or nil
  local geographies = type(result) == "table" and result.geographies or nil
  local areas = type(geographies) == "table" and geographies["Zip Code Tabulation Areas"] or nil
  local first = type(areas) == "table" and areas[1] or nil
  if type(first) ~= "table" then return nil, nil end
  return Z.extract(first.ZCTA5 or first.GEOID), nil
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

  local point, err = Z.point(address)
  if err then return { next = "collect", error = "zip_geocode_unavailable", address = address } end
  if not point or not point.lat or not point.lon then
    return { next = "collect", error = "resolve_failed", address = address }
  end

  local zip, zcta_err = Z.zcta(point.lat, point.lon)
  if zcta_err then return { next = "collect", error = "zip_geocode_unavailable", address = address } end
  if not zip then return { next = "collect", error = "resolve_failed", address = address } end

  return { next = "collect", zip_code = zip, source = "geocode" }
end
