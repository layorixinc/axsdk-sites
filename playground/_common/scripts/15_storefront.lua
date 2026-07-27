-- Read-only, replay-safe storefront search shared by Playground's non-Amazon commerce layers.
-- Site layers provide selectors and URL policy; this file owns the durable-v2 checkpoint protocol.

local C = AX_PLAYGROUND_COMMERCE
if type(C) ~= "table" then
  error("playground/_common/scripts/06_commerce_sites.lua must load before 15_storefront.lua")
end

local D = AX_PLAYGROUND_DURABLE
if type(D) ~= "table" then
  error("playground/_common/scripts/05_durable.lua must load before 15_storefront.lua")
end

AX_PLAYGROUND_STOREFRONT = AX_PLAYGROUND_STOREFRONT or {}
local S = AX_PLAYGROUND_STOREFRONT

local function lower(value)
  return C.clean(value):lower()
end

local function url_encode(value)
  return tostring(value or ""):gsub("([^%w%-_%.~])", function(character)
    return string.format("%%%02X", string.byte(character))
  end)
end

local function url_decode(value)
  return tostring(value or ""):gsub("%+", " "):gsub("%%(%x%x)", function(hex)
    return string.char(tonumber(hex, 16))
  end)
end

local function url_query_param(href, key)
  for pair in tostring(href or ""):gmatch("[?&]([^&]+)") do
    local raw_key, raw_value = pair:match("^([^=]+)=?(.*)$")
    if raw_key and url_decode(raw_key) == key then return url_decode(raw_value) end
  end
  return nil
end

local function current_url()
  return C.non_empty(dom.get_location_href()) or ""
end

