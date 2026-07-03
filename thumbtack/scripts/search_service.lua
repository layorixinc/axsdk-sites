local M = AX_THUMBTACK
if not M then
  error("thumbtack/scripts/00_common.lua must be loaded before search_service.lua")
end

-- Read the candidates on the loaded results page. Overlays (project-questions / search popups) are
-- closed and the invalid-ZIP banner is checked on every poll (non-suspending). Load-determination uses
-- M.wait_settled: poll the pro-count fingerprint until it stops changing (quiescence), so we read the
-- FINAL hydrated list -- never a mid-transition hub/empty. Outcomes are terminal (no durable re-call):
-- settled-with-pros -> completed; settled-empty (unrecognized service/slug) -> no_results; ZIP banner
-- -> invalid_zip. dom.wait is a bounded sleep, so the whole read stays under the per-call deadline.
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
  -- Fingerprint: "zipbad" when the invalid-ZIP banner shows, else the deduped pro-card count. Settle
  -- returns once this is stable for the quiet window (or on timeout); overlays are closed each poll.
  local function probe()
    M.dismiss_modals()
    if M.zip_rejected() then
      return "zipbad"
    end
    return #M.read_search_candidates()
  end
  M.wait_settled(probe, { timeout = timeout or 8000, quiet = 600, interval = 300 })
  if M.zip_rejected() then
    return rejected_zip()
  end
  local candidates = M.read_search_candidates()
  if #candidates == 0 then
    -- Defensive hardening (wait_settled stability): wait_settled settles on quiescence, so a results
    -- surface that renders pro cards AFTER a stable-empty window (client-fetched, non-SSR) could settle
    -- at 0 and misreport no_results. Thumbtack /k/ SSRs its cards, so candidates > 0 already here and
    -- this block never fires in practice; but if a future surface hydrates late, give the pro-list card
    -- marker ONE bounded chance to mount, then re-settle and re-read. Gated to a real results page so an
    -- invalid/unrecognized query (not on a results page) still returns no_results fast -- no added wait.
    local page = (type(AX_detect_page) == "function") and AX_detect_page() or {}
    if (page.page == "category_results" or page.page == "instant_results")
      and dom.wait_for_selector('[data-test="pro-list-result"], [data-testid="pro-list-result"]', { timeout = 2500 }) == true then
      M.wait_settled(probe, { timeout = 3000, quiet = 400, interval = 300 })
      candidates = M.read_search_candidates()
    end
  end
  if #candidates == 0 then
    -- Settled with an empty list and no ZIP banner: the service term did not resolve to a Thumbtack
    -- category with pros (unrecognized query/slug). Terminal no_results so the flow routes there and
    -- asks the user to rephrase, instead of looping the durable read.
    return {
      query = query,
      zip_code = zip_code,
      status = "no_results",
      error = "no_results",
      candidates = {},
      total_count = 0,
      message = "No pros found for this service in the given area. The service term may be unrecognized; ask the user to rephrase it as a common service (e.g. \"house cleaning\", \"lawn care\", \"plumbing\")."
    }
  end
  return {
    query = query,
    zip_code = zip_code,
    status = "completed",
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

  -- Sense: page identity + readiness come from the single detector, never from ad-hoc DOM reads. The
  -- fast path fires only when we are already on THIS query's category results page (/k/<slug>/) with a
  -- matching zip -- a stale /instant-results/ or a different-service page is deliberately NOT a match,
  -- so a different-service request re-searches instead of reading stale pros.
  local want = M.category_slug(query)
  local page = (type(AX_detect_page) == "function") and AX_detect_page() or {}
  local zip_ok = not (zip_code and page.zip_code and page.zip_code ~= zip_code)
  if page.page == "category_results" and want ~= "" and page.slug == want and zip_ok then
    return read_loaded(query, zip_code)
  end

  -- Otherwise fire a fresh full-reload search and re-enter. start_search is a durable navigating step:
  -- the command suspends across the reload and, on resume, either the fast path above matches the loaded
  -- /k/<slug>/ page, or start_search fast-forwards (cached) to the read below (covers a canonical-slug
  -- redirect where the URL slug differs from the query slug).
  M.start_search(query, zip_code)
  return read_loaded(query, zip_code)
end
