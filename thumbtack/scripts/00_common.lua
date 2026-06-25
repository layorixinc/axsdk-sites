AX_THUMBTACK = {}
local M = AX_THUMBTACK

M.HOME_URL = "https://www.thumbtack.com/"
M.SEARCH_INPUT_SELECTOR = 'input[aria-label="Search on Thumbtack"]'
-- The homepage search form scopes the query and zip fields. Thumbtack renders 3 "Zip code" inputs but
-- only this form's input[name="zip_code"] is read on submit, so the zip selector is scoped to the form.
-- The search UI varies by A/B bucket: the "Search" button is type=submit in some variants and
-- type=button in others, so the form is submitted via dom.submit_form (requestSubmit), not a button click.
M.SEARCH_FORM_SELECTOR = 'form:has(input[aria-label="Search on Thumbtack"])'
M.SEARCH_ZIP_SELECTOR = M.SEARCH_FORM_SELECTOR .. ' input[name="zip_code"]'
-- Autocomplete suggestion; appears after typing and must resolve into a keyword before submit navigates.
M.SEARCH_AUTOCOMPLETE_SELECTOR = '[role="option"]'
M.RESULT_READY_SELECTOR = 'a[href*="/service/"], [data-testid="pro-list-result"], [data-test="pro-list-result"]'
M.SERVICE_READY_SELECTOR = 'h1, button, [data-test="specialties-section__interested-item"]'
M.MODAL_SELECTOR = '[data-test="thumbprint-modal-container"], [role="dialog"]'
-- Quote/estimate flow ("Request Flow Dialog"): a multi-step dialog distinct from the legacy
-- thumbprint modal. The pro page also pre-renders many empty modal placeholders, so the flow is
-- detected and read by its active step, never by M.MODAL_SELECTOR.
M.REQUEST_FLOW_SELECTOR = '[aria-label="Request Flow Dialog"]'
M.REQUEST_FLOW_ACTIVE_SELECTOR = '[data-test="request-flow-step--active"]'
M.REQUEST_FLOW_ERROR_SELECTOR = '#request-flow-error'
-- Site-agnostic primitives are composed from the shared base (AX_BASE, _common/scripts/00_base.lua,
-- loaded before this file). Single source of truth; no duplicated logic in this module.
local B = AX_BASE
M.clean_text = B.clean_text
M.non_empty = B.non_empty
M.normalize_text = B.normalize_text
M.truncate_text = B.truncate_text
M.dedupe_adjacent = B.dedupe_adjacent
M.css_attr_string = B.css_attr_string
M.selector_for_name = B.selector_for_name
M.selector_for_id = B.selector_for_id
M.url_encode = B.url_encode
M.url_query_param = B.url_query_param
M.current_url = B.current_url
M.extract_zip = B.extract_zip
M.parse_number_text = B.parse_number_text
M.parse_rating = B.parse_rating
M.parse_review_count = B.parse_review_count
M.parse_price_text = B.parse_price_text
M.read_text_array = B.read_text_array
M.read_images = B.read_images
M.split_city_state = B.split_city_state
M.zip_from_city = B.zip_from_city
M.resolve_zip = B.resolve_zip


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

function M.is_home_page()
  local href = M.current_url()
  return href == "https://www.thumbtack.com/" or href == "http://www.thumbtack.com/" or href:match("^https://www%.thumbtack%.com/$") ~= nil
end

function M.is_results_page()
  local href = M.current_url()
  return href:find("/instant-results/", 1, true) ~= nil or href:find("/near-me", 1, true) ~= nil
end

function M.current_results_match(query, zip_code)
  local href = M.current_url()
  local slug = M.category_slug(query)
  -- Match the category results page for this query's slug, or a legacy instant-results page.
  local on_results = (slug ~= "" and href:find("/k/" .. slug .. "/", 1, true) ~= nil)
    or href:find("/instant-results/", 1, true) ~= nil
  if not on_results then
    return false
  end
  -- Reject only when an explicit zip is present and differs (results may still be hydrating).
  local zip_value = href:match("[?&]zip_code=(%d%d%d%d%d)") or M.non_empty(dom.get_attr(M.SEARCH_ZIP_SELECTOR, "value"))
  if zip_code and zip_value and zip_value ~= zip_code then
    return false
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

