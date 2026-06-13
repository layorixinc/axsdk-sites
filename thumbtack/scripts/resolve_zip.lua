local M = AX_THUMBTACK
if not M then
  error("thumbtack/scripts/00_common.lua must be loaded before resolve_zip.lua")
end

function AX_resolve_zip(args)
  return M.resolve_zip(args or {})
end
