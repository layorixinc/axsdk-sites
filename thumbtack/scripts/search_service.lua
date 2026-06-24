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

  -- Navigate directly to the category results page, then read in the same call. start_search uses
  -- nav.navigate (a durable await step), so the command suspends across the navigation and on resume
  -- replays from the top -- where current_results_match is now true and the read branch above returns
  -- the loaded pros. Direct navigation to a fixed URL is deterministic, so the replay re-uses the
  -- cached nav step and never bounces; the read below also covers a resume that continues in place.
  M.start_search(query, zip_code)
  return read_loaded(query, zip_code, 15000)
end
