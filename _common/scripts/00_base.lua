-- Shared, site-agnostic base layer (AX_BASE).
-- Loaded from _common/scripts/ BEFORE any <site>/scripts/*, and persists across site changes
-- (see SDK manager: replaceAXSDKLuaCommonScripts inserts common first; site scripts append).
-- Site modules do `local B = AX_BASE` and build on these primitives. No site selectors here.
AX_BASE = {}
local B = AX_BASE

-- US locale endpoints (reused by any US site needing city/ZIP resolution).
B.CENSUS_GEOCODER_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
B.ZIPPOPOTAM_CITY_URL = "https://api.zippopotam.us/us/"

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
-- Parses a trailing 2-letter state ("San Francisco, CA"); returns nil,nil when not "City, ST".
function B.split_city_state(address)
  local text = B.clean_text(address)
  local city, state = text:match("^(.+),%s*([A-Za-z][A-Za-z])%s*$")
  if city and state then
    return B.non_empty(city), state:upper()
  end
  return nil, nil
end

-- Census onelineaddress only matches full street addresses; a bare "City, ST" returns no
-- addressMatches. This resolves a representative ZIP for the city via Zippopotam.
function B.zip_from_city(address)
  local city, state = B.split_city_state(address)
  if not city or not state then
    return nil
  end
  local fetch = (net and net.fetch) or (http and http.fetch)
  if not fetch then
    return nil
  end
  local response = fetch(B.ZIPPOPOTAM_CITY_URL .. state:lower() .. "/" .. B.url_encode(city), {
    method = "GET",
    headers = {
      accept = "application/json"
    },
    credentials = "omit",
    response = "json",
    timeout = 4000
  })
  if response.reason == "pending" then
    return { pending = true }
  end
  if not response.ok or type(response.json) ~= "table" then
    return nil
  end
  local places = response.json.places
  if type(places) ~= "table" then
    return nil
  end
  local target = B.clean_text(city):lower()
  local fallback = nil
  for index = 1, #places do
    local place = places[index]
    local zip = place and place["post code"]
    if zip then
      if not fallback then
        fallback = tostring(zip)
      end
      local pname = place["place name"]
      if pname and B.clean_text(pname):lower() == target then
        return tostring(zip)
      end
    end
  end
  return fallback
end

-- args.zip_code (explicit) -> args.address embedded ZIP -> Census (full street) -> Zippopotam city.
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
    timeout = 4000
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
  if not zip then
    local city_zip = B.zip_from_city(address)
    if type(city_zip) == "table" and city_zip.pending then
      return {
        pending = true,
        error = "pending"
      }
    end
    if city_zip then
      return {
        zip_code = tostring(city_zip),
        source = "zippopotam_city"
      }
    end
    return {
      error = "zip_not_found",
      status = response.status,
      message = "No ZIP for this address. Provide a full street address or a 5-digit ZIP."
    }
  end

  return {
    zip_code = tostring(zip),
    source = "census_geocoder",
    matched_address = first.matchedAddress
  }
end
