-- Storefront search over the RPC channel.
--
-- The durable version of this (15_storefront.lua) carries a checkpoint state machine —
-- prepare → navigation_armed → navigated → read — because every navigation destroyed the Lua context and
-- the command had to resume into it. A runtime-side script keeps its own stack across the navigation, so
-- the machine is gone: look, maybe move, wait, read. What survives is the reading logic and the
-- distinction between outcomes, which is where the value was.
--
-- Called with a site CONFIG (data, not code) so one script serves every storefront.

AX_RPC_STOREFRONT = AX_RPC_STOREFRONT or {}
local S = AX_RPC_STOREFRONT

local function trim(value)
  return (tostring(value or ""):gsub("^%s+", ""):gsub("%s+$", ""))
end

local function non_empty(value)
  local text = trim(value)
  if text == "" then return nil end
  return text
end

local function array(value)
  -- The runtime provides `array()`; offline (fengari) it is absent and a bare table is fine because the
  -- test harness reads sequences by length.
  if type(_G.array) == "function" then return _G.array(value or {}) end
  return value or {}
end

local function url_encode(value)
  return (tostring(value or ""):gsub("[^%w%-%.%_%~ ]", function(c)
    return string.format("%%%02X", string.byte(c))
  end):gsub(" ", "+"))
end

--- The search URL for this site and query, including whatever fixed params the site needs.
function S.search_url(config, query, page)
  local url = config.search_url .. "?" .. config.search_param .. "=" .. url_encode(query)
  for key, value in pairs(config.search_extra or {}) do
    url = url .. "&" .. key .. "=" .. url_encode(value)
  end
  local paging = config.pagination
  if paging and page and page > 1 then
    url = url .. "&" .. paging.param .. "=" .. tostring(paging.start + (page - 1) * paging.step)
  end
  return url
end

--- True when the browser is already showing this site's results for this query. Re-searching costs a
--- full page load, so the cheapest correct move is to notice we are already there.
local function already_showing(config, href, query)
  local current = tostring(href or "")
  if not config.search_path_marker or not current:find(config.search_path_marker, 1, true) then
    return false
  end
  local encoded = url_encode(query)
  return current:find(config.search_param .. "=" .. encoded, 1, true) ~= nil
end

local function fields_for(config)
  local fields = { text = true }
  local function add(name, selector, attr)
    if not selector then return end
    fields[name] = { selector = selector }
    if attr then fields[name].attr = attr end
  end
  add("url", config.result_url_selector, "href")
  add("title", config.result_title_selector)
  add("price_text", config.result_price_selector)
  add("shipping_text", config.result_shipping_selector)
  add("rating_text", config.result_rating_selector)
  return fields
end

local function parse_price(text)
  local raw = tostring(text or ""):gsub(",", "")
  return tonumber(raw:match("%d+%.?%d*"))
end

local function product_id(config, href)
  local text = non_empty(href)
  if not text then return nil end
  for index = 1, #(config.product_id_patterns or {}) do
    local id = text:match(config.product_id_patterns[index])
    if id then return id end
  end
  return nil
end

--- Turns one read row into a candidate, or nil when it cannot be compared. A row without an id or a
--- price is dropped rather than guessed: a wrong number in a price comparison is worse than a missing row.
local function candidate_from(config, row)
  local href = non_empty(row.url)
  local id = product_id(config, href)
  local name = non_empty(row.title) or non_empty(row.image_alt)
  local price = parse_price(row.price_text)
  if not id or not name or not price then return nil end
  return {
    site = config.site,
    product_id = id,
    id = id,
    name = name,
    price = price,
    currency = config.default_currency,
    url = (config.product_url_prefix and (config.product_url_prefix .. id)) or href,
    shipping_text = non_empty(row.shipping_text),
    rating_text = non_empty(row.rating_text),
  }
end

--- Why a read produced nothing: a grid full of cards nobody could price is a different fact from an
--- empty grid, and the flow branches on it.
local function outcome(cards_seen, kept)
  if kept > 0 then return "ok" end
  if cards_seen > 0 then return "price_unavailable" end
  return "no_results"
end

--- Search one storefront and return its candidates. Read-only: no write op is reachable from here.
function S.search(config, args)
  args = type(args) == "table" and args or {}
  local query = non_empty(args.query)
  if not query then return { next = "error", error = "query_required" } end

  local from = dom.get_location_href()
  if not already_showing(config, from, query) then
    nav.navigate(S.search_url(config, query, tonumber(args.page)))
    -- href first. A document that is still alive answers a selector check from the OLD page, so an
    -- element probe here is a false positive waiting to happen.
    if not nav.wait_for_navigation(from, { timeout = 8000, interval = 200 }) then
      return { next = "error", error = "navigation_stuck", href = dom.get_location_href() }
    end
  end

  local ready = config.result_ready_selector or config.result_selector
  dom.wait_for_selector(ready, { timeout = config.search_timeout or 6000, interval = 200 })

  local rows = dom.query_all(config.result_selector, fields_for(config), config.result_limit or 24)
  local cards_seen = #rows
  local candidates = array({})
  local seen = {}
  for index = 1, cards_seen do
    local candidate = candidate_from(config, rows[index] or {})
    if candidate and not seen[candidate.product_id] then
      seen[candidate.product_id] = true
      candidates[#candidates + 1] = candidate
    end
  end

  local next_value = outcome(cards_seen, #candidates)
  return {
    next = next_value,
    site = config.site,
    query = query,
    href = dom.get_location_href(),
    cards_seen = cards_seen,
    candidates = candidates,
    error = (next_value ~= "ok") and next_value or nil,
  }
end
