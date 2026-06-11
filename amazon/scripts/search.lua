local M = AX_AMAZON
if not M then
  error("amazon/scripts/00_common.lua must be loaded before search.lua")
end

function AX_search_product(args)
  args = args or {}
  local query = M.non_empty(args.query or args.regex)
  local cursor = M.non_empty(args.cursor)

  local navigated = M.navigate_search_if_needed(query, cursor)
  if navigated then
    return {
      total_count = 0,
      candidates = ax.array(),
      cursor = cursor or false,
      error = "navigation_pending"
    }
  end

  dom.wait_for_selector(M.RESULT_READY_SELECTOR, { timeout = 30000 })

  if dom.exists('form[action*="validateCaptcha"]') then
    return {
      total_count = 0,
      candidates = ax.array(),
      cursor = false,
      error = "captcha_required"
    }
  end

  local candidates = M.read_candidates()
  return {
    total_count = M.read_total_count(#candidates),
    candidates = candidates,
    cursor = M.read_next_cursor() or false
  }
end
