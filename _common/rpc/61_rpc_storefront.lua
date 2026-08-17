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


--- Every page read, retried ONCE before it is believed.
---
--- A refused op is a fact about the CHANNEL, not about the page. Measured live: one `dom.exists` answered
--- `rpc_timeout` while the channel re-attached, the error raised out of `search`, and the store was lost
--- along with the candidates already parsed off the page — `shopping_search_one_store` reported a lua
--- runtime error and the comparison continued without that store. The quote and cart modules learned this
--- first; this one was still calling `dom.*` raw at every site.
---
--- A persistent refusal answers `nil`/`false`, never a fabricated value: "could not tell" has to stay
--- distinguishable from "checked, and no".
local __unpack = table.unpack or unpack
--- Persistent refusals in this invocation. Swallowing a refusal keeps a page-read from throwing away a
--- store, but it must not turn "the channel never answered" into "the site did not navigate" — those send
--- the operator to different places. The count is reset per call and the error branches consult it.
local __refused = 0
--- Resolved at CALL time, never at load time: modules are loaded before the runtime installs its globals,
--- so capturing `dom` here caught nil and every op answered "unavailable".
--- The same tolerance for `nav`, minus the one op that has an EFFECT. `nav.wait_for_navigation` polls
--- `dom.get_location_href`, so a refusal inside it raised out of the search exactly like a direct read;
--- `nav.navigate` is excluded because retrying a navigation that already fired would move the page twice.
local __tolerant_nav = { wait_for_navigation = true, wait_for = true }
local nav = setmetatable({}, {
  __index = function(_, name)
    local real = _G.nav
    local fn = type(real) == "table" and real[name]
    if type(fn) ~= "function" then return nil end
    if not __tolerant_nav[name] then return fn end
    return function(...)
      local args = table.pack and table.pack(...) or { n = select("#", ...), ... }
      local ok, value = pcall(fn, __unpack(args, 1, args.n))
      if ok then return value end
      ok, value = pcall(fn, __unpack(args, 1, args.n))
      if ok then return value end
      __refused = __refused + 1
      return nil
    end
  end,
})

local dom = setmetatable({}, {
  __index = function(_, name)
    return function(...)
      local real = _G.dom
      local fn = type(real) == "table" and real[name]
      if type(fn) ~= "function" then return nil end
      -- `select('#', ...)` with an explicit range: `a and b(x) or c(x)` truncates a multi-value return to
      -- ONE, and every op past its first argument would silently lose its parameters.
      local args = table.pack and table.pack(...) or { n = select("#", ...), ... }
      local ok, value = pcall(fn, __unpack(args, 1, args.n))
      if ok then return value end
      ok, value = pcall(fn, __unpack(args, 1, args.n))
      if ok then return value end
      __refused = __refused + 1
      return nil
    end
  end,
})
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

--- The search URL for this site and query, or nil when the site declares no shape for one.
---
--- Two shapes exist. Most stores take a query parameter; aliexpress puts the query in the PATH
--- (`/w/wholesale-logitech-m185.html`). Live, assuming the parameter concatenated a nil and the Lua
--- error took the whole store out of the comparison — a missing field must never cost more than the
--- store it describes.
function S.search_url(config, query, page)
  local url
  if config.search_path_prefix then
    url = config.search_path_prefix .. url_encode(query):gsub("%%20", "-"):gsub("+", "-")
      .. (config.search_path_suffix or "")
  elseif config.search_url and config.search_param then
    url = config.search_url .. "?" .. config.search_param .. "=" .. url_encode(query)
    for key, value in pairs(config.search_extra or {}) do
      url = url .. "&" .. key .. "=" .. url_encode(value)
    end
  elseif config.search_url then
    url = config.search_url
  else
    return nil
  end

  local paging = config.pagination
  if paging and paging.param and page and page > 1 then
    local separator = url:find("?", 1, true) and "&" or "?"
    url = url .. separator .. paging.param .. "=" .. tostring(paging.start + (page - 1) * paging.step)
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
  if config.search_path_prefix then
    return current:find(encoded:gsub("%%20", "-"):gsub("+", "-"), 1, true) ~= nil
  end
  return config.search_param ~= nil
    and current:find(config.search_param .. "=" .. encoded, 1, true) ~= nil
end

