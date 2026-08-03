--- Thumbtack's quote request, driven from the runtime.
---
--- The dialog is a same-context SPA overlay — pushState, no reload — and yet under the durable design
--- every step was its own call, so the flow re-entered `answer_quote` up to sixteen times to walk one
--- form. Nothing suspends here, so the whole wizard is a loop in a single call.
---
--- Two things must survive that collapse.
---
--- The CTA is POLLED. The aside sidebar hydrates after nav readiness, so one scan raced it: a quotable
--- pro was reported `quote_unavailable` and silently skipped.
---
--- The final Submit is NOT clicked. Reaching it is the answer this script gives; sending it belongs to
--- `submit_quote`, behind an explicit confirmation, because the click contacts a real person.

AX_RPC_QUOTE = AX_RPC_QUOTE or {}
local Q = AX_RPC_QUOTE
local B = AX_BASE

-- The shared wizard core accumulates its picks with `ax.array()`, which the DURABLE capability set
-- provides and the runtime does NOT. Live, the dialog opened and the very next step raised "attempt to
-- index a nil value (global 'ax')" — the unit suite had helpfully defined it. In the runtime the array
-- marker means nothing anyway: these lists never cross to JSON, they are read back by the wizard itself.
if ax == nil then
  ax = { array = function() return {} end }
end
local W = AX_WIZARD

Q.ACTIVE = '[data-test="request-flow-step--active"]'
Q.DIALOG = '[aria-label="Request Flow Dialog"]'
Q.ERROR = '#request-flow-error'
Q.PRO_READY = 'aside button, main button'
-- Ordered structural candidates. Each is VERIFIED by reading its own visible label before it is clicked,
-- so the list can be wide without ever pressing the wrong button. The survey that produced it: the CTA is
-- the last of four buttons in the aside, its parent is `<div class="">`, and it carries no id,
-- aria-label or data-test — only build hashes, which AGENTS.md §10 forbids.
Q.CTA_SELECTORS = {
  'aside div[class=""] > button',
  'aside button:last-of-type',
  'aside button:not(:last-child)',
  'aside button',
  'main button:last-of-type',
  'main button:not(:last-child)',
  'main button',
}
Q.CTA_PHRASES = { "request estimate", "request a quote", "request quote", "get a quote", "get estimate" }
-- The durable node capped its self-loop at 16 steps. The cap is the same; what changed is that a step
-- which stops advancing ends the loop instead of consuming the rest of it.
Q.MAX_STEPS = 16
Q.MAX_STALLED = 2

local function trim(value)
  return B.non_empty(value)
end

--- There is no wait op: the runtime's vocabulary is reads and writes. Pacing is therefore a bounded
--- series of real round trips, which is what the durable `dom.wait` cost anyway. Naming it `pace` keeps
--- it from being read as a timer it is not.
local function pace(ms)
  -- Capped at two round trips. At roughly a second each, a "300ms settle" spelled as three reads was
  -- three seconds of the tool's deadline, several times per step.
  for _ = 1, math.min(2, math.max(1, math.floor((ms or 200) / 100))) do
    -- This read exists for its round trip, not its answer, so a refusal is nothing to report.
    pcall(dom.exists, Q.ACTIVE)
  end
end

--- Runs a read that may be refused while the channel is re-attaching. Measured live: the navigation
--- landed on the pro, the first `dom.query_all` answered `rpc_timeout`, the error propagated out of the
--- tool, and the pro was reported as "stopped before submit" — a transport hiccup dressed up as a fact
--- about the page. A refusal is retried; only a persistent one is an answer, and it is `nil`, never a
--- fabricated empty result.
local function probe(fn, attempts)
  local last
  for attempt = 1, (attempts or 4) do
    local ok, value = pcall(fn)
    if ok then return value end
    last = value
    if attempt < (attempts or 4) then pace(200) end
  end
  return nil, last
end
Q.probe = probe

--- EVERY dom access in this module goes through these. Two live runs died on a raised op — first
--- `dom.query_all` right after the navigation, then `dom.exists` inside the contact fill — and wrapping
--- whichever one failed is whack-a-mole: ANY op can be refused while the channel re-attaches. A refusal
--- that survives a retry answers `nil`/`false`, which every caller already treats as "not there".
local function exists(selector) return probe(function() return dom.exists(selector) end, 2) == true end
local function text_of(selector) return probe(function() return dom.get_text(selector) end, 2) end
local function rows_of(selector, fields, limit)
  return probe(function() return dom.query_all(selector, fields, limit) end, 2) or {}
