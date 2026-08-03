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
  -- A title selector is often a CSS LIST and the browser answers with the first match in document
  -- order. On 11st that is the image, whose textContent is empty; the alt carries the name. Live, not
  -- asking for it turned 24 cards into zero candidates.
  add("image_alt", config.result_image_selector, "alt")
  add("image_url", config.result_image_selector, "src")
  add("brand", config.result_brand_selector)
  add("manufacturer_model", config.result_model_selector)
  add("price_text", config.result_price_selector)
  add("shipping_text", config.result_shipping_selector)
  add("rating_text", config.result_rating_selector)
  add("reviews_text", config.result_reviews_selector)
  add("condition", config.result_condition_selector)
  add("delivery_text", config.result_delivery_selector)
  add("return_terms", config.result_return_selector)
  -- The id attribute may sit on the row itself or on an element inside it: 11st keeps it on the card's
  -- anchor, whose href is an ad-server redirect carrying no product id at all.
  if config.result_id_attr or config.result_id_selector then
    fields.root_id = { attr = config.result_id_attr or "id" }
    if config.result_id_selector then fields.root_id.selector = config.result_id_selector end
  end
  return fields
end

--- The amount and the currency the text itself states. A symbol in the text beats the site default:
--- ranking 13,190 KRW against 13.95 USD as if both were the base was a real defect, and the store that
--- looked cheapest was simply quoted in a smaller unit.
local CURRENCY_MARKS = {
  { "US$", "USD" }, { "USD", "USD" }, { "$", "USD" },
  { "KRW", "KRW" }, { "₩", "KRW" }, { "원", "KRW" },
  { "EUR", "EUR" }, { "€", "EUR" },
  { "GBP", "GBP" }, { "£", "GBP" },
  { "JPY", "JPY" }, { "¥", "JPY" },
}

local function amount_in(text)
  local raw = tostring(text or ""):gsub(",", "")
  return tonumber(raw:match("%d+%.?%d*"))
end

local function parse_money(text, fallback_currency)
  local value = non_empty(text)
  if not value then return nil, non_empty(fallback_currency) end
  for index = 1, #CURRENCY_MARKS do
    local mark, code = CURRENCY_MARKS[index][1], CURRENCY_MARKS[index][2]
    if value:find(mark, 1, true) then
      local amount = amount_in(value)
      if amount then return amount, code end
    end
  end
  return amount_in(value), non_empty(fallback_currency)
end

local function parse_price(text)
  return (amount_in(text))
end

local SHIPPING_WORDS = { "shipping", "delivery", "postage", "배송비", "배송료" }
local FREE_PHRASES = { "free shipping", "free delivery", "free postage", "shipping: free",
  "무료배송", "무료 배송", "배송비 무료" }

--- The shipping figure a row states, or nil when it states none.
---
--- nil and 0 are different answers and the comparison ranks on the difference: 무료배송 is zero, and a
--- row that simply never mentions shipping has an UNKNOWN total. Reading the second as the first makes
--- a store the cheapest on the page for free.
--- `from_row_text` says the source is the card's whole concatenated text rather than a field the site
--- set aside for shipping. There a bare number next to a delivery word is not a fee: live on 11st a card
--- came back with a 4.7 KRW delivery charge, which was its seller rating sitting inside the window. So
--- the row text must state a currency; a dedicated field may state a bare number.
local function parse_shipping(text, fallback_currency, from_row_text)
  local value = non_empty(text)
  if not value then return nil, non_empty(fallback_currency) end
  local lowered = value:lower()

  for index = 1, #FREE_PHRASES do
    if lowered:find(FREE_PHRASES[index], 1, true) then return 0, non_empty(fallback_currency) end
  end

  local first = nil
  for index = 1, #SHIPPING_WORDS do
    local at = lowered:find(SHIPPING_WORDS[index], 1, true)
    if at and (not first or at < first) then first = at end
  end
  -- A number with no shipping word near it is a reward point, a rating count, anything.
  if not first then return nil, non_empty(fallback_currency) end

  local fragment = value:sub(first, first + 60)
  if from_row_text then
    local marked = false
    for index = 1, #CURRENCY_MARKS do
      if fragment:find(CURRENCY_MARKS[index][1], 1, true) then marked = true break end
    end
    if not marked then return nil, non_empty(fallback_currency) end
  end

  local amount, currency = parse_money(fragment, fallback_currency)
  if not amount then return nil, non_empty(fallback_currency) end
  return amount, currency
end

