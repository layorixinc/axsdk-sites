-- Thumbtack service marketplace provider (read-only, EXTERNAL_PACK_TASK_PLAN §9).
-- X0-4 measured (2026-08-27): search cards carry name · badge · rating (count) · hires · a review
-- quote and NO price; the page carries the site's own published band linked to /p/<slug>-prices.
-- A pro-stated rate is read ONLY from the card's intro region — a review is never a price.

local RESULT_SELECTOR = 'div:has(> [data-test="pro-list-result"])'
local INTRO_SELECTOR = '[data-test="pro-intro"]'
local SERVICE_LINK_SELECTOR = 'a[href*="/service/"]'
local PRICES_LINK_SELECTOR = 'a[href*="-prices"]'
local BADGES = { "Top Pro", "Exceptional", "Very good", "Great", "Good" }

local function clean(value, maximum)
  return text.clean(value, maximum or 240)
end

local function slugify(query)
  local lowered = string.lower(clean(query))
  local slug = string.gsub(lowered, "[^%w]+", "-")
  slug = string.gsub(slug, "^%-+", "")
  slug = string.gsub(slug, "%-+$", "")
  return slug
end

local function search_target(input)
  local base = "https://www.thumbtack.com/k/" .. slugify(input.query) .. "/near-me"
  if input.region ~= nil and input.region ~= "" then
    return url.with_params(base, { { "zip_code", input.region } })
  end
  return base
end

local function shows_search(input)
  local parsed = url.parse(page.href())
  if parsed == nil then return false end
  if parsed.origin ~= "https://www.thumbtack.com" then return false end
  if parsed.pathname ~= "/k/" .. slugify(input.query) .. "/near-me" then return false end
  if input.region ~= nil and input.region ~= "" and parsed.params.zip_code ~= input.region then
    return false
  end
  return true
end

local function strip_badges(value)
  local name = value
  local changed = true
  while changed do
    changed = false
    for _, badge in ipairs(BADGES) do
      local suffix = " " .. badge
      if #name > #suffix and string.sub(name, -#suffix) == suffix then
        name = string.sub(name, 1, #name - #suffix)
        changed = true
      end
    end
  end
  return clean(name)
end

local function card_candidate(card)
  local full = clean(dom.text(card), 800)
  local rating, review_count = string.match(full, "(%d%.%d)%s*%((%d+)%)")
  local hires = string.match(full, "(%d+)%s+hires")
  local rating_position = string.find(full, "%d%.%d%s*%(")
  local name = rating_position ~= nil and strip_badges(clean(string.sub(full, 1, rating_position - 1)))
    or clean(full, 80)
  if name == "" then return nil end
  local candidate = { name = name }
  if rating ~= nil then candidate.rating = tonumber(rating) end
  if review_count ~= nil then candidate.review_count = tonumber(review_count) end
  if hires ~= nil then candidate.hires = tonumber(hires) end
  local href = dom.attr(card, SERVICE_LINK_SELECTOR, "href")
  if href ~= nil then candidate.url = href end
  -- A pro-stated rate comes ONLY from the intro region. The review snippet is deliberately never
  -- read as a claim: the measured "$200 more" inside a review is a complaint, not a price.
  local intro = clean(dom.text(card, INTRO_SELECTOR))
  if intro ~= "" then
    candidate.claim_kind = "pro_stated"
    candidate.claim_text = intro
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
  local band = dom.query(PRICES_LINK_SELECTOR)
  if band ~= nil then
    local band_text = clean(dom.text(band), 400)
    if band_text ~= "" then
      result.site_claims = json.array({ { kind = "site_average", text = band_text } })
    end
  end
  return { step = "done", result = result }
end

register({ read_service_candidates = read_service_candidates })
