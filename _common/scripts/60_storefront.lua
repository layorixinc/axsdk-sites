local B = AX_BASE
if not B then
  error("_common/scripts/00_base.lua must be loaded before 60_storefront.lua")
end

AX_STOREFRONT = AX_STOREFRONT or {}
local S = AX_STOREFRONT
S.configs = S.configs or {}

local function array()
  if ax and type(ax.array) == "function" then return ax.array() end
  return {}
end

-- Result-page access. A site declares its paging shape in `config.pagination`; a site without that
-- block stays single-page rather than having a URL shape guessed for it.
function S.page_plan(config, page)
  if not AX_PAGINATION then
    error("_common/scripts/44_pagination.lua must be loaded before 60_storefront.lua")
  end
  return AX_PAGINATION.plan_page(type(config) == "table" and config.pagination or nil, page)
end

--- Whether another page is worth fetching. A probed-and-absent next control beats the row count,
--- which is only a hint: a full-looking page can still be the last one.
function S.has_more_from(count, next_page_supported, next_control_present)
  if next_page_supported ~= true then return false end
  if next_control_present == false then return false end
  return (tonumber(count) or 0) > 0
end

--- Probes the site's "next page" control when one is configured; nil means "not checked".
function S.next_control_present(config)
  local pagination = type(config) == "table" and config.pagination or nil
  local selector = pagination and pagination.next_selector
  if type(selector) ~= "string" or selector == "" then return nil end
  return dom.exists(selector) == true
end

local function clean(value)
  return B.clean_text(value)
end

local function non_empty(value)
  return B.non_empty(value)
end

local function lower(value)
  return clean(value):lower()
end

local function normalize_number(value)
  local text = tostring(value or ""):gsub(",", "")
  return tonumber(text)
end