--- The id a card carries, from its link or from the attribute the site hides it in. Patterns are tried
--- against BOTH sources.
---
--- A structured value no pattern understands yields NOTHING. Mining a first token out of
--- `{"content_type":"PRODUCT","content_no":"917…"}` gave every card on the page the id `content_type`;
--- the dedupe then collapsed 156 cards into one and a store full of listings reported almost nothing.
local function product_id(config, href, attr_value)
  local patterns = config.product_id_patterns or {}
  local function by_pattern(text)
    for index = 1, #patterns do
      local id = text:match(patterns[index])
      if id then return id end
    end
    return nil
  end

  local direct = non_empty(attr_value)
  if direct then
    local matched = by_pattern(direct)
    if matched then return matched end
    -- A bare id is usable; anything with JSON punctuation in it is a structure we did not parse.
    if not direct:find('[{}"]') then
      local token = direct:match("([%w_-]+)")
      if token then return token end
    end
  end

  local text = non_empty(href)
  return text and by_pattern(text) or nil
end

--- Turns one read row into a candidate, or nil when it cannot be compared. A row without an id or a
--- price is dropped rather than guessed: a wrong number in a price comparison is worse than a missing row.
local function candidate_from(config, row)
  local href = non_empty(row.url)
  local id = product_id(config, href, row.root_id)
  local name = non_empty(row.title) or non_empty(row.image_alt)
  local row_text = non_empty(row.text)

  -- Several adapters put no price in a field of its own and declare `price_from_text` instead; the same
  -- holds for shipping on six of the eight. Mining the row text WITHOUT that declaration would read a
  -- reward-point figure as a delivery fee.
  local price_source = non_empty(row.price_text) or (config.price_from_text and row_text or nil)
  local price, currency = parse_money(price_source, config.default_currency)
  if not id or not name or not price then return nil end

  local shipping_field = non_empty(row.shipping_text)
  local shipping_source = shipping_field or (config.shipping_from_text and row_text or nil)
  local shipping_cost, shipping_currency =
    parse_shipping(shipping_source, currency, shipping_field == nil)

  return {
    site = config.site,
    product_id = id,
    id = id,
    name = name,
    price = price,
    price_text = non_empty(row.price_text),
    currency = currency or config.default_currency,
    shipping_cost = shipping_cost,
    shipping_currency = shipping_currency,
    url = (config.product_url_prefix and (config.product_url_prefix .. id)) or href,
    image_url = non_empty(row.image_url),
    -- The comparison ranks on these. A row that reaches it without a shipping figure has no known
    -- total and is folded out of the default window, so dropping them here empties the window that the
    -- user actually reads.
    brand = non_empty(row.brand),
    manufacturer_model = non_empty(row.manufacturer_model),
    shipping_text = non_empty(row.shipping_text),
    rating_text = non_empty(row.rating_text),
    reviews_text = non_empty(row.reviews_text),
    condition = non_empty(row.condition),
    delivery_text = non_empty(row.delivery_text),
    return_terms = non_empty(row.return_terms),
  }
end

local DEFAULT_EMBEDDED_FIELDS = {
  url = { "itemUrl", "itemDetailLink" },
  title = { "itemName" },
  image_alt = { "itemName" },
  price_text = { "finalPrice" },
  rating_text = { "reviewScore" },
}

local function json_text(value)
  local text = non_empty(value)
  if not text then return nil end
  return (text:gsub("\\/", "/"):gsub('\\"', '"'):gsub("\\n", " "):gsub("\\r", " "):gsub("\\t", " "))
end

