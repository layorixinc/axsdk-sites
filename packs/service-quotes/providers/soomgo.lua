-- 숨고 (Soomgo) service marketplace provider (read-only, EXTERNAL_PACK_TASK_PLAN §9).
-- X0-4 measured (2026-08-27): a request-first marketplace — 0 money figures in the pro search
-- surface. The honest row is reputation only (경력 · 고용 · 리뷰), amount ABSENT by construction.

local RESULT_SELECTOR = '[data-testid="pro-card"]'

local function clean(value, maximum)
  return text.clean(value, maximum or 240)
end

local function search_target(input)
  return url.with_params("https://soomgo.com/search/pro", { { "query", input.query } })
end

local function shows_search(input)
  local parsed = url.parse(page.href())
  if parsed == nil then return false end
  return parsed.origin == "https://soomgo.com"
    and parsed.pathname == "/search/pro"
    and parsed.params.query == input.query
end

local function card_candidate(card)
  local full = clean(dom.text(card), 600)
  local name = clean(string.match(full, "^([^·]+)") or "", 80)
  if name == "" then return nil end
  local candidate = { name = name }
  local experience = string.match(full, "경력%s*(%d+)년")
  if experience ~= nil then candidate.experience_years = tonumber(experience) end
  local hires = string.match(full, "고용%s*(%d+)회")
  if hires ~= nil then candidate.hires = tonumber(hires) end
  local rating, review_count = string.match(full, "리뷰%s*(%d+%.?%d*)%s*%((%d+)%)")
  if rating ~= nil then candidate.rating = tonumber(rating) end
  if review_count ~= nil then candidate.review_count = tonumber(review_count) end
  local href = dom.attr(card, "href")
  if href ~= nil and href ~= "" then
    if string.sub(href, 1, 1) == "/" then href = "https://soomgo.com" .. href end
    candidate.url = href
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
