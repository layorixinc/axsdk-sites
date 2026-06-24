local M = AX_THUMBTACK
if not M then
  error("thumbtack/scripts/00_common.lua must be loaded before search_service.lua")
end

-- Read the candidates on an already-loaded results page, polling briefly while the list hydrates.
local function read_loaded(query, zip_code, timeout)
  dom.wait_for_selector(M.RESULT_READY_SELECTOR, { timeout = timeout or 6000 })
  M.dismiss_modals()
  local candidates = M.read_search_candidates()
  local tries = 0
  while #candidates == 0 and tries < 6 do
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

  -- Already on the matching results page: read candidates with a same-page poll (no navigation).
  if M.current_results_match(query, zip_code) then
    return read_loaded(query, zip_code, 6000)
  end

  M.start_search(query, zip_code)

  -- Single-call mode (wait=true): one remote call does the whole search. The durable call suspends
  -- across the results-page navigation and resumes here to read, so the candidates come back in the
  -- same call. The flow engine needs this: splitting the search across two nodes makes the second
  -- call replay the durable navigation steps and bounce back to the home page, so it never reads.
  if args.wait then
    return read_loaded(query, zip_code, 15000)
  end

  -- Two-phase mode (default): fire the funnel and return status="navigating" so the caller waits for
  -- the results page and calls again to read. Keeps the durable call from suspending across the slow
  -- cross-navigation resume (used by the live test harness).
  return {
    query = query,
    zip_code = zip_code,
    status = "navigating",
    candidates = ax.array(),
    total_count = 0,
    cursor = false
  }
end
