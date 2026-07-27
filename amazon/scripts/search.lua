local M = AX_AMAZON
if not M then
  error("amazon/scripts/00_common.lua must be loaded before search.lua")
end

-- Amazon paginates through `page=` on the same search URL, and its own next-page control is the
-- authoritative "is there more" signal. `page` is the shared adapter contract; `cursor` stays supported
-- because Amazon's navigator also accepts the raw next-page href.
function AX_search_product(args)
  args = args or {}
  local query = M.non_empty(args.query or args.regex)
  local page = math.max(1, math.floor(tonumber(args.page) or 1))
  local plan = AX_PAGINATION.plan_page({ mode = "query", param = "page", start = 1, step = 1, max_pages = 2 }, page)
  if not plan.supported then
    return { total_count = 0, candidates = ax.array(), cursor = false, page = page, has_more = false, error = plan.error }
  end
  local cursor = M.non_empty(args.cursor) or (page > 1 and tostring(page) or nil)

  M.navigate_search(query, cursor)

  dom.wait_for_selector(M.RESULT_READY_SELECTOR, { timeout = 8000 })

  if dom.exists('form[action*="validateCaptcha"]') then
    return {
      total_count = 0,
      candidates = ax.array(),
      cursor = false,
      page = page,
      has_more = false,
      error = "captcha_required"
    }
  end

  if M.is_login_page() then
    return M.login_required_result()
  end

  local candidates = M.read_candidates(query)
  local next_cursor = M.read_next_cursor() or false
  return {
    total_count = M.read_total_count(#candidates),
    candidates = candidates,
    cursor = next_cursor,
    page = page,
    has_more = next_cursor ~= false and #candidates > 0,
    pagination_supported = true
  }
end
