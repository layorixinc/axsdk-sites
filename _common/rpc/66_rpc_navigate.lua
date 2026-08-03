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

local function url_encode(value)
  return (tostring(value or ""):gsub("[^%w%-%._~]", function(char)
    return string.format("%%%02X", string.byte(char))
  end))
end

function N.host(url)
  return (tostring(url or ""):match("^https?://([^/]+)") or ""):lower()
end

function N.origin(url)
  return tostring(url or ""):match("^(https?://[^/]+)") or ""
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

--- A Lua table has no order, so the keys are sorted. That is what makes one navigation comparable to the
--- one before it — an unordered query string produces a different URL for the same request every run.
function N.query_string(params)
  if type(params) ~= "table" then return "" end
  local keys = {}
  for key, value in pairs(params) do
    if value ~= nil and value ~= "" then keys[#keys + 1] = tostring(key) end
  end
  table.sort(keys)
  local parts = {}
  for index = 1, #keys do
    local key = keys[index]
    local value = params[key]
    if type(value) == "boolean" then value = value and "true" or "false" end
    parts[#parts + 1] = url_encode(key) .. "=" .. url_encode(value)
  end
  return table.concat(parts, "&")
end

--- Resolves `link` against the page we are on. A path becomes an absolute URL on the current origin; an
--- absolute URL is taken as given.
function N.resolve(link, here)
  local target = trim(link)
  if not target then return nil end
  if target:match("^https?://") then return target end
  local origin = N.origin(here)
  if origin == "" then return nil end
  if target:sub(1, 1) ~= "/" then target = "/" .. target end
  return origin .. target
end

--- True when the browser is already showing `target` (ignoring a trailing slash difference).
local function same_page(here, target)
  local function strip(url) return (tostring(url or ""):gsub("/+$", "")) end
  return strip(here) == strip(target)
end

--- Navigates the current page to a same-site path or URL, and confirms it landed.
---
--- Refusals are separate answers because they call for different things: `missing_link` is the caller's
--- mistake, `offsite_link` would silently leave the flow's site, `navigation_failed` means the browser
--- never moved, and `wrong_landing` means it moved somewhere else — a login bounce or a canonical rewrite —
--- and names where, because the next node has to decide what to do about it.
function N.navigate_page(args)
  args = type(args) == "table" and args or {}
  local ok, here = pcall(dom.get_location_href)
  if not ok then return { next = "error", error = "rpc_unavailable" } end

  local link = trim(args.link) or trim(args.url)
  if not link then return { next = "error", error = "missing_link" } end

  local target = N.resolve(link, here)
  if not target then return { next = "error", error = "missing_link" } end
  if not N.same_site(target, here) then
    return { next = "error", error = "offsite_link", href = here, target = target }
  end

  local query = N.query_string(args.params)
  if query ~= "" then
    target = target .. (target:find("?", 1, true) and "&" or "?") .. query
  end

  if same_page(here, target) then
    return { next = "go", href = here, navigated = false }
  end

  nav.navigate(target)
  nav.wait_for_navigation(here, { timeout = 12000, interval = 250 })

  local landed = pcall(dom.get_location_href) and dom.get_location_href() or nil
  if not landed or same_page(landed, here) then
    return { next = "error", error = "navigation_failed", href = landed or here, target = target }
  end
  if not same_page(landed, target) and not landed:find(target, 1, true) then
    return { next = "error", error = "wrong_landing", href = landed, target = target }
  end
  return { next = "go", href = landed, navigated = true }
end
--- Sites that are NOT commerce stores, so the generated site data does not carry them. Everything else
--- comes from `RPC_SITES[slug].home_url` — two sources for "where does this site live" drift apart, and the
--- one nobody exercises is the one that sends the browser to the wrong host.
N.EXTRA_HOME = {
  thumbtack = "https://www.thumbtack.com/",
  bluemoonsoft = "http://bluemoonsoft.com/",
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

--- Gets the browser onto a site's home page, for the steps that need to BE somewhere before they can act:
--- the checkout has to reach its cart, bluemoonsoft's page navigation is same-site only, and the
--- single-site shopping loop searches whichever store is open.
---
--- A flow whose next step navigates to a URL of its own does NOT need this — the search readers all build
--- their own search URL, and opening a home page first is a whole page load spent to arrive somewhere the
--- next call leaves immediately.
---
--- The durable opener answered `status: "navigating"` and relied on the planner resuming the flow on the
--- destination. This one waits, so `search` means the browser is there.
function N.open_site(args)
  args = type(args) == "table" and args or {}
  local target = N.home_url(args.site) or trim(args.url)
  if not target then
    return { next = "error", error = trim(args.site) and "unknown_site" or "missing_target" }
  end

  local from = pcall(dom.get_location_href) and dom.get_location_href() or nil
  if from and N.same_site(target, from) then
    return { next = "search", site = args.site, url = target, href = from, navigated = false }
  end

  nav.navigate(target)
  nav.wait_for_navigation(from, { timeout = 15000, interval = 250 })
  local landed = pcall(dom.get_location_href) and dom.get_location_href() or nil
  if not landed or not N.same_site(target, landed) then
    return { next = "error", site = args.site, url = target, href = landed,
             error = "navigation_failed" }
  end
  return { next = "search", site = args.site, url = target, href = landed, navigated = true }
end
