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

  local page_error = M.ensure_product_page(product_id)
  if page_error then
    return page_error
  end

  return M.read_product_view(product_id)
end
