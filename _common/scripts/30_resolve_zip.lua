-- DEV-ONLY command: site-agnostic US ZIP resolution (AX_resolve_zip).
-- No flow invokes this — the request_service_quote flow resolves its ZIP through the `resolve_zip`
-- RPC tool (_common/flows.yaml, modules `_common.71_rpc_zip`). This command exists so the dev CLI
-- can exercise the same resolution ladder from any page without driving a flow:
--   npm run cdp -- run AX_resolve_zip '{"address":"San Francisco, CA"}'   (DEVTOOLS.md)
-- It is a one-line delegation to B.resolve_zip in 00_base.lua (RPC module source that stays); it
-- carries no logic of its own. Pure args + network (forward geocode via Photon/Nominatim, reverse
-- ZCTA + full-address geocode via Census, all through the luaFetch bridge): no DOM reads, no site
-- selectors, no AX_THUMBTACK dependency.
-- REMOVAL CONDITION: this file goes when the dev harness stops exposing direct stored-Lua ZIP probes.
local B = AX_BASE
if not B then
  error("_common/scripts/00_base.lua must be loaded before 30_resolve_zip.lua")
end

-- args.zip_code (explicit 5-digit) -> args.address embedded ZIP -> forward geocode + Census ZCTA
-- reverse -> Census onelineaddress. Returns { zip_code, source } | { error[...] } | { pending }.
function AX_resolve_zip(args)
  return B.resolve_zip(args or {})
end
