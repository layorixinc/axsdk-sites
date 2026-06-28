local M = AX_THUMBTACK
if not M then
  error("thumbtack/scripts/00_common.lua must be loaded before search_service.lua")
end

-- Read the candidates on an already-loaded results page. Close any project-questions/search overlay
-- first so the pro list is readable, then poll briefly for it to hydrate. The invalid-ZIP banner is
-- checked on EVERY poll iteration: for a bad ZIP, Thumbtack shows "Enter a valid zip code" and never
-- renders pros, so it must be detected with a NON-suspending poll. A blocking dom.wait_for_selector
-- would suspend the durable step until its deadline (returning pending) and never reach the banner
-- check -- that is what made the search self-loop. dom.wait is a bounded sleep, so the poll stays
-- under the per-call deadline and returns status="navigating" (prompting a re-call) while loading.
local function read_loaded(query, zip_code, timeout)
  M.dismiss_modals()
  local function rejected_zip()
    return {
      query = query,
      zip_code = zip_code,
      error = "invalid_zip",
      zip_status = "invalid_zip",
      message = "Thumbtack rejected the ZIP code as invalid. Ask the user for a valid US ZIP code or a more specific city and state."
    }
  end
  local candidates = M.read_search_candidates()
  local tries = 0
  local max_tries = math.max(1, math.floor((timeout or 3000) / 300))
  while #candidates == 0 and tries < max_tries do
    if M.zip_rejected() then
      return rejected_zip()
    end
    dom.wait(300)
    M.dismiss_modals()
    candidates = M.read_search_candidates()
    tries = tries + 1
  end
  if #candidates == 0 and M.zip_rejected() then
    return rejected_zip()
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
