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
  -- TEMP DIAGNOSTIC v2: catch each step's error into the mapped query field; avoid ax.array() in the
  -- return so a missing `ax` global cannot blank the whole result.
  args = args or {}
  local parts = {}
  parts[#parts + 1] = "q=" .. (M.non_empty(args.query) or "NIL")
  local oku, u = pcall(function() return M.current_url() end)
  parts[#parts + 1] = oku and ("url=" .. tostring(u)) or ("urlERR=" .. tostring(u))
  local oka, ae = pcall(function() return ax.array() end)
  parts[#parts + 1] = oka and "ax=ok" or ("axERR=" .. tostring(ae))
  local okr, nc = pcall(function() return #M.read_search_candidates() end)
  parts[#parts + 1] = okr and ("cards=" .. tostring(nc)) or ("readERR=" .. tostring(nc))
  return {
    status = "completed",
    query = table.concat(parts, " | "),
    zip_code = "DIAG",
    total_count = 0,
    candidates = {},
    cursor = false
  }
end
