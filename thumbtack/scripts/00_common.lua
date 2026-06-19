AX_THUMBTACK = {}
local M = AX_THUMBTACK

M.HOME_URL = "https://www.thumbtack.com/"
M.RESULT_READY_SELECTOR = 'a[href*="/service/"], [data-testid="pro-list-result"], [data-test="pro-list-result"]'
M.SERVICE_READY_SELECTOR = 'h1, button, [data-test="specialties-section__interested-item"]'
M.MODAL_SELECTOR = '[data-test="thumbprint-modal-container"], [role="dialog"]'
M.CENSUS_GEOCODER_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"

function M.clean_text(value)
  local text = tostring(value or "")
  text = text:gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", "")
  return text
end

function M.non_empty(value)
  local text = M.clean_text(value)
  if text == "" then
    return nil
  end
  return text
end

function M.normalize_text(value)
  return M.clean_text(value):lower():gsub("%s+", " ")
end

function M.truncate_text(value, limit)
  local text = M.clean_text(value)
  if #text <= limit then
    return text
  end
  return text:sub(1, limit - 1) .. "…"
end

function M.css_attr_string(value)
  local text = tostring(value or "")
  text = text:gsub("\\", "\\\\"):gsub('"', '\\"')
  return text
end

function M.selector_for_name(name)
  local text = M.non_empty(name)
  if not text then
    return nil
  end
  return '[name="' .. M.css_attr_string(text) .. '"]'
end

function M.selector_for_id(id)
  local text = M.non_empty(id)
  if not text then
    return nil
  end
  return '[id="' .. M.css_attr_string(text) .. '"]'
end

function M.url_encode(value)
  local text = tostring(value or "")
  return (text:gsub("([^%w%-_%.~])", function(char)
    return string.format("%%%02X", string.byte(char))
  end))
end

function M.extract_zip(value)
  local text = tostring(value or "")
  local zip = text:match("(%d%d%d%d%d)%-%d%d%d%d") or text:match("(%d%d%d%d%d)")
  return zip
end

function M.parse_number_text(value)
  local text = tostring(value or ""):gsub(",", "")
  local number_text = text:match("(%d+%.%d+)") or text:match("(%d+)")
  if not number_text then
    return nil
  end
  return tonumber(number_text)
end

function M.parse_rating(value)
  local rating = tonumber(tostring(value or ""):match("(%d+%.%d+)"))
  if rating and rating <= 5 then
    return rating
  end
  return nil
end

function M.parse_review_count(value)
  local count = tostring(value or ""):match("%(([%d,]+)%)")
  if count then
    local digits = count:gsub(",", "")
    return tonumber(digits)
  end
  return nil
end

function M.parse_price_text(value)
  local text = M.clean_text(value)
  local contact = text:match("Contact for price")
  if contact then
    return contact
  end
  local price = text:match("($[%d,]+[^$]-Starting price)") or text:match("($[%d,]+)")
  return M.non_empty(price)
end

function M.service_id_from_url(value)
  local text = tostring(value or "")
  return text:match("/service/(%d+)") or text:match("[?&]service_pk=(%d+)")
end

function M.slug_name_from_url(value)
  local text = tostring(value or "")
  local slug = text:match("/([^/%?]+)/service/%d+")
  if not slug then
    return nil
  end
  slug = slug:gsub("%-", " ")
  return (slug:gsub("(%a)([%w']*)", function(first, rest)
    return first:upper() .. rest:lower()
  end))
end

function M.dedupe_adjacent(value)
  local text = M.clean_text(value)
  local length = #text
  if length % 2 == 0 then
    local half = length / 2
    if text:sub(1, half) == text:sub(half + 1) then
      return text:sub(1, half)
    end
  end
  return text
end

function M.name_from_result_text(text, url)
  local value = M.clean_text(text)
  local prefix = value:match("^(.-)Great%s+%d")
    or value:match("^(.-)Excellent%s+%d")
    or value:match("^(.-)%d+%.%d%(")
    or value:match("^(.-)New on Thumbtack")
    or value:match("^(.-)Top Pro")
  prefix = M.dedupe_adjacent(prefix or "")
  return M.non_empty(prefix) or M.slug_name_from_url(url)
end

function M.response_time_from_text(value)
  local text = M.clean_text(value)
  return text:match("(Online Now %- responds [^%d]*%d+%s+%a+)")
    or text:match("(Responds in [^%.]+)")
    or text:match("(responds [^%.]+)")
end

function M.hire_count_from_text(value)
  local text = M.clean_text(value)
  local count = text:match("([%d,]+)%s+hires on Thumbtack")
  if count then
    local digits = count:gsub(",", "")
    return tonumber(digits)
  end
  return nil
