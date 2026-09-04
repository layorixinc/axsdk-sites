-- axde's own common Lua layer: loaded on EVERY host, before any site script.
--
-- It exists so a delivery is provable. `AX_dev_echo` is a global function, which is what core
-- detects to register a command — a `local function` would not be, wrapping or no wrapping. The
-- loader concatenates this directory in name order and wraps each file in its own vararg function,
-- so a `local` here cannot collide with another file's.

local M = {}

-- Marshaling shapes callers get wrong, in one answer: an empty table is an OBJECT on the wire, a
-- list stays a list, and a Korean string has to survive the round trip byte-for-byte.
function AX_dev_echo(args)
  local given = args or {}
  return {
    echoed = given.text or '',
    empty_object = {},
    list = { 1, 2, 3 },
    korean = '한글 왕복',
    arg_count = M.count(given),
  }
end

function M.count(table_value)
  local total = 0
  for _ in pairs(table_value) do total = total + 1 end
  return total
end

AX_DEV = M