--- The raw value of a JSON string field, honouring escapes.
---
--- A lazy `"(.-)"` match stops at the first quote it sees, including an escaped one, so a title like
--- `27\" 모니터` arrives as `27\` — a truncation that looks like a short product name rather than a
--- parsing bug. Scanning for the first UNESCAPED quote costs a loop and gets the whole value.
local function json_raw(chunk, name)
  local _, open = chunk:find('"' .. name .. '"%s*:%s*"')
  if not open then return nil end
  local index = open + 1
  while index <= #chunk do
    local char = chunk:sub(index, index)
    if char == "\\" then
      index = index + 2
    elseif char == '"' then
      return chunk:sub(open + 1, index - 1)
    else
      index = index + 1
    end
  end
  return nil
end

local function json_field(chunk, keys)
  for index = 1, #(keys or {}) do
    local value = json_text(json_raw(chunk, keys[index]))
    if value then return value end
  end
  return nil
end

--- The nested object or array a payload keeps its delivery information in, cut from ONE record's chunk.
--- `%b` matches balanced delimiters, so a block containing further objects comes back whole.
local function shipping_block(config, chunk)
  local key = config.embedded_shipping_block or "shippingCostInfo"
  return chunk:match('"' .. key .. '"%s*:%s*(%b[])')
    or chunk:match('"' .. key .. '"%s*:%s*(%b{})')
    or ""
end

--- Rows from a hydration payload. Some storefronts render the grid from one and leave the DOM with
--- build-generated class names only; the payload carries one clean record per product.
---
--- Each record is cut at the NEXT occurrence of the item key before any field is read. Searching the
--- whole payload for a field would let a record with no price inherit its neighbour's — a real product
--- shown at somebody else's number, which is worse than dropping the row. The key and the field names
--- come from the site config, so a site-side rename empties the result instead of silently mismatching.
local function read_embedded(config)
  local selector = config.embedded_json_selector
  -- Ask whether the payload is there before reading it: a missing element is an op FAILURE on this
  -- channel, and a store that simply does not ship a payload must fall through to the grid, not raise.
  local payload = (selector and dom.exists(selector)) and non_empty(dom.get_text(selector)) or nil
  local candidates = array({})
  if not payload then return candidates end

  local item_key = config.embedded_item_key or "itemId"
  local fields = config.embedded_fields or DEFAULT_EMBEDDED_FIELDS
  local pattern = '"' .. item_key .. '"%s*:%s*"([^"]+)"'
  local limit = config.result_limit or 24
  local cursor, seen = 1, {}

  while #candidates < limit do
    -- The item-key match CAPTURES the id. Discarding it left the row hunting for an id in `itemUrl`,
    -- which ssg does not put one in: a payload naming every product produced an empty store.
    local item_start, item_end, item_id = payload:find(pattern, cursor)
    if not item_start then break end
    local next_start = payload:find('"' .. item_key .. '"%s*:%s*"', item_end + 1) or (#payload + 1)
    local chunk = payload:sub(item_start, next_start - 1)
    local candidate = candidate_from(config, {
      root_id = item_id,
      url = json_field(chunk, fields.url),
      title = json_field(chunk, fields.title),
      image_alt = json_field(chunk, fields.image_alt),
      price_text = json_field(chunk, fields.price_text),
      -- A payload states shipping either as a scalar on the record ("dlvryFee":"0") or as a nested
      -- block ("shippingCostInfo":[{"text":"무료배송"}]). A configured field name always wins; the
      -- block is cut from THIS record's chunk, so a record without one cannot borrow its neighbour's.
      shipping_text = json_field(chunk, fields.shipping_text)
        or json_field(shipping_block(config, chunk), config.embedded_shipping_fields or { "text" }),
      rating_text = json_field(chunk, fields.rating_text),
    })
    if candidate and not seen[candidate.product_id] then
      seen[candidate.product_id] = true
      candidates[#candidates + 1] = candidate
    end
    cursor = next_start
  end
  return candidates
end

--- Where the reader actually is, when that is not a result page. An empty grid and a bot wall count the
--- same number of cards, and the difference is the whole answer: "this store had nothing" versus "this
--- store wants proof you are human". The multi-store loop also branches on it — an empty page is worth a
--- second navigation, a wall never is.
--- Costs at most three reads and only on the page we already landed on: no extra navigation.
---
--- Returns `kind, reason`. The KIND is one of two stable branch keys a flow can enumerate; the REASON is
--- whatever that site calls its wall. Returning the site's wording as the branch key made naver answer
--- `next = "security_verification_required"` live, which no flow enumerates — it would fall through
--- `invalidNext` into a generic error and lose the very reason it was carrying.
local function access_error(config, href)
  local low = href:lower()
  for index = 1, #(config.blocked_urls or {}) do
    local item = config.blocked_urls[index]
    if low:find(tostring(item.text):lower(), 1, true) then return "access_denied", item.error or "access_denied" end
  end
  for index = 1, #(config.login_urls or {}) do
    if low:find(tostring(config.login_urls[index]):lower(), 1, true) then return "login_required", "login_required" end
  end
  for index = 1, #(config.blocked_selectors or {}) do
    local item = config.blocked_selectors[index]
    if dom.exists(item.selector) then return "access_denied", item.error or "access_denied" end
  end
  if config.login_selector and dom.exists(config.login_selector) then return "login_required", "login_required" end
  if #(config.blocked_text or {}) > 0 then
    -- Read the body ONLY when a phrase is configured: it is the most expensive read here and most sites
    -- declare no phrases at all.
    local body = tostring(dom.get_text("body") or ""):lower()
    for index = 1, #config.blocked_text do
      local item = config.blocked_text[index]
      if body:find(tostring(item.text):lower(), 1, true) then return "access_denied", item.error or "access_denied" end
    end
  end
  return nil, nil
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

  -- Before counting cards. A wall that happens to render one card would otherwise report `ok`, and a
  -- wall that renders none would report `no_results` — both are answers about prices never compared.
  local landed = dom.get_location_href()
  local kind, reason = access_error(config, tostring(landed or ""))
  if kind then
    return { next = kind, site = config.site, query = query, href = landed, cards_seen = 0,
             candidates = array({}), error = reason }
  end

  -- A payload store reads its payload first; the rendered grid repeats wrappers per card and mixes ad
  -- chrome into the row text. A store that prefers the DOM (its payload prices are empty) still falls
  -- back to the payload rather than reporting an empty store.
  local candidates = array({})
  local cards_seen = 0
  if config.prefer_embedded and config.embedded_json_selector then
    candidates = read_embedded(config)
    cards_seen = #candidates
  end

  if #candidates == 0 then
    local rows = dom.query_all(config.result_selector, fields_for(config), config.result_limit or 24)
    cards_seen = #rows
    local seen = {}
    for index = 1, #rows do
      local candidate = candidate_from(config, rows[index] or {})
      if candidate and not seen[candidate.product_id] then
        seen[candidate.product_id] = true
        candidates[#candidates + 1] = candidate
      end
    end
    if #candidates == 0 and config.embedded_json_selector then
      local embedded = read_embedded(config)
      candidates = embedded
      cards_seen = math.max(cards_seen, #embedded)
    end
  end

  -- Paging is opt-in. `has_more` stays ABSENT for a site that declares no next control: absent means
  -- "cannot tell" and the caller treats it as no more, while `false` would claim a check that never
  -- happened. A probed-and-absent control beats the row count — a full page can still be the last one.
  local paging = config.pagination
  local next_selector = paging and paging.next_selector
  local has_more = nil
  if type(next_selector) == "string" and next_selector ~= "" then
    has_more = dom.exists(next_selector) == true
  end

  local next_value = outcome(cards_seen, #candidates)
  return {
    next = next_value,
    site = config.site,
    query = query,
    href = dom.get_location_href(),
    cards_seen = cards_seen,
    candidates = candidates,
    has_more = has_more,
    pagination_supported = paging ~= nil and paging.param ~= nil,
    error = (next_value ~= "ok") and next_value or nil,
  }
end

--- The production entry point: one store, one page, in the shape the rest of the pipeline already reads.
---
--- The normalizer that runs next was written against the durable adapter, so it looks for `status` and
--- `candidates` — not this reader's branch key. It also renders the store-specific reason to the user
--- ("네이버쇼핑: 보안 확인 필요 …"), so a wall keeps the wording its site config chose instead of being
--- flattened to `access_denied`.
---
--- There is no `navigating` answer. The durable adapter had one because a navigation destroyed its
--- context and the flow had to call it again; this script keeps its own stack across the reload.
function S.run_store_search(args)
  args = type(args) == "table" and args or {}
  local item = type(args.item) == "table" and args.item or {}
  local context = type(args.context) == "table" and args.context or {}

  -- A `kind: remote` tool receives the tool's `input:` mapping; a runtime lua tool receives the node's
  -- SELECTED FLOW STATE. The worker selects `item`, `context`, `page`, `query`, so the site arrives as
  -- `item.site`. Live, reading only the flat key made every store refuse with an empty site.
  local site = non_empty(args.site) or non_empty(item.site)
  -- The collector hands back the wording this store's own listings use; until then the shared query
  -- stands.
  local query = non_empty(args.query) or non_empty(context.query)
  -- Two different failures wear the same word. "The site data module did not load" is a delivery
  -- problem and every store refuses; "this store has no config" is a porting gap and only that store
  -- refuses. Live, both 11st and ssg came back with a bare `unsupported_site` and the two were
  -- indistinguishable, which cost a whole diagnosis round.
  --
  -- The reason rides in `store_result` because that is the only field the flow maps. A reason parked
  -- anywhere else is a reason nobody downstream can read.
  local function refuse(reason, extra)
    local out = { next = "unsupported_site", site = site, error = reason,
      store_result = { site = site, status = reason, error = reason, candidates = array({}) } }
    for key, value in pairs(extra or {}) do out[key] = value end
    return out
  end

  if type(RPC_SITES) ~= "table" then return refuse("site_data_unavailable") end

  local config = site and RPC_SITES[site]
  if not config then
    local known = array({})
    for name in pairs(RPC_SITES) do known[#known + 1] = name end
    table.sort(known)
    -- An empty result would read as "that store had nothing", a claim about listings nobody looked at.
    return refuse("site_not_ported", { known_sites = known })
  end

  local result = S.search(config, { query = query, page = args.page })
  local branch = result.next
  local status = (branch == "ok") and "candidates" or (result.error or branch)

  return {
    next = "done",
    store_result = {
      site = result.site,
      status = status,
      error = (branch ~= "ok") and (result.error or branch) or nil,
      login_required = (branch == "login_required") or nil,
      candidates = result.candidates,
      url = result.href,
      page = tonumber(args.page) or 1,
      cards_seen = result.cards_seen,
      has_more = result.has_more,
      pagination_supported = result.pagination_supported,
    },
  }
end