end
local function click(selector) return probe(function() return dom.click(selector) end, 2) == true end
local function set_value(selector, value)
  return probe(function() return dom.set_value(selector, value) end, 2) == true
end
local function wait_for(selector, timeout)
  return probe(function()
    return dom.wait_for_selector(selector, { timeout = timeout or 6000, interval = 200 })
  end, 2) == true
end

function Q.service_id_from(url)
  return tostring(url or ""):match("/service/(%d+)")
end

--- Where we are, from the URL plus one cheap DOM read — the part of `detect_page` this path needs.
--- A refused href read is not a wrong landing: answering `false` for it reported the pro page as somewhere
--- else entirely, and the quote was abandoned before it began.
function Q.on_pro(service_id)
  local href = probe(function() return dom.get_location_href() end, 3)
  if href == nil then return nil, nil end
  local here = Q.service_id_from(href)
  if not here then return false, href end
  if service_id and here ~= service_id then return false, href end
  return true, href
end

--- Thumbtack's own validation text, and what it wants changed. The site names the bad value, so the
--- message is quoted rather than paraphrased.
function Q.read_error()
  if not exists(Q.ERROR) then return nil end
  local text = trim(text_of(Q.ERROR))
  if not text then return nil end
  text = trim((text:gsub("%s*Close alert%s*$", ""))) or text
  local normalized = text:lower()
  local email = text:match('email address%s+"([^"]+)"') or text:match("([%w%.%+_%-]+@[%w%.%-]+%.%a%a+)")
  local field, code = nil, "request_flow_error"
  if email or normalized:find("email", 1, true) then
    field = "email"
    if normalized:find("disabled", 1, true) then code = "email_account_disabled"
    elseif normalized:find("invalid", 1, true) then code = "invalid_email"
    else code = "email_error" end
  end
  return { error = code, message = text, retry_field = field, bad_value = email }
end

function Q.options()
  return rows_of(
    Q.ACTIVE .. ' label:has(input[type="radio"]), ' .. Q.ACTIVE .. ' label:has(input[type="checkbox"])',
    {
      text = true,
      control = { selector = "input", attr = "type" },
      group = { selector = "input", attr = "name" },
      id = { selector = "input", attr = "id" },
      checked = { selector = "input", attr = "checked" },
    },
    160
  )
end

--- Selects an option and CONFIRMS it took.
---
--- CSS is the only way to reach an option — the capability has no text matching — so the input's own id
--- builds the selector, and its position within the input-name group is the fallback. Surveyed live: the
--- radios do carry ids, so the label selector resolves; the form still refused to advance and re-rendered
--- the same question twice. A bare click can fire without checking anything, which is exactly why the
--- durable code used `click_verified`. So: click the label, re-read, and if it did not take, click the
--- input itself. Reporting `ok` for a click the site ignored made the wizard answer a step it had not.
function Q.select_option(value, rows)
  local target = tostring(value or ""):lower():gsub("%s+", " ")
  if target == "" then return { ok = false, reason = "missing_value" } end
  local options = rows or Q.options()
  local counts = {}
  for index = 1, #options do
    local option = options[index]
    local group = option.group or ""
    counts[group] = (counts[group] or 0) + 1
    if tostring(option.text or ""):lower():gsub("%s+", " ") == target then
      if option.checked == true then return { ok = true, reason = "already_selected", type = option.control } end
      local id = trim(option.id)
      local selector
      if id then
        selector = Q.ACTIVE .. ' label:has(input[id="' .. id .. '"])'
      elseif option.group then
        selector = Q.ACTIVE .. ' div:has(> div > div > label > input[name="' .. option.group
          .. '"]) > div:nth-child(' .. counts[group] .. ') label'
      else
        return { ok = false, reason = "option_missing_selector", type = option.control }
      end
      local clicked = click(selector)
      if id then
        if Q.option_checked(id) then
          return { ok = true, reason = "selected", type = option.control }
        end
        -- The label was clickable and the site ignored it. The input is the control.
        click(Q.ACTIVE .. ' input[id="' .. id .. '"]')
        if Q.option_checked(id) then
          return { ok = true, reason = "selected_input", type = option.control }
        end
        return { ok = false, reason = "select_not_confirmed", type = option.control }
      end
      return { ok = clicked, reason = clicked and "selected" or "click_failed", type = option.control }
    end
  end
  return { ok = false, reason = "option_not_found" }