end

function M.location_from_text(value)
  local text = M.clean_text(value)
  return text:match("(Serves [A-Za-z%s%.%-]+, [A-Z][A-Z])")
end

function M.resolve_zip(args)
  args = args or {}
  local explicit = M.extract_zip(args.zip_code)
  if explicit then
    return {
      zip_code = explicit,
      source = "zip_code"
    }
  end

  local address = M.non_empty(args.address)
  if not address then
    return {
      error = "missing_zip_or_address"
    }
  end

  local embedded = M.extract_zip(address)
  if embedded then
    return {
      zip_code = embedded,
      source = "address_text"
    }
  end
  local fetch = (net and net.fetch) or (http and http.fetch)
  if not fetch then
    return {
      error = "fetch_unavailable"
    }
  end
  local response = fetch(M.CENSUS_GEOCODER_URL .. "?address=" .. M.url_encode(address) .. "&benchmark=Public_AR_Current&format=json", {
    method = "GET",
    headers = {
      accept = "application/json"
    },
    credentials = "omit",
    response = "json",
    timeout = 10000
  })

  if response.reason == "pending" then
    return {
      pending = true,
      error = "pending"
    }
  end

  if not response.ok then
    return {
      error = "zip_lookup_failed",
      status = response.status,
      reason = response.reason,
      body = response.body,
      message = response.error
    }
  end

  local matches = response.json
    and response.json.result
    and response.json.result.addressMatches
  local first = matches and matches[1]
  local components = first and first.addressComponents
  local zip = components and components.zip
  if not zip then
    return {
      error = "zip_not_found",
      status = response.status
    }
  end

  return {
    zip_code = tostring(zip),
    source = "census_geocoder",
    matched_address = first.matchedAddress
  }
end

function M.current_url()
  return M.non_empty(dom.get_location_href()) or ""
end

function M.is_home_page()
  local href = M.current_url()
  return href == "https://www.thumbtack.com/" or href == "http://www.thumbtack.com/" or href:match("^https://www%.thumbtack%.com/$") ~= nil
end

function M.is_results_page()
  return M.current_url():find("/instant%-results/", 1, false) ~= nil
end

function M.current_results_match(query, zip_code)
  if not M.is_results_page() then
    return false
  end
  local zip_value = M.non_empty(dom.get_attr('input[aria-label="Zip code"]', "value")) or M.current_url():match("[?&]zip_code=(%d%d%d%d%d)")
  if zip_code and zip_value ~= zip_code then
    return false
  end
  local query_value = M.non_empty(dom.get_attr('input[aria-label="Search on Thumbtack"]', "value"))
  if query and query_value and M.normalize_text(query_value) ~= M.normalize_text(query) then
    -- Thumbtack normalizes queries to canonical category names, so do not reject a populated result page.
    return dom.exists('a[href*="/service/"]')
  end
  return true
end

-- Selectors for dismissable modal/overlay popups (e.g., instant-results project questions).
M.MODAL_CLOSE_SELECTOR = '[aria-label="Close"], [data-test="close-modal"]'

-- Best-effort close of an open modal/overlay popup that overlays the results/page.
-- Closing does not navigate, so navigates=false keeps the durable step replay-safe.
-- Safe no-op when no such popup is present (dom.click returns false on no match).
function M.dismiss_modals()
  if dom.exists(M.MODAL_CLOSE_SELECTOR) then
    dom.click(M.MODAL_CLOSE_SELECTOR, { navigates = false })
  end
end

function M.start_search(query, zip_code)
  if not M.is_home_page() then
    nav.navigate(M.HOME_URL, {})
    return true
  end

  -- Prep the multi-input search as one async flow so React commits each step (typed query →
  -- autocomplete category selection → zip) before submitting. A plain durable sequence runs
  -- synchronously within a replay pass, so the submit would fire before Thumbtack resolves the
  -- query and produce no navigation. dom.fill yields between actions; the submit click is a
  -- separate navigating step.
  dom.fill({
    { set = 'input[aria-label="Search on Thumbtack"]', value = query },
    { wait = '[role="option"]' },
    { click = '[role="option"]' },
    { delay = 400 },
    { set = 'input[aria-label="Zip code"]', value = zip_code },
  })
  dom.click('button[data-test="search-button"]', { expectedUrl = "/instant-results/" })
  return true
end

