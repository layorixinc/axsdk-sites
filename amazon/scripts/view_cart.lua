local M = AX_AMAZON
if not M then
  error("amazon/scripts/00_common.lua must be loaded before view_cart.lua")
end

function AX_view_cart(args)
  args = args or {}

  local navigated = M.navigate_cart_if_needed()
  if navigated then
    return {
      pending = true,
      error = "navigation_pending"
    }
  end

  dom.wait_for_selector(M.CART_READY_SELECTOR, { timeout = 30000 })

  if dom.exists('form[action*="validateCaptcha"]') then
    return {
      error = "captcha_required"
    }
  end

  return M.read_cart_view()
end
