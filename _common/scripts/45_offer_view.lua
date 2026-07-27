-- Deterministic view layer over a ranked candidate list: refine parsing, filtering, sorting, paging,
-- and window rendering.
--
-- The model never receives the list itself — it sees one rendered window and answers with a number or
-- a command — so this module owns everything that would otherwise grow the prompt with the result set.
-- It is intentionally free of `dom`, `nav`, and `net` so it can be unit tested offline
-- (tools/lua/offer-view.test.mjs).

AX_OFFER_VIEW = AX_OFFER_VIEW or {}
local V = AX_OFFER_VIEW

V.DEFAULT_PAGE_SIZE = 5
V.DEFAULT_BUDGET_CHARS = 1200
V.SORTS = { total_asc = true, price_asc = true, rating_desc = true, delivery_asc = true }

local SITE_ALIASES = {
  amazon = { "amazon", "아마존" },
  walmart = { "walmart", "월마트" },
  ebay = { "ebay", "이베이" },
  aliexpress = { "aliexpress", "알리익스프레스", "알리" },
  etsy = { "etsy", "엣시" },
  coupang = { "coupang", "쿠팡" },
  ["naver-shopping"] = { "naver", "네이버쇼핑", "네이버 쇼핑" },
  gmarket = { "gmarket", "지마켓", "g마켓" },
  ["11st"] = { "11st", "11번가" },
  ssg = { "ssg", "쓱" }
}

-- Ordered so a longer marker is tested before a prefix of itself.
local RESET_MARKERS = { "필터 해제", "필터해제", "필터 초기화", "필터 지워", "조건 해제", "reset filter", "clear filter" }
local RESCOPE_MARKERS = { "말고", "다시 찾", "다시 검색", "재검색", "추가해서", "instead of", "search again" }
local FREE_SHIPPING_MARKERS = { "무료배송", "무료 배송", "배송비 무료", "free shipping" }
local SPONSORED_MARKERS = { "광고 빼", "광고 제외", "광고는 빼", "스폰서 제외", "no ads", "exclude sponsored" }
local COMPLETE_COST_MARKERS = { "총액 확실", "배송비 포함된 것만", "complete cost" }
-- The default window hides rows whose total is unknown; these are the ways users ask for them back.
local INCLUDE_INCOMPLETE_MARKERS = {
  "미확인 포함", "미확인도 포함", "미확인도", "전부 보여", "모두 보여", "다 보여", "include unknown", "show all"
}
local UPPER_MARKERS = { "이하", "아래", "미만", "under", "below", "less than" }
local LOWER_MARKERS = { "이상", "넘는", "초과", "over", "above", "more than" }

