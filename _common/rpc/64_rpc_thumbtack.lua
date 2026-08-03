--- Thumbtack's service search, read from the runtime.
---
--- This is where the durable design cost the most. Every page-level tool had to be re-entrant and
--- page-detecting because a navigation destroyed the Lua context, and resuming across it was measured at
--- 12–21 seconds. A runtime script keeps its own stack, so the read is a straight line: fire the search,
--- wait for the list to stop changing, classify, read.
---
--- The waiting is the part that must not be lost. Thumbtack's results hydrate, so reading the first
--- answer reports a half-rendered page as the final one and a service with fifteen pros comes back with
--- three. The durable version used a `wait_settled` primitive for this; here it is a loop, which is what
--- it always was.

AX_RPC_THUMBTACK = AX_RPC_THUMBTACK or {}
local T = AX_RPC_THUMBTACK

T.SEARCH_URL = "https://www.thumbtack.com/instant-results/"
T.CARD_SELECTOR = '[data-test="pro-list-result"], [data-testid="pro-list-result"]'
T.ZIP_REJECTED_SELECTOR = '[data-test="invalid-zip"], [data-test="zip-error"]'
T.RESULT_LIMIT = 24

local function trim(value)
  if type(value) ~= "string" then return nil end
  local text = value:gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", "")
  return text ~= "" and text or nil
end

local function array(value)
  if ax and type(ax.array) == "function" then
    local out = ax.array()
    for index = 1, #(value or {}) do out[index] = value[index] end
    return out
  end
  return value or {}
end

local function url_encode(value)
  return (tostring(value or ""):gsub("[^%w%-%._~]", function(char)
    return string.format("%%%02X", string.byte(char))
  end))
end

function T.search_url(query, zip_code)
  return T.SEARCH_URL .. "?" .. "query=" .. url_encode(query)
    .. (zip_code and ("&zip_code=" .. url_encode(zip_code)) or "")
end

local function fields()
  return {
    text = true,
    title = { selector = '[data-test="pro-name"], h3, h2' },
    rating_text = { selector = '[data-test="pro-rating"], [aria-label*="star"], .star-rating' },
    url = { selector = 'a[href*="/p/"]', attr = "href" },
  }
end

--- One pro card, or nil when it carries no name to show.
local function candidate_from(row)
  local name = trim(row.title) or trim(row.text)
  if not name then return nil end
  local rating = tonumber(tostring(row.rating_text or ""):match("(%d+%.?%d*)"))
  return {
    name = name,
    rating = rating,
    url = trim(row.url),
    summary = trim(row.text),
  }
end

local function read_cards()
  local rows = dom.query_all(T.CARD_SELECTOR, fields(), T.RESULT_LIMIT)
  local candidates = {}
  local seen = {}
  for index = 1, #rows do
    local candidate = candidate_from(rows[index] or {})
    if candidate and not seen[candidate.name] then
      seen[candidate.name] = true
      candidates[#candidates + 1] = candidate
    end
  end
  return candidates
end

--- Reads the list once it stops changing.
---
--- `attempts` bounds the wait the way the durable primitive's `timeout` did; `quiet` is how many
--- identical counts in a row count as settled. A single stable reading is not enough: the first and
--- second polls of a list that has not started rendering are both zero.
function T.settle(attempts, quiet)
  local last, stable, candidates = nil, 0, {}
  for _ = 1, (attempts or 8) do
    candidates = read_cards()
    if #candidates == last then
      stable = stable + 1
      if stable >= (quiet or 1) then return candidates end
    else
      stable = 0
    end
    last = #candidates
  end
  return candidates
end

--- Searches Thumbtack for a service near a ZIP and returns the pros it settled on.
function T.search_service(args)
  args = type(args) == "table" and args or {}
  local query = trim(args.query)
  local zip_code = trim(args.zip_code)
  if not query then return { next = "error", error = "query_required" } end

  local ok, from = pcall(dom.get_location_href)
  if not ok then return { next = "error", error = "rpc_unavailable" } end

  nav.navigate(T.search_url(query, zip_code))
  nav.wait_for_navigation(from, { timeout = 8000, interval = 200 })

  local candidates = T.settle(8, 2)

  -- A bad postcode answers with a banner and an empty list. Reporting `no_results` would send the user
  -- looking for another service when the ZIP is what Thumbtack disliked.
  if dom.exists(T.ZIP_REJECTED_SELECTOR) then
    return { next = "invalid_zip", query = query, zip_code = zip_code,
             candidates = array({}), error = "invalid_zip" }
  end

  if #candidates == 0 then
    return { next = "no_results", query = query, zip_code = zip_code,
             candidates = array({}), error = "no_results" }
  end

  return {
    next = "ok",
    query = query,
    zip_code = zip_code,
    href = dom.get_location_href(),
    candidates = array(candidates),
  }
end
