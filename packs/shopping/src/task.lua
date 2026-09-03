-- Shopping Pack task commands, authored and distributed as Lua (LUA_PACK_DESIGN.md).
-- Executed by the packaged prelude: `register`, `json`, `text`, `url`, `clock` are the whole API.

local function clean(value, maximum)
  return text.clean(value, maximum or 500)
end

local function is_finite(value)
  return type(value) == "number" and value == value
    and value ~= math.huge and value ~= -math.huge
end

local function is_int(value)
  return is_finite(value) and value % 1 == 0
end

local function prepare_search(input)
  local query = clean(type(input) == "table" and input.query or nil, 240)
  if query == "" then error("query_required") end
  return {
    query = query,
    page = 1,
    limit = 6,
    quantity = 1,
    query_variants = json.array({ query }),
  }
end

local function comparable_offer(candidate)
  local offer = {
    product_id = candidate.product_id,
    name = candidate.name,
    url = candidate.url,
    price = candidate.price,
    currency = candidate.currency,
    brand = candidate.brand,
    manufacturer_model = candidate.manufacturer_model,
    rating = candidate.rating,
    review_count = candidate.review_count,
    condition = candidate.condition,
  }
  local shipping_known = is_finite(candidate.shipping_cost)
    and candidate.shipping_cost >= 0
    and candidate.shipping_currency == candidate.currency
  if not shipping_known then return offer end
  offer.shipping_cost = candidate.shipping_cost
  offer.shipping_currency = candidate.shipping_currency
  offer.total = candidate.price + candidate.shipping_cost
  return offer
end

local CANDIDATE_KEYS = {
  product_id = true,
  name = true,
  url = true,
  price = true,
  currency = true,
  shipping_cost = true,
  shipping_currency = true,
  brand = true,
  manufacturer_model = true,
  rating = true,
  review_count = true,
  condition = true,
}

local function valid_candidate(candidate)
  if type(candidate) ~= "table" then return false end
  for key in pairs(candidate) do
    if type(key) ~= "string" or CANDIDATE_KEYS[key] ~= true then return false end
  end
  if clean(candidate.product_id, 128) == "" or clean(candidate.name) == "" then return false end
  if not is_finite(candidate.price) or candidate.price <= 0 then return false end
  if type(candidate.currency) ~= "string"
    or string.match(candidate.currency, "^%u%u%u$") == nil then return false end
  local parsed = type(candidate.url) == "string" and url.parse(candidate.url) or nil
  if parsed == nil or parsed.protocol ~= "https:" or parsed.username ~= ""
    or parsed.password ~= "" or parsed.search ~= "" or parsed.hash ~= "" then return false end
  local has_shipping = candidate.shipping_cost ~= nil or candidate.shipping_currency ~= nil
  if has_shipping and (not is_finite(candidate.shipping_cost) or candidate.shipping_cost < 0
    or candidate.shipping_currency ~= candidate.currency) then return false end
  if candidate.rating ~= nil and (not is_finite(candidate.rating)
    or candidate.rating < 0 or candidate.rating > 5) then return false end
  if candidate.review_count ~= nil and (not is_int(candidate.review_count)
    or candidate.review_count < 0) then return false end
  return true
end

local function relevant(candidate, query)
  local terms = text.terms(clean(query, 240))
  if #terms == 0 then return false end
  local parts = {}
  local function add(field)
    if type(field) == "string" and field ~= "" then parts[#parts + 1] = field end
  end
  add(candidate.name)
  add(candidate.brand)
  add(candidate.manufacturer_model)
  local haystack = text.fold(clean(table.concat(parts, " "), 1000))
  for index = 1, #terms do
    if string.find(haystack, terms[index], 1, true) == nil then return false end
  end
  return true
end

local function rank_provider_result(input)
  local provider_result = type(input) == "table" and input.providerResult or nil
  if type(provider_result) ~= "table"
    or provider_result.schema_version ~= 1
    or clean(provider_result.query, 240) == ""
    or not is_int(provider_result.page)
    or provider_result.page < 1 or provider_result.page > 2
    or not is_int(provider_result.cards_seen) or provider_result.cards_seen < 0
    or type(provider_result.has_more) ~= "boolean" then
    error("provider_result_required")
  end

  local status = provider_result.status
  local candidates = provider_result.candidates
  local valid_status = status == "candidates" or status == "no_results"
    or status == "price_unavailable"
  local invalid = not valid_status
  if status == "candidates" then
    if type(candidates) ~= "table" or #candidates < 1 or #candidates > 6 then
      invalid = true
    else
      for index = 1, #candidates do
        if not valid_candidate(candidates[index]) then invalid = true end
      end
    end
  elseif candidates ~= nil then
    invalid = true
  end
  if invalid then error("provider_result_invalid") end

  if status ~= "candidates" then
    local message = "No matching storefront results were found."
    if status == "price_unavailable" then
      message = "Storefront cards were present, but their prices could not be read safely."
    end
    return { status = status, offers = json.array({}), comparisonText = message }
  end

  local offers = {}
  for index = 1, #candidates do
    local candidate = candidates[index]
    if relevant(candidate, provider_result.query) then
      offers[#offers + 1] = comparable_offer(candidate)
    end
  end
  table.sort(offers, function(left, right)
    local left_known = left.total ~= nil
    local right_known = right.total ~= nil
    if left_known ~= right_known then return left_known end
    if left_known and right_known and left.total ~= right.total then
      return left.total < right.total
    end
    if left.price ~= right.price then return left.price < right.price end
    return left.product_id < right.product_id
  end)

  local lines = {}
  for index = 1, #offers do
    local offer = offers[index]
    local total = string.format("%s %.2f + shipping unknown", offer.currency, offer.price)
    if offer.total ~= nil then
      total = string.format("%s %.2f total", offer.currency, offer.total)
    end
    lines[#lines + 1] = string.format("%d. %s — %s", index, clean(offer.name), total)
  end
  local comparison = "No relevant storefront results were found."
  if #lines > 0 then comparison = table.concat(lines, "\n") end
  local ranked_status = "no_results"
  if #offers > 0 then ranked_status = "candidates" end
  return {
    status = ranked_status,
    offers = json.array(offers),
    comparisonText = comparison,
  }
end

register({
  prepare_search = prepare_search,
  rank_provider_result = rank_provider_result,
})