function M.result_candidate_from_row(row)
  local url = M.non_empty(row.url)
  local service_id = M.service_id_from_url(url)
  if not service_id then
    return nil
  end

  local text = M.clean_text(row.text)
  local name = M.name_from_result_text(text, url)
  if not name then
    return nil
  end

  return {
    service_id = service_id,
    id = service_id,
    name = name,
    url = url,
    image_url = M.non_empty(row.image_url),
    rating = M.parse_rating(text),
    review_count = M.parse_review_count(text),
    price_text = M.parse_price_text(text),
    response_time = M.response_time_from_text(text),
    hire_count = M.hire_count_from_text(text),
    location = M.location_from_text(text),
    summary = M.truncate_text(text, 360)
  }
end

function M.read_search_candidates()
  local rows = dom.query_all('a[href*="/service/"]', {
    url = { attr = "href" },
    text = true,
    image_url = { selector = "img", attr = "src" }
  }, 80)
  local candidates = ax.array()
  local seen = {}

  for index = 1, #rows do
    local candidate = M.result_candidate_from_row(rows[index])
    if candidate and not seen[candidate.service_id] then
      seen[candidate.service_id] = true
      candidates[#candidates + 1] = candidate
    end
  end

  return candidates
end

-- Service options (left-side filters): per the page structure, each option group is the
-- parent div of a `.tp-title-4` heading. Read them as { title, choices } and select a choice.
M.SERVICE_OPTION_GROUP_SELECTOR = 'div:has(> .tp-title-4)'

function M.is_option_control(value)
  return value == "Skip" or value == "Next" or value == "Back" or value == "More"
    or value == "Show more" or value == "See more" or value == "Change search"
end

function M.clean_choice_list(raw, title)
  local choices = ax.array()
  local seen = {}
  if type(raw) == "table" then
    for index = 1, #raw do
      local value = M.non_empty(raw[index])
      if value and value ~= title and not M.is_option_control(value) and not seen[value] then
        seen[value] = true
        choices[#choices + 1] = value
      end
    end
  end
  return choices
end

function M.read_service_options()
  local groups = dom.query_all(M.SERVICE_OPTION_GROUP_SELECTOR, {
    title = { selector = ".tp-title-4", text = true },
    choices = { selector = 'a[href], button, label, [role="radio"], [role="button"], [role="option"]', all = true }
  }, 40)
  local options = ax.array()
  local seen = {}
  for index = 1, #groups do
    local title = M.non_empty(groups[index].title)
    if title and not seen[title] then
      seen[title] = true
      options[#options + 1] = {
        title = title,
        choices = M.clean_choice_list(groups[index].choices, title)
      }
    end
  end
  return options
end

-- Select a service-option choice by its visible text. Link-style filters are clicked by href;
-- returns ok=false when no matching clickable (link) option is found.
function M.select_service_option(value)
  local target = M.normalize_text(value or "")
  if target == "" then return { ok = false, error = "missing_value" } end
  local links = dom.query_all(M.SERVICE_OPTION_GROUP_SELECTOR .. ' a[href]', {
    text = true,
    url = { attr = "href" }
  }, 200)
  for index = 1, #links do
    if M.normalize_text(links[index].text or "") == target then
      local href = M.non_empty(links[index].url)
      if href then
        dom.click('a[href="' .. href .. '"]', { navigates = true })
        return { ok = true, href = href }
      end
    end
  end
  return { ok = false, error = "option_not_found" }
end

function M.read_text_array(selector, limit)
  local rows = dom.query_all(selector, { text = true }, limit)
  local values = ax.array()
  local seen = {}
  for index = 1, #rows do
    local value = M.non_empty(rows[index].text)
    if value and not seen[value] then
      seen[value] = true
      values[#values + 1] = value
    end
  end
  return values
end

function M.read_images(selector, limit)
  local rows = dom.query_all(selector, {
    url = { attr = "src" },
    alt = { attr = "alt" }
  }, limit)
  local images = ax.array()
  local seen = {}
  for index = 1, #rows do
    local url = M.non_empty(rows[index].url)
    if url and not seen[url] then
      seen[url] = true
      images[#images + 1] = {
        url = url,
        alt = M.non_empty(rows[index].alt)
      }
    end
  end
  return images
end

function M.section_between(body, start_label, end_labels)
  local body_text = M.clean_text(body)
  local start_at = body_text:find(start_label, 1, true)
  if not start_at then
    return nil
  end
  local content_start = start_at + #start_label
  local end_at = nil
  for index = 1, #end_labels do
    local candidate = body_text:find(end_labels[index], content_start, true)
    if candidate and (not end_at or candidate < end_at) then
      end_at = candidate
    end
  end
  local text = end_at and body_text:sub(content_start, end_at - 1) or body_text:sub(content_start)
  return M.non_empty(M.truncate_text(text, 1200))
end

function M.current_service_matches(service_id)
  if not service_id then
    return dom.exists("h1") and M.current_url():find("/service/", 1, true) ~= nil
  end
  return M.service_id_from_url(M.current_url()) == service_id and dom.exists("h1")
end

function M.navigate_service_if_needed(args)
  local service_id = M.non_empty(args.service_id or args.id)
  local url = M.non_empty(args.url)
  if service_id and M.current_service_matches(service_id) then
    return false
  end
  if url and (not service_id or M.service_id_from_url(url) == service_id or not M.current_service_matches(service_id)) then
    if M.current_url() ~= url then
      nav.navigate(url, {})
      return true
    end
    return false
  end
  if service_id and M.current_service_matches(service_id) then
    return false
  end
  return false
end

function M.read_service_view(service_id)
  local body = dom.get_text("body") or ""
  local url = M.current_url()
  local resolved_id = service_id or M.service_id_from_url(url)
  local rating_text = M.non_empty(dom.get_text('[data-test="review-summary"]')) or body
  return {
    service_id = resolved_id,
    id = resolved_id,
    name = M.non_empty(dom.get_text("h1")),
    url = url,
    category = M.non_empty(dom.get_text('a[href*="/k/"]')) or M.non_empty(dom.get_text('input[aria-label="Search on Thumbtack"]')),
    rating = M.parse_rating(rating_text),
    review_count = M.parse_review_count(rating_text),
    about = M.section_between(body, "About", { "Overview", "Services offered", "Projects and media", "Reviews" }),
    overview = M.section_between(body, "Overview", { "Business hours", "Payment methods", "Social media", "Message", "Request" }),
    business_hours = M.section_between(body, "Business hours", { "Payment methods", "Social media", "Message", "Request", "Services offered" }),
    payment_methods = M.section_between(body, "Payment methods", { "Social media", "Message", "Request", "Services offered" }),
    services_offered = M.read_text_array('[data-test="specialties-section__interested-item"]', 20),
    photos = M.read_images('[data-test="media-section-carousel-container"] img, img[src*="production-next-images-cdn.thumbtack.com"]', 80),
    reviews = M.read_text_array('[data-test="qna-content"], [data-test="review-summary"]', 20),
    credentials = M.section_between(body, "Credentials", { "FAQs", "Related cost information", "Popular" }),
    faqs = M.read_text_array('[data-test="questions-section__question"], [data-test="qna-content"]', 40),
    actions = {
      message = body:find("Message", 1, true) ~= nil,
      request_quote = body:find("Request a quote", 1, true) ~= nil or body:find("Request estimate", 1, true) ~= nil
    }
  }
end

function M.read_project_form()
  local fields = dom.query_all(M.MODAL_SELECTOR .. ' input, ' .. M.MODAL_SELECTOR .. ' textarea, ' .. M.MODAL_SELECTOR .. ' select', {
    tag = { attr = "tagName" },
    type = { attr = "type" },
    name = { attr = "name" },
    id = { attr = "id" },
    placeholder = { attr = "placeholder" },
    value = { attr = "value" },
    checked = { attr = "checked" },
    aria = { attr = "aria-label" },
    text = true
  }, 120)
  local buttons = dom.query_all(M.MODAL_SELECTOR .. ' button, ' .. M.MODAL_SELECTOR .. ' [role="button"]', {
    text = true,
    aria = { attr = "aria-label" }
  }, 80)
  return {
    text = M.non_empty(dom.get_text(M.MODAL_SELECTOR)),
    fields = fields,
    buttons = buttons
  }
end

function M.apply_form_values(values)
  local applied = ax.array()
  if type(values) ~= "table" then
    return applied
  end
  for name, value in pairs(values) do
    local selector = nil
    if tostring(name):sub(1, 1) == "#" or tostring(name):sub(1, 1) == "." or tostring(name):find("[", 1, true) then
      selector = tostring(name)
    else
      selector = M.selector_for_name(name) or M.selector_for_id(name)
    end
    local ok = selector and dom.set_value(selector, value) or false
    applied[#applied + 1] = {
      kind = "form",
      name = tostring(name),
      value = value,
      ok = ok == true,
      reason = ok == true and "updated" or "control_not_found"
    }
  end
  return applied
end

function M.open_quote_modal()
  local selector = 'button._2Wt7kayvRID5rLVjUZGxyx + button._2Wt7kayvRID5rLVjUZGxyx'
  if dom.exists(selector) then
    return dom.click(selector)
  end
  selector = 'button._2i8mb7zKaftUGBdoxRCF1T'
  if dom.exists(selector) then
    return dom.click(selector)
  end
  return false
end
