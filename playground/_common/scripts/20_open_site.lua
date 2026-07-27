-- Portable durable-v2 store entry point for Playground's read-only commerce flows.
--
-- Common Lua remains loaded while site layers change. The host-owned operation grant restricts
-- every handoff to the explicit origins in 06_commerce_sites.lua / PLAYGROUND_LUA_OPERATIONS.

local C = AX_PLAYGROUND_COMMERCE
if type(C) ~= "table" then
  error("playground/_common/scripts/06_commerce_sites.lua must load before 20_open_site.lua")
end

local D = AX_PLAYGROUND_DURABLE
if type(D) ~= "table" then
  error("playground/_common/scripts/05_durable.lua must load before 20_open_site.lua")
end

local function arrived_value(snapshot)
  return {
    phase = "arrived",
    site = snapshot.value.site,
    target_url = snapshot.value.target_url,
    handoffs = snapshot.value.handoffs or 0
  }
end

-- Opens one explicitly supported commerce search origin. The site-local AX_search_product
-- command is loaded only after this portable operation has reached the mapped destination.
function AX_playground_open_site(args)
  local target = type(args) == "table" and C.site(args.site) or nil
  if not target then
    return {
      ok = false,
      error = "unsupported_site",
      site = type(args) == "table" and args.site or nil
    }
  end

  local origin, location_error = D.origin()
  if not origin then return location_error end

  local snapshot, open_error = D.open({ schema = 1, initial = {
    phase = "prepare",
    site = target.site,
    target_url = target.entry_url,
    handoffs = 0
  }})
  if not snapshot then return open_error end

  if snapshot.value.site ~= target.site or snapshot.value.target_url ~= target.entry_url then
    return { ok = false, error = "open_site_checkpoint_mismatch" }
  end

  if snapshot.value.phase == "prepare" then
    local next_value = origin == target.origin and arrived_value(snapshot) or {
      phase = "handoff_requested",
      site = snapshot.value.site,
      target_url = snapshot.value.target_url,
      handoffs = snapshot.value.handoffs or 0
    }
    local saved, save_error = D.save(snapshot, next_value)
    if not saved then return save_error end
    snapshot = saved
  end

  if snapshot.value.phase == "handoff_requested" then
    if origin == target.origin then
      local saved, save_error = D.save(snapshot, {
        phase = "arrived",
        site = snapshot.value.site,
        target_url = snapshot.value.target_url,
        handoffs = (snapshot.value.handoffs or 0) + 1
      })
      if not saved then return save_error end
      snapshot = saved
    else
      local handoff, handoff_error = D.handoff(snapshot.value.target_url)
      if not handoff then return handoff_error end
      if handoff.arrived ~= true then
        return {
          ok = true,
          operation = D.summary(),
          status = "navigating",
          site = snapshot.value.site,
          target_url = snapshot.value.target_url,
          phase = snapshot.value.phase,
          revision = snapshot.revision
        }
      end

      snapshot, open_error = D.open({ schema = 1 })
      if not snapshot then return open_error end
      if snapshot.value.site ~= target.site or snapshot.value.target_url ~= target.entry_url then
        return { ok = false, error = "open_site_checkpoint_mismatch" }
      end
      if snapshot.value.phase == "handoff_requested" then
        local saved, save_error = D.save(snapshot, {
          phase = "arrived",
          site = snapshot.value.site,
          target_url = snapshot.value.target_url,
          handoffs = (snapshot.value.handoffs or 0) + 1
        })
        if not saved then return save_error end
        snapshot = saved
      end
    end
  end

  if snapshot.value.phase ~= "arrived" then
    return { ok = false, error = "unexpected_open_site_phase", phase = snapshot.value.phase }
  end

  return {
    ok = true,
    operation = D.summary(),
    status = "ready",
    site = snapshot.value.site,
    target_url = snapshot.value.target_url,
    handoffs = snapshot.value.handoffs,
    phase = snapshot.value.phase,
    revision = snapshot.revision
  }
end
