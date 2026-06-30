-- Site-agnostic page-reading command (AX_read_page).
-- Loaded from _common/scripts/ alongside the base layer; available on EVERY site (the extension
-- injects _common/scripts/* on all hosts, before any <site>/scripts/*). Lets any flow read the
-- CURRENT page as Markdown so an LLM can understand the on-screen situation (recover from an
-- unexpected state, answer a form step, or report accurately) without bespoke per-site scraping.
-- Needs the live page DOM (dom.get_outerHTML) + the html capability (html.to_markdown/extract);
-- meaningful only on a real rendered page (returns { ok=false, error } otherwise).
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
