-- Playground-only fixtures for the host-granted programmable durable-operation contract.
--
-- These commands are deliberately inert unless the host registers each command in
-- AXSDK's lua.operations grant. Ordinary lua.call/lua.run commands must never gain
-- durable.state or durable.handoff access merely because this source defines AX_* names.
--
-- Required grants for positive tests:
--   AX_playground_durable_checkpoint  -> checkpoint grant
--   AX_playground_durable_same_origin -> checkpoint grant
--   AX_playground_durable_handoff     -> portable grant with https://axsdk.ai allowed

local D = AX_PLAYGROUND_DURABLE
if type(D) ~= "table" then
  error("playground/_common/scripts/05_durable.lua must load before 10_durable_operations.lua")
end


local function target_url(args)
  if type(args) ~= "table" or type(args.target_url) ~= "string" or args.target_url == "" then
    return nil, { ok = false, error = "invalid_target_url" }
  end
  local origin = string.match(args.target_url, "^(https?://[^/%?#]+)")
  if not origin then return nil, { ok = false, error = "invalid_target_url" } end
  return args.target_url, origin:lower()
end


function AX_playground_durable_checkpoint(args)

  args = type(args) == "table" and args or {}
  local label = type(args.label) == "string" and args.label or "playground-checkpoint"
  local snapshot, open_error = D.open({ schema = 1, initial = {
    phase = "prepare",
    label = label,
    checkpoints = 0
  }})
  if not snapshot then return open_error end

  local created = snapshot.created == true
  if snapshot.value.phase == "prepare" then
    local saved, save_error = D.save(snapshot, {
      phase = "checkpointed",
      label = snapshot.value.label,
      checkpoints = (snapshot.value.checkpoints or 0) + 1
    })
    if not saved then return save_error end
    snapshot = saved
  end

  return {
    ok = true,
    operation = D.summary(),
    created = created,
    phase = snapshot.value.phase,
    revision = snapshot.revision,
    label = snapshot.value.label,
    checkpoints = snapshot.value.checkpoints
  }
end

function AX_playground_durable_same_origin(args)

  local target, target_origin_or_error = target_url(args)
  if not target then return target_origin_or_error end
  local source_origin, source_error = D.origin()
  if not source_origin then return source_error end
  if source_origin ~= target_origin_or_error then
    return {
      ok = false,
      error = "same_origin_required",
      message = "Use durable.handoff for an allowlisted cross-origin continuation."
    }
  end

  local snapshot, open_error = D.open({ schema = 1, initial = {
    phase = "prepare",
    target_url = target,
    resumes = 0
  }})
  if not snapshot then return open_error end

  if snapshot.value.phase == "prepare" then
    local saved, save_error = D.save(snapshot, {
      phase = "navigation_armed",
      target_url = snapshot.value.target_url,
      resumes = (snapshot.value.resumes or 0) + 1
    })
    if not saved then return save_error end
    snapshot = saved
  end

  local navigation = nil
  if snapshot.value.phase == "navigation_armed" then
    navigation = nav.navigate(snapshot.value.target_url, {})
    snapshot, open_error = D.open({ schema = 1 })
    if not snapshot then return open_error end
    if snapshot.value.phase == "navigation_armed" then
      local saved, save_error = D.save(snapshot, {
        phase = "arrived",
        target_url = snapshot.value.target_url,
        resumes = snapshot.value.resumes or 0
      })
      if not saved then return save_error end
      snapshot = saved
    end
  end

  if snapshot.value.phase ~= "arrived" then
    return { ok = false, error = "unexpected_phase", phase = snapshot.value.phase }
  end

  return {
    ok = true,
    operation = D.summary(),
    phase = snapshot.value.phase,
    revision = snapshot.revision,
    target_url = snapshot.value.target_url,
    resumes = snapshot.value.resumes,
    navigation = navigation
  }
end

function AX_playground_durable_handoff(args)

  local target, target_origin_or_error = target_url(args)
  if not target then return target_origin_or_error end
  local source_origin, source_error = D.origin()
  if not source_origin then return source_error end
  if source_origin == target_origin_or_error then
    return {
      ok = false,
      error = "handoff_target_must_differ",
      message = "durable.handoff is only for an allowlisted cross-origin target."
    }
  end

  local snapshot, open_error = D.open({ schema = 1, initial = {
    phase = "source",
    target_url = target,
    target_runs = 0
  }})
  if not snapshot then return open_error end

  if snapshot.value.phase == "source" then
    local saved, save_error = D.save(snapshot, {
      phase = "handoff_requested",
      target_url = snapshot.value.target_url,
      target_runs = snapshot.value.target_runs or 0
    })
    if not saved then return save_error end
    snapshot = saved
  end

  if snapshot.value.phase == "handoff_requested" then
    local handoff, handoff_error = D.handoff(snapshot.value.target_url)
    if not handoff then return handoff_error end
    if handoff.arrived ~= true then
      return {
        ok = true,
        operation = D.summary(),
        phase = snapshot.value.phase,
        arrived = false,
        target_url = snapshot.value.target_url
      }
    end

    snapshot, open_error = D.open({ schema = 1 })
    if not snapshot then return open_error end
    if snapshot.value.phase == "handoff_requested" then
      local saved, save_error = D.save(snapshot, {
        phase = "target_complete",
        target_url = snapshot.value.target_url,
        target_runs = (snapshot.value.target_runs or 0) + 1
      })
      if not saved then return save_error end
      snapshot = saved
    end
  end

  if snapshot.value.phase ~= "target_complete" then
    return { ok = false, error = "unexpected_phase", phase = snapshot.value.phase }
  end

  return {
    ok = true,
    operation = D.summary(),
    phase = snapshot.value.phase,
    revision = snapshot.revision,
    target_url = snapshot.value.target_url,
    target_runs = snapshot.value.target_runs,
    arrived = true
  }
end
