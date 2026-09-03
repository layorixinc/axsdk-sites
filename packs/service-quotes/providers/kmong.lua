-- 크몽 (Kmong) service marketplace provider (read-only, EXTERNAL_PACK_TASK_PLAN §9).
-- X0-4 measured (2026-08-27): public fixed prices per listing (`99,000원~` beside `4.9 (80)`), so a
-- listing price is a real claim — carried as text for the task normaliser, never parsed here.

local RESULT_SELECTOR = '[data-testid="gig-card"]'
local LINK_SELECTOR = 'a[href*="/gig/"]'
local PRICE_SELECTOR = '[data-testid="gig-price"]'

local function clean(value, maximum)
  return text.clean(value, maximum or 240)
end

local function search_target(input)
  return url.with_params("https://kmong.com/search", {
    { "type", "gigs" },
    { "keyword", input.query },
  })
end

local function shows_search(input)
  local parsed = url.parse(page.href())
  if parsed == nil then return false end
  return parsed.origin == "https://kmong.com"
    and parsed.pathname == "/search"
    and parsed.params.type == "gigs"
    and parsed.params.keyword == input.query
end

local function card_candidate(card)
  local name = clean(dom.text(card, LINK_SELECTOR), 120)
  if name == "" then return nil end
  local candidate = { name = name }
  local href = dom.attr(card, LINK_SELECTOR, "href")
  if href ~= nil then candidate.url = href end
  local full = clean(dom.text(card), 400)
  local rating, review_count = string.match(full, "(%d%.%d)%s*%((%d+)%)")
  if rating ~= nil then candidate.rating = tonumber(rating) end
  if review_count ~= nil then candidate.review_count = tonumber(review_count) end
  local price_text = clean(dom.text(card, PRICE_SELECTOR))
  if price_text ~= "" then
    candidate.claim_kind = "listing_price"
    candidate.claim_text = price_text
  end
  return candidate
end

local function read_service_candidates(input)
  if not shows_search(input) then
    return { step = "navigate", url = search_target(input) }
  end
  local limit = math.max(1, math.min(6, input.limit or 6))
  local cards = dom.query_all(RESULT_SELECTOR)
  local candidates = {}
  for index = 1, #cards do
    local candidate = card_candidate(cards[index])
    if candidate ~= nil then
      candidates[#candidates + 1] = candidate
      if #candidates >= limit then break end
    end
  end
  local result = {
    schema_version = 1,
    status = #candidates > 0 and "candidates" or "no_results",
    query = input.query,
    cards_seen = #cards,
  }
  if #candidates > 0 then result.candidates = json.array(candidates) end
  return { step = "done", result = result }
end

register({ read_service_candidates = read_service_candidates })
