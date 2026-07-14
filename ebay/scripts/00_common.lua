AX_EBAY = {}
local M = AX_EBAY
local B = AX_BASE
if not B then
  error("_common/scripts/00_base.lua must be loaded before ebay/scripts/00_common.lua")
end

M.HOME_URL = "https://www.ebay.com/"
M.SEARCH_URL = "https://www.ebay.com/sch/i.html"
M.ITEM_URL_PREFIX = "https://www.ebay.com/itm/"
M.RESULT_SELECTOR = ".su-item-card[data-view], .s-item-card[data-view]"
M.RESULT_READY_SELECTOR = ".srp-river-results, .srp-results, .su-item-card, .srp-save-null-search, #signin-main, #captcha_form"
M.LOGIN_SELECTOR = "form#signin-form, #signin-main, input#userid, input#pass"
M.CAPTCHA_SELECTOR = "#captcha_form, #captcha-box, form[action*='captcha'], input[name='captcha']"
M.PRODUCT_READY_SELECTOR = "h1.x-item-title__mainTitle, h1[data-testid='x-item-title'], #signin-main, #captcha_form"
M.PRODUCT_PRICE_SELECTOR = ".x-price-primary span, [data-testid=\"x-price-primary\"] span, .x-price-primary"
M.PRODUCT_APPROX_PRICE_SELECTOR = ".x-price-approx__price, .x-price-approx"
M.ADD_SELECTOR = "#atcBtn_btn_1, a[href*='cart.payments.ebay.com/sc/add'], a[href*='/sc/add']"
M.CART_CONFIRM_SELECTOR = "[data-test-id='cart-item'], .cart-bucket-lineitem, .cart-bucket, [data-testid='cart-item'], [data-test-id='ADD_TO_CART_CONFIRMATION']"
M.ADD_READY_SELECTOR = M.CART_CONFIRM_SELECTOR .. ", " .. M.LOGIN_SELECTOR .. ", " .. M.CAPTCHA_SELECTOR
M.RESULT_LIMIT = 24

function M.clean_text(value)
  return B.clean_text(value)
end

function M.non_empty(value)
  return B.non_empty(value)
end

function M.normalize_query(value)
  return M.clean_text(value):lower():gsub("%s+", " ")
end

function M.host_matches(url)
  local href = M.non_empty(url) or ""
  return href:match("^https?://[^/]*ebay%.com[/]") ~= nil
    or href:match("^https?://ebay%.com[/]") ~= nil
end

function M.is_login_page()
  local href = M.non_empty(dom.get_location_href()) or ""
  return href:find("signin.ebay.com", 1, true) ~= nil
    or href:find("/signin/", 1, true) ~= nil
    or dom.exists(M.LOGIN_SELECTOR)
end

function M.is_captcha_page()
  local href = M.non_empty(dom.get_location_href()) or ""
  return href:find("/splashui/captcha", 1, true) ~= nil
    or dom.exists(M.CAPTCHA_SELECTOR)
end

function M.login_required_result()
  return {
    status = "login_required",
    login_required = true,
    url = M.non_empty(dom.get_location_href())
  }
end

function M.parse_number_text(value)
  local text = M.clean_text(value):gsub(",", "")
  local amount = text:match("(%d+%.%d+)") or text:match("(%d+)")
  return amount and tonumber(amount) or nil
end

function M.parse_price(value)
  local text = M.clean_text(value)
  if text == "" then return nil, nil end
  local currency = nil
  if text:find("KRW", 1, true) or text:find("₩", 1, true) then currency = "KRW"
  elseif text:find("US$", 1, true) or text:find("$", 1, true) then currency = "USD"
  elseif text:find("EUR", 1, true) or text:find("€", 1, true) then currency = "EUR"
  elseif text:find("GBP", 1, true) or text:find("£", 1, true) then currency = "GBP"
  elseif text:find("JPY", 1, true) or text:find("¥", 1, true) then currency = "JPY" end
  return M.parse_number_text(text), currency
