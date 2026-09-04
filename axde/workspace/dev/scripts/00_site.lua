-- The site layer for `dev` (host example.com).
--
-- Site scripts are cleared when the browser leaves the domain and re-applied when it returns, which
-- is exactly why a cross-domain helper belongs in `_common/` instead. This file proves the other
-- half of Lua delivery: a layer keyed `:dev` in the store, loaded only on the host `index.md` maps.

function AX_dev_site()
  return {
    layer = 'dev',
    -- Read through the same capability a product script uses, so an absent `dom` is visible as an
    -- absence rather than as a crash.
    href = type(dom) == 'table' and dom.get_location_href and dom.get_location_href() or nil,
  }
end
