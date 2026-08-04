--- Saved memory, from the runtime.
---
--- The platform kept the STORE on the device and exposed it as ops (`memory.get/set_bulk/search/delete`),
--- for two reasons worth repeating: a second store would split from the one the client already writes to,
--- and moving addresses and ordering habits off the device is a product decision, not a plumbing one. So
--- these cost one round trip each — the price of the data living somewhere else.
---
--- Every entry answers `memory_op_unavailable` rather than raising when the client has no handler for the
--- op. The ops were published before the extension implemented them, and a memory flow that dies is worse
--- than one that says the store could not be reached.

AX_RPC_MEMORY = AX_RPC_MEMORY or {}
local Y = AX_RPC_MEMORY

local function available()
  return type(memory) == "table"
end

--- Runs `fn` against the memory op set, or reports that the client has none.
local function call(fn)
  if not available() then
    return nil, "memory_op_unavailable"
  end
  local ok, value = pcall(fn)
  if not ok then
    -- `command_unresolved` is what an unregistered op answers; anything else is the store's own failure.
    local text = tostring(value or ""):lower()
    if text:find("command_unresolved", 1, true) or text:find("op_not_permitted", 1, true) then
      return nil, "memory_op_unavailable"
    end
    return nil, "memory_unavailable"
  end
  return value, nil
end

--- Every saved key, or one key's value when `key` is given.
function Y.get(args)
  args = type(args) == "table" and args or {}
  local key = type(args.key) == "string" and args.key ~= "" and args.key or nil
  local value, err = call(function()
    if key then return memory.get(key) end
    return memory.get()
  end)
  if err then return { next = "error", ok = false, error = err } end
  return { next = "report", ok = true, memory_result = value }
end

function Y.search(args)
  args = type(args) == "table" and args or {}
  local regex = type(args.regex) == "string" and args.regex or ""
  if regex == "" then return { next = "error", ok = false, error = "missing_regex" } end
  local value, err = call(function() return memory.search(regex) end)
  if err then return { next = "error", ok = false, error = err } end
  return { next = "report", ok = true, memory_result = value }
end

--- Writes. A non-empty value saves; an empty string deletes — the contract the flow already states.
function Y.set_bulk(args)
  args = type(args) == "table" and args or {}
  if type(args.memory) ~= "table" then return { next = "error", ok = false, error = "missing_memory" } end
  local value, err = call(function() return memory.set_bulk(args.memory) end)
  if err then return { next = "error", ok = false, error = err } end
  return { next = "report", ok = true, memory_result = value }
end

function Y.delete(args)
  args = type(args) == "table" and args or {}
  local keys = args.keys or args.delete_keys
  if type(keys) ~= "table" or #keys == 0 then
    return { next = "error", ok = false, error = "missing_keys" }
  end
  local value, err = call(function() return memory.delete(keys) end)
  if err then return { next = "error", ok = false, error = err } end
  return { next = "report", ok = true, memory_result = value }
end
