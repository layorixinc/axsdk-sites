--- The affiliate link for the offer the user picked.
---
--- Made at the ONE moment policy allows: after a numbered pick at the comparison window. That pick
--- already exists — `present_offers` renders, pauses, and reads the reply — so this module never decides
--- WHEN, only whether the store can be monetised and what the pick was worth.
---
--- Three things are structural rather than promised:
---
---  * It is granted no `nav.*`. It cannot navigate anywhere, so it cannot force a redirect.
---  * It never talks to an affiliate API. The signing keys live on our server; the extension knows one
---    host and sends it a product URL.
---  * A link and its disclosure are produced together or not at all. A link without the disclosure is
---    the violation, so there is no path that yields one without the other.

AX_RPC_AFFILIATE = AX_RPC_AFFILIATE or {}
local A = AX_RPC_AFFILIATE

local B = AX_BASE
if not B then
  error("_common/scripts/00_base.lua must be loaded before 74_rpc_affiliate.lua")
end

local W = AX_RPC_WIDGET
if not W then
  error("_common/rpc/69_rpc_widget.lua must be loaded before 74_rpc_affiliate.lua")
end

--- Our own conversion service. NOT the affiliate API: the access key and the HMAC signing stay server
--- side, and a key in the extension bundle is a key anyone can lift and earn on.
A.ENDPOINT = "https://api.axsdk.ai/v1/affiliate/deeplink"
A.TIMEOUT_MS = 6000

local function non_empty(value)
  return (type(value) == "string" and value ~= "") and value or nil
end

--- The program a site declares, from the generated site data the reader actually runs on.
local function program_for(site)
  if type(RPC_SITES) ~= "table" then return nil end
  local config = site and RPC_SITES[site]
  local affiliate = type(config) == "table" and config.affiliate or nil
  if type(affiliate) ~= "table" then return nil end
  if not non_empty(affiliate.program) then return nil end
  return affiliate
end

--- The total a row costs, read from ONE named field so both sides of a subtraction share units.
---
--- Mixing them is not hypothetical: the caller's offer object may carry only the converted `total_base`
--- while the snapshot rows carry the rendered `price_total`, and subtracting one from the other produced
--- "최대 18,999원 절약" on a comparison whose real saving was 3,610.
local function total_in(offer, field)
  if type(offer) ~= "table" then return nil end
  return tonumber(offer[field])
end

local function group(amount)
  local text = string.format("%d", math.floor(amount + 0.5))
  local out = text:reverse():gsub("(%d%d%d)", "%1,"):reverse()
  return (out:gsub("^,", ""))
end

--- The row the user picked, found IN the listing they read.
---
--- The saving is a statement about that window, so both numbers come out of it. Taking the picked total
--- from the caller's object instead is how the units drifted.
local function picked_row(snapshot, selected)
  local want_id = non_empty(selected.product_id) or non_empty(selected.id)
  local want_site = non_empty(selected.site)
  for index = 1, #snapshot.offers do
    local row = snapshot.offers[index]
    if type(row) == "table" then
      local id = non_empty(row.product_id) or non_empty(row.id)
      if id and id == want_id and (not want_site or row.site == want_site) then return row end
    end
  end
  return nil
end

--- What the pick saved against the dearest comparable row, or nil when the comparison shows no saving.
---
--- Stated only when it is true: a one-row comparison saves nothing, and the picked row may be the
--- dearest. Inventing a number to satisfy the "direct user benefit" requirement is the deception the
--- requirement exists to prevent.
---
--- Rows that state no total are EXCLUDED — 11st says nothing about shipping on most cards, and a wrong
--- number in a saving claim is worse than no claim.
function A.saving(snapshot, selected)
  if type(snapshot) ~= "table" or type(snapshot.offers) ~= "table" then return nil end
  local mine_row = picked_row(snapshot, type(selected) == "table" and selected or {})
  if not mine_row then return nil end

  -- Whichever field the listing states, both sides are read from THAT one.
  for _, field in ipairs({ "price_total", "total_base" }) do
    local mine = total_in(mine_row, field)
    if mine then
      local highest = nil
      for index = 1, #snapshot.offers do
        local total = total_in(snapshot.offers[index], field)
        if total and (not highest or total > highest) then highest = total end
      end
      local saved = (highest or mine) - mine
      if saved <= 0 then return nil end
      local currency = non_empty(snapshot.display_currency)
      if not currency or currency == "KRW" then
        return string.format("최대 %s원 절약", group(saved))
      end
      return string.format("최대 %s %s 절약", currency, group(saved))
    end
  end
  return nil
