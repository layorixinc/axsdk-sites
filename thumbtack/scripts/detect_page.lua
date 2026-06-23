-- Standalone Thumbtack page-type detector.
--
-- Pure and dependency-free: classifies the CURRENT page from its URL plus a couple of light DOM
-- checks. No navigation, no side effects, no reliance on other site scripts (AX_THUMBTACK). It is the
-- coordination primitive for re-entrant, page-detecting tools: every navigation on Thumbtack is a
-- full reload that destroys the Lua context (see thumbtack/CONTRACT.md §1), so a tool detects where
-- it is on each call, acts once, and returns — never awaiting across a navigation.
--
-- AX_detect_page() -> {
--   url,                         -- current location href
--   page,                        -- "home" | "instant_results" | "pro_profile" | "quote_dialog" | "other"
--   ready,                       -- true when the page's readiness selector is present (else still loading)
--   service_id?, zip_code?, keyword_pk?
-- }

local PAGE = {}

-- Readiness / structural selectors (thumbtack/CONTRACT.md §3).
PAGE.SELECTORS = {
  home_ready = 'input[data-test="search-input"], input[aria-label="Search on Thumbtack"]',
  results_ready = '[data-test="pro-list-result"], a[href*="/service/"]',
  pro_ready = 'h1',
  dialog = '[aria-label="Request Flow Dialog"]',
  dialog_active = '[data-test="request-flow-step--active"]',
}

function PAGE.current_url()
  if dom and dom.get_location_href then
    local href = dom.get_location_href()
    if type(href) == "string" then
      return href
    end
  end
  return ""
end

function PAGE.exists(selector)
  if dom and dom.exists and selector then
    return dom.exists(selector) == true
  end
  return false
end

-- Pathname of a URL ("/instant-results/" from "https://host/instant-results/?x=1"); "/" when bare.
function PAGE.pathname(url)
  local path = tostring(url or ""):match("^https?://[^/]+(/[^?#]*)")
  if not path or path == "" then
    return "/"
  end
  return path
end

function PAGE.query_param(url, name)
  return tostring(url or ""):match("[?&]" .. name .. "=([^&#]+)")
end

function PAGE.service_id_from_url(url)
  local text = tostring(url or "")
  return text:match("/service/(%d+)") or PAGE.query_param(text, "service_pk")
end

-- Classify the current page. Order matters: a pro URL also contains query params, so the
-- /service/<id> path is checked before instant-results and home.
function PAGE.detect()
  local url = PAGE.current_url()
  local path = PAGE.pathname(url)
  local result = { url = url, page = "other", ready = false }

  local service_id = url:match("/service/(%d+)")
  if service_id then
    result.service_id = service_id
    result.zip_code = PAGE.query_param(url, "zip_code")
    -- The quote/request flow is a same-context overlay on the pro page (no URL change of its own).
    if PAGE.exists(PAGE.SELECTORS.dialog) and PAGE.exists(PAGE.SELECTORS.dialog_active) then
      result.page = "quote_dialog"
      result.ready = true
    else
      result.page = "pro_profile"
      result.ready = PAGE.exists(PAGE.SELECTORS.pro_ready)
    end
    return result
  end

  if path:find("^/instant%-results/") then
    result.page = "instant_results"
    result.zip_code = PAGE.query_param(url, "zip_code")
    result.keyword_pk = PAGE.query_param(url, "keyword_pk")
    result.ready = PAGE.exists(PAGE.SELECTORS.results_ready)
    return result
  end

  if (path == "/" or path == "") and url:find("thumbtack%.com", 1, false) then
    result.page = "home"
    result.ready = PAGE.exists(PAGE.SELECTORS.home_ready)
    return result
  end

  return result
end

-- Public command + reusable handle (does not depend on or pollute AX_THUMBTACK).
function AX_detect_page(_args)
  return PAGE.detect()
end

AX_TT_PAGE = PAGE
