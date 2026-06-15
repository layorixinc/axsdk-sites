local M = AX_AMAZON
if not M then
  error("amazon/scripts/00_common.lua must be loaded before checkout.lua")
end

local function on_checkout_page()
  local href = M.non_empty(dom.get_location_href()) or ""
  return href:find("/gp/buy/", 1, true) ~= nil
    or href:find("/checkout/", 1, true) ~= nil
    or dom.exists("#submitOrderButtonId")
    or dom.exists("#deliver-to-customer-text")
    or dom.exists("#subtotals")
    or dom.exists("#spc-orders")
end

function AX_checkout(args)
  args = args or {}

  M.navigate_cart()
  dom.wait_for_selector(M.CART_READY_SELECTOR, { timeout = 30000 })

  if dom.exists('form[action*="validateCaptcha"]') then
    return {
      error = "captcha_required"
    }
  end

  if M.is_login_page() then
    return M.login_required_result()
  end

  if M.cart_page_matches() then
    local cart = M.read_cart_view()
    if cart.empty then
      return {
        status = "cart_empty",
        error = "cart_empty",
        item_count = cart.item_count
      }
    end
    if not dom.exists(M.CHECKOUT_BUTTON_SELECTOR) then
      return {
        status = "checkout_unavailable",
        error = "checkout_unavailable",
        item_count = cart.item_count
      }
    end
  end

  dom.click(M.CHECKOUT_BUTTON_SELECTOR)
  dom.wait_for_selector(M.CHECKOUT_READY_SELECTOR, { timeout = 30000 })

  if dom.exists('form[action*="validateCaptcha"]') then
    return {
      error = "captcha_required"
    }
  end

  if M.is_login_page() then
    return M.login_required_result()
  end

  if on_checkout_page() then
    return {
      status = "checkout",
      login_required = false,
      url = M.non_empty(dom.get_location_href()),
      checkout = M.read_checkout_view()
    }
  end

  return {
    status = "checkout_pending",
    login_required = false,
    url = M.non_empty(dom.get_location_href())
  }
end
