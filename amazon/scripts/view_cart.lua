local M = AX_AMAZON
if not M then
  error("amazon/scripts/00_common.lua must be loaded before view_cart.lua")
end

function AX_view_cart(args)
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

  return M.read_cart_view()
end
