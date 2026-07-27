-- Stable, read-only Amazon search helpers for the isolated Playground site layer.
-- This layer intentionally mirrors the public AX_search_product result shape without
-- importing production site sources into the Playground workspace.

AX_PLAYGROUND_AMAZON = {}
local M = AX_PLAYGROUND_AMAZON

M.SEARCH_URL = "https://www.amazon.com/s"
M.PRODUCT_URL_PREFIX = "https://www.amazon.com/dp/"
M.RESULT_SELECTOR = '[data-component-type="s-search-result"][data-asin]'
M.LOGIN_SELECTOR = '#authportal-main-section, #ap_email, #ap_password'
M.CAPTCHA_SELECTOR = 'form[action*="validateCaptcha"]'
M.NO_RESULTS_SELECTOR = '.s-no-results-result'
M.RESULT_READY_SELECTOR = M.RESULT_SELECTOR .. ', ' .. M.NO_RESULTS_SELECTOR .. ', ' .. M.LOGIN_SELECTOR .. ', ' .. M.CAPTCHA_SELECTOR
M.RESULT_ROOT_SELECTOR = '[data-component-type="s-search-results"]'
M.RESULT_LIMIT = 24

function M.clean_text(value)
  local text = tostring(value or "")
  text = text:gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", "")
  return text
end

function M.non_empty(value)
  local text = M.clean_text(value)
  if text == "" then return nil end
  return text
end

function M.truncate_text(value, limit)
  local text = M.clean_text(value)
  if #text <= limit then return text end
  return text:sub(1, limit - 1) .. "…"
end

function M.normalize_query(value)
  local text = M.non_empty(value)
  return text and text:lower() or ""
end

function M.parse_number(value)
  local normalized = tostring(value or ""):gsub(",", ""):gsub("%s+", "")
  return tonumber(normalized:match("(%d+%.%d+)") or normalized:match("(%d+)"))
end

function M.parse_price(value)
  local text = M.non_empty(value)
  if not text then return nil, nil end

  local currency = nil
  if text:find("US$", 1, true) or text:find("$", 1, true) then
    currency = "USD"
  elseif text:find("€", 1, true) then
    currency = "EUR"
  elseif text:find("£", 1, true) then
    currency = "GBP"
  elseif text:find("¥", 1, true) then
    currency = "JPY"
  end

  return M.parse_number(text), currency
end

function M.parse_rating(value)
  local rating = tonumber(M.clean_text(value):match("(%d+%.%d+)"))
  if rating and rating <= 5 then return rating end
  return nil
end

function M.parse_review_count(value)
  local compact = M.clean_text(value):gsub("[%(%),%s]", "")
  if compact == "" then return nil end
  local abbreviated = tonumber(compact:match("(%d+%.?%d*)[kK]"))
  if abbreviated then return math.floor(abbreviated * 1000) end
  return tonumber(compact:match("%d+"))
end

function M.parse_total_count(value, fallback)
  local largest = tonumber(fallback or 0) or 0
  for token in tostring(value or ""):gmatch("[%d,]+") do
    local digits = token:gsub(",", "")
    local parsed = tonumber(digits)
    if parsed and parsed > largest then largest = parsed end
  end
  return largest
end

function M.is_login_page()
  local href = M.non_empty(dom.get_location_href()) or ""
  return href:find("/ap/signin", 1, true) ~= nil or dom.exists(M.LOGIN_SELECTOR)
end

function M.login_required_result()
  return {
    ok = false,
    error = "login_required",
    status = "login_required",
    login_required = true,
    candidates = ax.array(),
  }
end

function M.is_captcha_page()
  return dom.exists(M.CAPTCHA_SELECTOR)
end

function M.is_search_page()
  local href = M.non_empty(dom.get_location_href()) or ""
  return href:find("/s?", 1, true) ~= nil or href:match("/s$") ~= nil
end

function M.current_search_matches(query)
  if not M.is_search_page() then return false end
  local current = M.normalize_query(dom.get_attr("#twotabsearchtextbox", "value"))
  return current ~= "" and current == M.normalize_query(query)
end

function M.result_fields()
  return {
    asin = { attr = "data-asin" },
    title = { selector = "h2" },
    title_alt = { selector = "h2 a" },
    image_alt = { selector = "img.s-image", attr = "alt" },
    url = { selector = 'h2 a, a.a-link-normal.s-no-outline, a[href*="/dp/"], a[href*="/gp/product/"]', attr = "href" },
    image_url = { selector = "img.s-image", attr = "src" },
    price_text = { selector = ".a-price .a-offscreen" },
    rating_text = { selector = "i.a-icon-star-small span.a-icon-alt, .a-icon-alt" },
    reviews_text = { selector = 'a[href*="#customerReviews"] span, a[href*="#customerReviews"]' },
    badge = { selector = ".a-badge-text, .s-label-popover-default" },
    sponsored = { selector = '.s-sponsored-label-info-icon, [aria-label="Sponsored"]', exists = true },
    text = true,
  }
end

function M.product_url(asin, href)
  local id = M.non_empty(asin)
  if id then return M.PRODUCT_URL_PREFIX .. id end

  local target = M.non_empty(href)
  if target and target:sub(1, 1) == "/" then return "https://www.amazon.com" .. target end
  return target
end

function M.candidate_from_row(row)
  local asin = M.non_empty(row.asin)
  local name = M.non_empty(row.image_alt) or M.non_empty(row.title) or M.non_empty(row.title_alt)
  if not asin or not name then return nil end

  local price, currency = M.parse_price(row.price_text)
  local summary = M.truncate_text(row.text, 280)
  local lower_summary = summary:lower()
  local sponsored = row.sponsored == true
    or lower_summary:find("^sponsored") ~= nil
    or summary:find("^스폰서 광고") ~= nil
    or summary:find("^후원") ~= nil

  return {
    product_id = asin,
    id = asin,
    name = name,
    url = M.product_url(asin, row.url),
    image_url = M.non_empty(row.image_url),
    price = price,
    price_text = M.non_empty(row.price_text),
    currency = currency,
    rating = M.parse_rating(row.rating_text),
    review_count = M.parse_review_count(row.reviews_text),
    badge = M.non_empty(row.badge),
    sponsored = sponsored,
    summary = summary,
  }
end

function M.read_candidates(query)
  local rows = dom.query_all(M.RESULT_SELECTOR, M.result_fields(), M.RESULT_LIMIT)
  local candidates = ax.array()
  local seen = {}
  local normalized_query = M.normalize_query(query)

  for index = 1, #rows do
    local candidate = M.candidate_from_row(rows[index])
    if candidate and not seen[candidate.id] then
      local sponsored_only = candidate.sponsored and not normalized_query:find("sponsored", 1, true)
      if not sponsored_only then
        seen[candidate.id] = true
        candidates[#candidates + 1] = candidate
      end
    end
  end

  return candidates
end

function M.read_total_count(fallback)
  local text = M.non_empty(dom.get_text(".s-breadcrumb"))
    or M.non_empty(dom.get_text('[data-component-type="s-result-info-bar"]'))
    or M.non_empty(dom.get_text(".s-result-info-bar"))
    or M.non_empty(dom.get_text(".s-desktop-toolbar"))
  return M.parse_total_count(text, fallback)
end

function M.read_next_cursor()
  return M.non_empty(dom.get_attr("a.s-pagination-next", "href"))
end

