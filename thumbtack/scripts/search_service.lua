local M = AX_THUMBTACK
if not M then
  error("thumbtack/scripts/00_common.lua must be loaded before search_service.lua")
end

-- Read the candidates on an already-loaded results page. Close any project-questions/search overlay
-- first so the pro list is readable, then wait briefly for it to hydrate. The wait stays under the SDK
-- per-call deadline so the call returns status="navigating" (prompting a re-call) rather than timing
-- out pending when the list is still loading.
local function read_loaded(query, zip_code, timeout)
  M.dismiss_modals()
  dom.wait_for_selector(M.RESULT_READY_SELECTOR, { timeout = timeout or 3000 })
  M.dismiss_modals()
  local candidates = M.read_search_candidates()
  local tries = 0
  while #candidates == 0 and tries < 2 do
    dom.wait(300)
    candidates = M.read_search_candidates()
    tries = tries + 1
  end
  if #candidates == 0 and M.zip_rejected() then
    -- Invalid/unsupported ZIP: Thumbtack shows "Enter a valid zip code" and never renders pros.
    -- Return the proven error shape (an `error` field, no status) so the search contract routes to
    -- its `error` outcome -> the no_results terminal, instead of "navigating" which self-loops to
    -- exhaustion. Fast-fails here rather than burning the per-call result wait every loop.
    return {
      query = query,
      zip_code = zip_code,
      error = "invalid_zip",
      zip_status = "invalid_zip",
      message = "Thumbtack rejected the ZIP code as invalid. Ask the user for a valid US ZIP code or a more specific city and state."
    }
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
    return read_loaded(query, zip_code)
  end

  -- Not on the results page yet: submit the homepage search box. start_search ends in a durable
  -- navigating step (dom.submit_form -> requestSubmit), so the command suspends across the navigation
  -- and on resume replays from the top, where current_results_match is now true and the read branch
  -- above returns the loaded pros. The read below covers a resume that continues in place.
  M.start_search(query, zip_code)
  return read_loaded(query, zip_code)
end
