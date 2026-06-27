-- Shared, site-agnostic base layer (AX_BASE).
-- Loaded from _common/scripts/ BEFORE any <site>/scripts/*, and persists across site changes
-- (see SDK manager: replaceAXSDKLuaCommonScripts inserts common first; site scripts append).
-- Site modules do `local B = AX_BASE` and build on these primitives. No site selectors here.
AX_BASE = {}
local B = AX_BASE

-- US locale endpoints (reused by any US site needing city/ZIP resolution).
B.CENSUS_GEOCODER_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
B.CENSUS_ZCTA_URL = "https://geocoding.geo.census.gov/geocoder/geographies/coordinates"
-- Forward geocoders (no API key; Photon needs no User-Agent): Photon (Komoot) primary, Nominatim
-- (OSM) fallback. A geocoded point is reverse-resolved to its ZCTA (ZIP) via the Census endpoint above.
B.PHOTON_SEARCH_URL = "https://photon.komoot.io/api"
B.NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search"

-- ── text ────────────────────────────────────────────────────────────────────
function B.clean_text(value)
  local text = tostring(value or "")
  text = text:gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", "")
  return text
end

function B.non_empty(value)
  local text = B.clean_text(value)
  if text == "" then
    return nil
  end
  return text
end

function B.normalize_text(value)
  return B.clean_text(value):lower():gsub("%s+", " ")
end

function B.truncate_text(value, limit)
  local text = B.clean_text(value)
  if #text <= limit then
    return text
  end
  return text:sub(1, limit - 1) .. "…"
end

-- Collapse an exactly-doubled string ("FooFoo" -> "Foo"); some DOM reads duplicate text nodes.
function B.dedupe_adjacent(value)
  local text = B.clean_text(value)
  local length = #text
  if length % 2 == 0 then
    local half = length / 2
    if text:sub(1, half) == text:sub(half + 1) then
      return text:sub(1, half)
    end
  end
  return text
end

-- ── css / selectors ──────────────────────────────────────────────────────────
function B.css_attr_string(value)
  local text = tostring(value or "")
  text = text:gsub("\\", "\\\\"):gsub('"', '\\"')
  return text
end

function B.selector_for_name(name)
  local text = B.non_empty(name)
  if not text then
    return nil
  end
  return '[name="' .. B.css_attr_string(text) .. '"]'
end

function B.selector_for_id(id)
  local text = B.non_empty(id)
  if not text then
    return nil
  end
  return '[id="' .. B.css_attr_string(text) .. '"]'
end

-- ── url ────────────────────────────────────────────────────────────────────
function B.url_encode(value)
  local text = tostring(value or "")
  return (text:gsub("([^%w%-_%.~])", function(char)
    return string.format("%%%02X", string.byte(char))
  end))
end

function B.url_query_param(url, name)
  local pattern = "[?&]" .. name .. "=([^&#]+)"
  return B.non_empty(tostring(url or ""):match(pattern))
end

function B.current_url()
  return B.non_empty(dom.get_location_href()) or ""
end

-- ── value parsers (generic) ───────────────────────────────────────────────────
function B.extract_zip(value)
  local text = tostring(value or "")
  local zip = text:match("(%d%d%d%d%d)%-%d%d%d%d") or text:match("(%d%d%d%d%d)")
  return zip
end

function B.parse_number_text(value)
  local text = tostring(value or ""):gsub(",", "")
  local number_text = text:match("(%d+%.%d+)") or text:match("(%d+)")
  if not number_text then
    return nil
  end
  return tonumber(number_text)
end

function B.parse_rating(value)
  local rating = tonumber(tostring(value or ""):match("(%d+%.%d+)"))
  if rating and rating <= 5 then
    return rating
  end
  return nil
end

function B.parse_review_count(value)
  local count = tostring(value or ""):match("%(([%d,]+)%)")
  if count then
    local digits = count:gsub(",", "")
    return tonumber(digits)
  end
  return nil
end

-- Generic US price text. Sites with different phrasing can supply their own parse fn to read_field.
function B.parse_price_text(value)
  local text = B.clean_text(value)
  local contact = text:match("Contact for price")
  if contact then
    return contact
  end
  local price = text:match("($[%d,]+[^$]-Starting price)") or text:match("($[%d,]+)")
  return B.non_empty(price)
end

-- ── dom reads (generic) ───────────────────────────────────────────────────────
function B.read_text_array(selector, limit)
  local rows = dom.query_all(selector, { text = true }, limit)
  local values = ax.array()
  local seen = {}
  for index = 1, #rows do
    local value = B.non_empty(rows[index].text)
    if value and not seen[value] then
      seen[value] = true
      values[#values + 1] = value
    end
  end
  return values
end

function B.read_images(selector, limit)
  local rows = dom.query_all(selector, {
    url = { attr = "src" },
    alt = { attr = "alt" }
  }, limit)
  local images = ax.array()
  local seen = {}
  for index = 1, #rows do
    local url = B.non_empty(rows[index].url)
    if url and not seen[url] then
      seen[url] = true
      images[#images + 1] = {
        url = url,
        alt = B.non_empty(rows[index].alt)
      }
    end
  end
  return images
end

-- Selector-first field read: candidates = ordered list of { selector, parse?, attr? }.
-- First candidate yielding a non-empty value wins. Returns value, source_selector.
-- attr reads an element attribute; otherwise text content of the first match is used.
-- This is the agreed read strategy: layering is across CANDIDATE SELECTORS (one paradigm),
-- never across different data sources.
function B.read_field(candidates)
  candidates = candidates or {}
  for index = 1, #candidates do
    local c = candidates[index]
    if c and c.selector then
      local raw
      if c.attr then
        local rows = dom.query_all(c.selector, { value = { attr = c.attr } }, 1)
        raw = rows[1] and rows[1].value
      else
        raw = dom.get_text(c.selector)
      end
      local value
      if c.parse then
        value = c.parse(raw)
      else
        value = B.non_empty(raw)
      end
      if value ~= nil and value ~= "" then
        return value, c.selector
      end
    end
  end
  return nil, nil
end

-- spec = { field_name = { candidate, ... }, ... }. Returns { values, sources, partial }.
-- Missing field -> nil (partial=true), never a hard error; sources records the winning selector
-- per field so drift is visible.
function B.read_fields(spec)
  local values, sources = {}, {}
  local partial = false
  for field, candidates in pairs(spec or {}) do
    local v, src = B.read_field(candidates)
    values[field] = v
    sources[field] = src
    if v == nil then
      partial = true
    end
  end
  return { values = values, sources = sources, partial = partial }
end

-- Best-effort close of an overlay/popup by selector. Does not navigate, so navigates=false keeps
-- the durable step replay-safe. Safe no-op when absent (dom.click returns false on no match).
function B.dismiss_overlay(selector)
  if selector and dom.exists(selector) then
    dom.click(selector, { navigates = false })
    return true
  end
  return false
end

-- ── dom actions (verified) ────────────────────────────────────────────────────
-- Gate on a readiness selector: returns wait_for_selector's result so callers surface a real
-- status instead of silently proceeding on timeout. { ok=true } | { ok=false, reason, selector }.
function B.require_ready(selector, opts)
  opts = opts or {}
  if dom.wait_for_selector(selector, { timeout = opts.timeout or 8000 }) == true then
    return { ok = true }
  end
  return { ok = false, reason = opts.reason or "not_ready", selector = selector }
end

-- Verified click: act -> verify -> retry-once. dom.click on a non-matching selector is a silent
-- no-op returning false, so a hit-check plus a post-condition turns "fired and hoped" into a real
-- result. opts: { selector, hit_check=true, navigates=false, timeout=4000, retry=1, and ONE of
-- expect=<selector appears> | expect_gone=<selector disappears> | verify=function()->bool }.
-- Returns { ok=true, reason="clicked" } only when the click landed AND the post-condition held;
-- else { ok=false, reason="not_found"|"click_failed"|"effect_not_confirmed", selector }.
function B.click_verified(opts)
  local selector = opts.selector
  local timeout = opts.timeout or 4000
  for attempt = 1, (opts.retry or 1) + 1 do
    if opts.hit_check ~= false and not dom.exists(selector) then
      return { ok = false, reason = "not_found", selector = selector }
    end
    -- A navigating click returns { ok, reason }; a plain effect click returns a bool. Normalize both.
    local clicked = dom.click(selector, { navigates = opts.navigates == true })
    local click_ok = (type(clicked) == "table") and (clicked.ok == true) or (clicked == true)
    if not click_ok then
      return { ok = false, reason = "click_failed", selector = selector }
    end
    local confirmed = true
    if opts.expect then
      confirmed = dom.wait_for_selector(opts.expect, { timeout = timeout }) == true
    elseif opts.expect_gone then
      confirmed = dom.wait_for({ selector = opts.expect_gone, gone = true }, { timeout = timeout }) == true
    elseif opts.verify then
      dom.wait(300)
      confirmed = opts.verify() == true
    end
    if confirmed then
      return { ok = true, reason = "clicked", attempt = attempt }
    end
    dom.wait(300)
  end
  return { ok = false, reason = "effect_not_confirmed", selector = selector }
end

-- ── US ZIP resolution (address/city -> ZIP) ───────────────────────────────────
-- Parses CITY and 2-letter STATE from a US address. Accepts a bare "City, ST" AND a full
-- "street, City, ST" (city = the comma-segment immediately before the state); returns nil,nil
-- when there is no trailing 2-letter state.
function B.split_city_state(address)
  local text = B.clean_text(address)
  local before, state = text:match("^(.+),%s*([A-Za-z][A-Za-z])%s*$")
  if not (before and state) then
    return nil, nil
  end
  -- "1 Main St, San Francisco" -> "San Francisco"; "San Francisco" -> "San Francisco".
  local city = before:match("([^,]+)%s*$") or before
  return B.non_empty(city), state:upper()
end

-- Forward-geocodes a free-form place/address string to a representative point, no API key required.
-- Primary: Photon (Komoot) — permissive CORS, no User-Agent requirement. Fallback: Nominatim (OSM).
-- Both reliably return coordinates for "City, ST" and full addresses where city-level postcode
-- lookups (and the Census street geocoder) come up empty.
-- Returns { lat, lon[, zip] } | { pending = true } | nil.
function B.geocode_point(query)
  local q = B.non_empty(query)
  if not q then
    return nil
  end
  local fetch = (net and net.fetch) or (http and http.fetch)
  if not fetch then
    return nil
  end
  -- Primary: Photon. Occasionally returns a postcode directly (used as a shortcut when present).
  local photon = fetch(B.PHOTON_SEARCH_URL .. "?q=" .. B.url_encode(q) .. "&limit=1", {
    method = "GET",
    headers = {
      accept = "application/json"
    },
    credentials = "omit",
    response = "json",
    timeout = 5000
  })
  if photon.reason == "pending" then
    return { pending = true }
  end
  if photon.ok and type(photon.json) == "table" then
    local features = photon.json.features
    local first = type(features) == "table" and features[1] or nil
    if type(first) == "table" then
      local props = first.properties
      local zip = type(props) == "table" and B.extract_zip(props.postcode) or nil
      local geom = first.geometry
      local coords = type(geom) == "table" and geom.coordinates or nil
      if type(coords) == "table" and coords[1] and coords[2] then
        -- GeoJSON coordinate order is [lon, lat].
        return { lon = tonumber(coords[1]), lat = tonumber(coords[2]), zip = zip }
      end
      if zip then
        return { zip = zip }
      end
    end
  end
  -- Fallback: Nominatim. The browser bridge cannot override User-Agent, so the request carries
  -- Chrome's UA (accepted by Nominatim for light use); on rejection this returns nil and the caller
  -- falls through to the Census street geocoder.
  local nom = fetch(B.NOMINATIM_SEARCH_URL .. "?q=" .. B.url_encode(q) .. "&format=jsonv2&addressdetails=1&limit=1", {
    method = "GET",
    headers = {
      accept = "application/json"
    },
    credentials = "omit",
    response = "json",
    timeout = 5000
  })
  if nom.reason == "pending" then
    return { pending = true }
  end
  if nom.ok and type(nom.json) == "table" then
    local first = nom.json[1]
    if type(first) == "table" and first.lat and first.lon then
      local zip = type(first.address) == "table" and B.extract_zip(first.address.postcode) or nil
      return { lon = tonumber(first.lon), lat = tonumber(first.lat), zip = zip }
    end
  end
  return nil
end

-- Reverse-geocodes a point to its US Census ZIP Code Tabulation Area (ZCTA5). A point always falls
-- within exactly one ZCTA, so this yields a representative ZIP even for city-centroid inputs that
-- forward geocoders return without a postcode. No API key, no User-Agent requirement.
-- Returns a ZIP string | { pending = true } | nil.
function B.zip_from_point(lat, lon)
  local y = tonumber(lat)
  local x = tonumber(lon)
  if not y or not x then
    return nil
  end
  local fetch = (net and net.fetch) or (http and http.fetch)
  if not fetch then
    return nil
  end
  local response = fetch(B.CENSUS_ZCTA_URL
    .. "?x=" .. tostring(x) .. "&y=" .. tostring(y)
    .. "&benchmark=Public_AR_Current&vintage=Current_Current&layers=all&format=json", {
    method = "GET",
    headers = {
      accept = "application/json"
    },
    credentials = "omit",
    response = "json",
    timeout = 6000
  })
  if response.reason == "pending" then
    return { pending = true }
  end
  if not response.ok or type(response.json) ~= "table" then
    return nil
  end
  local geos = response.json.result and response.json.result.geographies
  if type(geos) ~= "table" then
    return nil
  end
  -- The layer key carries a vintage prefix ("2020 Census ZIP Code Tabulation Areas") that shifts
  -- between vintages; match by substring so a future bump keeps resolving.
  for key, layer in pairs(geos) do
    if type(key) == "string" and key:lower():find("zip code tabulation", 1, true) and type(layer) == "table" then
      for index = 1, #layer do
        local entry = layer[index]
        local zip = entry and B.extract_zip(entry.ZCTA5 or entry.BASENAME or entry.NAME)
        if zip then
          return zip
        end
      end
    end
  end
  return nil
end

-- City/address -> representative ZIP via forward geocode (Photon/Nominatim) + Census ZCTA reverse.
-- Robust for the common "City, ST" input that single-shot postcode lookups cannot resolve.
-- Returns a ZIP string | { pending = true } | nil.
function B.zip_from_city(address)
  local point = B.geocode_point(address)
  if type(point) ~= "table" then
    return nil
  end
  if point.pending then
    return { pending = true }
  end
  if point.zip then
    return point.zip
  end
  if point.lat and point.lon then
    return B.zip_from_point(point.lat, point.lon)
  end
  return nil
end

-- Resolution ladder (layered; no single load-bearing source):
--   args.zip_code (explicit) -> embedded ZIP in args.address -> forward geocode + Census ZCTA reverse
--   (robust for "City, ST" and full addresses) -> Census onelineaddress (full street addresses) ->
--   error. The geocode/ZCTA path replaces the previously flaky Zippopotam primary, which also
--   mis-resolved some cities (e.g. "San Francisco" -> "South San Francisco").
function B.resolve_zip(args)
  args = args or {}
  local explicit = B.extract_zip(args.zip_code)
  if explicit then
    return {
      zip_code = explicit,
      source = "zip_code"
    }
  end

  local address = B.non_empty(args.address)
  if not address then
    return {
      error = "missing_zip_or_address"
    }
  end

  local embedded = B.extract_zip(address)
  if embedded then
    return {
      zip_code = embedded,
      source = "address_text"
    }
  end

  -- Primary: forward geocode (Photon/Nominatim) -> Census ZCTA reverse.
  local geo = B.zip_from_city(address)
  if type(geo) == "table" and geo.pending then
    return {
      pending = true,
      error = "pending"
    }
  end
  if type(geo) == "string" then
    return {
      zip_code = geo,
      source = "geocode_zcta"
    }
  end

  -- Fallback: Census full-address geocoder (authoritative for full street addresses).
  local fetch = (net and net.fetch) or (http and http.fetch)
  if not fetch then
    return {
      error = "fetch_unavailable"
    }
  end
  local response = fetch(B.CENSUS_GEOCODER_URL .. "?address=" .. B.url_encode(address) .. "&benchmark=Public_AR_Current&format=json", {
    method = "GET",
    headers = {
      accept = "application/json"
    },
    credentials = "omit",
    response = "json",
    timeout = 5000
  })

  if response.reason == "pending" then
    return {
      pending = true,
      error = "pending"
    }
  end

  if not response.ok then
    return {
      error = "zip_lookup_failed",
      status = response.status,
      reason = response.reason,
      body = response.body,
      message = response.error
    }
  end

  local matches = response.json
    and response.json.result
    and response.json.result.addressMatches
  local first = matches and matches[1]
  local components = first and first.addressComponents
  local zip = components and components.zip
  if zip then
    return {
      zip_code = tostring(zip),
      source = "census_geocoder",
      matched_address = first.matchedAddress
    }
  end
  return {
    error = "zip_not_found",
    status = response.status,
    message = "No ZIP for this address. Provide a full street address or a 5-digit ZIP."
  }
end
