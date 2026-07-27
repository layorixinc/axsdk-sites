local M = AX_EBAY
if not M then
  error("ebay/scripts/00_common.lua must be loaded before search.lua")
end

function AX_search_product(args)
  args = args or {}
  local query = M.non_empty(args.query or args.regex)
  local empty = (ax and type(ax.array) == "function") and ax.array() or {}
  if not query then
    return { total_count = 0, candidates = empty, error = "missing_query" }
  end
  local page = math.max(1, math.floor(tonumber(args.page) or 1))
  local plan = AX_PAGINATION.plan_page({ mode = "query", param = "_pgn", start = 1, step = 1, max_pages = 2 }, page)
  if not plan.supported then
    return { total_count = 0, candidates = empty, page = page, has_more = false, error = plan.error }
  end

  M.navigate_search(query, page)
  dom.wait_for_selector(M.RESULT_READY_SELECTOR, { timeout = 10000 })

  if M.is_captcha_page() then
    return {
      total_count = 0,
      candidates = (ax and type(ax.array) == "function") and ax.array() or {},
      page = page,
      has_more = false,
      error = "captcha_required"
    }
  end
  if M.is_login_page() then return M.login_required_result() end

  local candidates = M.read_candidates()
  return {
    total_count = M.read_total_count(#candidates),
    candidates = candidates,
    cursor = false,
    page = page,
    has_more = #candidates > 0 and dom.exists('a[type="next"], a.pagination__next') == true,
    pagination_supported = true
  }
end
