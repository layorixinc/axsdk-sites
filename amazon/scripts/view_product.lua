local M = AX_AMAZON
if not M then
  error("amazon/scripts/00_common.lua must be loaded before view_product.lua")
end

function AX_view_product(args)
  args = args or {}
  local product_id = M.normalize_product_id(args.product_id or args.id or args.asin)
  if not product_id then
    return {
      error = "missing_product_id"
    }
  end

  local navigated = M.navigate_product_if_needed(product_id)
  if navigated then
    return {
      product_id = product_id,
      error = "navigation_pending"
    }
  end

  dom.wait_for_selector(M.PRODUCT_READY_SELECTOR, { timeout = 30000 })

  if dom.exists('form[action*="validateCaptcha"]') then
    return {
      product_id = product_id,
      error = "captcha_required"
    }
  end

  return M.read_product_view(product_id)
end
