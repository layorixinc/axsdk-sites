--- 검색어 변형과 관련성 판정. 모델 코드와 브랜드가 앵커, 나머지 단어는 점수일 뿐이다.
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

--- A token matches when it appears, or when another spelling of THAT token does. The alias set names one
--- thing written several ways ("Logitech|로지텍"), so it substitutes only for a token that is one of those
--- spellings: applying it to every token let the brand's presence vouch for descriptor words too, and a
--- listing that never mentioned "ergonomic" was reported as an exact match for it.
-- Punctuation is dropped so "M-185" reads as one token, but whitespace is KEPT: gluing the whole title
-- together turned "Logitech M185" into "logitechm185" and the model code then looked like the tail of
-- another word, so an exact English listing was rejected.
local function flatten_for_anchor(value)
  return (lower(value):gsub("%p", ""))
end
local function alphanumeric_byte(byte)
  if byte == nil then return false end
  -- A multi-byte (Korean) neighbour is a word boundary for a latin model code: "로지텍m185" matches.
  if byte >= 128 then return false end
  return string.char(byte):match("%w") ~= nil
end

--- A word boundary between `neighbour` and the token's own adjacent byte `edge`. Two ASCII alphanumerics are
--- the same word; anything else is a boundary, INCLUDING a script change. Both halves are needed: reading
--- only the neighbour said "로지텍m185" has no boundary after `로지텍` (the neighbour `m` is alphanumeric) and
--- refused every Korean listing whose brand is glued to a latin model code — while reading only the edge
--- would let "ge" inside "Range" pass.
local function boundary_at(neighbour, edge)
  if not alphanumeric_byte(neighbour) then return true end
  return not alphanumeric_byte(edge)
end

--- True when `anchor` occurs in `haystack` as a whole token (M185 matches "M-185", never "M185R").
local function anchor_present(haystack, anchor)
  if anchor == "" then return false end
  local flat = flatten_for_anchor(haystack)
  local from = 1
  while true do
    local first, last = flat:find(anchor, from, true)
    if not first then return false end
    local before = first > 1 and flat:byte(first - 1) or nil
    if boundary_at(before, flat:byte(first)) and boundary_at(flat:byte(last + 1), flat:byte(last)) then
      return true
    end
    from = first + 1
  end
end
--- `whole` requires the token to appear as a WORD. The descriptors do not ask for it — they only score, and
--- a substring hit there costs at most an `(유사)` label. The BRAND anchor decides inclusion, and a short
--- brand is inside ordinary words: "ge" sits in Range, Storage, Vintage, Package, which is the vocabulary of
--- the very listings a GE search returns, so a Samsung refrigerator satisfied the brand anchor. Korean is
--- unaffected: its bytes are not ASCII alphanumerics, so `anchor_present` already treats them as boundaries.
local function token_matches(haystack, token, aliases, whole)
  local present = function(needle)
    if needle == "" then return false end
    if whole then return anchor_present(haystack, needle) end
    return haystack:find(needle, 1, true) ~= nil
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

-- Korean storefronts return the brand as a separate field ("brandName": "아디다스") and leave it out of
-- the product title, so matching the query against the title alone drops every offer of the requested
-- brand. Relevance therefore reads the structured fields the adapter already extracted.
function C.relevance_haystack(candidate)
  if type(candidate) ~= "table" then return lower(candidate) end
  local parts = {}
  -- Listed one by one: a table literal with a nil hole ends an ipairs walk early, which silently
  -- dropped every field after the first missing one (brand after an absent title).
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

local function matches_query(candidate, query, options)
  local aliases = brand_alias_list(options)
  local haystack = C.relevance_haystack(candidate)
  local tokens = relevance_tokens(query)
  if #tokens == 0 then return false end
  for index = 1, #tokens do
    if not token_matches(haystack, tokens[index], aliases) then return false end
  end
  return true
end

-- Relevance has to survive two facts about real listings: a Korean storefront writes the same product
-- without the English brand or the category word ("로지텍 M185 (정품)"), and a search for one model
-- returns neighbouring models ("로지텍 M750 …") that would otherwise eat the per-store cap. So the model
-- code and the brand ANCHOR the decision, and the remaining descriptor words only decide whether the
-- match is exact or merely similar. Without a model code there is nothing to anchor on and the strict
-- all-token rule stands.
local function normalize_anchor(value)
  return (lower(value):gsub("[%s%p]", ""))
