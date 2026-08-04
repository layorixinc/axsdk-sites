--- The sitemap of the SITE the browser is on.
---
--- R26 asked the runtime for this and the answer we got back read the APP PACKAGE's sitemap instead —
--- measured live, the extension's own `/`, `/settings`, `/help`. We adopted it, every bluemoonsoft
--- request answered with no hits, and the flow fell back to `/front/main` without saying why. So the
--- request was withdrawn and the tool stayed remote.
---
--- `sitemap.search_site` is the client op that reads the other document: `sitesStore.currentSitemap`,
--- the sitemap of the domain the tab is on. Same intent, right data.

AX_RPC_SITEMAP = AX_RPC_SITEMAP or {}
local S = AX_RPC_SITEMAP

--- Default matches the client's own (`rpc-ops.ts`): the answer rides in a prompt, so it is bounded there
--- as well as here.
S.DEFAULT_LIMIT = 20

local function available()
  return type(sitemap) == "table" and type(sitemap.search_site) == "function"
end

--- Calls the op, retrying a refusal ONCE.
---
--- POSITIONAL: `search_site(regex, limit?)` per `docs/rpc_lua_authoring.md` §4. The runtime builds the
--- params object the client reads; passing that object ourselves answered `bad_params: regex` live.
---
--- A refusal while the channel re-attaches is not a fact about the site — treating one as an answer
--- reported "this page is not in the sitemap" for a page that is. Only a persistent refusal is reported,
--- and it carries its RAW reason: `command_unresolved` means the client never registered the op, while
--- anything else points back at how we called it, and those have opposite fixes.
local function search(regex, limit)
  if not available() then
    return nil, "sitemap_op_unavailable", "no sitemap global in this runtime"
  end
  local last
  for attempt = 1, 2 do
    local ok, value = pcall(sitemap.search_site, regex, limit)
    if ok then return value, nil, nil end
    last = tostring(value or "")
    if attempt == 2 then
      local text = last:lower()
      if text:find("command_unresolved", 1, true) or text:find("op_not_permitted", 1, true) then
        return nil, "sitemap_op_unavailable", last:sub(1, 160)
      end
      return nil, "sitemap_unavailable", last:sub(1, 160)
    end
  end
end

function S.search(args)
  args = type(args) == "table" and args or {}
  local regex = type(args.regex) == "string" and args.regex or ""
  -- The op throws `bad_params` on an empty regex. Refusing here costs no round trip.
  if regex == "" then
    return { next = "error", ok = false, error = "missing_regex" }
  end
  local limit = tonumber(args.limit)
  limit = (limit and limit > 0) and math.floor(limit) or S.DEFAULT_LIMIT

  local result, err, why = search(regex, limit)
  if err then
    return { next = "error", ok = false, error = err, reason = why }
  end
  local chunks = type(result) == "table" and result.chunks or nil
  local total = type(result) == "table" and tonumber(result.total) or nil
  local source = type(result) == "table" and result.source or nil

  -- WHICH document answered decides whether this is an answer at all. When the site's sitemap is not
  -- loaded the client falls back to the app's own site index, and those lines look like site lines —
  -- measured live on bluemoonsoft, the hits were other sites' directory entries and the flow navigated
  -- to the home page as though it had found the page. `none` means neither document was there, which
  -- used to be indistinguishable from the index matching nothing. Both are refusals, and neither is
  -- "this site has no such page". A client that predates the field says nothing, and is trusted.
  if source == "index" or source == "none" then
    return {
      next = "error", ok = false, error = "site_sitemap_missing", source = source,
      -- Carried on purpose: these lines are the evidence for the refusal.
      chunks = type(chunks) == "table" and chunks or {},
      total = total or 0,
    }
  end

  -- No matches is an answer: the page is not listed, and the caller navigates to a known entry point
  -- instead. Sending it down the error branch would make "not listed" look like "could not look".
  return {
    next = "go",
    ok = true,
    chunks = type(chunks) == "table" and chunks or {},
    total = total or 0,
    source = source,
  }
end
