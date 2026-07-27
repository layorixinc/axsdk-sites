-- Test fixture: the extension's chat-session key/value capability, plus a helper that simulates the Lua
-- context being destroyed by a navigation (which is what happens between two user turns).
--
-- The runtime accepts STRING values only (axsdk-core default-capabilities `setLuaSessionState`); a table
-- write silently fails there, so the stub rejects it here rather than letting a test pass on a value the
-- extension would refuse.
local store = {}

session_state = {
  get = function(key) return store[key] end,
  set = function(key, value)
    if type(key) ~= "string" or key == "" then return { ok = false, error = "Session state key must be a non-empty string" } end
    if type(value) ~= "string" then return { ok = false, error = "Session state value must be a string" } end
    store[key] = value
    return { ok = true }
  end,
  keys = function()
    local keys = {}
    for key in pairs(store) do keys[#keys + 1] = key end
    table.sort(keys)
    return keys
  end,
  clear = function() store = {} return { ok = true } end
}

TEST_SESSION = {
  --- Drops everything that only lived in the Lua context, keeping the session store intact.
  drop_lua_context = function()
    if AX_COMMERCE then AX_COMMERCE.current_comparison = nil end
  end,
  size = function()
    local total = 0
    for _ in pairs(store) do total = total + 1 end
    return total
  end
}