function M.category_slug(query)
  -- Thumbtack category results live at /k/<slug>/near-me/. Build the slug from the service query:
  -- lowercase, collapse every run of non-alphanumeric chars to one hyphen, trim hyphens. e.g.
  -- "handyman"->"handyman", "House Cleaning"->"house-cleaning", "lawn mowing"->"lawn-mowing".
  local s = (query or ""):lower()
  s = s:gsub("[^%w]+", "-")
  s = s:gsub("^%-+", "")
  s = s:gsub("%-+$", "")
  return s
end

function M.start_search(query, zip_code)
  -- Submit the homepage search box. Type the query and zip into the search FORM's fields, wait for the
  -- autocomplete to resolve the query into a keyword (a [role="option"] suggestion appears), then submit
  -- the form, which navigates to /instant-results?keyword_pk=...&zip_code=<zip>. Submitting
  -- BEFORE the autocomplete resolves is a no-op (the form's onSubmit needs the resolved keyword), so the
  -- option wait + short settle are required. read_search_candidates parses the resulting pro list.
  local zip = M.non_empty(zip_code)
  local actions = { { set = M.SEARCH_INPUT_SELECTOR, value = query } }
  if zip then
    actions[#actions + 1] = { set = M.SEARCH_ZIP_SELECTOR, value = zip }
  end
  -- Keep the option wait + settle well under the SDK per-call deadline so the whole fill (then the
  -- form submit) completes in one durable call and the next call lands on the loaded results page.
  actions[#actions + 1] = { wait = M.SEARCH_AUTOCOMPLETE_SELECTOR, timeout = 2500 }
  actions[#actions + 1] = { delay = 800 }
  dom.fill(actions)
  dom.submit_form(M.SEARCH_FORM_SELECTOR, { expectedUrl = "/instant-results" })
end

function M.dedupe_name(value)
  -- Category cards render the pro name twice in responsive spans ("NameName"); collapse an exact
  -- doubling back to a single name and leave normal names untouched.
  local s = M.non_empty(value)
  if not s then
    return nil
  end
  local n = #s
  if n % 2 == 0 then
    local half = math.floor(n / 2)
    if s:sub(1, half) == s:sub(half + 1) then
      return M.non_empty(s:sub(1, half))
    end
  end
  return s
end

function M.result_candidate_from_row(row)
  local url = M.non_empty(row.url)
  local service_id = M.service_id_from_url(url)
  if not service_id then
    return nil
  end

  local text = M.clean_text(row.text)
  -- Name: prefer the avatar img alt ("Avatar for <name>"), then the de-doubled .pro-title, then
  -- fall back to deriving it from the card text/url (legacy instant-results layout).
  local name = nil
  local alt = M.non_empty(row.image_alt)
  if alt then
    name = M.non_empty((alt:gsub("^[Aa]vatar [Ff]or%s+", "")))
  end
  if not name then
    name = M.dedupe_name(row.name)
  end
  if not name then
    name = M.name_from_result_text(text, url)
  end
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
  -- The full pro card is the div that directly contains the [data-test|data-testid="pro-list-result"]
  -- marker; it holds the service link, avatar img, the pro name (.pro-title when present, else derived
  -- from the card text), and the rich text (rating/price/summary). The marker itself does NOT contain
  -- the service link, so query the parent div. The attribute is data-test in some A/B variants and
  -- data-testid in others, so match both.
  local rows = dom.query_all('div:has(> [data-test="pro-list-result"]), div:has(> [data-testid="pro-list-result"])', {
    url = { selector = 'a[href*="/service/"]', attr = "href" },
    name = { selector = ".pro-title", text = true },
    image_url = { selector = "img", attr = "src" },
    image_alt = { selector = "img", attr = "alt" },
    text = true
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
-- Radio/checkbox filter variant: a bold body-2 heading div followed by option <label> elements
-- (each wrapping a hidden input). Matched in one document-order query to rebuild { title, choices }.
M.RADIO_FILTER_SELECTOR = 'div.b.tp-body-2, label:has(input[type="radio"]), label:has(input[type="checkbox"])'

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
  local options = ax.array()
  local seen = {}
  -- Variant A: link/title filter groups (a `.tp-title-4` heading with link/label choices).
  local groups = dom.query_all(M.SERVICE_OPTION_GROUP_SELECTOR, {
    title = { selector = ".tp-title-4", text = true },
    choices = { selector = 'a[href], button, label, [role="radio"], [role="button"], [role="option"]', all = true }
  }, 40)
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
  -- Variant B: radio/checkbox filter groups.
  M.append_radio_filter_options(options, seen)
  return options
end

-- Reconstruct radio/checkbox filter groups from one document-order query: a heading row (no input)
-- opens a group; each following option label (input present) adds a choice and records the selected
-- one. A heading with no following option is ignored so unrelated bold text never forms a group.
function M.append_radio_filter_options(options, seen)
  local rows = dom.query_all(M.RADIO_FILTER_SELECTOR, {
    text = true,
    control = { selector = "input", attr = "type" },
    checked = { selector = "input", attr = "checked" }
  }, 200)
  local pending_title = nil
  local current = nil
  for index = 1, #rows do
    local row = rows[index]
    local text = M.clean_text(row.text)
    if not row.control then
      current = nil
      pending_title = (text ~= "" and not seen[text]) and text or nil
    elseif text ~= "" then
      if pending_title then
        seen[pending_title] = true
        current = { title = pending_title, choices = ax.array() }
        options[#options + 1] = current
        pending_title = nil
      end
      if current then
        current.choices[#current.choices + 1] = text
        if row.checked == true then
          current.selected = text
        end
      end
    end
  end
end

-- Select a service-option choice by its visible text. Link filters are clicked by href; radio /
-- checkbox filters fall back to a position-based click within the option's group.
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
  return M.select_radio_filter_option(target)
end

-- Radio/checkbox option: locate it by visible text, then click the Nth option label within its
-- group container (options share the input name, read at runtime; the label carries no stable id).
-- Idempotent: an already-selected option is left unchanged.
function M.select_radio_filter_option(target)
  local options = dom.query_all('label:has(input[type="radio"]), label:has(input[type="checkbox"])', {
    text = true,
    group = { selector = "input", attr = "name" },
    checked = { selector = "input", attr = "checked" }
  }, 300)
  local counts = {}
  for index = 1, #options do
    local option = options[index]
    local group = option.group or ""
    counts[group] = (counts[group] or 0) + 1
    if M.normalize_text(option.text or "") == target then
      if option.checked == true then
        return { ok = true, already_selected = true }
      end
      if option.group then
        local selector = 'div:has(> div > label > input[name="' .. option.group
          .. '"]) > *:nth-child(' .. counts[group] .. ') label'
        dom.click(selector, { navigates = false })
        return { ok = true, position = counts[group] }
      end
    end
  end
  return { ok = false, error = "option_not_found" }
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
      -- Clear the page's beforeunload guard (an open quote dialog sets one) so the real navigation
      -- below is not blocked by a native "Leave site?" prompt that nothing can dismiss in-flow.
      nav.clear_beforeunload()
      -- reload=true forces a real load: Next.js ignores synthetic pushState, so a same-origin
      -- pro->pro hop would otherwise change the URL without rendering the new pro (stale).
      -- Signature: navigate(url, query_params, opts). reload lives in the 3rd arg; passing it as the
      -- 2nd arg would leak ?reload=true into the URL and stay a pushState. Empty params, opts.reload=true.
      nav.navigate(url, {}, { reload = true })
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

function M.read_project_form_fields(scope)
  if scope == M.REQUEST_FLOW_ACTIVE_SELECTOR then
    local fields = dom.query_all(
      scope .. ' label:has(input[type="radio"]), '
        .. scope .. ' label:has(input[type="checkbox"])',
      {
        tag = { selector = "input", attr = "tagName" },
        type = { selector = "input", attr = "type" },
        name = { selector = "input", attr = "name" },
        id = { selector = "input", attr = "id" },
        placeholder = { selector = "input", attr = "placeholder" },
        value = { selector = "input", attr = "value" },
        checked = { selector = "input", attr = "checked" },
        aria = { selector = "input", attr = "aria-label" },
        text = true
      },
      120
    )
    local other_fields = dom.query_all(
      scope .. ' textarea, '
        .. scope .. ' select, '
        .. scope .. ' input:not([type="radio"]):not([type="checkbox"])',
      {
        tag = { attr = "tagName" },
        type = { attr = "type" },
        name = { attr = "name" },
        id = { attr = "id" },
        placeholder = { attr = "placeholder" },
        value = { attr = "value" },
        checked = { attr = "checked" },
        aria = { attr = "aria-label" },
        text = true
      },
      120
    )
    for index = 1, #other_fields do
      fields[#fields + 1] = other_fields[index]
    end
    return fields
  end
  return dom.query_all(scope .. ' input, ' .. scope .. ' textarea, ' .. scope .. ' select', {
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
end

function M.read_request_flow_questions()
  local questions = ax.array()
  local status = "not_open"
  local all_available = false
  local active_text = M.non_empty(dom.get_text(M.REQUEST_FLOW_ACTIVE_SELECTOR))

  if active_text then
    status = "active_step_only"
  elseif dom.exists(M.REQUEST_FLOW_SELECTOR) then
    status = "dialog_without_active_step"
  else
    return {
      status = status,
      all_questions_available = false,
      questions = questions
    }
  end

  local rows = dom.query_all(
    M.REQUEST_FLOW_SELECTOR .. ' form[data-test="request-flow-step-form"], '
      .. M.REQUEST_FLOW_SELECTOR .. ' [data-test="request-flow-step--active"]',
    {
      text = true,
      data_test = { attr = "data-test" },
      aria = { attr = "aria-label" }
    },
    40
  )
  local seen = {}
  for index = 1, #rows do
    local text = M.non_empty(rows[index].text)
    if text and not seen[text] then
      seen[text] = true
      questions[#questions + 1] = {
        index = #questions + 1,
        text = M.truncate_text(text, 600),
        active = active_text ~= nil and text == active_text
      }
    end
  end

  if active_text and #questions == 0 then
    questions[#questions + 1] = {
      index = 1,
      text = M.truncate_text(active_text, 600),
      active = true
    }
  end

  if active_text and #questions > 1 then
    status = "preloaded_questions"
    all_available = true
  end

  return {
    status = status,
    all_questions_available = all_available,
    questions = questions
  }
end


function M.read_request_flow_error()
  if not dom.exists(M.REQUEST_FLOW_ERROR_SELECTOR) then
    return nil
  end
  local text = M.non_empty(dom.get_text(M.REQUEST_FLOW_ERROR_SELECTOR))
  if not text then
    return nil
  end
  text = M.clean_text(text:gsub("%s*Close alert%s*$", ""))
  local normalized = M.normalize_text(text)
  local email = text:match('email address%s+"([^"]+)"')
    or text:match("([%w%.%+_%-]+@[%w%.%-]+%.[A-Za-z][A-Za-z]+)")
  local retry_field = nil
  local error_code = "request_flow_error"
  if email or normalized:find("email", 1, true) then
    retry_field = "email"
    if normalized:find("disabled", 1, true) then
      error_code = "email_account_disabled"
    elseif normalized:find("invalid", 1, true) then
      error_code = "invalid_email"
    else
      error_code = "email_error"
    end
  end
  local question = "Thumbtack returned an error: " .. text
  if retry_field == "email" then
    if email then
      question = 'Thumbtack rejected "' .. email .. '". Please provide a different email address.'
    else
      question = "Thumbtack rejected the email address. Please provide a different email address."
    end
  end
  return {
    error = error_code,
    message = text,
    field = retry_field,
    retry_field = retry_field,
    bad_value = email,
    question = question
  }
end

function M.dismiss_request_flow_error()
  if not dom.exists(M.REQUEST_FLOW_ERROR_SELECTOR) then
    return false
  end
  return dom.click(M.REQUEST_FLOW_ERROR_SELECTOR .. ' button[aria-label="Close alert"]', {
    navigates = false
  }) == true
end

function M.read_project_form()
  -- Read the active request-flow step when present (the real quote dialog); otherwise fall back to
  -- the legacy modal. Avoids the empty thumbprint-modal placeholders the page pre-renders.
  local scope = M.MODAL_SELECTOR
  if dom.exists(M.REQUEST_FLOW_ACTIVE_SELECTOR) then
    scope = M.REQUEST_FLOW_ACTIVE_SELECTOR
  elseif dom.exists(M.REQUEST_FLOW_SELECTOR) then
    scope = M.REQUEST_FLOW_SELECTOR
  end
  local fields = M.read_project_form_fields(scope)
  local buttons = dom.query_all(scope .. ' button, ' .. scope .. ' [role="button"]', {
    text = true,
    aria = { attr = "aria-label" }
  }, 80)
  local request_error = M.read_request_flow_error()
  local question_snapshot = M.read_request_flow_questions()
  return {
    scope = scope,
    text = M.non_empty(dom.get_text(scope)),
    fields = fields,
    buttons = buttons,
    request_error = request_error,
    error = request_error and request_error.error or nil,
    questions = question_snapshot.questions,
    all_questions_available = question_snapshot.all_questions_available,
    question_collection_status = question_snapshot.status
  }
end

function M.read_quote_contact(fields)
  local contact = {}
  for index = 1, #fields do
    local field = fields[index]
    local field_type = M.normalize_text(field.type or "")
    local placeholder = M.normalize_text(field.placeholder or "")
    local aria = M.normalize_text(field.aria or "")
    local value = M.non_empty(field.value)
    if value then
      if field_type == "email" or aria:find("email", 1, true) or placeholder:find("email", 1, true) then
        contact.email = value
      elseif field_type == "tel" or aria:find("phone", 1, true) or placeholder:find("555", 1, true) then
        contact.phone = value
      elseif placeholder:find("zip", 1, true) or aria:find("zip", 1, true) then
        contact.zip_code = value
      elseif placeholder:find("first name", 1, true) or aria:find("first name", 1, true) then
        contact.first_name = value
      elseif placeholder:find("last name", 1, true) or aria:find("last name", 1, true) then
        contact.last_name = value
      end
    end
  end
  return contact
end

function M.read_submit_button_label(form)
  local buttons = form and form.buttons or {}
  for index = 1, #buttons do
    local label = M.non_empty(buttons[index].text) or M.non_empty(buttons[index].aria)
    local normalized = M.normalize_text(label)
    if normalized:find("submit", 1, true)
      or normalized:find("send", 1, true)
      or normalized:find("quote", 1, true)
      or normalized:find("request", 1, true) then
      return label
    end
  end
  return nil
end

function M.read_quote_submission_snapshot()
  local url = M.current_url()
  local service_id = M.service_id_from_url(url)
  local form = M.read_project_form()
  local request_error = M.read_request_flow_error()
  local submit_button = M.read_submit_button_label(form)
  local aside_text = M.non_empty(dom.get_text("aside"))
  local main_text = M.non_empty(dom.get_text("main"))
  return {
    ready = submit_button ~= nil and dom.exists(M.REQUEST_FLOW_ACTIVE_SELECTOR),
    url = url,
    service_id = service_id,
    project_pk = M.url_query_param(url, "project_pk"),
    lp_request_pk = M.url_query_param(url, "lp_request_pk"),
    keyword_pk = M.url_query_param(url, "keyword_pk"),
    category_pk = M.url_query_param(url, "category_pk"),
    user_query_pk = M.url_query_param(url, "user_query_pk"),
    zip_code = M.url_query_param(url, "zip_code"),
    submit_button = submit_button,
    request_error = request_error,
    pro = {
      name = M.non_empty(dom.get_text("h1")),
      url = url,
      price_text = M.parse_price_text(aside_text or ""),
      summary = M.truncate_text(aside_text or main_text or "", 500)
    },
    quote = {
      form = form,
      contact = M.read_quote_contact(form.fields or {}),
      request_error = request_error,
      disclaimer = M.truncate_text(form.text or "", 1200)
    }
  }
end

function M.read_quote_submit_result(before_url)
  local url = M.current_url()
  local body_text = M.non_empty(dom.get_text("body"))
  local form = M.read_project_form()
  local request_error = M.read_request_flow_error()
  local submit_button = M.read_submit_button_label(form)
  return {
    url = url,
    url_changed = before_url ~= nil and before_url ~= url,
    active_flow = dom.exists(M.REQUEST_FLOW_ACTIVE_SELECTOR),
    submit_button = submit_button,
    request_error = request_error,
    form = form,
    page_text = M.truncate_text(body_text or "", 2000)
  }
end

function M.request_flow_auto_text_value(args)
  if not dom.exists(M.REQUEST_FLOW_ACTIVE_SELECTOR .. ' textarea') then
    return nil
  end
  return M.non_empty(args.user_requirements)
    or M.non_empty(args.requirements)
    or M.non_empty(args.requestText)
    or M.non_empty(args.description)
    or M.non_empty(args.details)
    or M.non_empty(args.message)
    or "Please provide a standard estimate."
end

function M.request_flow_options()
  return dom.query_all(
    M.REQUEST_FLOW_ACTIVE_SELECTOR .. ' label:has(input[type="radio"]), '
      .. M.REQUEST_FLOW_ACTIVE_SELECTOR .. ' label:has(input[type="checkbox"])',
    {
      text = true,
      control = { selector = "input", attr = "type" },
      group = { selector = "input", attr = "name" },
      id = { selector = "input", attr = "id" },
      checked = { selector = "input", attr = "checked" }
    },
    160
  )
end

function M.select_request_flow_option(value)
  local target = M.normalize_text(value or "")
  if target == "" then
    return { ok = false, reason = "missing_value" }
  end
  local options = M.request_flow_options()
  local counts = {}
  for index = 1, #options do
    local option = options[index]
    local group = option.group or ""
    counts[group] = (counts[group] or 0) + 1
    if M.normalize_text(option.text or "") == target then
      if option.checked == true then
        return { ok = true, reason = "already_selected", type = option.control }
      end
      local id = M.non_empty(option.id)
      local selector = nil
      if id then
        selector = M.REQUEST_FLOW_ACTIVE_SELECTOR .. ' label:has(input[id="' .. M.css_attr_string(id) .. '"])'
      elseif option.group then
        selector = M.REQUEST_FLOW_ACTIVE_SELECTOR
          .. ' div:has(> div > div > label > input[name="' .. M.css_attr_string(option.group)
          .. '"]) > div:nth-child(' .. counts[group] .. ') label'
      end
      if not selector then
        return { ok = false, reason = "option_missing_selector", type = option.control }
      end
      local ok = dom.click(selector, { navigates = false }) == true
      return {
        ok = ok,
        reason = ok and "selected" or "click_failed",
        type = option.control
      }
    end
  end
  return { ok = false, reason = "option_not_found" }
end

function M.request_flow_has_text_value()
  local rows = dom.query_all(M.REQUEST_FLOW_ACTIVE_SELECTOR .. ' textarea', {
    value = { attr = "value" },
    text = true
  }, 20)
  for index = 1, #rows do
    if M.non_empty(rows[index].value) or M.non_empty(rows[index].text) then
      return true
    end
  end
  return false
end

function M.request_flow_arg_value(args, keys)
  local contact = type(args.contact) == "table" and args.contact or {}
  for index = 1, #keys do
    local key = keys[index]
    local value = M.non_empty(args[key])
    if value then
      return value
    end
    value = M.non_empty(contact[key])
    if value then
      return value
    end
  end
  return nil
end

function M.set_request_flow_value(name, value, selectors, applied)
  if not value then
    return nil
  end
  for index = 1, #selectors do
    local selector = M.REQUEST_FLOW_ACTIVE_SELECTOR .. " " .. selectors[index]
    if dom.exists(selector) then
      local ok = dom.set_value(selector, value) == true
      applied[#applied + 1] = {
        kind = "flow_contact",
        name = name,
        value = value,
        ok = ok,
        reason = ok and "updated" or "update_failed"
      }
      return ok
    end
  end
  return nil
end

function M.note_request_flow_set(result, state)
  if result ~= nil then
    state.attempted = true
    if result == true then
      state.supplied = true
    end
  end
end

function M.apply_request_flow_contact_values(args, applied)
  local state = { supplied = false, attempted = false }

  local email = M.request_flow_arg_value(args, { "email" })
  if email then
    M.note_request_flow_set(M.set_request_flow_value("email", email, {
      'input[type="email"]',
      'input[autocomplete="email"]',
      'input[placeholder="Email"]',
      'input[placeholder="Email address"]'
    }, applied), state)
  end

  local first_name = M.request_flow_arg_value(args, { "first_name", "firstName", "given_name", "givenName" })
  if first_name then
    M.note_request_flow_set(M.set_request_flow_value("first_name", first_name, {
      'input[autocomplete="given-name"]',
      'input[placeholder="First name"]',
      'input[aria-label="First name"]'
    }, applied), state)
  end

  local last_name = M.request_flow_arg_value(args, { "last_name", "lastName", "family_name", "familyName" })
  if last_name then
    M.note_request_flow_set(M.set_request_flow_value("last_name", last_name, {
      'input[autocomplete="family-name"]',
      'input[placeholder="Last name"]',
      'input[aria-label="Last name"]'
    }, applied), state)
  end

  local phone = M.request_flow_arg_value(args, { "phone", "phone_number", "phoneNumber", "tel" })
  if phone then
    M.note_request_flow_set(M.set_request_flow_value("phone", phone, {
      'input[type="tel"]',
      'input[autocomplete="tel"]',
      'input[placeholder="(555) 555-5555"]',
      'input[aria-label="Phone number"]'
    }, applied), state)
  end

  local zip_code = M.request_flow_arg_value(args, { "zip_code", "zip", "postal_code", "postalCode" })
  if zip_code then
    M.note_request_flow_set(M.set_request_flow_value("zip_code", zip_code, {
      'input[autocomplete="postal-code"]',
      'input[placeholder="Zip code"]',
      'input[aria-label="Zip code"]'
    }, applied), state)
  end

  return state
end

function M.request_flow_control_count()
  local count = 0
  local choices = dom.query_all(
    M.REQUEST_FLOW_ACTIVE_SELECTOR .. ' label:has(input[type="radio"]), '
      .. M.REQUEST_FLOW_ACTIVE_SELECTOR .. ' label:has(input[type="checkbox"])',
    { text = true },
    160
  )
  for index = 1, #choices do
    if M.non_empty(choices[index].text) then
      count = count + 1
    end
  end

  local controls = dom.query_all(
    M.REQUEST_FLOW_ACTIVE_SELECTOR .. ' textarea, '
      .. M.REQUEST_FLOW_ACTIVE_SELECTOR .. ' select, '
      .. M.REQUEST_FLOW_ACTIVE_SELECTOR .. ' input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]):not([type="file"])',
    {
      tag = { attr = "tagName" },
      type = { attr = "type" },
      placeholder = { attr = "placeholder" },
      aria = { attr = "aria-label" },
      autocomplete = { attr = "autocomplete" }
    },
    160
  )
  for index = 1, #controls do
    local control = controls[index]
    local tag = M.normalize_text(control.tag or "")
    local control_type = M.normalize_text(control.type or "")
    local placeholder = M.non_empty(control.placeholder)
    local aria = M.non_empty(control.aria)
    local autocomplete = M.non_empty(control.autocomplete)
    if tag == "textarea"
      or tag == "select"
      or placeholder
      or aria
      or autocomplete
      or control_type == "email"
      or control_type == "tel"
      or control_type == "text"
      or control_type == "date"
      or control_type == "number" then
      count = count + 1
    end
  end
  return count
end

function M.request_flow_extra_control_count()
  local controls = dom.query_all(
    M.REQUEST_FLOW_ACTIVE_SELECTOR .. ' textarea, '
      .. M.REQUEST_FLOW_ACTIVE_SELECTOR .. ' select, '
      .. M.REQUEST_FLOW_ACTIVE_SELECTOR .. ' input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]):not([type="file"])',
    { tag = { attr = "tagName" } },
    40
  )
  return #controls
end

-- Thumbtack DOM ops for the generic AX_WIZARD step driver. All request-flow selectors live here;
-- the step control flow + decisions live in AX_WIZARD (shared, site-agnostic).
function M.tt_wizard_ctx()
  local active = M.REQUEST_FLOW_ACTIVE_SELECTOR
  return {
    active_exists = function() return dom.exists(active) end,
    read_error = function() return M.read_request_flow_error() end,
    current_text = function() return M.non_empty(dom.get_text(active)) end,
    read_options = function() return M.request_flow_options() end,
    select_option = function(value) return M.select_request_flow_option(value) end,
    auto_text_value = function(args) return M.request_flow_auto_text_value(args) end,
    set_text = function(value) return dom.set_value(active .. ' textarea', value) == true end,
    apply_contact = function(args, applied) return M.apply_request_flow_contact_values(args, applied) end,
    has_text = function() return M.request_flow_has_text_value() end,
    control_count = function() return M.request_flow_control_count() end,
    extra_control_count = function() return M.request_flow_extra_control_count() end,
    read_buttons = function()
      return dom.query_all(active .. ' button', {
        text = true,
        aria = { attr = "aria-label" },
        title = { attr = "title" }
      }, 20)
    end,
    advance_click = function(decision)
      local selector
      if decision.kind == "skip" then
        selector = active .. ' button:not([aria-label]):not([title])'
      else
        selector = active .. ' button:not([aria-label])'
      end
      return dom.click(selector, { navigates = false }) == true
    end,
    wait = function(ms) dom.wait(ms) end
  }
end

-- Delegates a single Thumbtack request-flow step to the generic form-wizard engine.
function M.update_request_flow_step(args, applied, prior_updates)
  return AX_WIZARD.drive_step(M.tt_wizard_ctx(), args, applied, prior_updates)
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
  -- The pro page's quote/estimate CTA carries no semantic id, so locate it by document structure:
  -- the sticky <aside> sidebar holds "View details" (its parent's :last-child) followed by the
  -- primary "Request estimate" button. NEVER target hashed CSS-module class names; the dom
  -- capability is CSS-only, so confirm the visible label via query_all before clicking.
  local selectors = {
    'aside button:not(:last-child)',
    'aside button',
    'main button:not(:last-child)'
  }
  for index = 1, #selectors do
    local selector = selectors[index]
    local rows = dom.query_all(selector, { text = true }, 1)
    if #rows > 0 then
      local text = M.normalize_text(rows[1].text)
      if text:find("request estimate", 1, true)
        or text:find("request a quote", 1, true)
        or text:find("get a quote", 1, true) then
        return dom.click(selector, { navigates = false })
      end
    end
  end
  return false
end