end

--- Whether the option with this input id is checked NOW. One read, because a click that reports success is
--- not the same as a site that accepted it.
function Q.option_checked(id)
  local rows = rows_of(Q.ACTIVE .. ' input[id="' .. id .. '"]', { checked = { attr = "checked" } }, 1)
  return #rows > 0 and rows[1].checked == true
end

local CONTACT_FIELDS = {
  { name = "email", keys = { "email", "submit_email" },
    selectors = { 'input[type="email"]', 'input[autocomplete="email"]', 'input[placeholder="Email"]', 'input[placeholder="Email address"]' } },
  { name = "first_name", keys = { "first_name", "firstName", "submit_first_name" },
    selectors = { 'input[autocomplete="given-name"]', 'input[placeholder="First name"]', 'input[aria-label="First name"]' } },
  { name = "last_name", keys = { "last_name", "lastName", "submit_last_name" },
    selectors = { 'input[autocomplete="family-name"]', 'input[placeholder="Last name"]', 'input[aria-label="Last name"]' } },
  { name = "phone", keys = { "phone", "phone_number", "submit_phone", "tel" },
    selectors = { 'input[type="tel"]', 'input[autocomplete="tel"]', 'input[aria-label="Phone number"]' } },
  { name = "zip_code", keys = { "zip_code", "zip", "postal_code", "submit_zip_code" },
    selectors = { 'input[autocomplete="postal-code"]', 'input[placeholder="Zip code"]', 'input[aria-label="Zip code"]' } },
}

local function arg_value(args, keys)
  local contact = type(args.contact) == "table" and args.contact or {}
  for index = 1, #keys do
    local value = trim(args[keys[index]]) or trim(contact[keys[index]])
    if value then return value end
  end
  return nil
end

