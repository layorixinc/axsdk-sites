-- Amazon embedded storefront provider, authored and distributed as Lua (LUA_PACK_DESIGN.md).
-- Runs INSIDE the retailer page's USER_SCRIPT world: `dom` reads the live document directly.
-- Selectors are the live-measured set the JS predecessor carried; keep them in sync with reality,
-- never with memory.

local RESULT_SELECTOR = '[data-component-type="s-search-result"][data-asin]'
local CAPTCHA_SELECTOR = 'form[action*="validateCaptcha"]'
local LOGIN_SELECTORS = { "#authportal-main-section", "#ap_email", "#ap_password" }
local TITLE_SELECTOR = "a h2 span, a h2"
local PRICE_SELECTOR = ".a-price .a-offscreen"
local SHIPPING_SELECTOR = '[data-cy="delivery-block"], [data-cy="delivery-recipe"]'
local NEXT_SELECTOR = "a.s-pagination-next:not(.s-pagination-disabled)"

local CURRENCY_MARKERS = { "us%s*%$", "usd%s*", "%$" }
local AMOUNT_PATTERN = "%d[%d,]*%.?%d?%d?"

local function clean(value, maximum)
  return text.clean(value, maximum or 500)
end

local function to_amount(captured)
  if captured == nil then return nil end
  local digits = string.gsub(captured, ",", "")
  return tonumber(digits)
end

-- Mirrors /(?:US\s*\$|USD\s*|\$)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i: earliest marker wins.
local function decimal_amount(value)
  local lowered = string.lower(value)
  local best_start = nil
  local best_end = nil
  for _, marker in ipairs(CURRENCY_MARKERS) do
    local start, finish = string.find(lowered, marker)
    if start ~= nil and (best_start == nil or start < best_start
      or (start == best_start and finish > best_end)) then
      best_start, best_end = start, finish
    end
  end
  if best_start == nil then return nil end
  local amount = to_amount(string.match(lowered, "^%s*(" .. AMOUNT_PATTERN .. ")", best_end + 1))
  if amount ~= nil and amount > 0 then return amount end
  return nil
end

local FREE_PATTERNS = { "free%s+shipping", "free%s+delivery", "무료%s*배송" }
local THRESHOLD_PATTERNS = {
  "orders?%s+over", "orders?%s+above", "orders?%s+of", "on%s+%$",
  "%$%s*%d[%d,%.]*.*free",
}
local THRESHOLD_LITERALS = { "이상", "초과" }

local function find_any(lowered, patterns, plain)
  for _, pattern in ipairs(patterns) do
    if string.find(lowered, pattern, 1, plain) ~= nil then return true end
  end
  return false
end

-- A conditional free-shipping offer is NOT free shipping, and a reward figure is not a fee
-- (AGENTS.md §13). Thresholds keep the fee unknown rather than inventing zero.
local function shipping_amount(value)
  local normalized = clean(value)
  if normalized == "" then return nil end
  local lowered = string.lower(normalized)
  local has_free = find_any(lowered, FREE_PATTERNS, false)
  local has_threshold = find_any(lowered, THRESHOLD_PATTERNS, false)
    or find_any(lowered, THRESHOLD_LITERALS, true)
  if has_free then
    if has_threshold then return nil end
    return 0
  end
  -- Fee forms: "shipping[ fee| cost][:] $N" and "$N shipping" — earliest match in the text wins.
  local best_position = nil
  local best_amount = nil
  local function consider(position, captured)
    local amount = to_amount(captured)
    if position ~= nil and amount ~= nil and amount >= 0
      and (best_position == nil or position < best_position) then
      best_position, best_amount = position, amount
    end
  end
  for _, word in ipairs({ "shipping", "delivery" }) do
    for _, marker in ipairs(CURRENCY_MARKERS) do
      for _, suffix in ipairs({ "%s+fee", "%s+cost", "" }) do
        local pattern = word .. suffix .. "%s*:?%s*" .. marker .. "%s*(" .. AMOUNT_PATTERN .. ")"
        local position, _, captured = string.find(lowered, pattern)
        consider(position, captured)
      end
      local reversed = marker .. "%s*(" .. AMOUNT_PATTERN .. ")%s+" .. word
      local position, _, captured = string.find(lowered, reversed)
      consider(position, captured)
    end
  end
  return best_amount
end

local function card_candidate(card)
  local asin = string.upper(clean(dom.attr(card, "data-asin") or "", 128))
  if string.match(asin, "^[%u%d]+$") == nil or #asin ~= 10 then return nil end
  local name = clean(dom.text(card, TITLE_SELECTOR))
  local price = decimal_amount(clean(dom.text(card, PRICE_SELECTOR)))
  if name == "" or price == nil then return nil end
  local shipping_cost = shipping_amount(dom.text(card, SHIPPING_SELECTOR))
  local candidate = {
    product_id = asin,
    name = name,
    url = "https://www.amazon.com/dp/" .. asin,
    price = price,
    currency = "USD",
  }
  if shipping_cost ~= nil then
    candidate.shipping_cost = shipping_cost
    candidate.shipping_currency = "USD"
  end
  return candidate
end

local function search_target(input)
  local params = { { "k", input.query } }
  if input.page > 1 then
    params[#params + 1] = { "page", string.format("%d", input.page) }
  end
  return url.with_params("https://www.amazon.com/s", params)
end

local function shows_search(input)
  local parsed = url.parse(page.href())
  if parsed == nil then return false end
  local page_param = tonumber(parsed.params.page or "1")
  return parsed.origin == "https://www.amazon.com"
    and parsed.pathname == "/s"
    and parsed.params.k == input.query
    and page_param == input.page
end

local function search_products(input)
  if dom.exists(CAPTCHA_SELECTOR) then
    return { step = "blocked", classification = "captcha_required" }
  end
  for _, selector in ipairs(LOGIN_SELECTORS) do
    if dom.exists(selector) then
      return { step = "blocked", classification = "login_required" }
    end
  end
  if not shows_search(input) then
    return { step = "navigate", url = search_target(input) }
  end

  local limit = math.max(1, math.min(6, input.limit))
  local cards = dom.query_all(RESULT_SELECTOR)
  local candidates = {}
  local seen = {}
  for index = 1, #cards do
    local candidate = card_candidate(cards[index])
    if candidate ~= nil and seen[candidate.product_id] ~= true then
      seen[candidate.product_id] = true
      candidates[#candidates + 1] = candidate
      if #candidates >= limit then break end
    end
  end

  local status = "no_results"
  if #candidates > 0 then
    status = "candidates"
  elseif #cards > 0 then
    status = "price_unavailable"
  end
  local result = {
    schema_version = 1,
    status = status,
    query = input.query,
    page = input.page,
    cards_seen = #cards,
    has_more = dom.exists(NEXT_SELECTOR),
  }
  if #candidates > 0 then result.candidates = json.array(candidates) end
  return { step = "done", result = result }
end

register({ search_products = search_products })
