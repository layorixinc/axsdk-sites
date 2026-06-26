-- Standalone, site-agnostic site-opener for the AXSDK Lua runtime.
--
-- Loaded from _common/scripts (kind:'common') so it is present on EVERY page — including external
-- pages such as a search engine — and survives the off-domain site-script clear. This is the global
-- entry that gets the browser onto a target site's home page before a site-specific flow can run
-- (a <site>/scripts/* command like AX_search_service only loads once that site's domain is active).
--
-- Re-entrant by design (see thumbtack/CONTRACT.md §1): every navigation is a full reload that
-- destroys the Lua context, so AX_open_site detects the current host, acts once, and returns —
-- never awaiting across the navigation. The caller re-invokes; once the host matches it is a no-op.
--
-- AX_open_site({ site = <slug> } | { url = <home url> }) -> {
--   site,            -- echoed slug (when given)
--   url,             -- resolved target home url (when resolvable)
--   status,          -- "ready" (already on site) | "navigating" (nav fired) | "error"
--   error?,          -- "unknown_site" | "missing_target"
-- }

local SITE = {}

-- Site slug -> home URL. Mirrors the published site directories in index.md (lowercase host/slug).
-- Add a row here when a new site directory is published.
SITE.HOME = {
  amazon = "https://www.amazon.com/",
  bluemoonsoft = "http://bluemoonsoft.com/",
  thumbtack = "https://www.thumbtack.com/",
}

function SITE.current_url()
  if dom and dom.get_location_href then
    local href = dom.get_location_href()
    if type(href) == "string" then
      return href
    end
  end
  return ""
end

-- Host of a URL ("www.thumbtack.com" from "https://www.thumbtack.com/x"); "" when not parseable.
function SITE.host(url)
  return tostring(url or ""):match("^https?://([^/]+)") or ""
end

-- Registered base domain ("thumbtack.com") of a URL, with any leading "www." stripped, for
-- subdomain-tolerant matching.
function SITE.base_domain(url)
  return (SITE.host(url):gsub("^www%.", ""))
end

-- True when the current page is on the target site: exact host match, or a subdomain of its base
-- domain (e.g. "www.thumbtack.com"/"thumbtack.com" both match a "thumbtack.com" target).
function SITE.on_site(target_url)
  local base = SITE.base_domain(target_url)
  if base == "" then
    return false
  end
  local host = SITE.host(SITE.current_url())
  if host == "" then
    return false
  end
  return host == base or host:sub(-(#base + 1)) == ("." .. base)
end

-- Resolve the target home URL from a site slug or an explicit url. Returns url, or nil + error code.
function SITE.resolve(args)
  local site = args.site
  if type(site) == "string" and site ~= "" then
    local url = SITE.HOME[site]
    if not url then
      return nil, "unknown_site"
    end
    return url
  end
  local url = args.url
  if type(url) == "string" and url ~= "" then
    return url
  end
  return nil, "missing_target"
end

function SITE.open(args)
  args = args or {}
  local url, err = SITE.resolve(args)
  if not url then
    return { site = args.site, status = "error", error = err }
  end
  if SITE.on_site(url) then
    return { site = args.site, url = url, status = "ready" }
  end
  -- Off the target site: fire the navigation and return. For a cross-domain target the SDK completes
  -- this call now and navigates afterward (no durable replay — the owning site script unloads on the
  -- domain change); the flow resumes on the destination, where this call becomes a no-op ("ready").
  nav.navigate(url, {})
  return { site = args.site, url = url, status = "navigating" }
end

-- Public command + reusable handle (does not depend on or pollute site tables like AX_THUMBTACK).
function AX_open_site(args)
  return SITE.open(args)
end

AX_SITE = SITE