end

local function decode(text)
  if type(text) ~= "string" or text == "" then return nil end
  if type(json) ~= "table" or type(json.decode) ~= "function" then return nil end
  local ok, value = pcall(json.decode, text)
  return ok and type(value) == "table" and value or nil
end

--- The first usable deep link in the reply. A 200 is not a link: an empty list, a missing field and a
--- non-https string all arrive that way.
local function first_link(payload)
  local links = type(payload) == "table" and payload.links or nil
  if type(links) ~= "table" then return nil end
  for index = 1, #links do
    local entry = links[index]
    local url = type(entry) == "table" and non_empty(entry.affiliate_url) or nil
    if url and url:match("^https://") then return url end
  end
  return nil
end

--- Converts the picked offer, or explains why it could not.
---
--- Branches: `no_program` (this store is not monetisable — the caller continues as before), `ready`,
--- `unavailable` (the conversion failed; the comparison STANDS and the user still gets their answer).
function A.link(args)
  args = type(args) == "table" and args or {}
  local selected = type(args.selected_offer) == "table" and args.selected_offer or {}
  local site = non_empty(args.site) or non_empty(selected.site)
  local affiliate = program_for(site)
  if not affiliate then
    return { next = "no_program", ok = true, site = site }
  end

  local target = non_empty(selected.url)
  if not target then
    return { next = "unavailable", ok = false, site = site, error = "offer_has_no_url" }
  end
  if type(net) ~= "table" or type(net.fetch) ~= "function" then
    -- No `net:` block on this tool, or a runtime without egress. Say which, raw.
    return { next = "unavailable", ok = false, site = site, error = "affiliate_fetch_unavailable" }
  end

  local body = json.encode({
    program = affiliate.program,
    urls = { target },
    comparison_id = non_empty(args.comparison_id),
    product_id = non_empty(selected.product_id) or non_empty(selected.id),
  })
  local ok, response = pcall(net.fetch, A.ENDPOINT, {
    method = "POST",
    headers = { ["content-type"] = "application/json", accept = "application/json" },
    body = body,
    credentials = "omit",
    timeout = A.TIMEOUT_MS,
  })
  if not ok then
    return { next = "unavailable", ok = false, site = site, error = "affiliate_unreachable" }
  end
  -- One decoder: the runtime answers {body, headers, ok, status} and never a `json` field.
  local url = first_link(B.response_json(response) or decode(type(response) == "table" and response.body or nil))
  if not url then
    return {
      next = "unavailable", ok = false, site = site,
      error = "affiliate_no_link:" .. tostring(type(response) == "table" and response.status or "no_response"),
    }
  end

  local snapshot = decode(args.comparison_state)
  local saving = A.saving(snapshot, selected)
  local label = non_empty(selected.name) and ("쿠팡에서 보기") or "상품 보기"
  local widget = W.render({
    template_id = "link_button",
    data = { label = label, action = { type = "link", url = url, target = "_blank" } },
  })

  return {
    next = "ready",
    ok = true,
    site = site,
    program = affiliate.program,
    affiliate_url = url,
    -- Produced WITH the link, never separately.
    disclosure = affiliate.disclosure,
    saving_text = saving,
    widget = type(widget) == "table" and non_empty(widget.value) or nil,
    widget_error = type(widget) == "table" and non_empty(widget.error) or nil,
  }
end
