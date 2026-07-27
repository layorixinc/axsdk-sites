local B = AX_BASE
if not B then
  error("_common/scripts/00_base.lua must be loaded before 50_commerce.lua")
end

AX_COMMERCE = AX_COMMERCE or {}
local C = AX_COMMERCE
C.adapters = C.adapters or {}
C.BASE_CURRENCY = "USD"
C.FX_URL = "https://api.frankfurter.dev/v1/latest"
C.MAX_OFFERS_PER_SITE = 3
-- Relevance is decided in two stages. The deterministic pass keeps what COULD be the product, up to
-- SCREEN_LIMIT_PER_SITE per store, because token rules cannot tell a mouse from a mouse pad; one model
-- call then says which rows actually are it, and MAX_OFFERS_PER_SITE is applied to what survives. The
-- screening list is the only part of this that ever enters a prompt, so it is bounded too.
C.SCREEN_LIMIT_PER_SITE = 6
C.SCREEN_MAX_ROWS = 30
C.SCREEN_TITLE_CHARS = 70
-- Ranking keeps more offers than one window shows: browsing pages through them, and only the window is
-- ever rendered into a prompt. The cap bounds the serialized flow state, not the model's context.
C.MAX_RANKED_OFFERS = 15
C.MAX_DISCOVERY_RESULTS = 6
C.SITE_HOMES = {
  ["11st"] = "https://www.11st.co.kr/",
  aliexpress = "https://www.aliexpress.com/",
  amazon = "https://www.amazon.com/",
  coupang = "https://www.coupang.com/",
  ebay = "https://www.ebay.com/",
  etsy = "https://www.etsy.com/",
  gmarket = "https://www.gmarket.co.kr/",
  ["naver-shopping"] = "https://search.shopping.naver.com/search/all?query=%EC%87%BC%ED%95%91",
  ssg = "https://www.ssg.com/",
  walmart = "https://www.walmart.com/"
}

local function clean(value)
  return B.clean_text(value)
end

local function non_empty(value)
  return B.non_empty(value)
end

local function lower(value)
  return clean(value):lower()
end

local function copy_table(value)
  local out = {}
  if type(value) == "table" then
    for key, item in pairs(value) do
      out[key] = item
    end
  end
  return out
end

local function array()
  if ax and type(ax.array) == "function" then
    return ax.array()
  end
  return {}
end

function C.register_adapter(site, adapter)
  local slug = lower(site)
  if slug == "" or type(adapter) ~= "table" then
    return false
  end
  adapter.site = slug
  C.adapters[slug] = adapter
  return true
end

function C.adapter(site)
  return C.adapters[lower(site)]
end

function C.current_url()
  return non_empty(dom.get_location_href()) or ""
end