local function fields_for(config)
  local fields = { text = true }
  local function add(name, selector, attr)
    if not selector then return end
    fields[name] = { selector = selector }
    if attr then fields[name].attr = attr end
  end
  -- The href is usually on a descendant anchor, and a selector fetches it. But a card root can BE the
  -- anchor: aliexpress declares `result_url_from_root` and carries no `result_url_selector` at all. The
  -- durable reader consumed that key and this one did not, so every aliexpress row arrived with no url
  -- and no id, `candidate_from` dropped all of them, and one of the ten stores answered zero candidates
  -- on the SHIPPED path while the durable tests stayed green against the other implementation. Asked as
  -- a root attribute so it still rides the single batched `query_all`.
  if config.result_url_selector then
    add("url", config.result_url_selector, "href")
  elseif config.result_url_from_root then
    fields.url = { attr = "href" }
  end
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
  -- ebay states the seller's positive-feedback share and its count in one line; the comparison ranks on
  -- the share, so a site that has one says where it lives.
  add("seller_text", config.result_seller_selector)
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
  -- No `원` here: it is a SUFFIX, so the amount comes BEFORE it and `won_amount` reads it. Listing it
  -- as a prefix mark made "배송비 2,500원 판매자 평점4.7" answer 4.7 — the number after the mark.
  { "KRW", "KRW" }, { "₩", "KRW" },
  { "EUR", "EUR" }, { "€", "EUR" },
  { "GBP", "GBP" }, { "£", "GBP" },
  { "JPY", "JPY" }, { "¥", "JPY" },
}

local function normalize_number(value)
  return tonumber((tostring(value or ""):gsub(",", "")))
end

