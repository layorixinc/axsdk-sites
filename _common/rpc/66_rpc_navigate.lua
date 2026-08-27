--- Same-site navigation, from the runtime.
---
--- `AX_navigate` was carried for a long time as a platform-owned command. It is not one: it builds a URL
--- from a link plus query params, navigates, and confirms arrival against an expected URL. In the runtime
--- that is `nav.navigate` + `nav.wait_for_navigation` + `dom.get_location_href` — the combination the
--- search and quote paths already run live.
---
--- What must be kept is the confirmation. A fired navigation is not an arrival: answering "go" for one
--- that never landed sends the next node to read a page that is still the previous one.

AX_RPC_NAV = AX_RPC_NAV or {}
local N = AX_RPC_NAV

local function trim(value)
  if type(value) ~= "string" then return nil end
  local text = value:gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", "")
  return text ~= "" and text or nil
end

local function href_or_nil()
  local ok, value = pcall(dom.get_location_href)
  if ok then return value end
  return nil
end

local function url_encode(value)
  return (tostring(value or ""):gsub("[^%w%-%._~]", function(char)
    return string.format("%%%02X", string.byte(char))
  end))
end

function N.host(url)
  return (tostring(url or ""):match("^https?://([^/]+)") or ""):lower()
end

--- The registered base domain, so `www.x.com` and `x.com` are the same site.
function N.base_domain(url)
  return (N.host(url):gsub("^www%.", ""))
end

function N.same_site(a, b)
  local left, right = N.base_domain(a), N.base_domain(b)
  if left == "" or right == "" then return false end
  return left == right or left:sub(-(#right + 1)) == ("." .. right)
    or right:sub(-(#left + 1)) == ("." .. left)
end

--- Sites that are NOT commerce stores, so the generated site data does not carry them. Everything else
--- comes from `RPC_SITES[slug].home_url` — two sources for "where does this site live" drift apart, and the
--- one nobody exercises is the one that sends the browser to the wrong host.
N.EXTRA_HOME = {
  thumbtack = "https://www.thumbtack.com/",
}

function N.home_url(slug)
  local site = trim(slug)
  if not site then return nil end
  if type(RPC_SITES) == "table" and type(RPC_SITES[site]) == "table" then
    local home = trim(RPC_SITES[site].home_url)
    if home then return home end
  end
  return N.EXTRA_HOME[site]
end

--- Which published store a URL is on, or nil. Hosts come from the generated site data, so this cannot
--- drift from what the readers accept; `www.` and any other subdomain resolve to the same store because
--- `search.11st.co.kr` and `www.11st.co.kr` are one shop.
function N.site_of(url)
  local host = N.base_domain(url)
  if host == "" or type(RPC_SITES) ~= "table" then return nil end
  local slugs = {}
  for slug in pairs(RPC_SITES) do slugs[#slugs + 1] = slug end
  table.sort(slugs)
  for index = 1, #slugs do
    local config = RPC_SITES[slugs[index]]
    local hosts = type(config) == "table" and config.hosts or nil
    for host_index = 1, #(hosts or {}) do
      local candidate = tostring(hosts[host_index] or ""):lower():gsub("^www%.", "")
      if candidate ~= "" and (host == candidate or host:sub(-(#candidate + 1)) == ("." .. candidate)) then
        return config.site or slugs[index]
      end
    end
  end
  return nil
end

--- The store a single-site turn runs on, and WHERE that decision came from.
---
--- The searching and cart readers both derive their adapter from the open page, so the only thing that
--- ever pinned this flow to one store was the opener's argument: flow state carried `site = "amazon"`,
--- nothing updated it, and a user standing on their own store was navigated away from it. The order is
--- the order of evidence: a store the user NAMED, else the store they are already looking at, else the
--- documented default — which is published as `site_source` so the answer can say it chose.
N.DEFAULT_SITE = "amazon"

function N.resolve_site(requested, here)
  local named = trim(requested)
  if named then return named, "requested" end
  local open = N.site_of(here)
  if open then return open, "current_page" end
  return N.DEFAULT_SITE, "default"
end

--- Gets the browser onto a site's home page, for the steps that need to BE somewhere before they can act:
--- the checkout has to reach its cart, and the single-site shopping loop searches whichever store is
--- open.
---
--- A flow whose next step navigates to a URL of its own does NOT need this — the search readers all build
--- their own search URL, and opening a home page first is a whole page load spent to arrive somewhere the
--- next call leaves immediately.
---
--- The durable opener answered `status: "navigating"` and relied on the planner resuming the flow on the
--- destination. This one waits, so `search` means the browser is there.
function N.open_site(args)
  args = type(args) == "table" and args or {}
  -- One href read serves both the resolution and the "already there" check: an op costs a round trip, and
  -- this tool used to spend one just to decide it had nothing to do.
  local from = href_or_nil()
  local site, source = N.resolve_site(args.site, from)
  local target = N.home_url(site) or trim(args.url)
  if not target then
    -- A slug the caller NAMED and nobody published is a bug, not a reason to shop somewhere else.
    return { next = "error", site = site, site_source = source,
             error = trim(args.site) and "unknown_site" or "missing_target" }
  end

  if from and N.same_site(target, from) then
    return { next = "search", site = site, site_source = source, url = target, href = from,
             navigated = false }
  end

  nav.navigate(target)
  nav.wait_for_navigation({ url = target, timeout = 15000, interval = 250 })
  local landed = href_or_nil()
  if not landed or not N.same_site(target, landed) then
    return { next = "error", site = site, site_source = source, url = target, href = landed,
             error = "navigation_failed" }
  end
  return { next = "search", site = site, site_source = source, url = target, href = landed,
           navigated = true }
end
