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
C.MAX_RANKED_OFFERS = 6
C.SITE_HOMES = {
  amazon = "https://www.amazon.com/",
  ebay = "https://www.ebay.com/"
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

function C.ensure_adapter(site)
  local slug = lower(site)
  local adapter = C.adapters[slug]
  local href = C.current_url()
  local on_target = adapter and type(adapter.host_matches) == "function" and adapter.host_matches(href)
  if on_target then
    return adapter, nil
  end

  local home = non_empty((adapter and adapter.home_url) or C.SITE_HOMES[slug])
  if not home then
    return nil, adapter and "site_home_unavailable" or "site_adapter_unavailable"
  end
  if nav and type(nav.clear_beforeunload) == "function" then
    nav.clear_beforeunload()
  end
  nav.navigate(home, {}, { reload = true })

  adapter = C.adapters[slug]
  href = C.current_url()
  on_target = adapter and type(adapter.host_matches) == "function" and adapter.host_matches(href)
  if not adapter then
    return nil, "site_adapter_unavailable"
  end
  if not on_target then
    return nil, "site_navigation_failed"
  end
  return adapter, nil
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
    return { rates = rates, date = nil, source = C.FX_URL }
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

local function matches_query(name, query)
  local haystack = lower(name)
  local needle = lower(query)
  for token in needle:gmatch("[%w]+") do
    if #token > 1 and not RELEVANCE_STOP_WORDS[token] and not haystack:find(token, 1, true) then
      return false
    end
  end
  return true
end

function C.normalize_candidates(site, candidates, quantity, query)
  local qty = math.max(1, math.floor(tonumber(quantity) or 1))
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
    item.quantity = qty
    item.base_currency = C.BASE_CURRENCY

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

    if item.product_id and item.name and item.price and matches_query(item.name, query) then
      normalized[#normalized + 1] = item
      if #normalized >= C.MAX_OFFERS_PER_SITE then break end
    end
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

local function money(value)
  local numeric = tonumber(value)
  if not numeric then return "unknown" end
  return string.format("USD %.2f", numeric)
end

local function comparison_line(offer)
  local total = offer.cost_complete and money(offer.total_base)
    or (money(offer.known_cost_base) .. " + unknown shipping/fees")
  local rating = tonumber(offer.rating) and string.format("%.1f/5", tonumber(offer.rating))
    or (tonumber(offer.seller_rating_percent) and string.format("seller %.1f%%", tonumber(offer.seller_rating_percent)) or "unrated")
  local condition = non_empty(offer.condition) or "condition not shown"
  return tostring(offer.rank) .. ". [" .. tostring(offer.site) .. "] " .. tostring(offer.name)
    .. " — total " .. total .. "; item " .. tostring(offer.price_text or offer.price or "unknown")
    .. "; shipping " .. tostring(offer.shipping_text or offer.shipping_cost or "unknown")
    .. "; " .. rating .. "; " .. condition
end

function AX_rank_store_offers(args)
  args = args or {}
  local offers = array()
  local failures = array()
  local results = args.results or args.store_results or {}

  for index = 1, #results do
    local result = results[index] or {}
    local site = non_empty(result.key) or tostring(index)
    if result.status == "completed" then
      local value = worker_value(result) or {}
      site = non_empty(value.site) or site
      local candidates = value.candidates or {}
      for candidate_index = 1, #candidates do
        local candidate = copy_table(candidates[candidate_index])
        candidate.site = non_empty(candidate.site) or site
        if non_empty(candidate.product_id or candidate.id) and non_empty(candidate.name or candidate.title)
            and tonumber(candidate.price) then
          candidate.product_id = non_empty(candidate.product_id or candidate.id)
          candidate.id = candidate.product_id
          candidate.name = non_empty(candidate.name or candidate.title)
          offers[#offers + 1] = candidate
        end
      end
      if #candidates == 0 then
        failures[#failures + 1] = { site = site, error = value.error or "no_results" }
      end
    else
      failures[#failures + 1] = { site = site, status = result.status or "failed", error = result.error or "store_search_failed" }
    end
  end

  table.sort(offers, compare_offers)
  while #offers > C.MAX_RANKED_OFFERS do
    table.remove(offers)
  end
  local lines = array()
  local incomplete = 0
  for index = 1, #offers do
    offers[index].rank = index
    if offers[index].cost_complete ~= true then incomplete = incomplete + 1 end
    lines[#lines + 1] = comparison_line(offers[index])
  end

  local next_value = "done"
  if #offers == 0 then
    next_value = "empty"
  elseif #failures > 0 then
    next_value = "partial"
  end
  return {
    next = next_value,
    offers = offers,
    failures = failures,
    comparison_text = table.concat(lines, "\n"),
    incomplete_count = incomplete,
    complete_count = #offers - incomplete,
    base_currency = C.BASE_CURRENCY
  }
end

function AX_resolve_store_offer(args)
  args = args or {}
  local offers = args.offers or {}
  local choice = tonumber(args.choice_index)
  if not choice or choice ~= math.floor(choice) or choice < 1 or choice > #offers then
    return { next = "invalid", error = "invalid_offer_index" }
  end
  local offer = offers[choice] or {}
  local site = non_empty(offer.site)
  local product_id = non_empty(offer.product_id or offer.id)
  if not site or not product_id then
    return { next = "invalid", error = "invalid_offer" }
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
    approved_total_base = tonumber(offer.total_base),
    cart_approval = "user_selected_compared_offer"
  }
end

function AX_search_store_product(args)
  args = args or {}
  local site = non_empty(args.site)
  local query = non_empty(args.query)
  if not site then return { error = "missing_site", candidates = array() } end
  if not query then return { site = site, error = "missing_query", candidates = array() } end

  local adapter, adapter_error = C.ensure_adapter(site)
  if not adapter then return { site = site, error = adapter_error, candidates = array() } end
  if type(adapter.search) ~= "function" then
    return { site = site, error = "search_unsupported", candidates = array() }
  end

  local result = adapter.search(args) or {}
  if result.pending or result.error or result.login_required then
    result.site = site
    result.candidates = result.candidates or array()
    return result
  end

  local candidates, fx = C.normalize_candidates(site, result.candidates or {}, args.quantity, query)
  if not candidates then
    return { site = site, pending = fx and fx.pending == true, error = fx and fx.error, candidates = array() }
  end
  result.site = site
  result.query = query
  result.candidates = candidates
  result.fx_date = fx.date
  result.fx_source = fx.source
  return result
end

function AX_add_store_product_to_cart(args)
  args = args or {}
  if args.cart_approval ~= "user_selected_compared_offer" then
    return { added = false, error = "approval_required" }
  end
  local site = non_empty(args.site)
  if not site then return { added = false, error = "missing_site" } end
  local adapter, adapter_error = C.ensure_adapter(site)
  if not adapter then return { site = site, added = false, error = adapter_error } end
  if type(adapter.add_to_cart) ~= "function" then
    return { site = site, added = false, error = "add_to_cart_unsupported" }
  end
  local result = adapter.add_to_cart(args) or {}
  result.site = site
  return result
end
