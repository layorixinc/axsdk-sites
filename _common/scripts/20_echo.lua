-- DEV-ONLY command: shared, site-agnostic runtime diagnostic (AX_echo).
-- No flow invokes this. It is the smallest possible probe of the stored-Lua command channel —
-- standalone (no AX_BASE), it console.log's every argument and echoes them back, so a broken
-- round-trip is visible in one call. Named callers:
--   playground REPL docs/tests (`.call AX_echo {...}` — tools/playground/cli.test.mjs)
-- Invoked as a command via lua.run("AX_echo", args) (args arrives as a single table) or directly
-- with varargs: AX_echo(a, b, c).
-- REMOVAL CONDITION: this file goes with the playground's durable pings — when the playground
-- REPL and its channel test stop exercising durable commands, nothing calls this.
function AX_echo(...)
  console.log(...)
  local n = select("#", ...)
  local args = {}
  for i = 1, n do
    args[i] = (select(i, ...))
  end
  return { ok = true, count = n, args = args }
end
