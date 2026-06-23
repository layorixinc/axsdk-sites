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

  -- Two-phase search. Reading and navigating are split across calls so the durable call never
  -- suspends across the results-page navigation (the SDK's cross-navigation resume is slow). When
  -- already on the results page, read candidates; otherwise fire the search funnel and return
  -- status="navigating" so the caller can wait for the results page and call again to read.
  if M.current_results_match(query, zip_code) then
    dom.wait_for_selector(M.RESULT_READY_SELECTOR, { timeout = 6000 })
    M.dismiss_modals()
    -- Same-page poll (no navigation) so one read call returns candidates as the list hydrates,
    -- instead of forcing the caller into several round trips.
    local candidates = M.read_search_candidates()
    local tries = 0
    while #candidates == 0 and tries < 4 do
      dom.wait(500)
      candidates = M.read_search_candidates()
      tries = tries + 1
    end
    return {
      query = query,
      zip_code = zip_code,
      status = #candidates > 0 and "completed" or "navigating",
      candidates = candidates,
      total_count = #candidates,
      service_options = M.read_service_options(),
      cursor = false
    }
  end

  M.start_search(query, zip_code)
  return {
    query = query,
    zip_code = zip_code,
    status = "navigating",
    candidates = ax.array(),
    total_count = 0,
    cursor = false
  }
end