end


local function is_model_token(token)
  return token:find("%d") ~= nil and token:find("%a") ~= nil and #normalize_anchor(token) >= 3
end


--- The model code and brand words a comparison must not compromise on.
function C.relevance_anchors(query, options)
  local model = non_empty(options and options.identity_model)
  local tokens = relevance_tokens(query)
  if not model then
    for index = 1, #tokens do
      if is_model_token(tokens[index]) then model = tokens[index] break end
    end
  end
  local brand = non_empty(options and (options.identity_brand or options.requested_brand))
  local brand_tokens = relevance_tokens(brand)
  local brand_keys = {}
  for index = 1, #brand_tokens do brand_keys[brand_tokens[index]] = true end

  local descriptors = array()
  local model_key = model and lower(model) or nil
  for index = 1, #tokens do
    local token = tokens[index]
    if token ~= model_key and not brand_keys[token] and not is_model_token(token) then
      descriptors[#descriptors + 1] = token
    end
  end
  return { model = model_key, brand_tokens = brand_tokens, descriptors = descriptors }
end

--- nil when the candidate is a different product; otherwise how close the wording is.
function C.relevance_match(candidate, query, options)
  local aliases = brand_alias_list(options)
  local haystack = C.relevance_haystack(candidate)
  local anchors = C.relevance_anchors(query, options)
  if not anchors.model then
    return matches_query(candidate, query, options) and { level = "exact", missing = "" } or nil
  end

  if not anchor_present(haystack, normalize_anchor(anchors.model)) then return nil end
  for index = 1, #anchors.brand_tokens do
    -- `true` = whole word. The brand decides INCLUSION, so a short brand found inside an ordinary word put
    -- a competitor's product in the comparison: "ge" is inside Range, Storage, Vintage and Package.
    if not token_matches(haystack, anchors.brand_tokens[index], aliases, true) then return nil end
  end

  local missing = array()
  for index = 1, #anchors.descriptors do
    local token = anchors.descriptors[index]
    if not token_matches(haystack, token, aliases) then missing[#missing + 1] = token end
  end
  return {
    level = #missing == 0 and "exact" or "partial",
    missing = table.concat(missing, " ")
  }
end

local function matches_discovery_query(candidate, query, options)
  local aliases = brand_alias_list(options)
  local haystack = C.relevance_haystack(candidate)
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
  local identity_model = non_empty(options and options.identity_model)
  local identity_brand = non_empty(options and options.identity_brand)
  local comparison_query = query
  if purpose ~= "discovery" and identity_model then
    comparison_query = identity_brand and (identity_brand .. " " .. identity_model) or identity_model
  end
  local fx = C.fetch_fx_rates(collect_currencies(candidates))
  if fx.pending then
    return nil, fx
  end

  -- Two passes: collect what qualifies, then fill the per-store cap with exact wording first. Filling in
  -- read order let a loosely-worded listing crowd out the exact one when the cap is 3.
  local exact = array()
  local partial = array()
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

    local match = nil
    if purpose == "discovery" then
      match = matches_discovery_query(item, query, options) and { level = "exact", missing = "" } or nil
    else
      match = C.relevance_match(item, comparison_query, options)
    end
    if item.product_id and item.name and item.price and match then
      item.match_level = match.level
      item.match_missing = match.missing ~= "" and match.missing or nil
      if match.level == "exact" then
        exact[#exact + 1] = item
      else
        partial[#partial + 1] = item
      end
    end
  end

  local normalized = array()
  for index = 1, #exact do
    if #normalized >= limit then break end
    normalized[#normalized + 1] = exact[index]
  end
  for index = 1, #partial do
    if #normalized >= limit then break end
    normalized[#normalized + 1] = partial[index]
  end
  return normalized, fx
end

-- 다른 commerce 모듈과 공유한다. 파일 순서상 이 아래 모듈들이 헤더에서 집어 간다.
C.split_list, C.matches_query = split_list, matches_query