--- Amounts in the text, in order, skipping any that CONTINUE an alphanumeric token.
---
--- Live on coupang: `로지텍 무선 마우스, 블랙, M18519,400원`. The model code ends in digits and the price
--- follows with no separator, so a naive digit run read the product at KRW 18,519,400. Hangul is
--- multi-byte, so a Korean prefix never blocks a match.
local function amounts_in(text)
  local value = tostring(text or "")
  local found = {}
  local cursor = 1
  while true do
    local start_at, end_at, amount = value:find("([%d][%d,]*%.?%d*)", cursor)
    if not start_at then break end
    local previous = start_at > 1 and value:sub(start_at - 1, start_at - 1) or ""
    if not previous:match("[%a%d]") then found[#found + 1] = normalize_number(amount) end
    cursor = end_at + 1
  end
  return found
end

local function amount_in(text)
  local found = amounts_in(text)
  return found[1]
end

--- The amount stated right after a currency mark, which is what makes the mark meaningful.
local function amount_after(text, marker)
  local value = tostring(text or "")
  local start_at = value:find(marker, 1, true)
  if not start_at then return nil end
  return normalize_number(value:sub(start_at + #marker):match("([%d][%d,]*%.?%d*)"))
end

local function parse_money(text, fallback_currency)
  local value = non_empty(text)
  if not value then return nil, non_empty(fallback_currency) end
  for index = 1, #CURRENCY_MARKS do
    local mark, code = CURRENCY_MARKS[index][1], CURRENCY_MARKS[index][2]
    local amount = amount_after(value, mark)
    if amount then return amount, code end
  end
  return amount_in(value), non_empty(fallback_currency)
end

-- Everything a card prints after these belongs to delivery, rewards or financing, not to the price.
local PRICE_CUTOFF_MARKERS = { "배송비", "무료배송", "배송", "적립", "포인트", "쿠폰", "할부",
  "shipping", "delivery", "postage", "coupon", "cashback", "reward" }

--- The last `원` amount in the text, on a token boundary.
--- The money parser is shared with the cart, which revalidates a price on the product page before it
--- clicks. Two parsers would disagree about the same string, and the one guarding the money would be the
--- one nobody exercised.
S.parse_money = parse_money

local function won_amount(text, pick_last)
  local value = tostring(text or "")
  local found, cursor = nil, 1
  while true do
    local start_at, end_at, amount = value:find("([%d][%d,]*%.?%d*)%s*원", cursor)
    if not start_at then break end
    local previous = start_at > 1 and value:sub(start_at - 1, start_at - 1) or ""
    if not previous:match("[%a%d]") then
      found = normalize_number(amount)
      if not pick_last then return found end
    end
    cursor = end_at + 1
  end
  return found
end

--- A card prints several numbers and only one is what the buyer pays. Each site says which rule finds
--- it; guessing produced a struck-through price, a per-month instalment, or a reward figure.
local function parse_candidate_price(value, fallback_currency, strategy)
  local text = non_empty(value)
  if not text then return nil, non_empty(fallback_currency) end

  if strategy == "decimal_preferred" then
    -- The screen-reader form is glued to the human one ("Now$4999current price Now $49.99"); the marked
    -- occurrence is the one meant for a person.
    local _, currency = parse_money(text, fallback_currency)
    local marker, cursor = nil, 1
    while true do
      local at = text:lower():find("current price", cursor, true)
      if not at then break end
      marker, cursor = at, at + 1
    end
    if marker then return parse_money(text:sub(marker), fallback_currency) end
    local found = amounts_in(text)
    if #found == 1 then return found[1], currency or non_empty(fallback_currency) end
    return nil, currency or non_empty(fallback_currency)
  end

  if strategy == "last_before_shipping" then
    local lowered = text:lower()
    local cutoff = #text + 1
    for index = 1, #PRICE_CUTOFF_MARKERS do
      local at = lowered:find(PRICE_CUTOFF_MARKERS[index], 1, true)
      if at and at < cutoff then cutoff = at end
    end
    local head = text:sub(1, cutoff - 1)
    local won = won_amount(head, true)
    if won then return won, "KRW" end
    return parse_money(head, fallback_currency)
  end

  return parse_money(text, fallback_currency)
end

local function parse_price(text)
  return (amount_in(text))
end

local SHIPPING_WORDS = { "shipping", "delivery", "postage", "배송비", "배송료" }
local FREE_PHRASES = { "free shipping", "free delivery", "free postage", "shipping: free",
  "무료배송", "무료 배송", "배송비 무료" }
--- A free-shipping promise that depends on a basket total. Measured normal renderings:
--- "배송비 3,000원 · 30,000원 이상 무료배송", "Shipping: $5.99 · Free shipping over $35".
local THRESHOLD_MARKS = { "이상", "초과", "이상부터", " over ", "over $", "above", "orders of" }

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

  local free_at = nil
  for index = 1, #FREE_PHRASES do
    local at = lowered:find(FREE_PHRASES[index], 1, true)
    if at and (not free_at or at < free_at) then free_at = at end
  end

  -- An UNCONDITIONAL free-shipping promise is zero. A CONDITIONAL one is not: it says nothing about what
  -- this row ships for, and this scan used to run over the whole text before any fee was extracted, so
  -- "배송비 3,000원 · 30,000원 이상 무료배송" answered 0 with the fee sitting right there. That is the
  -- failure the comment above forbids by name — the store becomes cheapest on the page for free — and the
  -- threshold form is the NORMAL rendering on a Korean store, not an edge case.
  --
  -- Everything from the threshold word on belongs to the condition, so the fee is looked for only BEFORE
  -- the free phrase. A threshold word misread on an unconditional row costs an UNKNOWN, never a number.
  local conditional = false
  if free_at then
    for index = 1, #THRESHOLD_MARKS do
      if lowered:find(THRESHOLD_MARKS[index], 1, true) then conditional = true break end
    end
    if not conditional then return 0, non_empty(fallback_currency) end
  end

  local scan_end = (conditional and free_at) and (free_at - 1) or #value
  local first = nil
  for index = 1, #SHIPPING_WORDS do
    local at = lowered:find(SHIPPING_WORDS[index], 1, true)
    if at and at <= scan_end and (not first or at < first) then first = at end
  end
  -- A number with no shipping word near it is a reward point, a rating count, anything. And under a
  -- threshold, no shipping word before it means the row states a condition and no fee at all.
  if not first then return nil, non_empty(fallback_currency) end

  local fragment = value:sub(first, math.min(first + 60, scan_end))
  local fragment_lowered = fragment:lower()
  local amount, currency = parse_money(fragment, fallback_currency)

  if amount and amount > 0 then
    if from_row_text then
      -- `원` is a suffix and so is absent from the prefix marks, but a fee written "2,500원" in the row
      -- text is exactly as stated as one written "$3.00".
      local marked = fragment:find("원", 1, true) ~= nil
      for index = 1, #CURRENCY_MARKS do
        if fragment:find(CURRENCY_MARKS[index][1], 1, true) then marked = true break end
      end
      if not marked then return nil, non_empty(fallback_currency) end
    end
    return amount, currency
  end

  -- The label can be glued to its value: 11st renders `<span class="sr-only">배송비</span><span
  -- class="value">무료</span>`, so the cell reads "배송비무료" with no separator and no phrase above matches.
  -- Judging the FRAGMENT after the marker covers every spacing, and a stated fee already won just above,
  -- so conditional copy like "3,000원 이상 무료" still reports the number rather than free.
  if fragment_lowered:find("무료", 1, true) or fragment_lowered:find("free", 1, true) then
    return 0, non_empty(fallback_currency)
  end
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

--- The share of buyers who rated this seller positively, and how many did. A line with no percentage
--- yields nothing rather than a number pulled from whatever digits were nearby.
local function seller_percent(text)
  local value = non_empty(text)
  return value and tonumber(value:match("(%d+%.?%d*)%%")) or nil
end

local function seller_reviews(text)
  local value = non_empty(text)
  local inside = value and value:match("%(([%d,]+)%)")
  return inside and tonumber((inside:gsub(",", ""))) or nil
end

--- Return terms the card states in its own words, when the site marks them up nowhere.
---
--- Measured live on eBay search (2026-08-15): the cards carry title, condition, price, buy format,
--- shipping and seller feedback and say nothing about returns — `[class*=return]` matched 0 elements on
--- the page, and so did the old `.s-item__free-returns`. So there is no selector to declare, and ebay's
--- generated config rightly has none. The DURABLE reader never used one either: it scanned the card's
--- lowered text for these two phrases and left the field nil otherwise. That derivation is the
--- capability, so it moves here. Declaring a selector that matches nothing would have made the field
--- silently absent forever, and defaulting it would state a returns policy the store never offered.
local RETURN_PHRASES = { { "free returns", "Free returns" }, { "무료 반품", "무료 반품" } }

local function returns_from_text(text)
  local low = tostring(text or ""):lower()
  if low == "" then return nil end
  for index = 1, #RETURN_PHRASES do
    local phrase = RETURN_PHRASES[index]
    if low:find(phrase[1], 1, true) then return phrase[2] end
  end
  return nil
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
  local price, currency = parse_candidate_price(price_source, config.default_currency, config.price_text_strategy)
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
    return_terms = non_empty(row.return_terms) or returns_from_text(row.text),
    seller_rating_percent = seller_percent(row.seller_text),
    review_count = seller_reviews(row.seller_text),
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
  -- Per invocation: a refusal from a previous call says nothing about this one.
  __refused = 0
  args = type(args) == "table" and args or {}
  local query = non_empty(args.query)
  -- Every outcome names its store. `flow.map` validates each item result against `required: [site]`
  -- and the normalizer refuses without one, so an error that omits it becomes a schema violation instead
  -- of the fact it was reporting — live, two stores failed discovery that way.
  if not query then return { next = "error", error = "query_required", site = config.site } end

  -- The channel can still be attaching — measured live as `rpc_timeout` on this exact read, moments
  -- after an extension reload, three turns in a row. One refused read is not a page problem, and
  -- raising here loses the whole store: the worker marks it failed and the comparison never shows it.
  -- The tight `opTimeoutMs` is for navigating polls, not for the opening read.
  -- Each failed attempt already costs the op timeout, so the retries ARE the wait. Live, one retry was
  -- not enough right after an extension reload: the channel needed a beat longer than a single 2s budget.
  local ok, from
  for _ = 1, 3 do
    ok, from = pcall(dom.get_location_href)
    if ok then break end
  end
  if not ok then return { next = "error", error = "rpc_unavailable", site = config.site } end
  local target = S.search_url(config, query, tonumber(args.page))
  if not target then return { next = "error", error = "search_url_unavailable", site = config.site } end
  if not already_showing(config, from, query) then
    -- CAUGHT, not retried: a navigation that already fired would move the page twice. A raise here is the
    -- channel, not the site, and it used to take the whole store down with it.
    local moved = pcall(function() return nav.navigate(target) end)
    if not moved then return { next = "error", error = "rpc_unavailable", site = config.site } end
    -- href first. A document that is still alive answers a selector check from the OLD page, so an
    -- element probe here is a false positive waiting to happen.
    --
    -- The TARGET is passed, and that is not a nicety. Without a `url` the port asks "has the address changed
    -- since I started", and it reads its baseline through a round trip: measured live, an Amazon search
    -- commits in ~460ms and an op costs about the same, so the baseline read often returns the page we just
    -- arrived at. `now ~= before` is then false forever, the wait burns its whole ceiling and reports failure
    -- about a navigation that WORKED — a store silently dropped from a comparison because it answered too
    -- fast. With `url` the check is `now:includes(target)`, true whenever we are there, whichever won the
    -- race. Reproduced in the playground: two Amazon searches in one session, one of them stuck, and the tab
    -- sitting on the correct search URL afterwards.
    if not nav.wait_for_navigation({ url = target, timeout = 8000, interval = 200 }) then
      -- A channel that answered nothing is not a site that would not move.
      if __refused > 0 then return { next = "error", error = "rpc_unavailable", site = config.site } end
      -- A site may redirect off the target (canonical slug, locale, an interstitial), and then the target
      -- match cannot hold however long it waits. Moving AT ALL is the fact worth having: `from` is the
      -- address before the navigation fired, so a different one now means the page went somewhere, and the
      -- selector wait below decides whether it is a result page. Only an address that never moved is stuck.
      local landed = dom.get_location_href()
      if landed == nil then return { next = "error", error = "rpc_unavailable", site = config.site } end
      if landed == from then
        return { next = "error", error = "navigation_stuck", site = config.site, href = landed }
      end
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
    -- A refused read answers nil, and `#nil` raises. Absent is "could not tell", which reads the same as
    -- an empty grid HERE — the outcome below already separates "no cards" from "cards without prices" —
    -- but it must not take the tool down with it.
    local rows = dom.query_all(config.result_selector, fields_for(config), config.result_limit or 24) or {}
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
    -- A refused probe answers nil, and `nil == true` is `false` — which would CLAIM there is no next
    -- page. Absent has to survive the comparison: "could not tell" and "checked, and no" are different
    -- facts and the caller stops paging on both, but only one of them is a measurement.
    local probed = dom.exists(next_selector)
    if probed ~= nil then has_more = probed == true end
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
--- An EMPTY candidate list must not cross as `{}`. `flow.map` validates the item result against
--- `candidates: [array, "null"]` and an empty Lua table encodes as an OBJECT, so a store that simply
--- found nothing failed the schema instead of reporting that it found nothing. Absent is the encoding
--- that cannot be mistaken, and the caller already reads `candidates or {}`.
local function without_empty_candidates(result)
  if type(result) == "table" then
    local inner = type(result.store_result) == "table" and result.store_result or result
    if type(inner.candidates) == "table" and #inner.candidates == 0 then inner.candidates = nil end
  end
  return result
end

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

  return without_empty_candidates({
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
  })
end

--- The site whose store is showing at `href`, or nil when no ported store claims that host.
---
--- The single-site shopping flow opens a store and then searches "the site that is open": its node
--- carries a query and nothing else. The durable adapter got the site for free because the browser had
--- already loaded that site's layer; a runtime script has to read it off the page.
---
--- A subdomain of a declared host counts (`www.ebay.com` for `ebay.com`), because a store rarely serves
--- search from the exact host it names. A page no config claims resolves to NOTHING — answering with
--- some other store would search the wrong shop.
function S.site_for_url(href)
  local host = tostring(href or ""):match("^https?://([^/]+)")
  if not host or type(RPC_SITES) ~= "table" then return nil end
  host = host:lower()

  for name, config in pairs(RPC_SITES) do
    for index = 1, #(config.hosts or {}) do
      local declared = tostring(config.hosts[index]):lower()
      if host == declared or host:sub(-(#declared + 1)) == "." .. declared then return name end
    end
  end
  return nil
end

--- Searches whichever ported store is currently open. Same result shape as `run_store_search`, so the
--- flow reads it the same way.
function S.run_open_site_search(args)
  args = type(args) == "table" and args or {}
  local ok, href = pcall(dom.get_location_href)
  if not ok then return { next = "error", error = "rpc_unavailable", site = config.site } end

  local site = S.site_for_url(href)
  if not site then
    return { next = "unsupported_site", site = site, error = "site_not_ported",
             store_result = { status = "site_not_ported", error = "site_not_ported", candidates = array({}) } }
  end
  local result = S.run_store_search({ site = site, query = args.query, page = args.page })
  -- The single-site flow predates the worker's envelope and maps `result.candidates` directly, so the
  -- list is exposed at the top level too rather than reshaping a flow to match a reader.
  local store = result.store_result or {}
  result.candidates = store.candidates
  result.error = store.error
  return result
end
