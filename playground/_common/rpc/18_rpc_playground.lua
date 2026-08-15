--- The playground's light entries: opening a mapped origin, and the op-grant checkpoint.
---
--- These replace two durable commands (`AX_playground_open_site`,
--- `AX_playground_durable_checkpoint`). The playground was the last place durable survived, and it was
--- not a clean split: a runtime twin already sat beside tools that still went the durable way to do the
--- same job. Two paths for one job is the drift this repo keeps paying for.
---
--- NO load-time dependency, on purpose. The playground delivers flows through `clientFlows`, where every
--- declared module is INLINED PER TOOL — so a module's dependency list is multiplied by the number of
--- tools that declare it, and the document has a 256 KiB ceiling. Pulling the storefront reader in here
--- would cost the checkpoint ~70 KiB to call one op. Search lives in `19_rpc_playground_search.lua`.

AX_RPC_PLAYGROUND = AX_RPC_PLAYGROUND or {}
local P = AX_RPC_PLAYGROUND

--- The site key from flat args or the fan-out worker's envelope.
---
--- The worker receives its SELECTED FLOW STATE, so the site arrives as `item.site`. Reading only the flat
--- key made every store in the production fan-out refuse with an empty site.
function P.site_of(args)
  if type(args) ~= "table" then return nil end
  if type(args.site) == "string" and args.site ~= "" then return args.site end
  local item = type(args.item) == "table" and args.item or nil
  if item and type(item.site) == "string" and item.site ~= "" then return item.site end
  return nil
end

--- Looked up lazily: modules load BEFORE the runtime installs globals, so a top-level read would see nil.
function P.config_for(site)
  if type(RPC_SITES) ~= "table" then return nil, "site_data_unavailable" end
  if not site then return nil, "missing_site" end
  local config = RPC_SITES[site]
  if not config then return nil, "unsupported_site" end
  return config, nil
end

local function host_of(url)
  return tostring(url or ""):match("^https?://([^/]+)") or ""
end

--- Whether `url` is on one of the hosts this site declares. Matched as a suffix so `www.amazon.com` and
--- `smile.amazon.com` both satisfy `amazon.com`, which is how the site configs write them.
local function on_site(config, url)
  local host = host_of(url):lower()
  for index = 1, #(config.hosts or {}) do
    local candidate = tostring(config.hosts[index]):lower()
    if host == candidate or host:sub(-(#candidate + 1)) == "." .. candidate then return true end
  end
  return false
end

--- Opens a supported playground origin.
---
--- The durable command answered `navigating` and expected to be called again, because a navigation
--- destroyed its context. This one keeps its stack across the reload, so the caller gets one answer.
function P.open_site(args)
  local site = P.site_of(args)
  local config, refusal = P.config_for(site)
  if not config then
    return { next = "error", site = site, error = refusal, open_site_status = refusal }
  end

  local from = dom.get_location_href()
  if on_site(config, from) then
    -- Already there. Re-entrant by design: a second call must not cost a navigation.
    return { next = "search", site = config.site, open_site_status = "ready" }
  end

  nav.navigate(config.home_url)
  -- ONE generous wait, not a retry loop: the SDK re-drives on DOM mutation and this timeout is a ceiling.
  nav.wait_for_navigation({ timeout = 20000, interval = 250 })

  local href = dom.get_location_href()
  if not on_site(config, href) then
    -- An off-target landing is a fact worth reporting, not a retry: a login wall and a canonical redirect
    -- both end here, and the caller decides.
    return { next = "error", site = config.site, error = "open_site_off_target", open_site_status = href }
  end
  return { next = "search", site = config.site, open_site_status = "ready" }
end

--- The RPC checkpoint: proof that the host grants this tool the ops it declared.
---
--- It replaces a durable checkpoint whose whole goal was "verify the host grants operation-private
--- durable state". There is no durable state to verify any more, so it verifies the grant that took its
--- place — a declared op answering — and it carries the RAW refusal, because `command_unresolved` (the
--- client never registered the op) and a denial have opposite fixes.
function P.checkpoint(args)
  args = type(args) == "table" and args or {}
  local label = type(args.label) == "string" and args.label ~= "" and args.label or "rpc-checkpoint"
  local ok, href = pcall(dom.get_location_href)
  if not ok then
    return { next = "grant_required", ok = false, label = label, error = tostring(href or "rpc_unavailable") }
  end
  return { next = "done", ok = true, label = label, href = href }
end