end

function M.parse_review_count(value)
  local text = M.clean_text(value):gsub(",", "")
  local compact = text:gsub("%s", "")
  local thousands = tonumber(compact:match("%((%d+%.?%d*)[Kk]%)"))
  if thousands then return math.floor(thousands * 1000) end
  return tonumber(compact:match("%((%d+)%)"))
end

function M.parse_item_id(value)
  local text = M.non_empty(value)
  if not text then return nil end
  local item_id = text:match("/itm/(%d+)") or text:match("[?&]item=(%d+)")
  if item_id and #item_id >= 9 and #item_id <= 15 then return item_id end
  local digits = text:gsub("%D", "")
  if #digits >= 9 and #digits <= 15 then return digits end
  return nil
end

function M.current_item_id()
  return M.parse_item_id(dom.get_location_href())
end

function M.product_page_matches(product_id)
  return M.current_item_id() == tostring(product_id)
    and dom.exists("h1.x-item-title__mainTitle, h1[data-testid='x-item-title']")
end

function M.item_url(product_id)
  return M.ITEM_URL_PREFIX .. tostring(product_id)
end

function M.current_search_matches(query)
  local href = M.non_empty(dom.get_location_href()) or ""
  if href:find("/sch/i.html", 1, true) == nil then return false end
  local value = M.non_empty(dom.get_attr("#gh-ac", "value"))
    or M.non_empty(dom.get_attr("input[aria-label='Search for anything']", "value"))
  return value and M.normalize_query(value) == M.normalize_query(query) or false
end

function M.navigate_search(query)
  if M.current_search_matches(query) then return end
  if nav and type(nav.clear_beforeunload) == "function" then nav.clear_beforeunload() end
  nav.navigate(M.SEARCH_URL, { _nkw = query }, { reload = true })
end

function M.navigate_product(product_id)
  if M.product_page_matches(product_id) then return end
  if nav and type(nav.clear_beforeunload) == "function" then nav.clear_beforeunload() end
  nav.navigate(M.item_url(product_id), {}, { reload = true })
end

function M.first_text(selectors)
  for index = 1, #selectors do
    local value = M.non_empty(dom.get_text(selectors[index]))
    if value then return value end
  end
  return nil
end

function M.parse_shipping(value, fallback_currency)
  local text = M.non_empty(value)
  if not text then return nil, fallback_currency, nil end
  local lowered = text:lower()
  if lowered:find("free shipping", 1, true)
      or lowered:find("free postage", 1, true)
      or lowered:find("shipping: free", 1, true)
      or lowered:find("무료 배송", 1, true)
      or lowered:find("배송비 무료", 1, true) then
    return 0, fallback_currency, text
  end

  local at = lowered:find("shipping", 1, true)
    or lowered:find("postage", 1, true)
    or lowered:find("배송비", 1, true)
  if not at then return nil, fallback_currency, text end
  local fragment = text:sub(at)
  local amount, currency = M.parse_price(fragment)
  return amount, currency or fallback_currency, fragment
end

function M.result_fields()
  return {
    url = { selector = ".su-link.su-item-card__title, .su-item-card__title, a[href*='/itm/']", attr = "href" },
    title = { selector = ".su-item-card__title .su-styled-text, .su-item-card__title, a[href*='/itm/']" },
    image_alt = { selector = "img", attr = "alt" },
    price_text = { selector = ".su-item-card__price, .s-item__price" },
    image_url = { selector = "img.s-item__image-img, .su-card-container__media img, img", attr = "src" },
    condition = { selector = ".su-item-card__subtitle .secondary, .su-item-card__header .secondary, .SECONDARY_INFO" },
    attributes_text = { selector = ".su-card-container__attributes__primary, .s-item__details" },
    seller_text = { selector = ".su-card-container__attributes__secondary, .s-item__seller-info-text" },
    text = true
  }
