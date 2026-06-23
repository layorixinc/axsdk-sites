-- Shared, site-agnostic debug command (AX_echo).
-- Loaded from _common/scripts/ alongside the base layer; available on every site.
-- console.log's every argument it receives, then echoes them back in the result so the
-- caller sees exactly what was passed. Invoked as a command via lua.run("AX_echo", args)
-- (args arrives as a single table) or directly with varargs: AX_echo(a, b, c).
function AX_echo(...)
  console.log(...)
  local n = select("#", ...)
  local args = {}
  for i = 1, n do
    args[i] = (select(i, ...))
  end
  return { ok = true, count = n, args = args }
end