local function amount_after(text, marker)
  local value = tostring(text or "")
  local start = value:find(marker, 1, true)
  if not start then return nil end
  local tail = value:sub(start + #marker)
  return normalize_number(tail:match("([%d][%d,]*%.?%d*)"))
end

-- A model code glued to the price ("… 블랙, M18519,400원") makes a naive digit run read 18,519,400.
-- An amount is only a price when it does not continue an alphanumeric token, so a match preceded by a
-- letter or digit is skipped. Korean characters are multi-byte, so a Hangul prefix never blocks a match.
function S.won_amount(value, pick_last)
  local text = tostring(value or "")
  local found = nil
  local cursor = 1
  while true do
    local start_at, end_at, amount = text:find("([%d][%d,]*%.?%d*)%s*원", cursor)
    if not start_at then break end
    local previous = start_at > 1 and text:sub(start_at - 1, start_at - 1) or ""
    if not previous:match("[%a%d]") then
      found = normalize_number(amount)
      if not pick_last then return found end
    end
    cursor = end_at + 1
  end
  return found
end

function S.parse_money(value, fallback_currency)
  local text = clean(value)
  if text == "" then return nil, non_empty(fallback_currency) end

  local amount = amount_after(text, "US$")
  if amount then return amount, "USD" end
  amount = amount_after(text, "USD")
  if amount then return amount, "USD" end
  amount = amount_after(text, "$")
  if amount then return amount, "USD" end
  amount = amount_after(text, "KRW")
  if amount then return amount, "KRW" end
  amount = amount_after(text, "₩")
  if amount then return amount, "KRW" end
  amount = amount_after(text, "EUR")
  if amount then return amount, "EUR" end
  amount = amount_after(text, "€")
  if amount then return amount, "EUR" end
  amount = amount_after(text, "GBP")
  if amount then return amount, "GBP" end
  amount = amount_after(text, "£")
  if amount then return amount, "GBP" end
  amount = amount_after(text, "JPY")
  if amount then return amount, "JPY" end
  amount = amount_after(text, "¥")
  if amount then return amount, "JPY" end

  local won = S.won_amount(text, false)
  if won then return won, "KRW" end

  local fallback = non_empty(fallback_currency)
  if not fallback then return nil, nil end
  local without_percentages = text:gsub("[%d,%.]+%%", "")
  -- Same boundary rule as the won matcher: a run that continues a token ("M18519400") is part of a
  -- model code, not an amount.
  local numeric = nil
  local cursor = 1
  while true do
    local start_at, end_at, candidate = without_percentages:find("([%d][%d,]*%.?%d*)", cursor)
    if not start_at then break end
    local previous = start_at > 1 and without_percentages:sub(start_at - 1, start_at - 1) or ""
    if not previous:match("%a") then
      numeric = candidate
      break
    end
    cursor = end_at + 1
  end
  return normalize_number(numeric), fallback:upper()
end

-- The sale price is the last amount BEFORE the row turns into shipping, reward-point, coupon, or
-- installment copy. Cutting only at "배송비" left "무료배송 … 최대 970원 적립" in scope and the reward
-- amount became the price, so every fragment that follows the price list is a cutoff marker.
S.PRICE_CUTOFF_MARKERS = {
  "배송비", "무료배송", "배송", "적립", "포인트", "쿠폰", "할부",
  "shipping", "delivery", "postage", "coupon", "cashback", "reward"
}

-- Some storefronts print the screen-reader form of the price glued to the human one
-- ("Now$4999current price Now $49.99"), and the same tile may also advertise a variant price
-- ("Options from $9.88"). Reading the first amount turned $49.99 into 4999 — a 100x error. The site's
-- own "current price" marker decides; when several amounts appear with nothing to distinguish them the
-- price is REFUSED, because a wrong number in a price comparison is worse than a missing row.
function S.amounts_in(value)
  local text = clean(value)
  local found = {}
  local cursor = 1
  while true do
    local start_at, end_at, amount = text:find("([%d][%d,]*%.?%d*)", cursor)
    if not start_at then break end
    local previous = start_at > 1 and text:sub(start_at - 1, start_at - 1) or ""
    if not previous:match("[%a%d]") then found[#found + 1] = normalize_number(amount) end
    cursor = end_at + 1
  end
  return found
end

function S.parse_candidate_price(value, fallback_currency, strategy)
  if strategy == "decimal_preferred" then
    local text = clean(value)
    local _, currency = S.parse_money(text, fallback_currency)
    local marker = nil
    local cursor = 1
    while true do
      local position = lower(text):find("current price", cursor, true)
      if not position then break end
      marker = position
      cursor = position + 1
    end
    if marker then
      return S.parse_money(text:sub(marker), fallback_currency)
    end
    local amounts = S.amounts_in(text)
    if #amounts == 1 then return amounts[1], currency or non_empty(fallback_currency) end
    return nil, currency or non_empty(fallback_currency)
  end
  if strategy ~= "last_before_shipping" then return S.parse_money(value, fallback_currency) end
  local text = clean(value)
  local cutoff = #text + 1
  local lowered = lower(text)
  for _, marker in ipairs(S.PRICE_CUTOFF_MARKERS) do
    local position = lowered:find(marker, 1, true)
    if position and position < cutoff then cutoff = position end
  end
  local price_text = text:sub(1, cutoff - 1)
  local last_won = S.won_amount(price_text, true)
  if last_won then return last_won, "KRW" end
  return S.parse_money(price_text, fallback_currency)
end

function S.parse_shipping(value, fallback_currency)
  local text = non_empty(value)
  local fallback = non_empty(fallback_currency)
  if not text then return nil, fallback, nil end
  local lowered = lower(text)
  local first = nil
  local function consider(position)
    if position and (not first or position < first) then first = position end
  end
  consider(lowered:find("shipping", 1, true))
  consider(lowered:find("delivery", 1, true))
  consider(lowered:find("postage", 1, true))
  consider(lowered:find("배송비", 1, true))

  if first then
    local paid_fragment = text:sub(first, first + 60)
    local paid_amount, paid_currency = S.parse_money(paid_fragment, fallback)
    if paid_amount and paid_amount > 0 then return paid_amount, paid_currency or fallback, paid_fragment end
  end

  if lowered:find("free shipping", 1, true)
      or lowered:find("free delivery", 1, true)
      or lowered:find("free postage", 1, true)
      or lowered:find("shipping: free", 1, true)
      or lowered:find("무료배송", 1, true)
      or lowered:find("무료 배송", 1, true)
      or lowered:find("배송비 무료", 1, true) then
    return 0, fallback, text
  end
  if not first then return nil, fallback, text end
  local fragment = text:sub(first)
  local amount, currency = S.parse_money(fragment, fallback)
  return amount, currency or fallback, fragment
end

function S.parse_rating(value)
  local text = clean(value)
  local rating = tonumber(text:match("(%d+%.%d+)")) or tonumber(text:match("(%d+)%s*/%s*5"))
  if rating and rating >= 0 and rating <= 5 then return rating end
  return nil
end

function S.parse_review_count(value)
  local text = clean(value):gsub(",", "")
  local thousands = tonumber(text:match("(%d+%.?%d*)[Kk]"))
  if thousands then return math.floor(thousands * 1000) end
  local man = tonumber(text:match("(%d+%.?%d*)만"))
  if man then return math.floor(man * 10000) end
  local parenthesized = text:match("%((%d+)%)")
  return tonumber(parenthesized or text:match("(%d+)"))
end

local function host_matches(config, url)
  local host = tostring(url or ""):match("^https?://([^/]+)") or ""
  host = host:lower()
  for index = 1, #(config.hosts or {}) do
    local suffix = tostring(config.hosts[index]):lower():gsub("^%.", "")
    if host == suffix or host:sub(-(#suffix + 1)) == "." .. suffix then return true end
  end
  return false
end

local function current_url()
  return non_empty(dom.get_location_href()) or ""
end

local function encoded_query_matches(actual, query)
  if not actual then return false end
  local normalized = tostring(actual):gsub("%+", "%%20"):lower()
  return normalized == B.url_encode(query):lower()
end

local function page_param_matches(config, href, page)
  local plan = S.page_plan(config, page)
  if not plan.supported then return page <= 1 end
  for key, value in pairs(plan.params) do
    if tostring(B.url_query_param(href, key) or "") ~= tostring(value) then return false end
  end
  -- Page one is the bare search URL, so the paging parameter is legitimately absent there.
  if page <= 1 and config.pagination and config.pagination.param then
    local actual = tonumber(B.url_query_param(href, config.pagination.param))
    local first = tonumber(config.pagination.start) or (config.pagination.mode == "offset" and 0 or 1)
    if actual and actual ~= first then return false end
  end
  return true
end

local function current_search_matches(config, query, page)
  local href = current_url()
  if not host_matches(config, href) then return false end
  if config.search_path_marker and not href:find(config.search_path_marker, 1, true) then return false end
  if not page_param_matches(config, href, page or 1) then return false end
  if config.search_param then
    local actual = B.url_query_param(href, config.search_param)
    if actual then return encoded_query_matches(actual, query) end
  end
  if config.search_input_selector then
    local value = non_empty(dom.get_attr(config.search_input_selector, "value"))
    if value then return lower(value) == lower(query) end
  end
  if config.search_path_prefix then
    local slug = B.url_encode(query):gsub("%%20", "-"):lower()
    return href:lower():find(slug, 1, true) ~= nil
  end
  return false
end

local function search_target(config, query)
  if config.search_path_prefix then
    return config.search_path_prefix .. B.url_encode(query):gsub("%%20", "-") .. (config.search_path_suffix or "")
  end
  return config.search_url
end

local function navigate_search(config, query, page)
  if current_search_matches(config, query, page) then return false end
  if nav and type(nav.clear_beforeunload) == "function" then nav.clear_beforeunload() end
  local params = {}
  if config.search_param then params[config.search_param] = query end
  for key, value in pairs(config.search_extra or {}) do params[key] = value end
  for key, value in pairs(S.page_plan(config, page).params or {}) do params[key] = value end
  nav.navigate(search_target(config, query), params, { reload = true })
  return true
end

--- The id a result card carries, from its link or from the attribute the site hides it in.
--- `attr_value` is whatever `result_id_selector`/`result_id_attr` read; it may be a bare id or a JSON
--- blob. Patterns are tried against BOTH sources, and a structured value no pattern understands yields
--- nothing: mining a first token out of `{"content_type":"PRODUCT","content_no":"917…"}` gave every card
--- on the page the id "content_type", the dedupe then collapsed the grid to a single row, and a store
--- full of listings reported no_results.
function S.product_id_from(config, url, attr_value)
  local function by_pattern(text)
    for index = 1, #((config and config.product_id_patterns) or {}) do
      local product_id = text:match(config.product_id_patterns[index])
      if product_id then return product_id end
    end
    return nil
  end

  local direct = non_empty(attr_value)
  if direct then
    local matched = by_pattern(direct)
    if matched then return matched end
    if not direct:find("[{}\"]") then
      local token = direct:match("([%w_-]+)")
      if token then return token end
    end
  end

  local text = non_empty(url)
  return text and by_pattern(text) or nil
end

local function parse_product_id(config, value, fallback)
  return S.product_id_from(config, value, fallback)
end

local function product_url(config, product_id, href)
  if config.product_url_prefix then
    return config.product_url_prefix .. tostring(product_id) .. (config.product_url_suffix or "")
  end
  local value = non_empty(href)
  return value and value:gsub("#.*$", "") or nil
end

local function first_text(selectors)
  for index = 1, #(selectors or {}) do
    local value = non_empty(dom.get_text(selectors[index]))
    if value then return value end
  end
  return nil
end

local function first_existing(selectors)
  for index = 1, #(selectors or {}) do
    if dom.exists(selectors[index]) then return selectors[index] end
  end
  return nil
end

local function blocked_error(config)
  for index = 1, #(config.blocked_selectors or {}) do
    local item = config.blocked_selectors[index]
    if dom.exists(item.selector) then return item.error end
  end
  local body = lower(dom.get_text("body"))
  for index = 1, #(config.blocked_text or {}) do
    local item = config.blocked_text[index]
    if body:find(lower(item.text), 1, true) then return item.error end
  end
  local href = current_url():lower()
  for index = 1, #(config.blocked_urls or {}) do
    local item = config.blocked_urls[index]
    if href:find(lower(item.text), 1, true) then return item.error end
  end
  return nil
end

local function login_required(config)
  local href = current_url():lower()
  for index = 1, #(config.login_urls or {}) do
    if href:find(lower(config.login_urls[index]), 1, true) then return true end
  end
  return config.login_selector and dom.exists(config.login_selector) or false
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
  add("brand", config.result_brand_selector)
  add("manufacturer_model", config.result_model_selector)
  add("image_url", config.result_image_selector, "src")
  add("price_text", config.result_price_selector)
  add("shipping_text", config.result_shipping_selector)
  add("rating_text", config.result_rating_selector)
  add("reviews_text", config.result_reviews_selector)
  add("condition", config.result_condition_selector)
  add("delivery_text", config.result_delivery_selector)
  add("return_terms", config.result_return_selector)
  -- The id attribute may sit on the row itself or on an element inside it (11st keeps it on the card's
  -- anchor, whose href is an ad-server redirect), so a selector is optional next to the attribute name.
  if config.result_id_attr or config.result_id_selector then
    fields.root_id = { attr = config.result_id_attr or "id" }
    if config.result_id_selector then fields.root_id.selector = config.result_id_selector end
  end
  if config.result_url_from_root then fields.url = { attr = "href" } end
  return fields
end

local function candidate_from_row(config, row)
  local href = non_empty(row.url)
  local product_id = parse_product_id(config, href, row.root_id)
  local name = non_empty(row.image_alt) or non_empty(row.title)
  local row_text = non_empty(row.text) or ""
  local price_source = non_empty(row.price_text) or (config.price_from_text and row_text or nil)
  local price, currency = S.parse_candidate_price(price_source, config.default_currency, config.price_text_strategy)
  if not product_id or not name or not price or not currency then return nil end

  local shipping_source = non_empty(row.shipping_text)
  if not shipping_source and config.shipping_from_text then shipping_source = row_text end
  local shipping_cost, shipping_currency, shipping_text = S.parse_shipping(shipping_source, currency)
  local lowered = lower(row_text)
  local sponsored = lowered:find("sponsored", 1, true) ~= nil
    or lowered:find("광고", 1, true) ~= nil
  local return_terms = non_empty(row.return_terms)
  if not return_terms and (lowered:find("free returns", 1, true) or lowered:find("무료 반품", 1, true)) then
    return_terms = lowered:find("무료 반품", 1, true) and "무료 반품" or "Free returns"
  end

  return {
    product_id = product_id,
    id = product_id,
    name = name,
    brand = non_empty(row.brand),
    manufacturer_model = non_empty(row.manufacturer_model),
    url = product_url(config, product_id, href),
    image_url = non_empty(row.image_url),
    price = price,
    price_text = price_source,
    currency = currency,
    shipping_cost = shipping_cost,
    shipping_text = shipping_text,
    shipping_currency = shipping_currency,
    rating = S.parse_rating(row.rating_text),
    review_count = S.parse_review_count(row.reviews_text),
    condition = non_empty(row.condition),
    delivery_text = non_empty(row.delivery_text),
    return_terms = return_terms,
    sponsored = sponsored,
    summary = (#row_text > 320) and (row_text:sub(1, 319) .. "…") or row_text
  }
end
local function json_text(value)
  local text = non_empty(value)
  if not text then return nil end
  return text:gsub("\\/", "/"):gsub('\\"', '"'):gsub("\\n", " "):gsub("\\r", " "):gsub("\\t", " ")
end

local function json_string_field(chunk, name)
  return json_text(chunk:match('"' .. name .. '"%s*:%s*"(.-)"'))
end

-- Some storefronts render their result grid from a hydration payload and give the DOM only
-- build-generated class names. Reading the payload keeps those sites selector-stable, but the field
-- names belong to the site, not to this module: each config supplies the item key and an ordered list
-- of candidate keys per field so a site-side rename never silently empties the result set.
local DEFAULT_EMBEDDED_FIELDS = {
  url = { "itemUrl", "itemDetailLink" },
  title = { "itemName" },
  image_alt = { "itemName" },
  brand = { "brandName" },
  image_url = { "itemImgUrl" },
  price_text = { "finalPrice" },
  rating_text = { "reviewScore" },
  reviews_text = { "reviewCount" }
}

local function embedded_field(chunk, keys)
  for index = 1, #(keys or {}) do
    local value = json_string_field(chunk, keys[index])
    if value then return value end
  end
  return nil
end

local function read_embedded_candidates(config)
  local payload = non_empty(config.embedded_json_selector and dom.get_text(config.embedded_json_selector))
  local candidates = array()
  if not payload then return candidates end

  local item_key = config.embedded_item_key or "itemId"
  local fields = config.embedded_fields or DEFAULT_EMBEDDED_FIELDS
  local shipping_block_key = config.embedded_shipping_block or "shippingCostInfo"
  local shipping_keys = config.embedded_shipping_fields or { "text" }
  local pattern = '"' .. item_key .. '"%s*:%s*"([^"]+)"'
  local cursor = 1
  local seen = {}
  local limit = config.result_limit or 24
  while #candidates < limit do
    local item_start, item_end, product_id = payload:find(pattern, cursor)
    if not item_start then break end
    local next_start = payload:find('"' .. item_key .. '"%s*:%s*"', item_end + 1) or (#payload + 1)
    local chunk = payload:sub(item_start, next_start - 1)
    local shipping_block = chunk:match('"' .. shipping_block_key .. '"%s*:%s*(%b[])')
      or chunk:match('"' .. shipping_block_key .. '"%s*:%s*(%b{})')
      or ""
    local row = {
      root_id = product_id,
      url = embedded_field(chunk, fields.url),
      title = embedded_field(chunk, fields.title),
      image_alt = embedded_field(chunk, fields.image_alt),
      brand = embedded_field(chunk, fields.brand),
      image_url = embedded_field(chunk, fields.image_url),
      price_text = embedded_field(chunk, fields.price_text),
      -- A payload states shipping either as a nested block ("shippingCostInfo":[{…}]) or as a scalar
      -- fee on the record itself ("dlvryFee":"0"); a configured field name always wins.
      shipping_text = embedded_field(chunk, fields.shipping_text) or embedded_field(shipping_block, shipping_keys),
      rating_text = embedded_field(chunk, fields.rating_text),
      reviews_text = embedded_field(chunk, fields.reviews_text)
    }
    local candidate = candidate_from_row(config, row)
    if candidate and not seen[candidate.product_id] then
      seen[candidate.product_id] = true
      candidates[#candidates + 1] = candidate
    end
    cursor = next_start
  end
  return candidates
end


--- Why a read produced nothing: a grid full of cards nobody could price is a different fact from an
--- empty grid, and reporting it as "no results" made the store look like it does not sell the product.
function S.read_outcome(cards_seen, kept)
  if (tonumber(kept) or 0) > 0 then return nil end
  if (tonumber(cards_seen) or 0) > 0 then return "price_unavailable" end
  return "no_results"
end

local function read_candidates(config)
  -- A hydration payload carries one clean record per product; the rendered grid repeats wrappers per
  -- card and mixes ad chrome into the row text, so a site that exposes the payload reads it first and
  -- keeps the DOM pass as the fallback.
  if config.prefer_embedded and config.embedded_json_selector then
    local embedded = read_embedded_candidates(config)
    if #embedded > 0 then return embedded, #embedded end
  end
  local rows = dom.query_all(config.result_selector, result_fields(config), config.result_limit or 24)
  local candidates = array()
  local seen = {}
  for index = 1, #rows do
    local candidate = candidate_from_row(config, rows[index] or {})
    if candidate and not seen[candidate.product_id] then
      seen[candidate.product_id] = true
      candidates[#candidates + 1] = candidate
    end
  end
  if #candidates == 0 and config.embedded_json_selector then
    local embedded = read_embedded_candidates(config)
    return embedded, math.max(#rows, #embedded)
  end
  return candidates, #rows
end

local function search(config, args)
  args = args or {}
  local query = non_empty(args.query or args.regex)
  if not query then return { site = config.site, error = "missing_query", candidates = array() } end
  local page = math.max(1, math.floor(tonumber(args.page) or 1))
  local plan = S.page_plan(config, page)
  if not plan.supported then
    return { site = config.site, query = query, page = page, error = plan.error, candidates = array(), has_more = false }
  end

  if navigate_search(config, query, page) then
    return { site = config.site, query = query, page = page, status = "navigating", candidates = array() }
  end
  dom.wait_for_selector("body", { timeout = config.search_timeout or 10000 })
  local blocked = blocked_error(config)
  if blocked then return { site = config.site, page = page, error = blocked, blocked = true, candidates = array(), url = current_url() } end
  if login_required(config) then
    return { site = config.site, page = page, status = "login_required", login_required = true, candidates = array(), url = current_url() }
  end

  dom.wait_for_selector(config.result_ready_selector or config.result_selector, { timeout = config.search_timeout or 10000 })
  blocked = blocked_error(config)
  if blocked then return { site = config.site, page = page, error = blocked, blocked = true, candidates = array(), url = current_url() } end

  local candidates, cards_seen = read_candidates(config)
  local outcome = S.read_outcome(cards_seen, #candidates)
  if outcome then
    return {
      site = config.site, query = query, page = page, error = outcome,
      cards_seen = cards_seen, candidates = candidates, has_more = false, url = current_url()
    }
  end
  local has_more = S.has_more_from(#candidates, S.page_plan(config, page + 1).supported, S.next_control_present(config))
  return {
    site = config.site,
    query = query,
    page = page,
    total_count = #candidates,
    candidates = candidates,
    has_more = has_more,
    pagination_supported = S.page_plan(config, 2).supported,
    cursor = false
  }
end

local function product_page_matches(config, product_id)
  return parse_product_id(config, current_url()) == tostring(product_id)
    and first_existing(config.product_title_selectors or {}) ~= nil
end

local function navigate_product(config, product_id)
  if product_page_matches(config, product_id) then return false end
  if nav and type(nav.clear_beforeunload) == "function" then nav.clear_beforeunload() end
  nav.navigate(product_url(config, product_id), {}, { reload = true })
  return true
end

local function cart_page(config)
  local href = current_url()
  for index = 1, #(config.cart_url_markers or {}) do
    if href:find(config.cart_url_markers[index], 1, true) then return true end
  end
  return false
end

local function cart_contains(config, product_id)
  if config.confirmation_selector and dom.exists(config.confirmation_selector) then return true end
  if not cart_page(config) then return false end
  local id = tostring(product_id or ""):gsub('["\\]', "")
  if id == "" then return false end
  local selector = 'a[href*="' .. id .. '"], [data-product-id="' .. id .. '"], [data-item-id="' .. id .. '"]'
  return dom.exists(selector)
end

local function validate_product_identity(config, args, product_id)
  local expected_model = non_empty(args.expected_identity_model)
  if not expected_model then return nil end
  local title = first_text(config.product_title_selectors or {})
  if not title then
    return {
      product_id = product_id,
      added = false,
      error = "identity_revalidation_failed",
      expected_identity_model = expected_model
    }
  end
  local observed = lower(title):gsub("[^%w]+", "")
  local expected = lower(expected_model):gsub("[^%w]+", "")
  if expected == "" or not observed:find(expected, 1, true) then
    return {
      product_id = product_id,
      added = false,
      error = "identity_changed",
      expected_identity_model = expected_model,
      current_product_title = title
    }
  end
  return nil
end

local function validate_product_price(config, args, product_id)
  local expected_price = tonumber(args.expected_unit_price)
  local expected_currency = non_empty(args.expected_currency)
  if not expected_price and not expected_currency then return nil end

  local price_text = first_text(config.product_price_selectors or {})
  local current_price, current_currency = S.parse_money(price_text, config.default_currency)
  if not current_price or not current_currency then
    return { product_id = product_id, added = false, error = "price_revalidation_failed", current_price_text = price_text }
  end
  if expected_currency and current_currency:upper() ~= expected_currency:upper() then
    return {
      product_id = product_id,
      added = false,
      error = "currency_changed",
      expected_currency = expected_currency:upper(),
      current_currency = current_currency:upper(),
      current_price = current_price,
      current_price_text = price_text
    }
  end
  if expected_price and current_price > expected_price + 0.005 then
    return {
      product_id = product_id,
      added = false,
      error = "price_changed",
      expected_unit_price = expected_price,
      current_price = current_price,
      current_currency = current_currency,
      current_price_text = price_text
    }
  end
  return nil
end

local function add_to_cart(config, args)
  args = args or {}
  local product_id = parse_product_id(config, args.product_id or args.id, args.product_id or args.id)
  if not product_id then return { site = config.site, added = false, error = "missing_product_id" } end
  if config.cart_supported == false then
    return { site = config.site, product_id = product_id, added = false, error = "add_to_cart_unsupported" }
  end

  local confirmed = cart_contains(config, product_id)
  if not confirmed and not login_required(config) and not blocked_error(config) then
    if navigate_product(config, product_id) then
      return { site = config.site, product_id = product_id, added = false, pending = true, status = "navigating" }
    end
    dom.wait_for_selector("body", { timeout = config.product_timeout or 10000 })
    local blocked = blocked_error(config)
    if blocked then return { site = config.site, product_id = product_id, added = false, error = blocked, blocked = true } end
    if login_required(config) then
      return { site = config.site, product_id = product_id, added = false, status = "login_required", login_required = true }
    end
    if not product_page_matches(config, product_id) then
      return { site = config.site, product_id = product_id, added = false, error = "product_navigation_failed" }
    end

    local identity_error = validate_product_identity(config, args, product_id)
    if identity_error then identity_error.site = config.site; return identity_error end

    local stale = validate_product_price(config, args, product_id)
    if stale then stale.site = config.site; return stale end

    for index = 1, #(config.required_option_selectors or {}) do
      local selector = config.required_option_selectors[index]
      if dom.exists(selector) and not non_empty(dom.get_attr(selector, "value")) then
        return { site = config.site, product_id = product_id, added = false, error = "variation_required" }
      end
    end

    local quantity = math.max(1, math.floor(tonumber(args.quantity) or 1))
    if quantity > 1 then
      local quantity_selector = first_existing(config.quantity_selectors or {})
      if not quantity_selector then
        return { site = config.site, product_id = product_id, added = false, error = "quantity_unavailable" }
      end
      dom.set_value(quantity_selector, tostring(quantity))
    end

    local add_selector = first_existing(config.add_selectors or {})
    if not add_selector then
      return { site = config.site, product_id = product_id, added = false, error = "add_to_cart_unavailable" }
    end
    if dom.click(add_selector) ~= true then
      return { site = config.site, product_id = product_id, added = false, error = "click_failed" }
    end

    if config.add_ready_selector then
      dom.wait_for_selector(config.add_ready_selector, { timeout = config.product_timeout or 10000 })
    end
    confirmed = cart_contains(config, product_id)
    if not confirmed and config.cart_url then
      if nav and type(nav.clear_beforeunload) == "function" then nav.clear_beforeunload() end
      nav.navigate(config.cart_url, {}, { reload = true })
      return { site = config.site, product_id = product_id, added = false, pending = true, status = "navigating" }
    end
  end

  local blocked = blocked_error(config)
  if blocked then return { site = config.site, product_id = product_id, added = false, error = blocked, blocked = true } end
  if login_required(config) then
    return { site = config.site, product_id = product_id, added = false, status = "login_required", login_required = true }
  end
  confirmed = confirmed or cart_contains(config, product_id)
  local add_error = nil
  if not confirmed then add_error = "add_to_cart_pending" end
  return {
    site = config.site,
    product_id = product_id,
    added = confirmed,
    pending = not confirmed,
    error = add_error,
    confirmation = confirmed and (first_text(config.confirmation_text_selectors or {}) or "Added to cart") or nil,
    cart_url = confirmed and current_url() or nil
  }
end

S.search = search
S.add_to_cart = add_to_cart

function S.register(config)
  if type(config) ~= "table" or not non_empty(config.site) then return false end
  config.site = lower(config.site)
  S.configs[config.site] = config
  AX_STOREFRONT_CONFIG = config

  if AX_COMMERCE and type(AX_COMMERCE.register_adapter) == "function" then
    AX_COMMERCE.register_adapter(config.site, {
      home_url = config.home_url,
      host_matches = function(url) return host_matches(config, url) end,
      search = function(args) return search(config, args) end,
      add_to_cart = function(args) return add_to_cart(config, args) end
    })
  end
  return true
end