end

function M.candidate_from_row(row)
  local item_id = M.parse_item_id(row.url)
  local name = M.non_empty(row.image_alt) or M.non_empty(row.title)
  local row_text = M.clean_text(row.text)
  local lowered = row_text:lower()
  if not item_id or not name or name:lower() == "shop on ebay" then return nil end
  local sponsored = lowered:find("sponsored", 1, true) ~= nil
    or lowered:find("서폰스", 1, true) ~= nil

  local price, currency = M.parse_price(row.price_text)
  if not price or not currency then return nil end
  local shipping_cost, shipping_currency, shipping_text = M.parse_shipping(
    M.non_empty(row.attributes_text) or row_text,
    currency
  )
  local seller_text = M.non_empty(row.seller_text)
  local seller_rating = seller_text and tonumber(seller_text:match("(%d+%.?%d*)%%")) or nil
  local return_terms = nil
  if lowered:find("free returns", 1, true) or lowered:find("무료 반품", 1, true) then
    return_terms = lowered:find("무료 반품", 1, true) and "무료 반품" or "Free returns"
  end

  return {
    product_id = item_id,
    id = item_id,
    name = name,
    url = M.item_url(item_id),
    image_url = M.non_empty(row.image_url),
    price = price,
    price_text = M.non_empty(row.price_text),
    currency = currency,
    shipping_cost = shipping_cost,
    shipping_text = shipping_text,
    shipping_currency = shipping_currency,
    condition = M.non_empty(row.condition),
    return_terms = return_terms,
    seller_rating_percent = seller_rating,
    review_count = M.parse_review_count(seller_text),
    sponsored = sponsored,
    summary = (#row_text > 320) and (row_text:sub(1, 319) .. "…") or row_text
  }
end

function M.read_candidates()
  local rows = dom.query_all(M.RESULT_SELECTOR, M.result_fields(), M.RESULT_LIMIT)
  local candidates = (ax and type(ax.array) == "function") and ax.array() or {}
  local seen = {}
  for index = 1, #rows do
    local candidate = M.candidate_from_row(rows[index] or {})
    if candidate and not seen[candidate.product_id] then
      seen[candidate.product_id] = true
      candidates[#candidates + 1] = candidate
    end
  end
  return candidates
end

function M.read_total_count(fallback)
  local text = M.first_text({ ".srp-controls__count-heading", ".srp-controls__count", "h1.srp-controls__count-heading" }) or ""
  local largest = tonumber(fallback) or 0
  for token in text:gmatch("[%d,]+") do
    local value = tonumber((token:gsub(",", "")))
    if value and value > largest then largest = value end
  end
  return largest
end

function M.read_product_price(expected_currency)
  local price_text = M.non_empty(dom.get_text(M.PRODUCT_PRICE_SELECTOR))
  local price, currency = M.parse_price(price_text)
  local expected = M.non_empty(expected_currency)
  if expected and currency and currency:upper() ~= expected:upper() then
    local approximate_text = M.non_empty(dom.get_text(M.PRODUCT_APPROX_PRICE_SELECTOR))
    local approximate_price, approximate_currency = M.parse_price(approximate_text)
    if approximate_price and approximate_currency and approximate_currency:upper() == expected:upper() then
      return approximate_price, approximate_currency, approximate_text
    end
  end
  return price, currency, price_text
end

if AX_COMMERCE and type(AX_COMMERCE.register_adapter) == "function" then
  AX_COMMERCE.register_adapter("ebay", {
    home_url = M.HOME_URL,
    host_matches = M.host_matches,
    search = function(args)
      if type(AX_search_product) ~= "function" then return { error = "search_unsupported" } end
      return AX_search_product(args)
    end,
    add_to_cart = function(args)
      if type(AX_add_to_cart) ~= "function" then return { added = false, error = "add_to_cart_unsupported" } end
      return AX_add_to_cart(args)
    end
  })
end
