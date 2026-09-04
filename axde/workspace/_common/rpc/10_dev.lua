-- axde's own runtime module: `_common.10_dev`.
--
-- Runtime modules are delivered byte-for-byte as a name→source map (`axsdk:lua-modules`), never
-- concatenated or wrapped, because the runtime compiles each one as its own chunk. That is the half
-- of a delivery a durable-layer check cannot see, which is why the scaffold carries one.
--
-- A module only RUNS when a flow tool names it in `execute.modules`; delivery does not depend on
-- that, so this file lands in the store whether or not anything declares it.

local M = {}

-- Which host primitives this runtime actually has, answered by CALLING nothing: a module that
-- probes by invoking would report a refusal as an absence.
function M.surface()
  return {
    dom = type(dom),
    nav = type(nav),
    rpc = type(rpc),
    json = type(json),
    clock = type(rpc) == 'table' and type(rpc.now) or 'n/a',
  }
end

function M.echo(args)
  return { ok = true, text = (args or {}).text or '' }
end

AX_RPC_DEV = M
