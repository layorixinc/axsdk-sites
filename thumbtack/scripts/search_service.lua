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
  -- TEMP DIAGNOSTIC: report what the flow's remote execution context sees, via mapped fields.
  args = args or {}
  local q = M.non_empty(args.query) or "NOQUERY"
  local z = M.non_empty(args.zip_code) or "NOZIP"
  local okurl, url = pcall(function() return M.current_url() end)
  local okc, ncards = pcall(function() return #M.read_search_candidates() end)
  return {
    status = "completed",
    query = "DIAG q=" .. q .. " z=" .. z,
    zip_code = "url=" .. (okurl and tostring(url) or ("err:" .. tostring(url))),
    total_count = okc and ncards or -1,
    candidates = ax.array(),
    service_options = ax.array(),
    cursor = false
  }
end