local function host_matches(config, href)
  local host = tostring(href or ""):match("^https?://([^/?#]+)")
  if not host then return false end
  host = host:lower()
  for index = 1, #(config.hosts or {}) do
    local suffix = tostring(config.hosts[index]):lower():gsub("^%.", "")
    if host == suffix or host:sub(-(#suffix + 1)) == "." .. suffix then return true end
  end
  return false
end

local function current_search_matches(config, query)
  local href = current_url()
  if not host_matches(config, href) then return false end
  if config.search_path_marker and not href:find(config.search_path_marker, 1, true) then return false end
  if config.search_param then
    local actual = url_query_param(href, config.search_param)
    if actual then return lower(actual) == lower(query) end
  end
  if config.search_input_selector then
    local actual = C.non_empty(dom.get_attr(config.search_input_selector, "value"))
    if actual then return lower(actual) == lower(query) end
  end
  if config.search_path_prefix then
    local slug = url_encode(query):gsub("%%20", "-"):lower()
    return href:lower():find(slug, 1, true) ~= nil
  end
  return false
end

local function search_target(config, query)
  if config.search_path_prefix then
    return config.search_path_prefix .. url_encode(query):gsub("%%20", "-") .. (config.search_path_suffix or "")
  end
  return config.search_url
end

local function navigate_search(config, query)
  if current_search_matches(config, query) then return { ok = true, fired = false } end
  if nav and type(nav.clear_beforeunload) == "function" then nav.clear_beforeunload() end
  local params = {}
  if config.search_param then params[config.search_param] = query end
  for key, value in pairs(config.search_extra or {}) do params[key] = value end
  local navigation = nav.navigate(search_target(config, query), params, { reload = true })
  if type(navigation) ~= "table" or navigation.ok ~= true then
    return navigation or { ok = false, error = "search_navigation_failed" }
  end
  return navigation
end

-- Amounts written next to their currency marker win over the first number in the text: a card's
-- text often starts with a model year or DPI figure ("2026 NEW X11 ... ₩27,000") that would
-- otherwise be read as the price on price_from_text sites.
local CURRENCY_ANCHORS = {
  { pattern = "₩%s*([%d][%d,]*%.?%d*)", currency = "KRW" },
  { pattern = "KRW%s*([%d][%d,]*%.?%d*)", currency = "KRW" },
  { pattern = "([%d][%d,]*%.?%d*)%s*원", currency = "KRW" },
  { pattern = "%$%s*([%d][%d,]*%.?%d*)", currency = "USD" },
  { pattern = "USD%s*([%d][%d,]*%.?%d*)", currency = "USD" },
  { pattern = "€%s*([%d][%d,]*%.?%d*)", currency = "EUR" },
  { pattern = "£%s*([%d][%d,]*%.?%d*)", currency = "GBP" },
  { pattern = "¥%s*([%d][%d,]*%.?%d*)", currency = "JPY" }
}

-- Card text concatenates the price with the rating and sold count ("₩27,0004.2248 판매"), so a raw
-- digit run overshoots. Rebuild the number from its thousand groups and stop at the first group
-- that is not exactly three digits; a truncated number keeps no decimals.
local function sanitize_amount(raw)
  local integer_part, decimal_part = raw:match("^([%d,]+)%.?(%d*)$")
  if not integer_part then return tonumber((raw:gsub(",", ""))) end
  local digits, first, truncated = "", true, false
  for segment in integer_part:gmatch("[^,]+") do
    if first then
      digits, first = segment, false
    elseif #segment == 3 then
      digits = digits .. segment
    else
      digits = digits .. segment:sub(1, 3)
      truncated = true
      break
    end
  end
  if truncated or decimal_part == "" or #decimal_part > 2 then return tonumber(digits) end
  return tonumber(digits .. "." .. decimal_part)
end

local function parse_money(value, fallback_currency)
  local text = C.clean(value)
  if text == "" then return nil, nil end
  local currency = nil
  if text:find("KRW", 1, true) or text:find("₩", 1, true) then currency = "KRW"
  elseif text:find("US$", 1, true) or text:find("$", 1, true) then currency = "USD"
  elseif text:find("EUR", 1, true) or text:find("€", 1, true) then currency = "EUR"
  elseif text:find("GBP", 1, true) or text:find("£", 1, true) then currency = "GBP"
  elseif text:find("JPY", 1, true) or text:find("¥", 1, true) then currency = "JPY" end
  for index = 1, #CURRENCY_ANCHORS do
    local anchor = CURRENCY_ANCHORS[index]
    local anchored = text:match(anchor.pattern)
    if anchored then
      return sanitize_amount(anchored), currency or anchor.currency or fallback_currency
    end
  end
  local amount = text:match("([%d][%d,]*%.?%d*)")
  if not amount then return nil, currency or fallback_currency end
  return sanitize_amount(amount), currency or fallback_currency
end

-- Cards that print the struck-through list price before the sale price (Coupang) need the LAST
-- amount ahead of the shipping fragment, not the first one, which the product name can also glue
-- itself to ("… 마우스 M75" + "139,900원" + "30%" + "27,900원").
local function last_anchored_amount(text, fallback_currency)
  local best_start, best_amount, best_currency = nil, nil, nil
  for index = 1, #CURRENCY_ANCHORS do
    local anchor = CURRENCY_ANCHORS[index]
    local position = 1
    while true do
      local start_at, end_at, captured = text:find(anchor.pattern, position)
      if not start_at then break end
      if not best_start or start_at >= best_start then
        best_start, best_amount, best_currency = start_at, captured, anchor.currency
      end
      position = end_at + 1
    end
  end
  if not best_amount then return nil, nil end
  return sanitize_amount(best_amount), best_currency or fallback_currency
end

local function parse_candidate_price(value, fallback_currency, strategy)
  if strategy ~= "last_before_shipping" then return parse_money(value, fallback_currency) end
  local text = C.clean(value)
  local marker = lower(text):find("배송", 1, true)
    or lower(text):find("shipping", 1, true)
    or lower(text):find("delivery", 1, true)
  if marker then text = text:sub(1, marker - 1) end
  local amount, currency = last_anchored_amount(text, fallback_currency)
  if amount then return amount, currency end
  return parse_money(text, fallback_currency)
end

local function parse_shipping(value, fallback_currency)
  local text = C.non_empty(value)
  if not text then return nil, fallback_currency, nil end
  local lowered = lower(text)
  if lowered:find("free shipping", 1, true)
      or lowered:find("free delivery", 1, true)
      or lowered:find("무료 배송", 1, true)
      or lowered:find("배송비 무료", 1, true) then
    return 0, fallback_currency, text
  end
  local marker = lowered:find("shipping", 1, true)
    or lowered:find("delivery", 1, true)
    or lowered:find("배송", 1, true)
  local fragment = marker and text:sub(marker) or text
  local amount, currency = parse_money(fragment, fallback_currency)
  return amount, currency or fallback_currency, fragment
end

local function parse_rating(value)
  local rating = tonumber(C.clean(value):match("(%d+%.%d+)"))
  return rating and rating <= 5 and rating or nil
end

local function parse_review_count(value)
  local compact = C.clean(value):gsub(",", ""):gsub("%s+", "")
  local abbreviated = tonumber(compact:match("(%d+%.?%d*)[kK]"))
  if abbreviated then return math.floor(abbreviated * 1000) end
  return tonumber(compact:match("(%d+)"))
end

local function parse_product_id(config, href, fallback)
  local direct = C.non_empty(fallback)
  if direct then return direct:match("([%w_-]+)") end
  local target = C.non_empty(href)
  if not target then return nil end
  for index = 1, #(config.product_id_patterns or {}) do
    local product_id = target:match(config.product_id_patterns[index])
    if product_id then return product_id end
  end
  return nil
end

local function product_url(config, product_id, href)
  if config.product_url_prefix and product_id then
    return config.product_url_prefix .. tostring(product_id) .. (config.product_url_suffix or "")
  end
  local target = C.non_empty(href)
  if target and target:sub(1, 1) == "/" then return config.origin .. target end
  return target and target:gsub("#.*$", "") or nil
end

local function result_fields(config)
  local fields = { text = true }
  local function add(name, selector, attr)
    if not selector then return end
    fields[name] = { selector = selector }
    if attr then fields[name].attr = attr end
  end
  add("url", config.result_url_selector, "href")
  add("title", config.result_title_selector)
  add("image_alt", config.result_image_selector, "alt")
  add("image_url", config.result_image_selector, "src")
  add("price_text", config.result_price_selector, config.result_price_attr)
  add("shipping_text", config.result_shipping_selector)
  add("rating_text", config.result_rating_selector)
  add("reviews_text", config.result_reviews_selector)
  add("condition", config.result_condition_selector)
  add("delivery_text", config.result_delivery_selector)
  if config.result_id_attr then fields.root_id = { attr = config.result_id_attr } end
  if config.result_url_from_root then fields.url = { attr = "href" } end
  return fields
end

local function candidate_from_row(config, row)
  local href = C.non_empty(row.url)
  local product_id = parse_product_id(config, href, row.root_id)
  local name = C.non_empty(row.image_alt) or C.non_empty(row.title)
  local row_text = C.non_empty(row.text) or ""
  local price_source = C.non_empty(row.price_text) or (config.price_from_text and row_text or nil)
  local price, currency = parse_candidate_price(price_source, config.default_currency, config.price_text_strategy)
  if not product_id or not name or not price or not currency then return nil end

  local shipping_source = C.non_empty(row.shipping_text)
  if not shipping_source and config.shipping_from_text then shipping_source = row_text end
  local shipping_cost, shipping_currency, shipping_text = parse_shipping(shipping_source, currency)
  local lowered = lower(row_text)

  return {
    product_id = product_id,
    id = product_id,
    name = name,
    url = product_url(config, product_id, href),
    image_url = C.non_empty(row.image_url),
    price = price,
    price_text = price_source,
    currency = currency,
    shipping_cost = shipping_cost,
    shipping_text = shipping_text,
    shipping_currency = shipping_currency,
    rating = parse_rating(row.rating_text),
    review_count = parse_review_count(row.reviews_text),
    condition = C.non_empty(row.condition),
    delivery_text = C.non_empty(row.delivery_text),
    sponsored = lowered:find("sponsored", 1, true) ~= nil or lowered:find("광고", 1, true) ~= nil,
    summary = #row_text > 320 and row_text:sub(1, 319) .. "…" or row_text
  }
end

local function read_candidates(config)
  local rows = dom.query_all(config.result_selector, result_fields(config), config.result_limit or 24)
  local candidates = C.array()
  local seen = {}
  for index = 1, #rows do
    local candidate = candidate_from_row(config, rows[index] or {})
    if candidate and not seen[candidate.product_id] then
      seen[candidate.product_id] = true
      candidates[#candidates + 1] = candidate
    end
  end
  return candidates
end

local function blocked_error(config)
  for index = 1, #(config.blocked_selectors or {}) do
    local blocked = config.blocked_selectors[index]
    if dom.exists(blocked.selector) then return blocked.error end
  end
  local body = #(config.blocked_text or {}) > 0 and lower(dom.get_text("body")) or ""
  for index = 1, #(config.blocked_text or {}) do
    local blocked = config.blocked_text[index]
    if body:find(lower(blocked.text), 1, true) then return blocked.error end
  end
  return nil
end

local function login_required(config)
  local href = lower(current_url())
  for index = 1, #(config.login_urls or {}) do
    if href:find(lower(config.login_urls[index]), 1, true) then return true end
  end
  return config.login_selector and dom.exists(config.login_selector) or false
end

local function result(config, query, ok, fields)
  local output = {
    ok = ok,
    site = config.site,
    query = query,
    candidates = C.array(),
    total_count = 0,
    cursor = false,
    url = current_url()
  }
  for key, value in pairs(fields or {}) do output[key] = value end
  return output
end

local function checkpoint_failure(config, query, failure)
  if type(failure) == "table" then
    return result(config, query, false, failure)
  end
  return result(config, query, false, { error = "durable_state_failed" })
end

function S.search(config, args)
  args = type(args) == "table" and args or {}
  local query = C.non_empty(args.query or args.regex)
  if not query then return result(config, nil, false, { error = "query_required" }) end

  local snapshot, open_error = D.open({ schema = 1, initial = {
    phase = "prepare",
    site = config.site,
    query = query,
    candidates = C.array(),
    total_count = 0,
    cursor = false
  }})
  if not snapshot then return checkpoint_failure(config, query, open_error) end
  if snapshot.value.site ~= config.site or snapshot.value.query ~= query then
    return result(config, query, false, { error = "search_checkpoint_mismatch" })
  end

  if snapshot.value.phase == "prepare" then
    local saved, save_error = D.save(snapshot, {
      phase = "navigation_armed",
      site = snapshot.value.site,
      query = snapshot.value.query,
      candidates = snapshot.value.candidates,
      total_count = snapshot.value.total_count,
      cursor = snapshot.value.cursor
    })
    if not saved then return checkpoint_failure(config, query, save_error) end
    snapshot = saved
  end

  if snapshot.value.phase == "navigation_armed" then
    local navigation = navigate_search(config, snapshot.value.query)
    if type(navigation) ~= "table" or navigation.ok ~= true then
      return result(config, query, false, navigation or { error = "search_navigation_failed" })
    end
    snapshot, open_error = D.open({ schema = 1 })
    if not snapshot then return checkpoint_failure(config, query, open_error) end
    if snapshot.value.site ~= config.site or snapshot.value.query ~= query then
      return result(config, query, false, { error = "search_checkpoint_mismatch" })
    end
    if snapshot.value.phase == "navigation_armed" then
      local saved, save_error = D.save(snapshot, {
        phase = "await_results",
        site = snapshot.value.site,
        query = snapshot.value.query,
        candidates = snapshot.value.candidates,
        total_count = snapshot.value.total_count,
        cursor = snapshot.value.cursor
      })
      if not saved then return checkpoint_failure(config, query, save_error) end
      snapshot = saved
    end
  end

  if snapshot.value.phase == "await_results" then
    local blocked = blocked_error(config)
    if blocked then return result(config, query, false, { error = blocked, blocked = true }) end
    if login_required(config) then
      return result(config, query, false, { error = "login_required", status = "login_required", login_required = true })
    end

    local waiting = dom.wait_for_selector(config.result_ready_selector or config.result_selector, {
      timeout = config.search_timeout or 15000
    })
    if type(waiting) == "table" and waiting.ok == false then
      return result(config, query, false, { error = waiting.error or "results_not_ready" })
    end

    blocked = blocked_error(config)
    if blocked then return result(config, query, false, { error = blocked, blocked = true }) end
    if login_required(config) then
      return result(config, query, false, { error = "login_required", status = "login_required", login_required = true })
    end
    if not dom.exists(config.result_ready_selector or config.result_selector) then
      return result(config, query, false, { error = "results_not_ready" })
    end

    local candidates = read_candidates(config)
    if #candidates == 0 then return result(config, query, false, { error = "no_results" }) end

    local saved, save_error = D.save(snapshot, {
      phase = "extracted",
      site = snapshot.value.site,
      query = snapshot.value.query,
      candidates = candidates,
      total_count = #candidates,
      cursor = false
    })
    if not saved then return checkpoint_failure(config, query, save_error) end
    snapshot = saved
  end

  if snapshot.value.phase ~= "extracted" then
    return result(config, query, false, { error = "unexpected_search_phase", phase = snapshot.value.phase })
  end

  return result(config, snapshot.value.query, true, {
    candidates = snapshot.value.candidates,
    total_count = snapshot.value.total_count,
    cursor = snapshot.value.cursor or false,
    phase = snapshot.value.phase,
    revision = snapshot.revision,
    operation = D.summary()
  })
end
