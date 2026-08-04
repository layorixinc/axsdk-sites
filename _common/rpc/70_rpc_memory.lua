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
---
--- The RAW reason travels with the refusal. "unavailable" on its own cost a whole round of diagnosis: it
--- could not tell an op the client never registered from one we failed to declare properly, and we made
--- exactly that mistake once already (`rpc.allow` grants OPS and does not reach `net`).
local function call(fn)
  if not available() then
    return nil, "memory_op_unavailable", "no memory global in this runtime"
  end
  local ok, value = pcall(fn)
  if not ok then
    local raw = tostring(value or "")
    local text = raw:lower()
    -- `command_unresolved` is what an unregistered op answers; anything else is the store's own failure.
    if text:find("command_unresolved", 1, true) or text:find("op_not_permitted", 1, true) then
      return nil, "memory_op_unavailable", raw:sub(1, 160)
    end
    return nil, "memory_unavailable", raw:sub(1, 160)
  end
  return value, nil, nil
end

--- Every saved key, or one key's value when `key` is given.
function Y.get(args)
  args = type(args) == "table" and args or {}
  local key = type(args.key) == "string" and args.key ~= "" and args.key or nil
  local value, err, why = call(function()
    if key then return memory.get(key) end
    return memory.get()
  end)
  if err then return { next = "error", ok = false, error = err, reason = why } end
  return { next = "report", ok = true, memory_result = value }
end

function Y.search(args)
  args = type(args) == "table" and args or {}
  local regex = type(args.regex) == "string" and args.regex or ""
  if regex == "" then return { next = "error", ok = false, error = "missing_regex" } end
  local value, err, why = call(function() return memory.search(regex) end)
  if err then return { next = "error", ok = false, error = err, reason = why } end
  return { next = "report", ok = true, memory_result = value }
end

--- Writes. The binding is POSITIONAL — `set_bulk(entries)` per `docs/rpc_lua_authoring.md` §4 — and the
--- runtime wraps it into the params object the client reads. Passing the wrapper ourselves produced a
--- live `bad_params`. An ABSENT value deletes that key, so saving and deleting are the same op and a
--- multi-key delete is ONE round trip. An empty string is a delete too, as the flow tells the user.
local function write(entries)
  if #entries == 0 then return nil, "missing_memory", nil end
  return call(function() return memory.set_bulk(entries) end)
end

function Y.set_bulk(args)
  args = type(args) == "table" and args or {}
  if type(args.memory) ~= "table" then return { next = "error", ok = false, error = "missing_memory" } end
  local entries = {}
  for key, value in pairs(args.memory) do
    if type(key) == "string" and key ~= "" then
      -- Only a non-empty string is a save; anything else means remove, which is `value` left out.
      if type(value) == "string" and value ~= "" then
        entries[#entries + 1] = { key = key, value = value }
      else
        entries[#entries + 1] = { key = key }
      end
    end
  end
  local value, err, why = write(entries)
  if err then return { next = "error", ok = false, error = err, reason = why } end
  return { next = "report", ok = true, memory_result = value }
end

--- `memory.delete(key)` takes a SINGLE key. A list therefore goes through `set_bulk` with the values
--- left out: same effect, one round trip instead of one per key.
function Y.delete(args)
  args = type(args) == "table" and args or {}
  local keys = args.keys or args.delete_keys
  if type(keys) ~= "table" or #keys == 0 then
    return { next = "error", ok = false, error = "missing_keys" }
  end
  local entries = {}
  for index = 1, #keys do
    local key = keys[index]
    if type(key) == "string" and key ~= "" then entries[#entries + 1] = { key = key } end
  end
  local value, err, why = write(entries)
  if err then
    return { next = "error", ok = false, error = err == "missing_memory" and "missing_keys" or err, reason = why }
  end
  return { next = "report", ok = true, memory_result = value }
end