local function home_matches_url(home, url)
  local target_host = tostring(home or ""):match("^https?://([^/]+)")
  local current_host = tostring(url or ""):match("^https?://([^/]+)")
  if not target_host or not current_host then return false end
  local base = target_host:lower():gsub("^www%.", "")
  local host = current_host:lower()
  return host == base or host:sub(-(#base + 1)) == "." .. base
end

function C.ensure_adapter(site)
  local slug = lower(site)
  local adapter = C.adapters[slug]
  local href = C.current_url()
  local on_target = adapter and type(adapter.host_matches) == "function" and adapter.host_matches(href)
  if on_target then return adapter, nil, nil end

  local home = non_empty((adapter and adapter.home_url) or C.SITE_HOMES[slug])
  if not home then return nil, adapter and "site_home_unavailable" or "site_adapter_unavailable", nil end
  if not adapter and home_matches_url(home, href) then
    return nil, nil, "loading_adapter"
  end
  if home_matches_url(home, href) then return nil, "site_navigation_failed", nil end

  if nav and type(nav.clear_beforeunload) == "function" then nav.clear_beforeunload() end
  nav.navigate(home, {}, { reload = true })
  return nil, nil, "navigating"
end

local function free_shipping(text)
  local value = lower(text)
  if value == "" then
    return false
  end
  return value:find("free shipping", 1, true) ~= nil
    or value:find("free delivery", 1, true) ~= nil
    or value:find("shipping: free", 1, true) ~= nil
    or value:find("무료 배송", 1, true) ~= nil
    or value:find("배송비 무료", 1, true) ~= nil
end

local function collect_currencies(candidates)
  local set = {}
  for index = 1, #(candidates or {}) do
    local candidate = candidates[index] or {}
    local currency = non_empty(candidate.currency)
    local shipping_currency = non_empty(candidate.shipping_currency)
    if currency then set[currency:upper()] = true end
    if shipping_currency then set[shipping_currency:upper()] = true end
  end
  return set
end

-- Normalization runs per store, so a worker only ever sees its own store's currency. Skipping the
-- conversion there looked cheap but left each store in its own units, and the parent ranked 13,190 KRW
-- against 13.95 USD as if both were the base. Every offer is therefore converted to one fixed base;
-- the comparison chooses its display currency later, when all offers are visible.
function C.fetch_fx_rates(currencies)
  local rates = { USD = 1 }
  local symbols = {}
  for currency in pairs(currencies or {}) do
    local code = tostring(currency):upper()
    if code ~= "USD" then
      symbols[#symbols + 1] = code
    end
  end
  table.sort(symbols)
  if #symbols == 0 then
    return { rates = rates, base = C.BASE_CURRENCY, date = nil, source = C.FX_URL }
  end

  local fetch = (net and net.fetch) or (http and http.fetch)
  if not fetch then
    return { rates = rates, source = C.FX_URL, error = "fx_fetch_unavailable" }
  end
  local response = fetch(C.FX_URL .. "?base=USD&symbols=" .. B.url_encode(table.concat(symbols, ",")), {
    method = "GET",
    headers = { accept = "application/json" },
    credentials = "omit",
    response = "json",
    timeout = 5000
  })
  if response and response.reason == "pending" then
    return { pending = true, source = C.FX_URL }
  end
  if not response or response.ok ~= true or type(response.json) ~= "table" then
    return { rates = rates, source = C.FX_URL, error = "fx_fetch_failed" }
  end

  local body_rates = response.json.rates
  if type(body_rates) == "table" then
    for code, amount in pairs(body_rates) do
      local numeric = tonumber(amount)
      if numeric and numeric > 0 then
        rates[tostring(code):upper()] = numeric
      end
    end
  end
  return {
    rates = rates,
    date = non_empty(response.json.date),
    source = C.FX_URL
  }
end

local function convert_to_base(amount, currency, rates)
  local numeric = tonumber(amount)
  local code = non_empty(currency)
  if not numeric or not code then
    return nil, nil
  end
  code = code:upper()
  local rate = tonumber((rates or {})[code])
  if not rate or rate <= 0 then
    return nil, nil
  end
  return numeric / rate, rate
end

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
local function token_matches(haystack, token, aliases)
  if haystack:find(token, 1, true) then return true end
  local count = #(aliases or {})
  if count == 0 then return false end

  local in_set = false
  for index = 1, count do
    if aliases[index] == token then in_set = true break end
  end
  if not in_set then return false end

  for index = 1, count do
    local alias = aliases[index]
    if alias ~= "" and alias ~= token and haystack:find(alias, 1, true) then return true end
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

-- Punctuation is dropped so "M-185" reads as one token, but whitespace is KEPT: gluing the whole title
-- together turned "Logitech M185" into "logitechm185" and the model code then looked like the tail of
-- another word, so an exact English listing was rejected.
local function flatten_for_anchor(value)
  return (lower(value):gsub("%p", ""))
end

local function is_model_token(token)
  return token:find("%d") ~= nil and token:find("%a") ~= nil and #normalize_anchor(token) >= 3
end

local function alphanumeric_byte(byte)
  if byte == nil then return false end
  -- A multi-byte (Korean) neighbour is a word boundary for a latin model code: "로지텍m185" matches.
  if byte >= 128 then return false end
  return string.char(byte):match("%w") ~= nil
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
    if not alphanumeric_byte(before) and not alphanumeric_byte(flat:byte(last + 1)) then return true end
    from = first + 1
  end
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
    if not token_matches(haystack, anchors.brand_tokens[index], aliases) then return nil end
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

local function worker_value(result)
  if type(result) ~= "table" then return nil end
  local value = result.value
  if type(value) ~= "table" then return nil end
  if type(value.store_result) == "table" then return value.store_result end
  return value
end

local function identity_text(value)
  return lower(value):gsub("%s+", ""):gsub("[%p%c]", "")
end

local function stable_hash(value)
  local hash = 5381
  local text = tostring(value or "")
  for index = 1, #text do
    hash = ((hash * 33) + text:byte(index)) % 4294967296
  end
  return string.format("%.0f", math.floor(hash))
end

local function canonical_value(value, active)
  local kind = type(value)
  if kind == "nil" then return "z" end
  if kind == "boolean" then return value and "b1" or "b0" end
  if kind == "number" then
    local text = tostring(value)
    return "n" .. tostring(#text) .. ":" .. text
  end
  if kind == "string" then
    return "s" .. tostring(#value) .. ":" .. value
  end
  if kind ~= "table" then return "x" .. kind end

  active = active or {}
  if active[value] then return "cycle" end
  active[value] = true
  local entries = array()
  for key in pairs(value) do
    entries[#entries + 1] = { key = key, canonical_key = canonical_value(key, active) }
  end
  table.sort(entries, function(left, right) return left.canonical_key < right.canonical_key end)
  local fields = array()
  for index = 1, #entries do
    local entry = entries[index]
    fields[#fields + 1] = entry.canonical_key .. canonical_value(value[entry.key], active)
  end
  active[value] = nil
  return "t" .. tostring(#fields) .. ":" .. table.concat(fields)
end

local function stable_fields(value)
  if type(value) ~= "table" then return "t0:" end
  return canonical_value(value)
end

local function joined_query(brand, model, category)
  local parts = array()
  local seen = {}
  local function add(value)
    local text = non_empty(value)
    local key = text and identity_text(text)
    if text and key ~= "" and not seen[key] then
      seen[key] = true
      parts[#parts + 1] = text
    end
  end
  add(brand)
  add(model)
  add(category)
  return non_empty(table.concat(parts, " "))
end

local function infer_model(value)
  local text = clean(value)
  for token in text:gmatch("[%w%-]+") do
    local normalized = token:lower()
    local has_letter = token:match("%a") ~= nil
    local has_digit = token:match("%d") ~= nil
    local unit = normalized:find("ghz", 1, true)
      or normalized:find("mah", 1, true)
      or normalized:find("gb", 1, true)
      or normalized:find("tb", 1, true)
      or normalized:find("dpi", 1, true)
    if has_letter and has_digit and not unit and #token >= 2 then return token end
  end
  return nil
end

local function candidate_model(candidate)
  return non_empty(candidate and (candidate.manufacturer_model or candidate.model_hint or candidate.model))
    or infer_model(candidate and (candidate.name or candidate.title))
end

local function identity_fingerprint(kind, brand, model, category, hard_constraints)
  return table.concat({
    "kind=" .. tostring(kind or ""),
    "brand=" .. identity_text(brand),
    "model=" .. identity_text(model),
    "category=" .. identity_text(category),
    "hard=" .. stable_fields(hard_constraints)
  }, "|")
end

function AX_prepare_product_identity(args)
  args = args or {}
  local category = non_empty(args.product_category or args.category)
  local brand = non_empty(args.requested_brand or args.brand)
  local model = non_empty(args.requested_model or args.model)
  if not category and not model then
    return {
      next = "ask_scope",
      identity_status = "missing",
      error = "missing_product_scope"
    }
  end

  local query = joined_query(brand, model, category)
  if model then
    return {
      next = "lock",
      identity_status = "exact",
      identity_kind = non_empty(args.identity_kind) or "standardized_model",
      product_category = category,
      identity_brand = brand,
      identity_model = model,
      canonical_query = query,
      hard_constraints = copy_table(args.hard_constraints),
      soft_preferences = copy_table(args.soft_preferences)
    }
  end

  local discovery_sites = array()
  local seen_sites = {}
  for index = 1, #(args.stores or {}) do
    local item = args.stores[index] or {}
    local site = non_empty(item.site)
    if site and not seen_sites[site] and #discovery_sites < 3 then
      seen_sites[site] = true
      discovery_sites[#discovery_sites + 1] = { site = site }
    end
  end

  return {
    next = "discover",
    identity_status = brand and "family" or "category",
    identity_kind = non_empty(args.identity_kind) or "standardized_model",
    product_category = category,
    identity_brand = brand,
    discovery_query = query,
    discovery_sites = discovery_sites,
    hard_constraints = copy_table(args.hard_constraints),
    soft_preferences = copy_table(args.soft_preferences)
  }
end

function AX_lock_product_identity(args)
  args = args or {}
  local kind = non_empty(args.identity_kind) or "standardized_model"
  local category = non_empty(args.product_category or args.category)
  local brand = non_empty(args.identity_brand or args.brand)
  local model = non_empty(args.identity_model or args.model)
  if kind == "standardized_model" and not model then
    return { next = "invalid", error = "model_required" }
  end
  if kind == "spec_equivalent" and not category then
    return { next = "invalid", error = "category_required" }
  end
  if kind == "unique_listing" and not non_empty(args.source_product_id) then
    return { next = "invalid", error = "source_listing_required" }
  end

  local hard = copy_table(args.hard_constraints)
  local fingerprint = identity_fingerprint(kind, brand, model, category, hard)
  return {
    next = "compare",
    identity_status = "locked",
    identity_id = "identity-" .. stable_hash(fingerprint),
    identity_fingerprint = fingerprint,
    identity_kind = kind,
    identity_name = non_empty(args.identity_name or args.display_name) or joined_query(brand, model, category),
    identity_brand = brand,
    identity_model = model,
    product_category = category,
    canonical_query = non_empty(args.canonical_query) or joined_query(brand, model, category),
    locked_hard_constraints = hard,
    locked_soft_preferences = copy_table(args.soft_preferences),
    identity_source_refs = args.source_refs,
    identity_approval = "locked_product_identity"
  }
end

function AX_build_product_options(args)
  args = args or {}
  local groups = {}
  local group_order = array()
  local failures = array()
  local results = args.results or args.discovery_results or {}
  local requested_brand = non_empty(args.requested_brand or args.identity_brand)

  for result_index = 1, #results do
    local result = results[result_index] or {}
    local site = non_empty(result.key) or tostring(result_index)
    if result.status == "completed" then
      local value = worker_value(result) or {}
      site = non_empty(value.site) or site
      local candidates = value.candidates or {}
      for candidate_index = 1, #candidates do
        local candidate = candidates[candidate_index] or {}
        local product_id = non_empty(candidate.product_id or candidate.id)
        local url = non_empty(candidate.url)
        local name = non_empty(candidate.name or candidate.title)
        if product_id and url and name then
          local model = candidate_model(candidate)
          local brand = non_empty(candidate.brand)
          local kind = model and "standardized_model" or "unique_listing"
          local key = model and ("model|" .. identity_text(brand) .. "|" .. identity_text(model))
            or ("listing|" .. identity_text(site) .. "|" .. identity_text(product_id))
          local option = groups[key]
          if not option then
            option = {
              identity_kind = kind,
              display_name = model and (joined_query(brand, model, nil) or name) or name,
              brand = brand,
              model = model,
              product_category = non_empty(args.product_category),
              identity_confidence = model and "medium" or "low",
              needs_enrichment = model == nil,
              source_refs = array(),
              sample_prices = array(),
              group_key = key,
              source_seen = {},
              site_seen = {},
              has_explicit_model = false
            }
            groups[key] = option
            group_order[#group_order + 1] = key
          end

          if non_empty(candidate.manufacturer_model) then option.has_explicit_model = true end
          local source_key = identity_text(site) .. "|" .. identity_text(product_id)
          if not option.source_seen[source_key] then
            option.source_seen[source_key] = true
            option.site_seen[site] = true
            option.source_refs[#option.source_refs + 1] = {
              site = site,
              product_id = product_id,
              url = url,
              name = name,
              brand_source = non_empty(candidate.brand_source),
              model_source = non_empty(candidate.model_source)
            }
            if tonumber(candidate.price) and non_empty(candidate.currency) then
              option.sample_prices[#option.sample_prices + 1] = {
                site = site,
                product_id = product_id,
                price = tonumber(candidate.price),
                currency = tostring(candidate.currency):upper()
              }
            end
          end
        end
      end
      if #candidates == 0 then
        failures[#failures + 1] = { site = site, error = value.error or "no_results" }
      end
    else
      failures[#failures + 1] = { site = site, error = result.error or "store_search_failed" }
    end
  end

  local options = array()
  for index = 1, #group_order do
    local option = groups[group_order[index]]
    local source_sites = array()
    for site in pairs(option.site_seen) do source_sites[#source_sites + 1] = site end
    table.sort(source_sites)
    table.sort(option.source_refs, function(left, right)
      local left_key = tostring(left.site or "") .. "|" .. tostring(left.product_id or "") .. "|" .. tostring(left.url or "")
      local right_key = tostring(right.site or "") .. "|" .. tostring(right.product_id or "") .. "|" .. tostring(right.url or "")
      return left_key < right_key
    end)
    table.sort(option.sample_prices, function(left, right)
      local left_key = tostring(left.site or "") .. "|" .. tostring(left.product_id or "") .. "|" .. tostring(left.currency or "")
      local right_key = tostring(right.site or "") .. "|" .. tostring(right.product_id or "") .. "|" .. tostring(right.currency or "")
      if left_key ~= right_key then return left_key < right_key end
      return (tonumber(left.price) or math.huge) < (tonumber(right.price) or math.huge)
    end)
    option.source_sites = source_sites
    option.source_site_count = #source_sites
    if option.model then
      option.identity_confidence = (option.has_explicit_model or #source_sites > 1) and "high" or "medium"
      option.model_source = option.has_explicit_model and "metadata" or "title_inference"
    end
    option.source_seen = nil
    option.site_seen = nil
    option.has_explicit_model = nil
    options[#options + 1] = option
  end
  table.sort(options, function(left, right)
    if left.source_site_count ~= right.source_site_count then return left.source_site_count > right.source_site_count end
    if #left.source_refs ~= #right.source_refs then return #left.source_refs > #right.source_refs end
    return tostring(left.display_name or "") < tostring(right.display_name or "")
  end)

  local limit = math.max(1, math.min(tonumber(args.max_options) or 5, 10))
  while #options > limit do table.remove(options) end
  for index = 1, #options do
    options[index].option_id = "D" .. tostring(index)
    options[index].group_key = nil
  end
  local version_snapshot = {
    query = non_empty(args.query or args.discovery_query),
    product_category = non_empty(args.product_category),
    requested_brand = requested_brand,
    hard_constraints = copy_table(args.hard_constraints),
    soft_preferences = copy_table(args.soft_preferences),
    options = options
  }
  local version = "disc-" .. stable_hash(canonical_value(version_snapshot))
  for index = 1, #options do options[index].options_version = version end

  return {
    next = #options > 0 and "choose" or "empty",
    options = options,
    options_version = version,
    failures = failures
  }
end

function AX_resolve_product_option(args)
  args = args or {}
  local options = args.options or args.product_options or {}
  local version = non_empty(args.options_version)
  local chosen_version = non_empty(args.choice_options_version)
  if not version or not chosen_version then
    return { next = "invalid", error = "product_options_version_required" }
  end
  if version ~= chosen_version then
    return { next = "invalid", error = "stale_product_options" }
  end

  local choice = tonumber(args.choice_index)
  if not choice and non_empty(args.choice_id) then
    for index = 1, #options do
      if tostring(options[index].option_id or "") == tostring(args.choice_id) then choice = index; break end
    end
  end
  if not choice or choice ~= math.floor(choice) or choice < 1 or choice > #options then
    return { next = "invalid", error = "invalid_product_option" }
  end

  local option = options[choice] or {}
  local sources = option.source_refs or {}
  if #sources == 0 then return { next = "invalid", error = "ungrounded_product_option" } end
  if option.needs_enrichment == true or option.identity_confidence == "low" then
    local source = sources[1] or {}
    return {
      next = "enrich",
      selected_option = option,
      selected_option_id = option.option_id,
      source_site = source.site,
      source_product_id = source.product_id,
      source_url = source.url
    }
  end

  local locked = AX_lock_product_identity({
    identity_kind = option.identity_kind,
    identity_name = option.display_name,
    identity_brand = option.brand,
    identity_model = option.model,
    product_category = option.product_category,
    canonical_query = joined_query(option.brand, option.model, option.product_category),
    hard_constraints = args.hard_constraints,
    soft_preferences = args.soft_preferences,
    source_refs = sources
  })
  if locked.next ~= "compare" then return locked end
  locked.next = "lock"
  locked.selected_option = option
  locked.selected_option_id = option.option_id
  locked.product_options_version = version
  return locked
end

local function candidate_variant(candidate, key)
  local variants = candidate and (candidate.variants or candidate.identity_variants)
  return type(variants) == "table" and variants[key] or nil
end

function AX_verify_product_offers(args)
  args = args or {}
  local identity_id = non_empty(args.identity_id)
  local kind = non_empty(args.identity_kind) or "standardized_model"
  local expected_brand = non_empty(args.identity_brand)
  local expected_model = non_empty(args.identity_model)
  local expected_category = non_empty(args.product_category)
  local hard = args.hard_constraints or args.locked_hard_constraints or {}
  local verified = array()
  local ambiguous = array()
  local excluded = array()
  local failures = array()
  local results = args.results or args.store_results or {}

  for result_index = 1, #results do
    local result = results[result_index] or {}
    local site = non_empty(result.key) or tostring(result_index)
    if result.status == "completed" then
      local value = worker_value(result) or {}
      site = non_empty(value.site) or site
      local candidates = value.candidates or {}
      for candidate_index = 1, #candidates do
        local candidate = copy_table(candidates[candidate_index])
        candidate.site = non_empty(candidate.site) or site
        local reason = nil
        local outcome = "exact"
        local observed_model = candidate_model(candidate)
        local observed_brand = non_empty(candidate.brand)

        if kind == "standardized_model" then
          if not observed_model then
            outcome, reason = "ambiguous", "manufacturer_model_missing"
          elseif identity_text(observed_model) ~= identity_text(expected_model) then
            outcome, reason = "mismatch", "model_mismatch"
          elseif expected_brand and observed_brand and identity_text(observed_brand) ~= identity_text(expected_brand) then
            outcome, reason = "mismatch", "brand_mismatch"
          end
        elseif kind == "spec_equivalent" then
          local category = non_empty(candidate.product_category or candidate.category)
          if not category then
            outcome, reason = "ambiguous", "category_missing"
          elseif expected_category and identity_text(category) ~= identity_text(expected_category) then
            outcome, reason = "mismatch", "category_mismatch"
          end
        elseif kind == "unique_listing" then
          outcome, reason = "ambiguous", "unique_listing_not_comparable"
        end

        if outcome ~= "mismatch" then
          local keys = array()
          for key in pairs(hard) do keys[#keys + 1] = key end
          table.sort(keys)
          for key_index = 1, #keys do
            local key = keys[key_index]
            local expected = hard[key]
            if expected ~= nil then
              local observed = candidate_variant(candidate, key)
              if observed == nil then
                outcome, reason = "ambiguous", "variant_missing:" .. tostring(key)
                break
              elseif identity_text(observed) ~= identity_text(expected) then
                outcome, reason = "mismatch", "variant_mismatch:" .. tostring(key)
                break
              end
            end
          end
        end

        candidate.identity_id = identity_id
        candidate.identity_match = outcome
        candidate.observed_model = observed_model
        if outcome == "exact" then
          verified[#verified + 1] = candidate
        elseif outcome == "ambiguous" then
          candidate.reason = reason
          ambiguous[#ambiguous + 1] = candidate
        else
          candidate.reason = reason
          excluded[#excluded + 1] = candidate
        end
      end
      if #candidates == 0 then
        failures[#failures + 1] = { site = site, error = value.error or "no_results" }
      end
    else
      failures[#failures + 1] = { site = site, status = result.status or "failed", error = result.error or "store_search_failed" }
    end
  end

  return {
    next = #verified > 0 and (#failures > 0 and "partial" or "done") or "empty",
    identity_id = identity_id,
    verified_offers = verified,
    ambiguous_offers = ambiguous,
    excluded_offers = excluded,
    failures = failures
  }
end

local function offer_cost(offer)
  return tonumber(offer.total_base) or tonumber(offer.known_cost_base) or math.huge
end

local function offer_rating(offer)
  return tonumber(offer.rating) or ((tonumber(offer.seller_rating_percent) or 0) / 20)
end

local function compare_offers(left, right)
  local left_complete = left.cost_complete == true
  local right_complete = right.cost_complete == true
  if left_complete ~= right_complete then
    return left_complete
  end
  local left_cost, right_cost = offer_cost(left), offer_cost(right)
  if left_cost ~= right_cost then return left_cost < right_cost end
  local left_rating, right_rating = offer_rating(left), offer_rating(right)
  if left_rating ~= right_rating then return left_rating > right_rating end
  local left_reviews = tonumber(left.review_count) or 0
  local right_reviews = tonumber(right.review_count) or 0
  if left_reviews ~= right_reviews then return left_reviews > right_reviews end
  local left_site, right_site = tostring(left.site or ""), tostring(right.site or "")
  if left_site ~= right_site then return left_site < right_site end
  return tostring(left.product_id or "") < tostring(right.product_id or "")
end

local function money(value, currency)
  local numeric = tonumber(value)
  local code = non_empty(currency) or C.BASE_CURRENCY
  if not numeric then return "unknown" end
  -- Zero-decimal currencies (KRW, JPY) read wrong with cents, and a single-currency comparison keeps
  -- its own currency rather than a converted one, so the code travels with the amount.
  if code == "KRW" or code == "JPY" then
    return string.format("%s %d", code, math.floor(numeric + 0.5))
  end
  return string.format("%s %.2f", code, numeric)
end

-- A store that returned nothing is a fact the user has to see: "네이버는 보안 확인 필요" is actionable,
-- a silently missing store is indistinguishable from "this product is not sold there". Codes come from
-- the adapters; anything unmapped is still reported verbatim rather than swallowed.
local STORE_NAMES = {
  ["naver-shopping"] = "네이버쇼핑",
  ["11st"] = "11번가",
  coupang = "쿠팡", ssg = "SSG", gmarket = "지마켓", amazon = "아마존",
  walmart = "월마트", ebay = "이베이", aliexpress = "알리익스프레스", etsy = "엣시"
}

local STORE_ERRORS = {
  security_verification_required = "보안 확인 필요 (브라우저에서 확인 후 다시 시도)",
  captcha_required = "보안 확인(캡차) 필요 (브라우저에서 직접 통과해야 함)",
  login_required = "로그인 필요 (브라우저에서 로그인 후 다시 시도)",
  access_denied = "접근 차단됨",
  no_results = "검색 결과 없음",
  price_unavailable = "상품은 있었지만 가격을 읽지 못했습니다 (사이트 표시 방식 변경)",
  store_search_failed = "검색 실패",
  search_unsupported = "이 사이트는 검색을 지원하지 않음",
  pagination_unsupported = "추가 페이지를 지원하지 않음",
  missing_query = "검색어를 만들지 못함"
}

function C.store_label(site)
  local slug = lower(site)
  local name = STORE_NAMES[slug]
  if not name then return non_empty(site) or "알 수 없는 사이트" end
  return name .. "(" .. slug .. ")"
end

-- A worker failure arrives in whatever shape the layer that produced it used: a code string, a nested
-- record, or only a status. A live run rendered "네이버쇼핑: table: 0x2af" because the value was pushed
-- straight into the sentence, so every shape is reduced to readable text here.
local function failure_text(failure)
  local direct = non_empty(type(failure.error) ~= "table" and failure.error or nil)
  if direct then return STORE_ERRORS[direct] or direct end
  if type(failure.error) == "table" then
    for _, key in ipairs({ "error", "code", "reason", "message" }) do
      local nested = non_empty(type(failure.error[key]) ~= "table" and failure.error[key] or nil)
      if nested then return STORE_ERRORS[nested] or nested end
    end
  end
  local status = non_empty(type(failure.status) ~= "table" and failure.status or nil)
  if status and status ~= "failed" then return STORE_ERRORS[status] or status end
  return STORE_ERRORS.store_search_failed
end

--- One line describing which stores answered and what the others need from the user.
function C.store_status(failures, offers)
  local ok_sites = {}
  local ok_count = 0
  for index = 1, #(offers or {}) do
    local site = lower(offers[index].site)
    if site ~= "" and not ok_sites[site] then
      ok_sites[site] = true
      ok_count = ok_count + 1
    end
  end

  local parts = array()
  local failed_count = 0
  local seen = {}
  for index = 1, #(failures or {}) do
    local failure = failures[index] or {}
    local site = lower(failure.site)
    local text = failure_text(failure)
    local key = site .. "|" .. text
    if not seen[key] then
      seen[key] = true
      failed_count = failed_count + 1
      parts[#parts + 1] = C.store_label(failure.site) .. ": " .. text
    end
  end

  if failed_count == 0 then
    return { text = "", ok_count = ok_count, failed_count = 0 }
  end
  local total = ok_count + failed_count
  local header = string.format("사이트 %d곳 중 %d곳에서 결과를 받았습니다", total, ok_count)
  return {
    text = header .. " · " .. table.concat(parts, " · "),
    ok_count = ok_count,
    failed_count = failed_count
  }
end


-- Ranking always compares the converted base amount, but a comparison whose offers all quote the same
-- currency reads better in that currency than in a converted one, so the display currency is chosen
-- once per comparison and the native total is shown when it is exact.
local function comparison_line(offer, display_currency)
  local base = non_empty(offer.base_currency) or C.BASE_CURRENCY
  local native = non_empty(display_currency) and display_currency == non_empty(offer.currency)
  local total_value = native and offer.total_for_quantity or offer.total_base
  local total_currency = native and offer.currency or base
  local total = offer.cost_complete and money(total_value, total_currency)
    or (money(offer.known_cost_base, base) .. " + unknown shipping/fees")
  local rating = tonumber(offer.rating) and string.format("%.1f/5", tonumber(offer.rating))
    or (tonumber(offer.seller_rating_percent) and string.format("seller %.1f%%", tonumber(offer.seller_rating_percent)) or "unrated")
  local condition = non_empty(offer.condition) or "condition not shown"
  -- price_text/shipping_text may be a whole row dump on text-parsed storefronts; the parsed numbers are
  -- what the user must compare, so the line shows those and keeps raw text out of the prompt.
  local item_price = money(offer.price, offer.currency or base)
  local shipping = tonumber(offer.shipping_cost)
  local shipping_label = shipping == nil and "shipping unknown"
    or (shipping == 0 and "free shipping" or ("shipping " .. money(shipping, offer.shipping_currency or offer.currency or base)))
  return tostring(offer.rank) .. ". [" .. tostring(offer.site) .. "] " .. tostring(offer.name)
    .. " — total " .. total .. "; item " .. item_price
    .. "; " .. shipping_label
    .. "; " .. rating .. "; " .. condition
end

-- The single currency every offer quotes, or nil when the comparison spans currencies.
local function uniform_currency(offers)
  local seen = nil
  for index = 1, #offers do
    local code = non_empty(offers[index].currency)
    if not code then return nil end
    if seen and seen ~= code then return nil end
    seen = code
  end
  return seen
end

-- What the user is browsing has to outlive the Lua context: every user turn (and every navigation)
-- rebuilds the runtime. The offer list therefore travels in FLOW state — the browsing node is
-- deterministic and reads it from there — and only the rendered window is kept in the chat session, for
-- the model-called presentation tool that cannot read flow state. The session store accepts strings
-- only, so nothing but text goes in. Either way the model's context stays the same size whether the
-- comparison holds three offers or thirty.
C.VIEW_PAGE_SIZE = 5
C.VIEW_BUDGET_CHARS = 1200
C.COMPARISON_SESSION_PREFIX = "commerce.comparison."

local function session_store()
  if type(session_state) == "table" and type(session_state.set) == "function" then return session_state end
  return nil
end

local function session_read(field)
  local store = session_store()
  if not store then return nil end
  local value = store.get(C.COMPARISON_SESSION_PREFIX .. field)
  return type(value) == "string" and value ~= "" and value or nil
end

local function persist_comparison(snapshot)
  C.current_comparison = snapshot
  local store = session_store()
  if not store then return snapshot end
  store.set(C.COMPARISON_SESSION_PREFIX .. "id", tostring(snapshot.comparison_id))
  store.set(C.COMPARISON_SESSION_PREFIX .. "window", tostring(snapshot.question))
  store.set(C.COMPARISON_SESSION_PREFIX .. "page", tostring(snapshot.view.page))
  store.set(C.COMPARISON_SESSION_PREFIX .. "pages", tostring(snapshot.view.pages))
  store.set(C.COMPARISON_SESSION_PREFIX .. "total", tostring(snapshot.view.total))
  return snapshot
end

--- The window the given comparison id is currently showing, from this turn's cache or the chat session.
function C.load_window(comparison_id)
  local id = non_empty(comparison_id)
  local current = C.current_comparison
  if type(current) == "table" and (id == nil or current.comparison_id == id) then
    return {
      comparison_id = current.comparison_id,
      question = current.question,
      page = current.view.page,
      pages = current.view.pages,
      total = current.view.total
    }
  end
  local stored_id = session_read("id")
  if not stored_id or (id ~= nil and stored_id ~= id) then return nil end
  return {
    comparison_id = stored_id,
    question = session_read("window") or "",
    page = tonumber(session_read("page")) or 1,
    pages = tonumber(session_read("pages")) or 1,
    total = tonumber(session_read("total")) or 0
  }
end

function C.render_comparison(snapshot, page)
  local view = AX_OFFER_VIEW.render(snapshot.offers, {
    page = page or snapshot.view and snapshot.view.page or 1,
    page_size = C.VIEW_PAGE_SIZE,
    budget_chars = C.VIEW_BUDGET_CHARS,
    display_currency = snapshot.display_currency,
    -- What the user must know beyond the rows themselves: which stores failed, and how many rows were
    -- folded away for having no known total.
    notes = snapshot.notes
  })
  snapshot.view = view
  snapshot.question = view.text
  return snapshot
end

--- Opens (or reopens) the current comparison over `offers` and renders its first window.
function C.open_comparison(offers, identity_id, options)
  options = options or {}
  local fingerprint = array()
  for index = 1, #offers do
    fingerprint[#fingerprint + 1] = tostring(offers[index].site or "") .. ":"
      .. tostring(offers[index].product_id or "") .. ":" .. tostring(offers[index].total_base or "")
  end
  local comparison_id = "cmp-" .. stable_hash(tostring(identity_id or "") .. "|"
    .. AX_OFFER_VIEW.signature(options.filters, options.sort) .. "|" .. table.concat(fingerprint, "|"))

  for index = 1, #offers do
    offers[index].rank = index
    offers[index].comparison_id = comparison_id
  end

  local snapshot = {
    comparison_id = comparison_id,
    identity_id = identity_id,
    offers = offers,
    all_offers = options.all_offers or offers,
    filters = options.filters or {},
    sort = options.sort or "total_asc",
    display_currency = uniform_currency(offers),
    notes = options.notes
  }
  C.render_comparison(snapshot, 1)
  if #offers == 0 then return snapshot end
  return persist_comparison(snapshot)
end

--- Whether a listing contains rows the default window folds away (no known total).
function C.has_incomplete(offers)
  for index = 1, #(offers or {}) do
    if offers[index].cost_complete ~= true then return true end
  end
  return false
end

--- The lines a window carries beyond the offers: store outcomes and rows folded for an unknown total.
--- `answered` is the WHOLE listing, not the visible page: a folded row still proves its store answered.
function C.comparison_notes(failures, answered, hidden_incomplete, screened_out)
  local notes = array()
  local status = C.store_status(failures, answered)
  if status.text ~= "" then notes[#notes + 1] = status.text end
  if (tonumber(screened_out) or 0) > 0 then
    notes[#notes + 1] = string.format("관련 없는 %d건은 제외했습니다", math.floor(tonumber(screened_out)))
  end
  if (hidden_incomplete or 0) > 0 then
    notes[#notes + 1] = string.format(
      "배송비/총액 미확인 %d건은 접었습니다 — '미확인 포함'이라고 하면 함께 보여드려요",
      hidden_incomplete)
  end
  return notes, status
end

--- Records a window move without reissuing the comparison.
function C.move_comparison(snapshot, page)
  C.render_comparison(snapshot, page)
  return persist_comparison(snapshot)
end

--- The answer shape every browsing turn returns: the rendered window plus where it sits in the list.
function C.comparison_answer(snapshot, extras)
  local answer = {
    next = "ask",
    comparison_id = snapshot.comparison_id,
    question = snapshot.question,
    view_page = snapshot.view.page,
    view_pages = snapshot.view.pages,
    view_total = snapshot.view.total
  }
  for key, value in pairs(extras or {}) do answer[key] = value end
  return answer
end

-- Reading the worker records once, in one place: every store loop below needs the same unwrap.
local function each_store_result(results, visit)
  for index = 1, #(results or {}) do
    local record = results[index] or {}
    local value = record.status == "completed" and worker_value(record) or nil
    visit(record, value, non_empty(value and value.site) or non_empty(record.key) or tostring(index), index)
  end
end

--- The numbered list of live listings a model screens for relevance, and the ids that back the numbers.
--- Stores take turns so a store listed later is not starved by one that returned more rows.
function AX_build_offer_screening(args)
  args = args or {}
  local per_store = array()
  each_store_result(args.store_results or args.results, function(_, value, site)
    if value then per_store[#per_store + 1] = { site = site, candidates = value.candidates or {} } end
  end)

  local lines = array()
  local ids = array()
  local rank = 1
  while #ids < C.SCREEN_MAX_ROWS do
    local placed = false
    for store_index = 1, #per_store do
      local store = per_store[store_index]
      local candidate = store.candidates[rank]
      if candidate and #ids < C.SCREEN_MAX_ROWS then
        local product_id = non_empty(candidate.product_id or candidate.id)
        local name = non_empty(candidate.name or candidate.title)
        if product_id and name then
          placed = true
          ids[#ids + 1] = store.site .. ":" .. product_id
          local title = AX_OFFER_VIEW.clip(name, C.SCREEN_TITLE_CHARS)
          local price = money(candidate.price, candidate.currency)
          local line = string.format("%d. [%s] %s", #ids, store.site, title)
          if price ~= "" then line = line .. " · " .. price end
          if candidate.match_level == "partial" then line = line .. " · (유사)" end
          lines[#lines + 1] = line
        end
      end
    end
    if not placed then break end
    rank = rank + 1
  end

  return {
    next = #ids > 0 and "judge" or "empty",
    screening_text = table.concat(lines, "\n"),
    screening_ids = table.concat(ids, "|"),
    screening_count = #ids
  }
end

--- Applies a screening verdict: keeps the numbered rows, caps each store at the comparison limit, and
--- reports what was removed. An ABSENT verdict (a stalled or failed screening node) keeps everything —
--- losing precision costs a wrong row in the window, losing the offers costs the whole turn.
function AX_apply_offer_screening(args)
  args = args or {}
  local ids = split_list(args.screening_ids)
  local verdict = args.keep
  local skipped = verdict == nil

  local keep = {}
  local kept_total = 0
  if not skipped then
    for number in tostring(verdict):gmatch("%d+") do
      local position = tonumber(number)
      local id = position and ids[position]
      if id and not keep[id] then
        keep[id] = true
        kept_total = kept_total + 1
      end
    end
  end

  local results = array()
  local screened_out = 0
  local capped_out = 0
  local remaining = 0
  each_store_result(args.store_results or args.results, function(record, value, site)
    if not value then
      results[#results + 1] = record
      return
    end
    local candidates = value.candidates or {}
    local kept = array()
    for index = 1, #candidates do
      local candidate = candidates[index]
      local product_id = non_empty(candidate.product_id or candidate.id)
      local wanted = skipped or (product_id and keep[site .. ":" .. product_id]) or false
      if not wanted then
        screened_out = screened_out + 1
      elseif #kept >= C.MAX_OFFERS_PER_SITE then
        capped_out = capped_out + 1
      else
        kept[#kept + 1] = candidate
      end
    end
    remaining = remaining + #kept
    local store_result = copy_table(value)
    store_result.candidates = kept
    store_result.total_count = #kept
    results[#results + 1] = { key = non_empty(record.key) or site, status = "completed", value = { store_result = store_result } }
  end)

  return {
    next = remaining > 0 and "done" or "empty",
    store_results = results,
    screened_out = screened_out,
    capped_out = capped_out,
    screened_kept = remaining,
    screening_skipped = skipped or nil
  }
end

function AX_rank_store_offers(args)
  args = args or {}
  local offers = array()
  local failures = array()
  local required_identity = non_empty(args.identity_id)

  local function append_offer(value, fallback_site)
    local candidate = copy_table(value)
    candidate.site = non_empty(candidate.site) or fallback_site
    candidate.product_id = non_empty(candidate.product_id or candidate.id)
    candidate.id = candidate.product_id
    candidate.name = non_empty(candidate.name or candidate.title)
    local identity_matches = not required_identity
      or candidate.identity_id == required_identity
      or candidate.identity_match == "exact"
    if identity_matches and candidate.product_id and candidate.name and tonumber(candidate.price) then
      candidate.identity_id = required_identity or candidate.identity_id
      offers[#offers + 1] = candidate
    end
  end

  if args.verified_offers ~= nil then
    for index = 1, #(args.verified_offers or {}) do
      append_offer(args.verified_offers[index], non_empty(args.verified_offers[index] and args.verified_offers[index].site))
    end
    for index = 1, #(args.failures or {}) do failures[#failures + 1] = copy_table(args.failures[index]) end
  else
    local results = args.results or args.store_results or {}
    for index = 1, #results do
      local result = results[index] or {}
      local site = non_empty(result.key) or tostring(index)
      if result.status == "completed" then
        local value = worker_value(result) or {}
        site = non_empty(value.site) or site
        local candidates = value.candidates or {}
        for candidate_index = 1, #candidates do append_offer(candidates[candidate_index], site) end
        if #candidates == 0 then
          failures[#failures + 1] = { site = site, error = value.error or "no_results" }
        end
      else
        failures[#failures + 1] = { site = site, status = result.status or "failed", error = result.error or "store_search_failed" }
      end
    end
  end

  table.sort(offers, compare_offers)
  while #offers > C.MAX_RANKED_OFFERS do table.remove(offers) end

  -- The task is total cost, so a row whose shipping is unknown cannot answer it. Those rows are folded
  -- out of the default window but stay in `all_offers`, one sentence away ("미확인 포함"). Folding them
  -- when there is nothing else left would leave the user with no choice at all, so that case shows them.
  local complete = array()
  local incomplete = 0
  for index = 1, #offers do
    if offers[index].cost_complete == true then
      complete[#complete + 1] = offers[index]
    else
      incomplete = incomplete + 1
    end
  end
  local visible = #complete > 0 and complete or offers
  local hidden_incomplete = #complete > 0 and incomplete or 0

  local notes, status = C.comparison_notes(failures, offers, hidden_incomplete, args.screened_out)
  local snapshot = C.open_comparison(visible, required_identity, {
    all_offers = offers,
    filters = hidden_incomplete > 0 and { complete_cost_only = true } or {},
    notes = notes
  })
  local next_value = "done"
  if #offers == 0 then
    next_value = "empty"
  elseif #failures > 0 then
    next_value = "partial"
  end
  return {
    next = next_value,
    identity_id = required_identity,
    comparison_id = snapshot.comparison_id,
    offers = snapshot.offers,
    all_offers = offers,
    failures = failures,
    comparison_text = snapshot.question,
    store_status = status.text,
    stores_with_offers = status.ok_count,
    stores_failed = status.failed_count,
    incomplete_count = incomplete,
    complete_count = #complete,
    screened_out = tonumber(args.screened_out) or 0,
    base_currency = C.BASE_CURRENCY,
    display_currency = snapshot.display_currency or C.BASE_CURRENCY,
    view_page = snapshot.view.page,
    view_pages = snapshot.view.pages,
    view_total = snapshot.view.total
  }
end

function AX_present_store_offers(args)
  args = args or {}
  local window = C.load_window(args and args.comparison_id)
  if not window then
    return { error = "stale_comparison" }
  end
  return {
    comparison_id = window.comparison_id,
    question = window.question,
    view_page = window.page,
    view_pages = window.pages,
    view_total = window.total
  }
end

-- Browsing the comparison: move the window, filter it, or sort it. The offer list arrives in the call
-- arguments (the browsing node is deterministic and reads flow state), so this survives the Lua context
-- being rebuilt between turns. A window move keeps the comparison id so the numbers the user is looking
-- at stay valid; anything that changes WHICH offers are listed reissues it, and every number from the
-- previous listing then fails resolution.
function AX_refine_store_offers(args)
  args = args or {}
  local comparison_id = non_empty(args.comparison_id)
  local offers = args.offers
  if type(offers) ~= "table" or #offers == 0 then
    -- Nothing to browse without the listing. Answering "ask" sent the model straight back into the same
    -- failing call (seven times in one measured turn); "error" routes to a terminal that explains itself.
    return { next = "error", error = "stale_comparison" }
  end
  local current_id = non_empty(offers[1] and offers[1].comparison_id)
  if not comparison_id or (current_id and current_id ~= comparison_id) then
    return { next = "error", error = "stale_comparison" }
  end

  local all_offers = type(args.all_offers) == "table" and #args.all_offers > 0 and args.all_offers or offers
  local identity_id = non_empty(args.identity_id or (offers[1] and offers[1].identity_id))
  local sort = AX_OFFER_VIEW.SORTS[args.view_sort] and args.view_sort or "total_asc"
  local page = math.max(1, math.floor(tonumber(args.view_page) or 1))

  -- Store outcomes and the folded-row note describe the listing, not one page of it, so every window the
  -- user browses to carries them.
  local function notes_for(list)
    local hidden = #all_offers - #list
    return C.comparison_notes(args.failures, all_offers, hidden > 0 and C.has_incomplete(all_offers) and hidden or 0)
  end

  -- A refinement that did not apply must say so in the window, not only in a state field the model may
  -- forget to mention: the window is the one text the user is guaranteed to see.
  local REFINE_REASONS = {
    price_currency_unknown = "요청하신 금액 조건(원/KRW)은 이 목록의 통화와 달라 적용하지 못했습니다 — 목록에 쓰인 통화로 다시 말씀해 주세요",
    no_matches = "조건에 맞는 상품이 없어 이전 목록을 그대로 보여드립니다",
    unparsed = "말씀하신 조건을 이해하지 못했습니다 — '무료배송만', '3만원 이하', '평점 높은 순'처럼 알려주세요"
  }

  local function window_of(list, list_id, extras)
    local notes, status = notes_for(list)
    local reason = extras and extras.refine_error and REFINE_REASONS[extras.refine_error]
    if reason then table.insert(notes, 1, reason) end
    local snapshot = {
      comparison_id = list_id,
      identity_id = identity_id,
      offers = list,
      all_offers = all_offers,
      sort = sort,
      display_currency = uniform_currency(list),
      notes = notes
    }
    C.render_comparison(snapshot, page)
    persist_comparison(snapshot)
    -- The answer must restate the listing: the flow copies these into state, and returning without them
    -- emptied `offers` so the NEXT browsing call reported a lost comparison.
    local answer = C.comparison_answer(snapshot, extras)
    answer.offers = list
    answer.all_offers = all_offers
    answer.view_sort = sort
    answer.store_status = status.text
    return answer
  end

  local request = non_empty(args.refine_request)
  if request then
    local parsed = AX_OFFER_VIEW.parse_refine(request)
    if parsed.rescope then
      return { next = "research", comparison_id = comparison_id, rescope_request = request }
    end
    if parsed.unparsed then
      return window_of(offers, comparison_id, { refine_error = "unparsed" })
    end

    local filters = parsed.reset and {} or parsed.filters
    -- "미확인 포함" is the one filter expressed as a removal: it clears the default fold instead of
    -- adding a condition, so the listing grows back to everything that survived ranking.
    local unfold = filters.include_incomplete == true
    filters.include_incomplete = nil
    if not unfold and not parsed.reset and C.has_incomplete(all_offers) then
      filters.complete_cost_only = true
    end
    local next_sort = parsed.reset and "total_asc" or (parsed.sort or sort)

    -- A threshold in a currency this listing never quotes cannot be judged. Reporting "0건" would be a
    -- claim about prices that were never compared, so the previous listing stands and says why.
    local ungroundable = AX_OFFER_VIEW.filter_error(all_offers, filters)
    if ungroundable then
      return window_of(offers, comparison_id, { refine_error = ungroundable })
    end

    local visible = AX_OFFER_VIEW.apply(all_offers, { filters = filters, sort = next_sort })
    if #visible == 0 then
      -- An empty result would strand the user with nothing to pick, so the previous listing stands.
      return window_of(offers, comparison_id, { refine_error = "no_matches" })
    end
    local hidden = filters.complete_cost_only and (#all_offers - #visible) or 0
    local notes, status = C.comparison_notes(args.failures, all_offers, hidden)
    local snapshot = C.open_comparison(visible, identity_id, {
      all_offers = all_offers,
      filters = filters,
      sort = next_sort,
      notes = notes
    })
    return C.comparison_answer(snapshot, {
      offers = snapshot.offers,
      all_offers = all_offers,
      view_sort = next_sort,
      store_status = status.text
    })
  end

  page = AX_OFFER_VIEW.resolve_page(page, non_empty(args.page_command), args.page_number,
    math.max(1, math.ceil(#offers / C.VIEW_PAGE_SIZE)))
  return window_of(offers, comparison_id, { all_offers = all_offers, view_sort = sort })
end

function AX_resolve_store_offer(args)
  args = args or {}
  if args.choice_stage ~= "asked" then
    return { next = "invalid", error = "approval_turn_required" }
  end
  local offers = args.offers or {}
  local comparison_id = non_empty(args.comparison_id)
  local choice_comparison_id = non_empty(args.choice_comparison_id)
  if not comparison_id or not choice_comparison_id then
    return { next = "invalid", error = "comparison_version_required" }
  end
  if comparison_id ~= choice_comparison_id then
    return { next = "invalid", error = "stale_comparison" }
  end
  local choice = tonumber(args.choice_index)
  if not choice or choice ~= math.floor(choice) or choice < 1 or choice > #offers then
    return { next = "invalid", error = "invalid_offer_index" }
  end
  local offer = offers[choice] or {}
  if comparison_id and non_empty(offer.comparison_id) and offer.comparison_id ~= comparison_id then
    return { next = "invalid", error = "stale_comparison" }
  end
  local site = non_empty(offer.site)
  local product_id = non_empty(offer.product_id or offer.id)
  local identity_id = non_empty(args.identity_id or offer.identity_id)
  if not site or not product_id then
    return { next = "invalid", error = "invalid_offer" }
  end
  if not identity_id then
    return { next = "invalid", error = "missing_locked_identity" }
  end
  return {
    next = "add",
    selected_offer = offer,
    selected_rank = choice,
    site = site,
    product_id = product_id,
    product_name = non_empty(offer.name or offer.title),
    quantity = tonumber(offer.quantity) or tonumber(args.quantity) or 1,
    expected_unit_price = tonumber(offer.price),
    expected_currency = non_empty(offer.currency),
    expected_identity_model = non_empty(offer.manufacturer_model or offer.model_hint),
    approved_total_base = tonumber(offer.total_base),
    identity_id = identity_id,
    comparison_id = comparison_id or non_empty(offer.comparison_id),
    identity_approval = "locked_product_identity",
    comparison_approval = "current_comparison",
    cart_approval = "user_selected_compared_offer"
  }
end


function C.normalize_search_result(args, raw_result)
  args = args or {}
  local site = non_empty(args.site)
  local query = non_empty(args.query)
  if not site then return { error = "missing_site", candidates = array() } end
  if not query then return { site = site, error = "missing_query", candidates = array() } end

  local result = copy_table(raw_result or args.result)
  if result.status == "navigating" or result.navigated == true then
    result.status = "navigating"
    result.pending = true
  end
  if result.pending or result.error or result.login_required then
    result.site = site
    result.candidates = result.candidates or array()
    return result
  end

  local candidates, fx = C.normalize_candidates(site, result.candidates or {}, args.quantity, query, args)
  if not candidates then
    return { site = site, pending = fx and fx.pending == true, error = fx and fx.error, candidates = array() }
  end
  for index = 1, #candidates do
    local candidate = candidates[index]
    local explicit_model = non_empty(candidate.manufacturer_model)
    candidate.manufacturer_model = explicit_model
    candidate.model_hint = explicit_model or non_empty(candidate.model_hint) or infer_model(candidate.name)
    candidate.model_source = explicit_model and (non_empty(candidate.model_source) or "metadata")
      or (candidate.model_hint and "title_inference" or nil)

    local observed_brand = non_empty(candidate.brand)
    if observed_brand then
      candidate.brand = observed_brand
      candidate.brand_source = non_empty(candidate.brand_source) or "metadata"
    else
      local requested_brand = non_empty(args.requested_brand or args.identity_brand)
      if requested_brand and matches_query({ name = candidate.name }, requested_brand, args) then
        candidate.brand = requested_brand
        candidate.brand_source = "title"
      else
        candidate.brand = nil
        candidate.brand_source = nil
      end
    end
    candidate.identity_confidence = explicit_model and "high" or (candidate.model_hint and "medium" or "low")
  end
  if #candidates == 0 then result.error = "no_results" end
  result.site = site
  result.query = query
  result.candidates = candidates
  result.fx_date = fx.date
  result.fx_source = fx.source
  return result
end

function AX_normalize_store_product_result(args)
  return C.normalize_search_result(args, args and (args.result or args.store_result))
end

-- One store's search can span more than one result page. The Lua context dies on every navigation, so
-- the accumulator cannot live here: the worker hands back what it has collected so far and this command
-- merges the page it just read, re-applies the per-store cap, and decides whether another page is worth
-- the extra navigation. Every stop names itself so a thin store result can explain itself.
function AX_collect_store_page(args)
  args = args or {}
  local result = copy_table(args.result or args.store_result)
  local purpose = non_empty(args.purpose) or "comparison"
  local target = math.max(1, math.floor(tonumber(args.target)
    or (purpose == "discovery" and C.MAX_DISCOVERY_RESULTS or C.MAX_OFFERS_PER_SITE)))
  local page = math.max(1, math.floor(tonumber(args.page) or tonumber(result.page) or 1))

  local merged = AX_PAGINATION.merge_pages(args.collected, result.candidates or {}, page)
  local collected = array()
  -- `target` is the paging goal (is another navigation worth it), `keep_limit` is how many rows are
  -- carried forward for screening. Raising the goal to the wider limit would buy a second page for every
  -- store just to fill a list the model is about to cut down.
  local keep_limit = math.max(target, purpose == "discovery" and C.MAX_DISCOVERY_RESULTS or C.SCREEN_LIMIT_PER_SITE)
  for index = 1, math.min(#merged.items, keep_limit) do collected[index] = merged.items[index] end

  -- An empty page is not a broken store: "no_results" means this page held nothing relevant, and the
  -- next page is exactly where the match tends to be. Only a wall (captcha, login, access) stops here.
  local page_error = non_empty(result.error)
  local blocking = (page_error ~= nil and page_error ~= "no_results") or result.blocked == true
  local decision
  if blocking then
    decision = { continue = false, reason = "store_error" }
    page_error = page_error or "blocked"
  else
    page_error = nil
    decision = AX_PAGINATION.should_continue({
      collected = #collected,
      target = target,
      page = page,
      max_pages = tonumber(args.max_pages),
      added = merged.added,
      remote_used = tonumber(args.remote_used),
      remote_budget = tonumber(args.remote_budget),
      has_more = result.has_more
    })
  end

  local store_result = copy_table(result)
  store_result.candidates = collected
  store_result.total_count = #collected
  store_result.pages_read = page
  store_result.page = page
  store_result.has_more = result.has_more == true and decision.continue ~= true
  store_result.stop_reason = decision.reason
  store_result.error = nil
  store_result.blocked = nil
  store_result.page_error = page_error
  if #collected == 0 then
    -- With nothing collected the page error IS the store's outcome; downstream ranking reports it.
    store_result.error = page_error or "no_results"
  end

  -- A store that answered nothing may simply have been asked in the wrong language: a Korean store lists
  -- "로지텍 M185" and never matches "Logitech M185". Before giving up on it, the same search is retried in
  -- the other wordings the model wrote for this request. A store that DID answer never pays for the extra
  -- navigation, and a blocked store is not retried at all — the wall will not move for a synonym.
  local attempted = non_empty(args.tried_queries) or ""
  local active_query = non_empty(args.query) or non_empty(result.query)
  if active_query and not attempted:find(active_query, 1, true) then
    attempted = attempted == "" and active_query or (attempted .. "|" .. active_query)
  end

  if not decision.continue and #collected == 0 and not blocking then
    local context = args.context or {}
    local wordings = C.query_variants({
      query = non_empty(context.query) or active_query,
      query_variants = non_empty(args.query_variants) or non_empty(context.query_variants)
    })
    for index = 1, #wordings do
      local wording = wordings[index]
      if not attempted:find(wording, 1, true) then
        return {
          next = "retry_query",
          page = 1,
          query = wording,
          tried_queries = attempted,
          stop_reason = "retry_query",
          collected = collected,
          collected_count = #collected,
          store_result = store_result
        }
      end
    end
    decision = { continue = false, reason = "queries_exhausted" }
    store_result.stop_reason = decision.reason
  end

  return {
    next = decision.continue and "more" or "done",
    page = decision.continue and (page + 1) or page,
    query = active_query,
    tried_queries = attempted,
    stop_reason = decision.reason,
    collected = collected,
    collected_count = #collected,
    store_result = store_result
  }
end

function AX_search_store_product(args)
  args = args or {}
  local site = non_empty(args.site)
  local query = non_empty(args.query)
  if not site then return { error = "missing_site", candidates = array() } end
  if not query then return { site = site, error = "missing_query", candidates = array() } end

  local adapter, adapter_error, pending_status = C.ensure_adapter(site)
  if not adapter then
    return {
      site = site,
      status = pending_status,
      pending = pending_status ~= nil,
      error = adapter_error,
      candidates = array()
    }
  end
  if type(adapter.search) ~= "function" then
    return { site = site, error = "search_unsupported", candidates = array() }
  end

  local result = adapter.search(args) or {}
  return C.normalize_search_result(args, result)
end

function AX_add_store_product_to_cart(args)
  args = args or {}
  if args.cart_approval ~= "user_selected_compared_offer" then
    return { added = false, error = "approval_required" }
  end
  if not non_empty(args.identity_id) or args.identity_approval ~= "locked_product_identity"
      or not non_empty(args.comparison_id) or args.comparison_approval ~= "current_comparison" then
    return { added = false, error = "identity_approval_required" }
  end
  local site = non_empty(args.site)
  if not site then return { added = false, error = "missing_site" } end
  local adapter, adapter_error, pending_status = C.ensure_adapter(site)
  if not adapter then
    return {
      site = site,
      added = false,
      status = pending_status,
      pending = pending_status ~= nil,
      error = adapter_error
    }
  end
  if type(adapter.add_to_cart) ~= "function" then
    return { site = site, added = false, error = "add_to_cart_unsupported" }
  end
  local result = adapter.add_to_cart(args) or {}
  result.site = site
  return result
end
