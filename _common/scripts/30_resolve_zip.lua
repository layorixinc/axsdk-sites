-- Site-agnostic US ZIP resolution command (AX_resolve_zip).
-- Loaded from _common/scripts/ alongside the base layer; available on EVERY site (the extension
-- injects _common/scripts/* on all hosts, before any <site>/scripts/*). This lets the
-- request_service_quote flow resolve a ZIP from ANY starting page (e.g. google.com) before it
-- navigates to a provider site like Thumbtack — step 1 of the flow must not depend on already
-- being on the provider.
-- Pure args + network (Census full-address geocoder, Zippopotam city fallback via the luaFetch
-- bridge): no DOM reads, no site selectors, no AX_THUMBTACK dependency.
local B = AX_BASE
if not B then
  error("_common/scripts/00_base.lua must be loaded before 30_resolve_zip.lua")
end

-- args.zip_code (explicit 5-digit) -> args.address embedded ZIP -> Census (full street) ->
-- Zippopotam city. Returns { zip_code, source } | { error[, message|status|reason] } | { pending }.
function AX_resolve_zip(args)
  return B.resolve_zip(args or {})
end
