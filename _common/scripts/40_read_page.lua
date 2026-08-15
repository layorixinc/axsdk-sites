-- DEV-ONLY command: site-agnostic page reading (AX_read_page).
-- No flow invokes this — flows that read pages do so through their own RPC tools. This command is
-- the situational read of the dev tooling, and every caller is named:
--   SDK harness `page` command (axsdk-extension-cdp/scripts/harness.mjs — `npm run cdp -- page`)
--   node tools/ax.mjs page          tools/playground.mjs `.page`
--   _common/scripts/test_read_page.mjs (live test)
-- It is a one-line delegation to B.read_page in 00_base.lua (RPC module source that stays); it
-- carries no logic of its own. Converts the CURRENT page to Markdown so an operator or LLM can see
-- the on-screen situation without bespoke per-site scraping. Needs the live page DOM
-- (dom.get_outerHTML) + the html capability (html.to_markdown/extract); meaningful only on a real
-- rendered page (returns { ok=false, error } otherwise).
-- REMOVAL CONDITION: this file goes when the SDK harness's `page` command stops calling a durable
-- command (harness.mjs:316,415) — until then, deleting it breaks `npm run cdp -- page`.
local B = AX_BASE
if not B then
  error("_common/scripts/00_base.lua must be loaded before 40_read_page.lua")
end

-- args: { scope?="body", mode?="auto"|"article"|"structure", max_chars?=6000, url? }
-- Returns { ok=true, markdown, mode_used, url, title?, ..., length, extracted, truncated }
--   | { ok=false, error[, scope] }.
function AX_read_page(args)
  return B.read_page(args or {})
end
