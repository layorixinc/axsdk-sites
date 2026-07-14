local M = AX_EBAY
if not M then
  error("ebay/scripts/00_common.lua must be loaded before add_to_cart.lua")
end

local function cart_or_confirmation_page(product_id)
  if dom.exists("[data-test-id='ADD_TO_CART_CONFIRMATION']") then return true end
  local href = M.non_empty(dom.get_location_href()) or ""
  if href:find("cart.payments.ebay.com", 1, true) == nil
      and href:find("cart.ebay.com", 1, true) == nil
      and not dom.exists(M.CART_CONFIRM_SELECTOR) then
    return false
  end
  local id = tostring(product_id or ""):gsub("[^%d]", "")
  return id ~= "" and dom.exists("a[href*='/itm/" .. id .. "'], a[href*='item=" .. id .. "']")
end

local function read_confirmation()
  return M.first_text({
    "[data-test-id='ADD_TO_CART_CONFIRMATION']",
    "[data-test-id='cart-item']",
    ".cart-bucket-lineitem",
    ".cart-bucket"
  })
end

local function validate_price(args, product_id)
  local expected = tonumber(args.expected_unit_price)
  local expected_currency = M.non_empty(args.expected_currency)
  if not expected and not expected_currency then return nil end

  local current, currency, price_text = M.read_product_price(expected_currency)
  if not current or not currency then
    return {
      product_id = product_id,
      added = false,
      error = "price_revalidation_failed",
      current_price_text = price_text
    }
  end
  if expected_currency and currency:upper() ~= expected_currency:upper() then
    return {
      product_id = product_id,
      added = false,
      error = "currency_changed",
      expected_currency = expected_currency:upper(),
      current_currency = currency:upper(),
      current_price = current,
      current_price_text = price_text
    }
  end
  if expected and current > expected + 0.005 then
    return {
      product_id = product_id,
      added = false,
      error = "price_changed",
      expected_unit_price = expected,
      current_price = current,
      current_currency = currency,
      current_price_text = price_text
    }
  end
  return nil
end

function AX_add_to_cart(args)
  args = args or {}
  local product_id = M.parse_item_id(args.product_id or args.id)
  if not product_id then return { added = false, error = "missing_product_id" } end

  local post_add = cart_or_confirmation_page(product_id) or M.is_login_page() or M.is_captcha_page()
  if not post_add then
    M.navigate_product(product_id)
    dom.wait_for_selector(M.PRODUCT_READY_SELECTOR, { timeout = 10000 })

    if M.is_captcha_page() then return { product_id = product_id, added = false, error = "captcha_required" } end
    if M.is_login_page() then return M.login_required_result() end
    if not M.product_page_matches(product_id) then
      return { product_id = product_id, added = false, error = "product_navigation_failed" }
    end

    local stale = validate_price(args, product_id)
    if stale then return stale end

    local quantity = math.max(1, math.floor(tonumber(args.quantity) or 1))
    if quantity > 1 then
      local quantity_selector = nil
      if dom.exists("#qtyTextBox") then quantity_selector = "#qtyTextBox"
      elseif dom.exists("input[name='quantity']") then quantity_selector = "input[name='quantity']" end
      if not quantity_selector then
        return { product_id = product_id, added = false, error = "quantity_unavailable" }
      end
      dom.set_value(quantity_selector, tostring(quantity))
    end

    if not dom.exists(M.ADD_SELECTOR) then
      return { product_id = product_id, added = false, error = "add_to_cart_unavailable" }
    end
    local clicked = dom.click(M.ADD_SELECTOR)
    if clicked ~= true then
      return { product_id = product_id, added = false, error = "click_failed" }
    end
    dom.wait_for_selector(M.ADD_READY_SELECTOR, { timeout = 10000 })
  end

  if M.is_captcha_page() then return { product_id = product_id, added = false, error = "captcha_required" } end
  if M.is_login_page() then return M.login_required_result() end

  local confirmed = cart_or_confirmation_page(product_id)
  local add_error = nil
  if not confirmed then add_error = "add_to_cart_pending" end
  return {
    product_id = product_id,
    added = confirmed,
    pending = not confirmed,
    error = add_error,
    confirmation = confirmed and read_confirmation() or nil,
    cart_url = confirmed and M.non_empty(dom.get_location_href()) or nil
  }
end
