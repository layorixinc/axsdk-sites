local M = AX_THUMBTACK
if not M then
  error("thumbtack/scripts/00_common.lua must be loaded before search_service.lua")
end

function AX_search_service(args)
  args = args or {}
  local query = M.non_empty(args.query)
  if not query then
    return {
      error = "missing_query"
    }
  end

  local cursor = M.non_empty(args.cursor)
  if cursor then
    if M.current_url() ~= cursor then
      nav.navigate(cursor, {})
      return {
        pending = true,
        error = "navigation_pending",
        cursor = cursor
      }
    end
  end

  local zip_result = M.resolve_zip(args)
  if zip_result.pending then
    return zip_result
  end
  if zip_result.error then
    return zip_result
  end
  local zip_code = zip_result.zip_code

  if not M.current_results_match(query, zip_code) then
    M.start_search(query, zip_code)
    return {
      pending = true,
      error = "navigation_pending",
      zip_code = zip_code
    }
  end

  dom.wait_for_selector(M.RESULT_READY_SELECTOR, { timeout = 30000 })
  M.dismiss_modals()
  local candidates = M.read_search_candidates()

  return {
    query = query,
    zip_code = zip_code,
    candidates = candidates,
    total_count = #candidates,
    service_options = M.read_service_options(),
    cursor = false
  }
end
