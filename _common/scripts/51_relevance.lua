--- 검색어 변형, discovery용 recall, 구조·비용 정규화. 비교 관련성 판단은 LLM만 담당한다.
local B = AX_BASE
local C = AX_COMMERCE
if not (B and C) then
  error("_common/scripts/50_commerce_core.lua must be loaded before 51_relevance.lua")
end
local non_empty = B.non_empty
local lower, copy_table, array, free_shipping, collect_currencies, convert_to_base = C.lower, C.copy_table, C.array, C.free_shipping, C.collect_currencies, C.convert_to_base

local RELEVANCE_STOP_WORDS = {
  ["and"] = true,
  ["for"] = true,
  ["the"] = true,
  ["with"] = true,
  ["new"] = true
}

-- Equivalent wordings are NOT kept in this file. A storefront lists the same product in its own
-- language, and which words mean the same thing is a language question, so the model that read the
-- request supplies them: `query_variants` for the search box and `brand_aliases` for matching. This
-- module only splits, orders, bounds, and applies them.
local function split_list(value)
  local items = array()
  local seen = {}
  for piece in tostring(value or ""):gmatch("[^|\n]+") do
    local text = non_empty(piece)
    if text and not seen[lower(text)] then
      seen[lower(text)] = true
      items[#items + 1] = text
    end
  end
  return items
end

--- The wordings one store search may try, in order: the caller's own query first, then the model's
--- alternatives as it ranked them. Each extra wording costs a navigation, so the list is bounded like
--- the page budget, and a request with no alternatives is searched exactly once.
function C.query_variants(options)
  options = options or {}
  local ordered = array()
  local seen = {}
  local function add(value)
    local text = non_empty(value)
    if not text or seen[lower(text)] then return end
    seen[lower(text)] = true
    ordered[#ordered + 1] = text
  end

  local base = non_empty(options.query)
  if not base then return ordered end
  add(base)

  local supplied = split_list(options.query_variants)
  for index = 1, #supplied do add(supplied[index]) end

  while #ordered > 3 do table.remove(ordered) end
  return ordered
end

local function relevance_tokens(value)
  local tokens = array()
  local normalized = lower(value):gsub("[%p%c]", " ")
  for token in normalized:gmatch("%S+") do
    if #token > 1 and not RELEVANCE_STOP_WORDS[token] then tokens[#tokens + 1] = token end
  end
  return tokens
end

local function flatten_discovery_token(value)
  return (lower(value):gsub("%p", ""))
end

local function ascii_alphanumeric(byte)
  if byte == nil or byte >= 128 then return false end
  return string.char(byte):match("%w") ~= nil
end

local function discovery_boundary(neighbour, edge)
  if not ascii_alphanumeric(neighbour) then return true end
  return not ascii_alphanumeric(edge)
end

--- A discovery anchor is a whole token: GE must not match `Storage`, while M185 may match `M-185`.
--- Script changes are boundaries so a localized brand glued to a Latin model remains discoverable.
local function discovery_anchor_present(haystack, anchor)
  if anchor == "" then return false end
  local flat = flatten_discovery_token(haystack)
  local from = 1
  while true do
    local first, last = flat:find(anchor, from, true)
    if not first then return false end
    local before = first > 1 and flat:byte(first - 1) or nil
    if discovery_boundary(before, flat:byte(first))
      and discovery_boundary(flat:byte(last + 1), flat:byte(last)) then
      return true
    end
    from = first + 1
  end
end

--- A discovery token matches when it appears, or when another spelling of THAT brand token does. This is
--- only a broad recall guard for the model-choice surface; comparison relevance belongs to the LLM.
local function token_matches(haystack, token, aliases)
  local function present(needle)
    return discovery_anchor_present(haystack, needle)
  end
  if present(token) then return true end
  local count = #(aliases or {})
  if count == 0 then return false end

  local in_set = false
  for index = 1, count do
    if aliases[index] == token then in_set = true break end
  end
  if not in_set then return false end

  for index = 1, count do
    local alias = aliases[index]
    if alias ~= token and present(alias) then return true end
  end
  return false
end

--- Every spelling of the brand the model listed, lowercased, or an empty list when it listed none.
local function brand_alias_list(options)
  local raw = split_list(options and options.brand_aliases)
  local out = array()
  for index = 1, #raw do out[#out + 1] = lower(raw[index]) end
  return out
end

-- Discovery reads structured fields as well as the title so a localized brand field can keep a grounded
-- model option in the user-choice surface. This is not the comparison relevance judgement.
local function discovery_haystack(candidate)
  if type(candidate) ~= "table" then return lower(candidate) end
  local parts = {}
  local function append(value)
    local text = non_empty(value)
    if text then parts[#parts + 1] = text end
  end
  append(candidate.name)
  append(candidate.title)
  append(candidate.brand)
  append(candidate.manufacturer_model)
  append(candidate.model_hint)
  return lower(table.concat(parts, " "))
end

--- Whether a storefront title states the requested brand or one model-supplied spelling. This extracts a
--- structured brand field for discovery provenance; it never includes or excludes a comparison row.
local function brand_matches(candidate, brand, options)
  local tokens = relevance_tokens(brand)
  if #tokens == 0 then return false end
  local haystack = discovery_haystack(candidate)
  local aliases = brand_alias_list(options)
  for index = 1, #tokens do
    if not token_matches(haystack, tokens[index], aliases) then return false end
  end
  return true
end


local function matches_discovery_query(candidate, query, options)
  local aliases = brand_alias_list(options)
  local haystack = discovery_haystack(candidate)
  local tokens = relevance_tokens(query)
  if #tokens == 0 then return false end

  local requested_brand = non_empty(options and (options.requested_brand or options.identity_brand))
  local brand_tokens = relevance_tokens(requested_brand)
  local brand_keys = {}
  for index = 1, #brand_tokens do
    local token = brand_tokens[index]
    brand_keys[token] = true
    if not token_matches(haystack, token, aliases) then return false end
  end

  local considered = 0
  for index = 1, #tokens do
    local token = tokens[index]
    if not brand_keys[token] then
      considered = considered + 1
      if token_matches(haystack, token, aliases) then return true end
    end
  end
  return #brand_tokens > 0 and considered == 0
end

function C.normalize_candidates(site, candidates, quantity, query, options)
  local qty = math.max(1, math.floor(tonumber(quantity) or 1))
  local purpose = non_empty(options and options.purpose) or "comparison"
  local limit = purpose == "discovery" and C.MAX_DISCOVERY_RESULTS or C.SCREEN_LIMIT_PER_SITE
  local fx = C.fetch_fx_rates(collect_currencies(candidates))
  if fx.pending then
    return nil, fx
  end

  local normalized = array()
  for index = 1, #(candidates or {}) do
    local candidate = candidates[index] or {}
    local item = copy_table(candidate)
    item.site = lower(site)
    item.product_id = non_empty(item.product_id or item.id)
    item.id = item.product_id
    item.name = non_empty(item.name or item.title)
    item.summary = nil
    item.image_url = nil
    item.currency = non_empty(item.currency) and tostring(item.currency):upper() or nil
    item.price = tonumber(item.price)
    item.shipping_cost = tonumber(item.shipping_cost)
    if item.shipping_cost == nil and free_shipping(item.shipping_text) then
      item.shipping_cost = 0
    end
    item.shipping_currency = non_empty(item.shipping_currency) and tostring(item.shipping_currency):upper() or item.currency
    item.base_currency = fx.base or C.BASE_CURRENCY

    local price_base, price_rate = convert_to_base(item.price, item.currency, fx.rates)
    local shipping_base, shipping_rate = convert_to_base(item.shipping_cost, item.shipping_currency, fx.rates)
    item.price_base = price_base
    item.shipping_base = shipping_base
    item.fx_rate = price_rate or shipping_rate
    item.fx_date = fx.date
    item.fx_source = fx.source
    item.cost_complete = item.product_id ~= nil and item.name ~= nil and price_base ~= nil and shipping_base ~= nil
    item.known_cost_base = price_base and (price_base * qty) or nil
    if item.cost_complete then
      item.unit_total = item.price + item.shipping_cost
      item.total_for_quantity = (item.price * qty) + item.shipping_cost
      item.total_base = (price_base * qty) + shipping_base
    else
      item.unit_total = nil
      item.total_for_quantity = nil
      item.total_base = nil
      item.cost_error = fx.error or (item.shipping_cost == nil and "shipping_unknown") or "currency_conversion_unavailable"
    end

    -- Comparison rows are a bounded RECALL surface for `judge_relevance`; code must not decide which
    -- search result is the requested product before the LLM sees it. Discovery is different: its rows
    -- become grounded model choices for the user, so its broad query/brand recall guard remains.
    local accepted = purpose ~= "discovery" or matches_discovery_query(item, query, options)
    if item.product_id and item.name and item.price and accepted then
      item.match_level = nil
      item.match_missing = nil
      normalized[#normalized + 1] = item
      if #normalized >= limit then break end
    end
  end
  return normalized, fx
end

-- 다른 commerce 모듈과 공유한다. 파일 순서상 이 아래 모듈들이 헤더에서 집어 간다.
C.split_list, C.brand_matches = split_list, brand_matches
