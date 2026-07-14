local M = AX_EBAY
if not M then
  error("ebay/scripts/00_common.lua must be loaded before search.lua")
end

function AX_search_product(args)
  args = args or {}
  local query = M.non_empty(args.query or args.regex)
  if not query then
    return {
      total_count = 0,
      candidates = (ax and type(ax.array) == "function") and ax.array() or {},
      error = "missing_query"
    }
  end

  M.navigate_search(query)
  dom.wait_for_selector(M.RESULT_READY_SELECTOR, { timeout = 10000 })

  if M.is_captcha_page() then
    return {
      total_count = 0,
      candidates = (ax and type(ax.array) == "function") and ax.array() or {},
      error = "captcha_required"
    }
  end
  if M.is_login_page() then return M.login_required_result() end

  local candidates = M.read_candidates()
  return {
    total_count = M.read_total_count(#candidates),
    candidates = candidates,
    cursor = false
  }
end