-- Every string that reaches a window goes through here. A live Thumbtack card carried an `<img>` tag in
-- its response-time text and rendered it verbatim to the user: the window is a text surface, so markup
-- and collapsed whitespace are removed at the boundary rather than trusted away in each reader.
local function trim(value)
  local text = tostring(value or "")
  text = text:gsub("<[^<>]*>", " ")
  text = text:gsub("%s+", " ")
  return (text:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function lower(value)
  return trim(value):lower()
end

local function contains_any(haystack, markers)
  for index = 1, #markers do
    if haystack:find(markers[index], 1, true) then return true end
  end
  return false
end

local function to_number(text)
  return tonumber((tostring(text or ""):gsub(",", "")))
end

local function count_keys(record)
  local total = 0
  for _ in pairs(record or {}) do total = total + 1 end
  return total
end

--- Formats an amount with the currency code; zero-decimal currencies never show cents.
function V.format_amount(value, currency)
  local numeric = tonumber(value)
  local code = trim(currency)
  if code == "" then code = "USD" end
  -- The window is Korean end to end; an English placeholder mid-row reads as a broken row, not a
  -- missing number (a live 11st comparison showed "총 unknown").
  if not numeric then return "미확인" end
  if code == "KRW" or code == "JPY" then
    local rounded = string.format("%d", math.floor(numeric + 0.5))
    local grouped = rounded:reverse():gsub("(%d%d%d)", "%1,"):reverse():gsub("^,", "")
    return code .. " " .. grouped
  end
  return string.format("%s %.2f", code, numeric)
end

--- Interprets one user sentence. Everything it cannot ground becomes `unparsed`, never a guess.
function V.parse_refine(text)
  local raw = trim(text)
  local lowered = lower(raw)
  local result = { filters = {}, sort = nil, unparsed = false, reset = false, rescope = false }
  if lowered == "" then
    result.unparsed = true
    return result
  end

  if contains_any(lowered, RESET_MARKERS) then
    result.reset = true
    return result
  end
  if contains_any(lowered, RESCOPE_MARKERS) then
    result.rescope = true
    return result
  end

  local rating_context = lowered:find("평점", 1, true) or lowered:find("별점", 1, true) or lowered:find("rating", 1, true)
  local wants_upper = contains_any(lowered, UPPER_MARKERS)
  local wants_lower = contains_any(lowered, LOWER_MARKERS)

  if rating_context then
    -- Both "평점 4.5점 이상" and "평점 4.5 이상" are how people write it; requiring the 점 unit dropped
    -- the second form into "unparsed".
    local score = tonumber(lowered:match("(%d+%.?%d*)%s*점"))
      or tonumber(lowered:match("평점%s*(%d+%.?%d*)"))
      or tonumber(lowered:match("별점%s*(%d+%.?%d*)"))
      or tonumber(lowered:match("rating%s*(%d+%.?%d*)"))
    if score and wants_lower then result.filters.min_rating = score end
    if lowered:find("높은", 1, true) or lowered:find("high", 1, true) then result.sort = "rating_desc" end
  end

  -- Price is only read when the sentence actually names money, so "평점 4점 이상" never sets a price.
  -- The currency the user spoke in is part of the threshold: "3만원 이하" applied to a USD listing let
  -- every dollar offer through until the amount carried its currency.
  local man = tonumber(lowered:match("(%d+%.?%d*)%s*만원"))
  local won = to_number(lowered:match("([%d][%d,]*)%s*원"))
  local dollars = tonumber(lowered:match("%$%s*(%d+%.?%d*)"))
    or tonumber(lowered:match("(%d+%.?%d*)%s*달러"))
    or tonumber(lowered:match("(%d+%.?%d*)%s*usd"))
  local amount = man and (man * 10000) or won or dollars
  local currency = (man or won) and "KRW" or (dollars and "USD" or nil)
  if not amount then
    -- A bare number with a comparison word stays currency-less: it is compared to the offer's own price.
    -- `gsub` returns (string, count); without the extra parentheses the count becomes tonumber's base.
    local bare = lowered:match("([%d][%d,]*)%s*[%a%s]*이하") or lowered:match("([%d][%d,]*)%s*[%a%s]*이상")
    amount = bare and tonumber((bare:gsub(",", ""))) or nil
  end
  if amount then
    if wants_upper then
      result.filters.price_max = amount
      result.filters.price_currency = currency
    elseif wants_lower and not rating_context then
      result.filters.price_min = amount
      result.filters.price_currency = currency
    end
  end

  if contains_any(lowered, FREE_SHIPPING_MARKERS) then result.filters.free_shipping_only = true end
  if contains_any(lowered, SPONSORED_MARKERS) then result.filters.exclude_sponsored = true end
  if contains_any(lowered, COMPLETE_COST_MARKERS) then result.filters.complete_cost_only = true end
  if contains_any(lowered, INCLUDE_INCOMPLETE_MARKERS) then result.filters.include_incomplete = true end

  local sites = {}
  for slug, aliases in pairs(SITE_ALIASES) do
    for index = 1, #aliases do
      if lowered:find(aliases[index], 1, true) then
        sites[#sites + 1] = slug
        break
      end
    end
  end
  if #sites > 0 then
    table.sort(sites)
    result.filters.sites = sites
  end

  if not result.sort then
    if lowered:find("싼", 1, true) or lowered:find("저렴", 1, true) or lowered:find("낮은 순", 1, true)
      or lowered:find("cheap", 1, true) then
      result.sort = "total_asc"
    elseif lowered:find("빠른 배송", 1, true) or lowered:find("빨리", 1, true) or lowered:find("fastest", 1, true) then
      result.sort = "delivery_asc"
    end
  end

  result.unparsed = count_keys(result.filters) == 0 and result.sort == nil
  return result
end
-- Offers in a comparison quote different currencies but every one of them also carries the base-currency
-- amount, so the listing itself tells us the rate for each currency it contains.
local function rate_table(items)
  local rates = {}
  for index = 1, #(items or {}) do
    local item = items[index]
    local code = trim(item.currency):upper()
    local price = tonumber(item.price)
    local base = tonumber(item.price_base)
    if code ~= "" and price and base and base > 0 and rates[code] == nil then
      rates[code] = price / base
    end
  end
  return rates
end

--- The offer's price expressed in `currency`, or nil when the listing cannot ground the conversion.
local function price_in(item, currency, rates)
  local price = tonumber(item.price)
  if not currency then return price end
  local code = trim(item.currency):upper()
  if code == currency then return price end
  local base = tonumber(item.price_base)
  local rate = rates[currency]
  if not base or not rate then return nil end
  return base * rate
end

--- Why a filter cannot be applied to this listing, or nil when it can.
function V.filter_error(items, filters)
  filters = filters or {}
  local currency = filters.price_currency
  if not currency then return nil end
  if not (filters.price_max or filters.price_min) then return nil end
  -- Groundable when the rate is known OR when an offer already quotes that currency: comparing won to
  -- won needs no conversion, and a listing without base amounts is still perfectly comparable then.
  if rate_table(items)[currency] then return nil end
  for index = 1, #(items or {}) do
    if trim(items[index].currency):upper() == currency then return nil end
  end
  return "price_currency_unknown"
end

local function matches_filters(item, filters, rates)
  filters = filters or {}
  local price = price_in(item, filters.price_currency, rates or {})
  if filters.price_max and (price == nil or price > filters.price_max) then return false end
  if filters.price_min and (price == nil or price < filters.price_min) then return false end
  if filters.free_shipping_only and tonumber(item.shipping_cost) ~= 0 then return false end
  if filters.min_rating then
    local rating = tonumber(item.rating)
    if rating == nil or rating < filters.min_rating then return false end
  end
  if filters.exclude_sponsored and item.sponsored == true then return false end
  if filters.complete_cost_only and item.cost_complete ~= true then return false end
  if filters.sites then
    local site = lower(item.site)
    local allowed = false
    for index = 1, #filters.sites do
      if site == lower(filters.sites[index]) then allowed = true break end
    end
    if not allowed then return false end
  end
  return true
end

local function sort_value(item, sort)
  if sort == "price_asc" then return tonumber(item.price_base) or tonumber(item.price) end
  if sort == "rating_desc" then return tonumber(item.rating) end
  if sort == "delivery_asc" then return tonumber(item.delivery_days) end
  return tonumber(item.total_base)
end

--- Filters then sorts, with the original position as the tiebreaker so the order is reproducible.
function V.apply(items, options)
  options = options or {}
  local sort = V.SORTS[options.sort] and options.sort or "total_asc"
  local descending = sort == "rating_desc"
  local rates = rate_table(items)
  local kept = {}
  for index = 1, #(items or {}) do
    local item = items[index]
    if item and matches_filters(item, options.filters, rates) then
      kept[#kept + 1] = { item = item, position = index }
    end
  end
  table.sort(kept, function(left, right)
    local left_value = sort_value(left.item, sort)
    local right_value = sort_value(right.item, sort)
    if left_value ~= right_value then
      -- A missing sort key never outranks a known one.
      if left_value == nil then return false end
      if right_value == nil then return true end
      if descending then return left_value > right_value end
      return left_value < right_value
    end
    return left.position < right.position
  end)
  local result = {}
  for index = 1, #kept do result[index] = kept[index].item end
  return result
end

--- Page window for a total, clamped into range. An empty list still reports one page.
function V.page_bounds(total, page, page_size)
  local size = math.max(1, math.floor(tonumber(page_size) or V.DEFAULT_PAGE_SIZE))
  local count = math.max(0, math.floor(tonumber(total) or 0))
  local pages = math.max(1, math.ceil(count / size))
  local current = math.floor(tonumber(page) or 1)
  if current < 1 then current = 1 end
  if current > pages then current = pages end
  if count == 0 then return { first = 0, last = 0, page = 1, pages = 1 } end
  local first = ((current - 1) * size) + 1
  local last = math.min(count, current + 0 == current and first + size - 1 or first)
  return { first = first, last = last, page = current, pages = pages }
end

--- Applies a page command ("next"/"prev"/"first"/"last") or an absolute number, staying in range.
function V.resolve_page(current, command, number, pages)
  local total_pages = math.max(1, math.floor(tonumber(pages) or 1))
  local page = math.floor(tonumber(current) or 1)
  local requested = tonumber(number)
  if requested then
    page = math.floor(requested)
  elseif command == "next" then
    page = page + 1
  elseif command == "prev" then
    page = page - 1
  elseif command == "first" then
    page = 1
  elseif command == "last" then
    page = total_pages
  end
  if page < 1 then page = 1 end
  if page > total_pages then page = total_pages end
  return page
end

--- Trims markup/whitespace and shortens to `limit` bytes without splitting a UTF-8 sequence. Every text
--- surface built from live listing text goes through here, not only the comparison window.
function V.clip(value, limit)
  local text = trim(value)
  if limit and #text > limit then
    -- Byte-safe clip: never split a UTF-8 sequence.
    local cut = limit
    while cut > 1 and text:byte(cut + 1) and text:byte(cut + 1) >= 128 and text:byte(cut + 1) <= 191 do
      cut = cut - 1
    end
    return text:sub(1, cut) .. "…"
  end
  return text
end
local clip = V.clip

-- Field degradation order. Level 0 is the full line; each later level drops the least decision-relevant
-- field first and only then shortens the product name. Number, site, and total always survive, and the
-- notes above the list survive until the very tightest level.
local LEVELS = {
  { name = 64, condition = true, rating = true, shipping = true, item = true, notes = true },
  { name = 64, condition = false, rating = true, shipping = true, item = true, notes = true },
  { name = 48, condition = false, rating = false, shipping = true, item = true, notes = true },
  { name = 40, condition = false, rating = false, shipping = true, item = false, notes = true },
  { name = 24, condition = false, rating = false, shipping = false, item = false, notes = false }
}

local function render_line(number, item, level, display_currency)
  local currency = trim(display_currency)
  local native = currency ~= "" and currency == trim(item.currency)
  local total_value = native and item.total_for_quantity or item.total_base
  local total_currency = native and item.currency or (item.base_currency or currency)
  -- A row the site worded differently ("유사") must be visible as such: the user is comparing prices of
  -- what they believe is one product, and an unmarked near-match is how a wrong purchase happens.
  local label = item.match_level == "partial" and " (유사)" or ""
  local parts = { tostring(number) .. ". [" .. tostring(item.site or "?") .. "]" .. label .. " " .. clip(item.name, level.name) }
  parts[#parts + 1] = "총 " .. V.format_amount(total_value, total_currency)
  if level.item then
    parts[#parts + 1] = "상품가 " .. V.format_amount(item.price, item.currency or total_currency)
  end
  if level.shipping then
    local shipping = tonumber(item.shipping_cost)
    if shipping == nil then
      parts[#parts + 1] = "배송비 미확인"
    elseif shipping == 0 then
      parts[#parts + 1] = "무료배송"
    else
      parts[#parts + 1] = "배송비 " .. V.format_amount(shipping, item.shipping_currency or item.currency or total_currency)
    end
  end
  if level.rating and tonumber(item.rating) then
    parts[#parts + 1] = string.format("평점 %.1f", tonumber(item.rating))
  end
  if level.condition and trim(item.condition) ~= "" then
    parts[#parts + 1] = trim(item.condition)
  end
  return table.concat(parts, " · ")
end

local function render_at_level(items, bounds, level, options)
  local lines = {}
  if bounds.first > 0 then
    for position = bounds.first, bounds.last do
      lines[#lines + 1] = render_line(position, items[position], level, options.display_currency)
    end
  end
  local header
  if bounds.first == 0 then
    header = "조건에 맞는 상품 0개"
  elseif level.condition then
    header = string.format("총 %d개 중 %d-%d번 (%d/%d 페이지)", #items, bounds.first, bounds.last, bounds.page, bounds.pages)
  else
    header = string.format("%d개 중 %d-%d (%d/%d)", #items, bounds.first, bounds.last, bounds.page, bounds.pages)
  end
  local footer = level.condition
    and "번호로 선택 · '다음'/'이전' · '무료배송만' 같은 조건 · '취소'"
    or "번호 선택 · 다음/이전 · 취소"

  -- Notes (store outcomes, folded rows) sit above the list: they change what the list MEANS, so they must
  -- survive as long as any row does. Only the tightest level drops them.
  local blocks = { header }
  if level.notes then
    for index = 1, #(options.notes or {}) do blocks[#blocks + 1] = options.notes[index] end
  end
  if #lines > 0 then blocks[#blocks + 1] = table.concat(lines, "\n") end
  blocks[#blocks + 1] = footer
  return table.concat(blocks, "\n")
end

--- Renders one window. The text is what the user sees; the model only relays numbers back.
function V.render(items, options)
  options = options or {}
  local list = items or {}
  local size = math.max(1, math.floor(tonumber(options.page_size) or V.DEFAULT_PAGE_SIZE))
  local budget = math.max(120, math.floor(tonumber(options.budget_chars) or V.DEFAULT_BUDGET_CHARS))
  local bounds = V.page_bounds(#list, options.page, size)

  local text = nil
  local truncated = false
  for level_index = 1, #LEVELS do
    text = render_at_level(list, bounds, LEVELS[level_index], options)
    truncated = level_index > 1
    if #text <= budget then break end
  end

  return {
    text = text,
    page = bounds.page,
    pages = bounds.pages,
    first = bounds.first,
    last = bounds.last,
    total = #list,
    truncated = truncated
  }
end

--- Stable identity of "what the list contains". Page moves keep it; filters and sort change it.
function V.signature(filters, sort)
  local keys = {}
  for key, value in pairs(filters or {}) do
    local rendered
    if type(value) == "table" then
      local copy = {}
      for index = 1, #value do copy[index] = tostring(value[index]) end
      table.sort(copy)
      rendered = table.concat(copy, "+")
    else
      rendered = tostring(value)
    end
    keys[#keys + 1] = tostring(key) .. "=" .. rendered
  end
  table.sort(keys)
  keys[#keys + 1] = "sort=" .. (V.SORTS[sort] and sort or "total_asc")
  return table.concat(keys, "|")
end

-- Service pros are ranked on different fields than storefront offers (reviews, response speed, a free
-- text keyword), so they get their own parser. Anything that is not a known criterion is treated as a
-- keyword the user typed rather than being discarded: on a pro list that is what people actually mean.
-- Ordered specific-first: "a few hours" is slower than "an hour", so the generic "hour" marker must not
-- swallow it. The first marker that matches wins.
local RESPONSE_BUCKETS = {
  { "minute", 1 }, { "분", 1 },
  { "few hours", 3 }, { "몇 시간", 3 },
  { "hour", 2 }, { "시간", 2 },
  { "few days", 5 },
  { "day", 4 }, { "일", 4 },
  { "week", 6 }, { "주", 6 }
}

--- Ordinal speed of a "Responds within …" label; unknown labels sort last.
function V.response_rank(value)
  local text = lower(value)
  if text == "" then return nil end
  for index = 1, #RESPONSE_BUCKETS do
    if text:find(RESPONSE_BUCKETS[index][1], 1, true) then return RESPONSE_BUCKETS[index][2] end
  end
  return nil
end

--- First amount in a price label ("Starting at $70" -> 70) so a text price can still be ordered.
function V.price_hint(value)
  local text = tostring(value or ""):gsub(",", "")
  return tonumber(text:match("(%d+%.?%d*)"))
end

function V.parse_candidate_refine(text)
  local raw = trim(text)
  local lowered = lower(raw)
  local result = { filters = {}, sort = nil, unparsed = false, reset = false, rescope = false }
  if lowered == "" then
    result.unparsed = true
    return result
  end
  if contains_any(lowered, RESET_MARKERS) then
    result.reset = true
    return result
  end

  if lowered:find("리뷰", 1, true) or lowered:find("review", 1, true) then
    result.sort = "reviews_desc"
  elseif lowered:find("평점", 1, true) or lowered:find("별점", 1, true) or lowered:find("rating", 1, true) then
    if lowered:find("높은", 1, true) or lowered:find("high", 1, true) or lowered:find("좋은", 1, true) then
      result.sort = "rating_desc"
    end
    local score = tonumber(lowered:match("(%d+%.?%d*)%s*점")) or tonumber(lowered:match("(%d+%.?%d*)"))
    if score and contains_any(lowered, LOWER_MARKERS) then result.filters.min_rating = score end
    if not result.sort and not result.filters.min_rating then result.sort = "rating_desc" end
  elseif lowered:find("저렴", 1, true) or lowered:find("싼", 1, true) or lowered:find("cheap", 1, true)
    or lowered:find("가격", 1, true) then
    result.sort = "price_asc"
  elseif lowered:find("응답", 1, true) or lowered:find("빠른", 1, true) or lowered:find("respon", 1, true)
    or lowered:find("fast", 1, true) then
    result.sort = "response_asc"
  elseif lowered:find("고용", 1, true) or lowered:find("hire", 1, true) then
    result.sort = "hires_desc"
  else
    result.filters.keyword = raw
  end

  return result
end

local function candidate_sort_value(item, sort)
  if sort == "reviews_desc" then return tonumber(item.review_count) end
  if sort == "hires_desc" then return tonumber(item.hire_count) end
  if sort == "price_asc" then return V.price_hint(item.price_text or item.price) end
  if sort == "response_asc" then return V.response_rank(item.response_time) end
  return tonumber(item.rating)
end

local function candidate_matches(item, filters)
  filters = filters or {}
  if filters.min_rating then
    local rating = tonumber(item.rating)
    if rating == nil or rating < filters.min_rating then return false end
  end
  if filters.keyword then
    local needle = lower(filters.keyword)
    local haystack = lower(tostring(item.name or "") .. " " .. tostring(item.summary or "")
      .. " " .. tostring(item.price_text or "") .. " " .. tostring(item.response_time or ""))
    if not haystack:find(needle, 1, true) then return false end
  end
  return true
end

--- Filters then ranks service pros; ties keep the order the site returned.
function V.apply_candidates(items, options)
  options = options or {}
  local sort = options.sort or "rating_desc"
  local ascending = sort == "price_asc" or sort == "response_asc"
  local kept = {}
  for index = 1, #(items or {}) do
    local item = items[index]
    if item and candidate_matches(item, options.filters) then
      kept[#kept + 1] = { item = item, position = index }
    end
  end
  table.sort(kept, function(left, right)
    local left_value = candidate_sort_value(left.item, sort)
    local right_value = candidate_sort_value(right.item, sort)
    if left_value ~= right_value then
      if left_value == nil then return false end
      if right_value == nil then return true end
      if ascending then return left_value < right_value end
      return left_value > right_value
    end
    return left.position < right.position
  end)
  local result = {}
  for index = 1, #kept do result[index] = kept[index].item end
  return result
end

local CANDIDATE_LEVELS = {
  { name = 48, summary = 40, response = true, price = true, reviews = true },
  { name = 40, summary = 0, response = true, price = true, reviews = true },
  { name = 32, summary = 0, response = false, price = true, reviews = true },
  { name = 24, summary = 0, response = false, price = true, reviews = false }
}

-- Some sites hand back the whole card as the "summary": the pro's name repeated (the last copy often
-- truncated), then the rating parenthetical and badge words the line already shows in their own columns.
-- Everything that merely repeats another column is removed until the text stops changing; what is left
-- is either a real description or too short to deserve a slot.
local CANDIDATE_BADGES = { "Top Pro", "Exceptional", "Very good", "Great", "In high demand", "Offers remote services" }

function V.candidate_summary(item)
  local text = trim(item.summary)
  if text == "" then return nil end
  local name = trim(item.name)
  local escaped = name ~= "" and name:gsub("(%W)", "%%%1") or nil

  local previous
  repeat
    previous = text
    if escaped then
      -- Whole copies anywhere, then a truncated leading fragment of the name (>= 6 chars of it).
      text = trim((text:gsub(escaped, " ")))
      for length = #name - 1, 6, -1 do
        local fragment = name:sub(1, length):gsub("(%W)", "%%%1")
        local stripped = text:gsub("^" .. fragment, "")
        if stripped ~= text then
          text = trim(stripped)
          break
        end
      end
    end
    text = trim((text:gsub("^%d+%.?%d*%s*%(%s*[%d,]+%s*%)", "")))
    for index = 1, #CANDIDATE_BADGES do
      text = trim((text:gsub("^" .. CANDIDATE_BADGES[index], "")))
    end
  until text == previous

  if #text < 8 then return nil end
  return text
end

local function candidate_line(number, item, level)
  local parts = { tostring(number) .. ". " .. clip(item.name, level.name) }
  if tonumber(item.rating) then
    parts[#parts + 1] = string.format("평점 %.1f", tonumber(item.rating))
  end
  if level.reviews and tonumber(item.review_count) then
    parts[#parts + 1] = "리뷰 " .. tostring(math.floor(tonumber(item.review_count))) .. "개"
  end
  if level.price and trim(item.price_text) ~= "" then
    parts[#parts + 1] = trim(item.price_text)
  end
  if level.response and trim(item.response_time) ~= "" then
    parts[#parts + 1] = trim(item.response_time)
  end
  local summary = level.summary > 0 and V.candidate_summary(item) or nil
  if summary then
    parts[#parts + 1] = clip(summary, level.summary)
  end
  return table.concat(parts, " · ")
end

--- Renders one window of service pros under the same character budget rules as offers.
function V.render_candidates(items, options)
  options = options or {}
  local list = items or {}
  local size = math.max(1, math.floor(tonumber(options.page_size) or V.DEFAULT_PAGE_SIZE))
  local budget = math.max(120, math.floor(tonumber(options.budget_chars) or V.DEFAULT_BUDGET_CHARS))
  local bounds = V.page_bounds(#list, options.page, size)

  local text, truncated = nil, false
  for level_index = 1, #CANDIDATE_LEVELS do
    local level = CANDIDATE_LEVELS[level_index]
    local lines = {}
    if bounds.first > 0 then
      for position = bounds.first, bounds.last do
        lines[#lines + 1] = candidate_line(position, list[position], level)
      end
    end
    local header = bounds.first == 0 and "조건에 맞는 전문가 0명"
      or string.format("전문가 %d명 중 %d-%d번 (%d/%d 페이지)", #list, bounds.first, bounds.last, bounds.page, bounds.pages)
    local footer = "번호로 선택(여러 개 가능) · '다음'/'이전' · 다른 기준 입력 · '취소'"
    text = header .. (#lines > 0 and ("\n" .. table.concat(lines, "\n")) or "") .. "\n" .. footer
    truncated = level_index > 1
    if #text <= budget then break end
  end

  return {
    text = text,
    page = bounds.page,
    pages = bounds.pages,
    first = bounds.first,
    last = bounds.last,
    total = #list,
    truncated = truncated
  }
end
