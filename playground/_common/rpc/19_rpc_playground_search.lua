--- The playground's storefront search, over RPC.
---
--- Separate from `18_rpc_playground.lua` because this one needs the storefront reader and the generated
--- site data (~70 KiB together), and `clientFlows` INLINES every declared module PER TOOL against a
--- 256 KiB ceiling. The checkpoint calls one op; it must not pay for a reader it never touches.

AX_RPC_PLAYGROUND_SEARCH = AX_RPC_PLAYGROUND_SEARCH or {}
local Q = AX_RPC_PLAYGROUND_SEARCH

local S = AX_RPC_STOREFRONT
if not S then
  error("_common/rpc/61_rpc_storefront.lua must be loaded before 19_rpc_playground_search.lua")
end

local P = AX_RPC_PLAYGROUND
if not P then
  error("_common/rpc/18_rpc_playground.lua must be loaded before 19_rpc_playground_search.lua")
end

--- One storefront search, in the shape the playground flows already read.
---
--- `site` may arrive flat or as the worker's `item.site`, `query` flat or as `context.query` — the same
--- envelope the production fan-out uses, where reading only the flat key made every store refuse.
function Q.search(args)
  args = type(args) == "table" and args or {}
  local context = type(args.context) == "table" and args.context or {}
  local site = P.site_of(args) or "amazon"
  local query = args.query
  if type(query) ~= "string" or query == "" then query = context.query end

  local config, refusal = P.config_for(site)
  if not config then
    return { next = "error", site = site, search_error = refusal, error = refusal }
  end
  if type(query) ~= "string" or query == "" then
    return { next = "error", site = config.site, search_error = "missing_query", error = "missing_query" }
  end

  local result = S.search(config, { query = query })
  local candidates = type(result.candidates) == "table" and result.candidates or nil
  -- Absent, never empty: an empty Lua table encodes as a JSON object and fails every array schema it
  -- reaches — in the production fan-out that turned "no matches" into a technical failure for a store.
  if candidates and #candidates == 0 then candidates = nil end

  return {
    -- The script picks its own branch and the tool passes it through.
    next = (result.next == "ok" and candidates) and "done" or "error",
    site = config.site,
    query = query,
    candidates = candidates,
    total_count = result.cards_seen,
    cursor = result.has_more and "more" or nil,
    search_error = result.error or ((not candidates) and "no_results" or nil),
    store_result = result,
  }
end