--- Fills whichever contact controls the step is actually showing.
---
--- ONE read of the step's inputs decides everything. The first version probed each field's candidate
--- selectors with an `exists`, then a `set_value` — ten round trips on a step that asks for no contact
--- details at all — and a three-step form died live with `deadline exceeded`. The rows carry the very
--- attributes the selectors were guessing at, so the guess is unnecessary.
---
--- A field the step does not ask for is not a failure: the wizard reads `attempted`/`supplied`, so
--- claiming either one falsely decides the step wrongly.
function Q.apply_contact(args, applied, prefetched)
  local state = { supplied = false, attempted = false }
  local rows = prefetched or Q.free_controls()
  if #rows == 0 then return state end
  for index = 1, #CONTACT_FIELDS do
    local field = CONTACT_FIELDS[index]
    local value = arg_value(args, field.keys)
    if value then
      -- Match the row by the attribute the field is keyed on, then address it by that same attribute.
      local selector = nil
      for r = 1, #rows do
        local row = rows[r]
        local kind = tostring(row.type or ""):lower()
        local auto = trim(row.autocomplete)
        local place = trim(row.placeholder)
        local aria = trim(row.aria)
        for s = 1, #field.selectors do
          local candidate = field.selectors[s]
          local wanted = candidate:match('%[type="([^"]+)"%]')
          if wanted and kind == wanted then selector = Q.ACTIVE .. ' input[type="' .. wanted .. '"]' end
          wanted = candidate:match('%[autocomplete="([^"]+)"%]')
          if wanted and auto == wanted then selector = Q.ACTIVE .. ' input[autocomplete="' .. wanted .. '"]' end
          wanted = candidate:match('%[placeholder="([^"]+)"%]')
          if wanted and place == wanted then selector = Q.ACTIVE .. ' input[placeholder="' .. wanted .. '"]' end
          wanted = candidate:match('%[aria%-label="([^"]+)"%]')
          if wanted and aria == wanted then selector = Q.ACTIVE .. ' input[aria-label="' .. wanted .. '"]' end
          if selector then break end
        end
        if selector then break end
      end
      if selector then
        local ok = set_value(selector, value)
        state.attempted = true
        if ok then state.supplied = true end
        applied[#applied + 1] = { kind = "flow_contact", name = field.name, ok = ok }
      end
    end
  end
  return state
end

function Q.control_count(prefetched_options, prefetched_controls)
  local count = 0
  local choices = prefetched_options or Q.options()
  for index = 1, #choices do
    if trim(choices[index].text) then count = count + 1 end
  end
  local controls = prefetched_controls or Q.free_controls()
  for index = 1, #controls do
    local control = controls[index]
    local tag = tostring(control.tag or ""):lower()
    local kind = tostring(control.type or ""):lower()
    if tag == "textarea" or tag == "select" or trim(control.placeholder) or trim(control.aria)
      or trim(control.autocomplete) or kind == "email" or kind == "tel" or kind == "text"
      or kind == "date" or kind == "number" then
      count = count + 1
    end
  end
  return count
end

function Q.free_controls()
  return rows_of(
    Q.ACTIVE .. ' textarea, ' .. Q.ACTIVE .. ' select, '
      .. Q.ACTIVE .. ' input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]):not([type="file"])',
    { tag = { attr = "tagName" }, type = { attr = "type" }, placeholder = { attr = "placeholder" },
      aria = { attr = "aria-label" }, autocomplete = { attr = "autocomplete" } },
    160
  )
end

function Q.has_text()
  local rows = rows_of(Q.ACTIVE .. ' textarea', { value = { attr = "value" }, text = true }, 20)
  for index = 1, #rows do
    if trim(rows[index].value) or trim(rows[index].text) then return true end
  end
  return false
end

--- The DOM glue the shared wizard core needs. Every decision stays in `AX_WIZARD`; this table is only how
--- Thumbtack's dialog is read and touched.
---
--- Reads are memoized for the duration of ONE step and dropped the moment anything is written, because
--- the wizard asks for the same option list and the same control set three or four times per pass. At a
--- second per round trip that repetition was the difference between finishing a form and hitting the
--- tool's deadline. The cache cannot go stale: a fresh ctx is built for every step, and every write
--- invalidates it.
function Q.ctx()
  local cache = {}
  local function invalidate() cache.options, cache.controls = nil, nil end
  local function options()
    if cache.options == nil then cache.options = Q.options() end
    return cache.options
  end
  local function controls()
    if cache.controls == nil then cache.controls = Q.free_controls() end
    return cache.controls
  end
  return {
    active_exists = function() return exists(Q.ACTIVE) end,
    read_error = function() return Q.read_error() end,
    current_text = function() return trim(text_of(Q.ACTIVE)) end,
    read_options = options,
    select_option = function(value)
      -- Read the list FIRST, then drop the cache: invalidating before the read just re-fetched it.
      local rows = options()
      local result = Q.select_option(value, rows)
      invalidate()
      return result
    end,
    auto_text_value = function(args)
      if not exists(Q.ACTIVE .. ' textarea') then return nil end
      return trim(args.user_requirements) or trim(args.requirements) or trim(args.requestText)
        or trim(args.description) or "Please provide a standard estimate."
    end,
    set_text = function(value)
      invalidate()
      return set_value(Q.ACTIVE .. ' textarea', value)
    end,
    apply_contact = function(args, applied)
      local state = Q.apply_contact(args, applied, controls())
      if state.attempted then invalidate() end
      return state
    end,
    has_text = function() return Q.has_text() end,
    control_count = function() return Q.control_count(options(), controls()) end,
    extra_control_count = function() return #controls() end,
    read_buttons = function()
      return rows_of(Q.ACTIVE .. ' button',
        { text = true, aria = { attr = "aria-label" }, title = { attr = "title" } }, 20)
    end,
    advance_click = function(decision)
      local selector = Q.ACTIVE .. ' button:not([aria-label])'
      if decision.kind == "skip" then selector = selector .. ':not([title])' end
      return click(selector) == true
    end,
    wait = pace,
  }
end

--- Thumbtack's sentence when a pro cannot take the job. Quoted, never paraphrased: it is the only thing
--- that tells the user this pro was never an option, and it names what to do next.
Q.REFUSAL_PHRASES = { "can't do your job", "cannot do your job", "can’t do your job" }

function Q.pro_refusal()
  local body = text_of("body")
  local text = trim(body)
  if not text then return nil end
  local lower = text:lower()
  for index = 1, #Q.REFUSAL_PHRASES do
    local at = lower:find(Q.REFUSAL_PHRASES[index], 1, true)
    if at then
      -- A fixed window around the phrase dragged in whatever the page rendered next. `dom.get_text` is
      -- textContent, so adjacent blocks arrive with no separator at all — the cut has to be the
      -- sentence's own: the site opens it with "Sorry" and closes it with a period.
      local start = 1
      local search = 1
      while true do
        local found = lower:find("sorry", search, true)
        if not found or found > at then break end
        start = found
        search = found + 1
      end
      local stop = text:find(".", at, true) or #text
      return trim(text:sub(start, stop))
    end
  end
  return nil
end

--- A CSS selector that isolates ONE button, built from whatever stable handle it carries. The capability
--- has no text matching, so a label found by reading cannot be clicked by that label — and reading the
--- FIRST match of a candidate selector clicks whatever happens to lead the sidebar. Measured live: the
--- buttons were `5.0(1) | Share | View details | Select date | Select answer(s) | Request estimate |
--- Read more | Message`, so the first-match scan clicked a rating and reported the CTA missing.
--- Hashed class names are never used (AGENTS.md §10) — only id, aria-label, data-test.
function Q.handle_selector(row)
  local id = trim(row.id)
  if id and not id:find('"', 1, true) then return '[id="' .. id .. '"]' end
  local aria = trim(row.aria)
  if aria and not aria:find('"', 1, true) then return '[aria-label="' .. aria .. '"]' end
  local test = trim(row.testid)
  if test and not test:find('"', 1, true) then return '[data-test="' .. test .. '"]' end
  return nil
end

function Q.is_cta(text)
  local label = tostring(text or ""):lower()
  for phrase = 1, #Q.CTA_PHRASES do
    if label:find(Q.CTA_PHRASES[phrase], 1, true) then return true end
  end
  return false
end

--- Clicks the quote CTA in the PAGE world, by its visible text.
---
--- Surveyed live: the button carries no id, no aria-label and no data-test, and its only classes are
--- build hashes — which AGENTS.md §10 forbids precisely because they change every deploy. It is the last
--- of four buttons in the aside, under a `<div class="">`, so no structural selector isolates it either.
--- The `dom` capability resolves standard CSS and cannot match text, so this is the one thing left: ask
--- the page. Returns the label it clicked, or nil.
function Q.click_by_text()
  local quoted = {}
  for index = 1, #Q.CTA_PHRASES do quoted[index] = '"' .. Q.CTA_PHRASES[index] .. '"' end
  local script = "(function(){var p=[" .. table.concat(quoted, ",") .. "];"
    .. "var b=document.querySelectorAll('aside button, main button');"
    .. "for(var i=0;i<b.length;i++){var t=(b[i].textContent||'').toLowerCase();"
    .. "for(var j=0;j<p.length;j++){if(t.indexOf(p[j])>=0){b[i].click();"
    .. "return (b[i].textContent||'').trim().slice(0,60);}}}return null;})()"
  local ok, value = pcall(page.eval, script)
  -- A refused or failing op is a fact about our own reach, not about the page. Swallowing it left the
  -- refusal saying only "unreachable", which is exactly the sentence that needed explaining.
  if not ok then return nil, tostring(value) end
  return trim(value), nil
end

--- Opens the request-flow dialog, polling for the CTA and confirming a step actually mounted. Detection
--- keys on the ACTIVE step, never the modal container: the page pre-renders empty placeholders that look
--- open. Returns `ok, seen` — the labels it read, so a refusal can say what the page offered instead of
--- only that it found nothing.
function Q.open_dialog()
  -- Every op is a wire round trip measured at roughly a second on a live page, against a 120s deadline.
  -- So the scan reads the whole button set ONCE per attempt. Retrying each read on top of a poll that
  -- already retries is what pushed a changed page into `deadline exceeded` — the poll IS the retry.
  local function try(fn)
    local ok, value = pcall(fn)
    if ok then return value end
    return nil
  end
  local function active() return exists(Q.ACTIVE) end
  if active() then return true, nil end
  wait_for(Q.PRO_READY)

  local seen, order = {}, {}
  local function note(text)
    if text and not seen[text] then
      seen[text] = true
      order[#order + 1] = text:sub(1, 60)
    end
  end

  -- Reports whether the click landed on something, so "clicked and nothing opened" stays distinct from
  -- "nothing was clickable".
  local clicked_any = false
  local function open_with(selector)
    if click(selector) then clicked_any = true end
    return wait_for(Q.ACTIVE)
  end

  -- Three outcomes, because they call for different work: no CTA at all, a CTA nothing can reach, or a
  -- CTA that was clicked and opened nothing. Collapsing them into one string meant every live refusal
  -- needed a manual survey of the page to tell which had happened. The verdict is reached only after the
  -- attempts are spent — deciding on the first pass removed the wait the sidebar's hydration needs.
  local label, handles, eval_note = nil, nil, nil
  for attempt = 1, 8 do
    if attempt > 1 then pace(200) end
    if exists(Q.ACTIVE) then return true, nil end
    local rows = try(function()
      return rows_of(Q.PRO_READY, {
        text = true,
        id = { attr = "id" },
        aria = { attr = "aria-label" },
        testid = { attr = "data-test" },
      }, 16)
    end) or {}
    local candidate = nil
    for index = 1, #rows do
      local text = trim(rows[index].text)
      note(text)
      if text and not candidate and Q.is_cta(text) then candidate = rows[index] end
    end
    if candidate then
      label = trim(candidate.text)
      handles = table.concat({ trim(candidate.id) or "-", trim(candidate.aria) or "-", trim(candidate.testid) or "-" }, "/")
      local handle = Q.handle_selector(candidate)
      if handle and open_with(handle) then return true, nil end
      -- No handle: fall back to the positional candidates, which work when the CTA does lead its region.
      for index = 1, #Q.CTA_SELECTORS do
        local selector = Q.CTA_SELECTORS[index]
        local one = rows_of(selector, { text = true }, 1)
        local text = one and #one > 0 and trim(one[1].text) or nil
        if text and Q.is_cta(text) and open_with(selector) then return true, nil end
      end
      -- Nothing CSS can name reached it. Ask the page.
      local hit, why = Q.click_by_text()
      eval_note = hit and ("clicked " .. hit) or (why or "no match")
      if hit then
        clicked_any = true
        if wait_for(Q.ACTIVE) then
          return true, nil
        end
      end
    end
  end
  if not label then return false, order end
  return false, order, {
    code = clicked_any and "quote_dialog_did_not_open" or "quote_cta_unreachable",
    label = label,
    handles = handles,
    eval = eval_note,
  }
end

--- Navigates to the pro when needed, opens the dialog, and drives every step it can answer. Returns the
--- state fields the quote loop reports on — `pick_quote` builds its outcome line from these names, so
--- they are the durable ones.
function Q.request_quote(args)
  args = type(args) == "table" and args or {}
  -- `auto: true` lived in the durable tool's `input:` block, and a runtime lua tool never sees that
  -- block — the same mapping trap that made the search answer `query_required`. Without it the wizard
  -- scores nothing, every step reports `missing_answer`, and the form is handed over on step one.
  -- This script IS the auto driver, so it says so itself; `auto = false` still turns it off.
  local drive = { auto = args.auto ~= false }
  for key, value in pairs(args) do
    if key ~= "auto" then drive[key] = value end
  end
  local url = trim(args.quote_url) or trim(args.url)
  local service_id = trim(args.quote_target_service_id) or trim(args.service_id) or (url and Q.service_id_from(url))

  if Q.on_pro(service_id) ~= true then
    if not url then
      return { next = "error", quote_error = "missing_url", quote_status = "no_target" }
    end
    local from = probe(function() return dom.get_location_href() end, 3)
    probe(function() return nav.navigate(url) end, 2)
    probe(function() return nav.wait_for_navigation(from, { timeout = 12000, interval = 250 }) end, 2)
    -- `nil` means the reads themselves were refused; only a definite `false` is a wrong landing. Calling
    -- an unanswered question a wrong landing abandoned the pro before the quote began.
    local landed = Q.on_pro(service_id)
    if landed == false then
      return { next = "error", quote_error = "wrong_landing", quote_status = "not_on_pro" }
    end
  end

  local opened, seen, blocked = Q.open_dialog()
  if not opened then
    -- Thumbtack renders no CTA when the pro cannot serve the job, and it says so in a sentence. Measured
    -- live: reporting that as "FAILED to open/answer" hid the site's reason and invited a retry that
    -- could never work.
    local refusal = Q.pro_refusal()
    if refusal then
      return { next = "error", quote_error = "pro_unavailable", quote_status = "pro_declined",
               quote_message = refusal }
    end
    if blocked then
      return { next = "error", quote_error = blocked.code, quote_status = blocked.code,
               quote_message = 'CTA "' .. tostring(blocked.label) .. '" (id/aria/data-test: '
                 .. tostring(blocked.handles) .. '; page.eval: ' .. tostring(blocked.eval or '-') .. ')' }
    end
    -- Otherwise the page offered SOMETHING; naming it is the difference between "the CTA is gone" and
    -- "the CTA moved". Live, the sidebar had become an inline mini-form and this was the only way to see
    -- that without a manual survey.
    return { next = "error", quote_error = "quote_unavailable", quote_status = "no_quote_cta",
             quote_message = (seen and #seen > 0) and ("The page offered: " .. table.concat(seen, " | ")) or nil }
  end

  -- The dialog frame mounts before its form does. Surveyed live: the step read "How much help do you
  -- need?" with a single `Next` (type=submit), yet the wizard saw no buttons at all and called it
  -- `advance_button_not_found` — it had been asked one poll too early.
  wait_for(Q.ACTIVE .. ' button', 8000)

  local applied = {}
  local steps, stalled, flow = 0, 0, nil
  while steps < Q.MAX_STEPS do
    local before = #applied
    flow = W.drive_step(Q.ctx(), drive, applied, before)
    if not flow then break end
    steps = steps + 1

    if flow.request_error then
      return { next = "error", quote_error = flow.request_error.error, quote_status = "request_flow_error",
               quote_message = flow.request_error.message, quote_retry_field = flow.request_error.retry_field,
               quote_steps = steps }
    end
    -- Reaching the submit step is the goal. `missing_answer` hands off too, because a required step this
    -- cannot answer will not answer itself on a retry. `advance_button_not_found` does NOT: that is
    -- structural or early, and treating it as arrival reported an untouched form as ready to send.
    if flow.reached_submit_step or flow.advance_reason == "missing_answer" then
      return { next = "submit", quote_status = "at_submit_step", quote_reached_submit = flow.reached_submit_step == true,
               quote_advance_reason = flow.advance_reason, quote_steps = steps }
    end
    if flow.advanced then
      stalled = 0
    else
      stalled = stalled + 1
      if stalled >= Q.MAX_STALLED then
        return { next = "error", quote_error = "quote_stalled", quote_status = "stalled",
                 quote_advance_reason = flow.advance_reason, quote_steps = steps }
      end
    end
  end

  return { next = "error", quote_error = "quote_steps_exhausted", quote_status = "exhausted",
           quote_advance_reason = flow and flow.advance_reason or nil, quote_steps = steps }
end

--- Sends the request. Separate from driving the form on purpose: this click contacts a real person, so it
--- runs only with an explicit `confirm`, and the flow can stop at the node boundary.
function Q.submit_quote(args)
  args = type(args) == "table" and args or {}
  if args.confirm ~= true then
    return { next = "done", quote_submit_status = "confirmation_required",
             quote_submit_message = "A quote is only sent with an explicit confirmation." }
  end
  if not exists(Q.ACTIVE) then
    return { next = "done", quote_submit_status = "no_active_step", quote_submit_error = "dialog_closed" }
  end

  local applied = {}
  Q.apply_contact(args, applied)

  local buttons = rows_of(Q.ACTIVE .. ' button',
    { text = true, aria = { attr = "aria-label" }, title = { attr = "title" } }, 20)
  local decision = W.classify_advance(buttons)
  if decision.reached_submit_step ~= true then
    return { next = "done", quote_submit_status = "no_submit_button",
             quote_submit_error = "submit_not_found", quote_submit_message = decision.label }
  end

  local clicked = click(Q.ACTIVE .. ' button:not([aria-label])') == true
  pace(600)

  -- A validation popover means the request did NOT go out. Reporting it as submitted would tell the user
  -- a pro was contacted when none was.
  local rejection = Q.read_error()
  if rejection then
    return { next = "done", quote_submit_status = "rejected", quote_submit_error = rejection.error,
             quote_submit_message = rejection.message }
  end
  if not clicked then
    return { next = "done", quote_submit_status = "submit_click_failed", quote_submit_error = "click_failed" }
  end
  return { next = "done", quote_submit_status = "submitted", quote_submit_button = decision.label,
           quote_submit_message = trim(text_of(Q.ACTIVE)) }
end

--- The quote path lives in its own module because the search does not need the wizard, and a module is
--- what the runtime snapshots. Both entries stay reachable under the search namespace so the flow keeps
--- one Thumbtack name.
AX_RPC_THUMBTACK = AX_RPC_THUMBTACK or {}
AX_RPC_THUMBTACK.request_quote = Q.request_quote
AX_RPC_THUMBTACK.submit_quote = Q.submit_quote
