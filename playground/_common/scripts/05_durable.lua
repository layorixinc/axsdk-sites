-- Shared durable-operation plumbing for Playground command chunks.
--
-- Each Lua file is an isolated chunk, so this common namespace is the only deliberate
-- cross-file channel. It owns capability/response validation only; command state machines
-- remain explicit in their respective files.

AX_PLAYGROUND_DURABLE = AX_PLAYGROUND_DURABLE or {}
local D = AX_PLAYGROUND_DURABLE

local function failure(error, fields)
  local result = { ok = false, error = error }
  if type(fields) == "table" then
    for key, value in pairs(fields) do result[key] = value end
  end
  return result
end

local function operation_required(capability, cause)
  return failure("durable_operation_required", {
    capability = capability,
    cause = cause,
    message = "Register this command in the host lua.operations grant before using Playground durable operations."
  })
end

local function normalize_failure(result, fallback, capability)
  if type(result) ~= "table" then return failure(fallback, { capability = capability }) end
  if result.error == "no_durable_context" then
    return operation_required(capability, result.error)
  end
  return result
end

local function state_api()
  if type(durable) ~= "table" or type(durable.state) ~= "table" then
    return nil, operation_required("state")
  end
  if type(durable.state.open) ~= "function" or type(durable.state.save) ~= "function" then
    return nil, operation_required("state")
  end
  return durable
end

local function handoff_api()
  local api, err = state_api()
  if not api then return nil, err end
  if type(api.handoff) ~= "function" then return nil, operation_required("handoff") end
  return api
end

local function operation_api()
  local api, err = state_api()
  if not api then return nil, err end
  if type(api.operation) ~= "table" or type(api.operation.info) ~= "function" then
    return nil, operation_required("operation_info")
  end
  return api
end

-- Opens the command-private object checkpoint. Successful snapshots always contain
-- a table value and numeric revision, so callers can safely inspect snapshot.value.phase.
function D.open(options)
  if type(options) ~= "table" or type(options.schema) ~= "number" then
    return nil, failure("state_invalid_schema")
  end

  local api, api_error = state_api()
  if not api then return nil, api_error end

  local snapshot = api.state.open({
    schema = options.schema,
    initial = options.initial
  })
  if type(snapshot) ~= "table" then
    return nil, failure("durable_state_invalid_response", { capability = "state" })
  end
  if snapshot.ok ~= true then
    return nil, normalize_failure(snapshot, "durable_state_invalid_response", "state")
  end
  if type(snapshot.value) ~= "table" or type(snapshot.revision) ~= "number" then
    return nil, failure("durable_state_invalid_response", { capability = "state" })
  end
  return snapshot
end

-- Saves a replacement checkpoint using the snapshot's observed revision.
-- CAS conflicts and SDK quota/schema errors are returned unchanged.
function D.save(snapshot, value)
  if type(snapshot) ~= "table" or type(snapshot.revision) ~= "number" then
    return nil, failure("durable_state_invalid_snapshot", { capability = "state" })
  end
  if type(value) ~= "table" then
    return nil, failure("state_invalid_value", { capability = "state" })
  end

  local api, api_error = state_api()
  if not api then return nil, api_error end

  local saved = api.state.save(snapshot, value)
  if type(saved) ~= "table" then
    return nil, failure("durable_state_invalid_response", { capability = "state" })
  end
  if saved.ok ~= true then
    return nil, normalize_failure(saved, "durable_state_invalid_response", "state")
  end
  if type(saved.value) ~= "table" or type(saved.revision) ~= "number" then
    return nil, failure("durable_state_invalid_response", { capability = "state" })
  end
  return saved
end

-- Arms or resumes a portable cross-origin handoff. Target policy stays command-specific:
-- this helper never chooses the URL or broadens the host's operation allowlist.
function D.handoff(url)
  if type(url) ~= "string" or url == "" then
    return nil, failure("handoff_invalid_target", { capability = "handoff" })
  end

  local api, api_error = handoff_api()
  if not api then return nil, api_error end

  local result = api.handoff({ url = url })
  if type(result) ~= "table" then
    return nil, failure("handoff_invalid_response", { capability = "handoff" })
  end
  if result.ok ~= true then
    return nil, normalize_failure(result, "handoff_invalid_response", "handoff")
  end
  if type(result.arrived) ~= "boolean" then
    return nil, failure("handoff_invalid_response", { capability = "handoff" })
  end
  return result
end

-- Returns a normalized current origin for command-level same-origin/target checks.
function D.origin()
  if type(dom) ~= "table" or type(dom.get_location_href) ~= "function" then
    return nil, failure("location_unavailable")
  end
  local href = dom.get_location_href()
  local origin = type(href) == "string" and href:match("^(https?://[^/%?#]+)") or nil
  if not origin then return nil, failure("location_unavailable") end
  return origin:lower()
end

-- Provides stable operation metadata for command result payloads. A missing metadata capability
-- is represented as an empty summary because callers use this only after a successful checkpoint.
function D.summary()
  local api = operation_api()
  if not api then return { command = nil, portable = false, status = nil } end

  local info = api.operation.info()
  if type(info) ~= "table" or info.ok == false then
    return { command = nil, portable = false, status = nil }
  end
  return {
    command = info.command,
    portable = info.portable == true,
    status = info.status
  }
end
