local M = AX_PLAYGROUND_AMAZON
if not M then
  error("playground/amazon/scripts/00_amazon.lua must load before 10_search.lua")
end

local D = AX_PLAYGROUND_DURABLE
if type(D) ~= "table" then
  error("playground/_common/scripts/05_durable.lua must load before playground/amazon/scripts/10_search.lua")
end

local SITE = "amazon"

-- Playground's durable implementation of the repository-standard Amazon search command.
-- Host grant required for positive runs:
--   { command = "AX_search_product", checkpointMaxBytes = 64 * 1024 }
--
-- The phase is business intent only. The durable journal is authoritative for whether
-- nav.navigate and the two waits have already completed during replay.
function AX_search_product(args)
  args = type(args) == "table" and args or {}
  local requested = M.non_empty(args.query or args.regex)
  if not requested then return { ok = false, site = SITE, error = "query_required", candidates = ax.array() } end


  local snapshot, open_error = D.open({ schema = 1, initial = {
    phase = "prepare",
    query = requested,
    candidates = ax.array(),
    total_count = 0,
    cursor = false,
  }})
  if not snapshot then return open_error end

  if snapshot.value.phase == "prepare" then
    local saved, save_error = D.save(snapshot, {
      phase = "navigation_armed",
      query = snapshot.value.query,
      candidates = snapshot.value.candidates,
      total_count = snapshot.value.total_count,
      cursor = snapshot.value.cursor,
    })
    if not saved then return save_error end
    snapshot = saved
  end

  if snapshot.value.phase == "navigation_armed" then
    -- The phase records intent, not effect completion. Detect the actual results document before
    -- navigating so replay or an explicit re-invocation never fires an already-complete search again.
    if not M.current_search_matches(snapshot.value.query) then
      local navigation = nav.navigate(M.SEARCH_URL, { k = snapshot.value.query })
      if type(navigation) ~= "table" or navigation.ok ~= true then
        navigation = type(navigation) == "table" and navigation or { ok = false, error = "search_navigation_failed" }
        navigation.site = SITE
        navigation.query = snapshot.value.query
        navigation.candidates = navigation.candidates or ax.array()
        navigation.total_count = navigation.total_count or 0
        navigation.cursor = navigation.cursor or false
        return navigation
      end
    end
    snapshot, open_error = D.open({ schema = 1 })
    if not snapshot then return open_error end
    if snapshot.value.phase == "navigation_armed" then
      local saved, save_error = D.save(snapshot, {
        phase = "await_results",
        query = snapshot.value.query,
        candidates = snapshot.value.candidates,
        total_count = snapshot.value.total_count,
        cursor = snapshot.value.cursor,
      })
      if not saved then return save_error end
      snapshot = saved
    end
  end

  if snapshot.value.phase == "await_results" then
    dom.wait_for_selector(M.RESULT_READY_SELECTOR, { timeout = 30000 })

    if M.is_captcha_page() then
      return {
        ok = false,
        site = SITE,
        error = "captcha_required",
        query = snapshot.value.query,
        candidates = ax.array(),
        total_count = 0,
        cursor = false,
      }
    end

    if M.is_login_page() then
      local login = M.login_required_result()
      login.site = SITE
      login.query = snapshot.value.query
      login.total_count = 0
      login.cursor = false
      return login
    end

    dom.wait_settled(nil, {
      root = M.RESULT_ROOT_SELECTOR,
      quiet = 400,
      timeout = 30000,
    })

    local candidates = M.read_candidates(snapshot.value.query)
    local saved, save_error = D.save(snapshot, {
      phase = "extracted",
      query = snapshot.value.query,
      candidates = candidates,
      total_count = M.read_total_count(#candidates),
      cursor = M.read_next_cursor() or false,
    })
    if not saved then return save_error end
    snapshot = saved
  end

  if snapshot.value.phase == "extracted" then
    return {
      site = SITE,
      ok = true,
      query = snapshot.value.query,
      candidates = snapshot.value.candidates,
      total_count = snapshot.value.total_count,
      cursor = snapshot.value.cursor or false,
      phase = snapshot.value.phase,
      revision = snapshot.revision,
    }
  end

  return { ok = false, site = SITE, error = "unexpected_search_phase", phase = snapshot.value.phase, candidates = ax.array() }
end
