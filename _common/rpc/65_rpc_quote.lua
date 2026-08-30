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
--- The final Submit is NOT clicked. Reaching it is the answer this script gives; the flow reports that
--- stop and exposes no action that can contact a professional.

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

--- What this invocation is allowed to spend, in MILLISECONDS.
---
--- It used to be a count of round trips: 95, chosen when we believed an op cost about a second, so that a
--- long form would stop and report instead of being killed mid-run with `deadline exceeded before
--- dom.exists`. The report was the right idea; the number was a PROXY for the deadline and it was
--- miscalibrated. Measured on the live channel, an op's median is ~460ms and the gap between answers
--- ~510ms, so ninety-five round trips is under half of the platform's 120s ceiling — the wizard stopped
--- with most of its deadline unused, six steps into a seven-step form.
---
--- `rpc.now()` removes the need to guess. Stop when there is no time left for another step, whatever an
--- op happens to cost today. Kept under the flow's declared `deadlineMs` by enough margin to return an
--- answer rather than be killed while composing one; `check:flows` pins the two against each other,
--- because a constant that must agree with a number in another file is a constant that drifts.
Q.TIME_BUDGET_MS = 90000

--- Round trips spent. No longer the budget — still reported, because "how many trips did that take" is
--- the first question about a slow run, and it is what makes a batch's saving visible.
Q.spent = 0
Q.started_at = nil

local function clock()
  return (type(rpc) == "table" and type(rpc.now) == "function") and rpc.now() or nil
end

local function charge()
  Q.spent = Q.spent + 1
end

--- True once there is no time for another step.
---
--- Falls back to the old count when the host has no clock, so a runtime without `rpc.now` still stops
--- itself rather than being killed. The fallback keeps the original 95 on purpose: without a clock we are
--- guessing again, and the safe guess is the one we have already run.
Q.OP_BUDGET = 95
--- Milliseconds left, or nil when the host has no clock.
local function remaining_ms()
  local now = clock()
  if not now or not Q.started_at then return nil end
  return Q.TIME_BUDGET_MS - (now - Q.started_at)
end

local function over_budget()
  local now = clock()
  if not now or not Q.started_at then return Q.spent >= Q.OP_BUDGET end
  return (now - Q.started_at) >= Q.TIME_BUDGET_MS
end

--- Waits without buying the wait with round trips.
---
--- This function's own comment used to say "there is no wait op: the runtime's vocabulary is reads and
--- writes", and paid for a pause with up to two `dom.exists` reads issued for their latency. That was
--- never true of the HOST: `rpc.sleep(ms)` costs no round trip and no `maxCalls` (it does spend the
--- deadline, which is now what the budget measures). At a measured ~460ms per op, every pace was about a
--- second of the deadline bought at full price.
local function pace(ms)
  local wait = math.max(50, math.floor(ms or 200))
  if type(rpc) == "table" and type(rpc.sleep) == "function" then
    pcall(rpc.sleep, wait)
    return
  end
  -- No host timer: fall back to the old shape rather than not waiting at all, since the callers that
  -- pace are waiting on the SITE and skipping it would read a page mid-render.
  for _ = 1, math.min(2, math.max(1, math.floor(wait / 100))) do
    charge()
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
local function exists(selector)
  charge()
  return probe(function() return dom.exists(selector) end, 2) == true
end
local function text_of(selector)
  charge()
  return probe(function() return dom.get_text(selector) end, 2)
end
local function rows_of(selector, fields, limit)
  charge()
  return probe(function() return dom.query_all(selector, fields, limit) end, 2) or {}
end
local function click(selector)
  charge()
  return probe(function() return dom.click(selector) end, 2) == true
end
local function set_value(selector, value)
  charge()
  return probe(function() return dom.set_value(selector, value) end, 2) == true
end
local function wait_for(selector, timeout)
  charge()
  return probe(function()
    return dom.wait_for_selector(selector, { timeout = timeout or 6000, interval = 200 })
  end, 2) == true
end

--- Optional ops: the platform can ship one before the client implements it, so support is a live fact.
---
--- The client answers an unregistered op immediately (`command_unresolved`) — it does NOT hang — but the
--- attempt is still a round trip, and re-attempting per step is what spent the deadline. So support is
--- decided ONCE per invocation and remembered.
---
--- "Never implemented" and "refused this once" are different facts, and only the first is remembered:
--- marking an op dead because a flaky channel dropped one call would disable an op the client does
--- support, for the rest of the run.
Q.unavailable = {}

--- The codes that mean "this client will never answer this op", as opposed to "not this time".
---
--- `command_unresolved` is the one that matters and the one we first got wrong: axsdk-core's
--- `executeRpcOp` answers it for an op it has no handler for, while `op_not_permitted` is reserved for
--- `page.eval` without its opt-in. Keying only on the latter meant an op the extension will never
--- implement was re-attempted on every step, and those round trips are what spent the deadline.
local function permanent_refusal(message)
  local text = tostring(message or ""):lower()
  return text:find("command_unresolved", 1, true) ~= nil
    or text:find("op_not_permitted", 1, true) ~= nil
    or text:find("not allowed", 1, true) ~= nil
    or text:find("nil value", 1, true) ~= nil
end

local function optional(name, call)
  if Q.unavailable[name] then return nil end
  charge()
  if type(dom[name]) ~= "function" then
    Q.unavailable[name] = true
    return nil
  end
  local ok, value = pcall(call)
  if not ok then
    if permanent_refusal(value) then Q.unavailable[name] = true end
    return nil
  end
  return value
end

--- One round trip for several READS. Returns `nil` when unavailable, meaning "read them one by one".
--- `dom.read_many` answers `{ value = … }` / `{ error = … }` per entry in request order.
local function read_many(requests)
  local answers = optional("read_many", function() return dom.read_many(requests) end)
  if type(answers) ~= "table" then return nil end
  local out = {}
  for index = 1, #requests do
    local answer = answers[index]
    if type(answer) ~= "table" or answer.error ~= nil then return nil end
    out[index] = answer.value
  end
  return out
end

--- Clicks the element whose VISIBLE LABEL matches, within `selector` — the gap CSS left, since the quote
--- CTA carries no id, no aria-label and no data-test, only build hashes.
local function click_text(selector, label)
  return optional("click_text", function()
    return dom.click_text(selector, label, { exact = false })
  end) == true
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

--- The measured last safe step before Thumbtack starts contact/lead handling. It rendered only Skip/Back,
--- and auto-clicking Skip produced the site's request-flow error after 8-11 otherwise successful steps.
--- Crossing this boundary buys no read capability, so the safe answer is the same as a final Submit:
--- report the live step and leave every button untouched.
function Q.is_contact_boundary(text)
  local normalized = B.normalize_text(text or "")
  return normalized:find("send a message to the pro", 1, true) ~= nil
end

-- The batch and the one-by-one reads must ask for exactly the same thing, so the selector and its field
-- set are named once and shared.
Q.OPTION_SELECTOR = Q.ACTIVE .. ' label:has(input[type="radio"]), ' .. Q.ACTIVE .. ' label:has(input[type="checkbox"])'
Q.OPTION_FIELDS = {
  text = true,
  control = { selector = "input", attr = "type" },
  group = { selector = "input", attr = "name" },
  id = { selector = "input", attr = "id" },
  checked = { selector = "input", attr = "checked" },
}
Q.CONTROL_SELECTOR = Q.ACTIVE .. ' textarea, ' .. Q.ACTIVE .. ' select, '
  .. Q.ACTIVE .. ' input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]):not([type="file"])'
Q.CONTROL_FIELDS = {
  tag = { attr = "tagName" }, type = { attr = "type" }, placeholder = { attr = "placeholder" },
  aria = { attr = "aria-label" }, autocomplete = { attr = "autocomplete" },
}
Q.BUTTON_FIELDS = { text = true, aria = { attr = "aria-label" }, title = { attr = "title" } }

function Q.options()
  return rows_of(Q.OPTION_SELECTOR, Q.OPTION_FIELDS, 160)
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
  return rows_of(Q.CONTROL_SELECTOR, Q.CONTROL_FIELDS, 160)
end

function Q.read_buttons()
  return rows_of(Q.ACTIVE .. ' button', Q.BUTTON_FIELDS, 20)
end

--- The button the positional advance selector will actually hit: the first one its filter keeps, in
--- document order. `dom` resolves standard CSS only, so a click cannot be aimed by label — but the batch
--- already reads every button's text, aria-label and title, so WHICH button the selector lands on is
--- computable without an extra round trip.
---
--- This exists because the two halves disagreed. `W.classify_advance` decides by LABEL and returns the
--- moment it sees an advance word, dropping the fact that a submit-like button shares the step; the click
--- was positional. A step rendering "Send request" before "Next" therefore had its submit pressed by the
--- wizard's own advance, and `Q.submit_step_form` would have followed with `requestSubmit()`. A quote is
--- never auto-submitted, so the labels have to agree before anything is pressed.
function Q.advance_target(buttons, skip)
  for index = 1, #(buttons or {}) do
    local button = buttons[index]
    if type(button) == "table" and not trim(button.aria) and (not skip or not trim(button.title)) then
      return button
    end
  end
  return nil
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
  local function invalidate()
    cache.options, cache.controls, cache.buttons = nil, nil, nil
    cache.active, cache.text, cache.filled = nil, nil, nil
  end

  --- The option list, the free controls and the buttons all describe the SAME instant, and the wizard asks
  --- for them three or four times per pass. One batch fills all three for one call; without the op each
  --- one is read on demand exactly as before.
  local function fill()
    if cache.filled then return end
    cache.filled = true
    -- Whether the step is THERE and what it SAYS describe the same instant as its options, and both ops
    -- are batchable. Measured on a live turn: 95 frames, `dom.exists` 37 of them — 21 seconds of a 90s
    -- budget spent asking "is there a step?" one round trip at a time, next to a batch that was already
    -- being issued.
    local answers = read_many({
      { op = "dom.exists", params = { selector = Q.ACTIVE } },
      { op = "dom.get_text", params = { selector = Q.ACTIVE } },
      { op = "dom.query_all", params = { selector = Q.OPTION_SELECTOR, fields = Q.OPTION_FIELDS, limit = 160 } },
      { op = "dom.query_all", params = { selector = Q.CONTROL_SELECTOR, fields = Q.CONTROL_FIELDS, limit = 160 } },
      { op = "dom.query_all", params = { selector = Q.ACTIVE .. ' button', fields = Q.BUTTON_FIELDS, limit = 20 } },
    })
    if answers then
      cache.active = answers[1]
      cache.text = answers[2]
      cache.options, cache.controls, cache.buttons = answers[3] or {}, answers[4] or {}, answers[5] or {}
    end
  end
  local function options()
    fill()
    if cache.options == nil then cache.options = Q.options() end
    return cache.options
  end
  local function controls()
    fill()
    if cache.controls == nil then cache.controls = Q.free_controls() end
    return cache.controls
  end
  local function buttons()
    fill()
    if cache.buttons == nil then cache.buttons = Q.read_buttons() end
    return cache.buttons
  end
  return {
    active_exists = function()
      fill()
      -- Only ask separately when the batch could not answer — a client without `read_many` still works,
      -- exactly as before.
      if cache.active == nil then return exists(Q.ACTIVE) end
      return cache.active == true
    end,
    read_error = function() return Q.read_error() end,
    current_text = function()
      fill()
      if cache.text == nil then return trim(text_of(Q.ACTIVE)) end
      return trim(cache.text)
    end,
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
    read_buttons = buttons,
    advance_click = function(decision)
      local skip = decision.kind == "skip"
      -- Verified before pressed, from the batch already in hand (`Q.advance_target`). A click that fires is
      -- not a click on the button the DECISION named: the classification is label-based and this selector is
      -- positional, so a step rendering a submit-like button first would have its submit pressed here. When
      -- the two disagree nothing is pressed and the step stalls, which the stop report already explains by
      -- name — a wrongly-sent quote does not get a second chance.
      local target = Q.advance_target(buttons(), skip)
      local wanted = B.normalize_text(decision.label)
      if not target or (wanted ~= "" and B.normalize_text(target.text) ~= wanted) then
        return false
      end
      local selector = Q.ACTIVE .. ' button:not([aria-label])'
      if skip then selector = selector .. ':not([title])' end
      local clicked = click(selector) == true
      -- The click is what MOVES the step, so everything read about the old one is now stale. This did not
      -- matter while the batch held only option lists — nothing re-read them after the click. It matters
      -- now that the step's presence and text ride the same cache: advancement is detected by comparing
      -- the text before and after, and serving the cached "before" made every step look stalled.
      invalidate()
      return clicked
    end,
    wait = pace,
  }
end

--- Thumbtack's sentence when a pro cannot take the job. Quoted, never paraphrased: it is the only thing
--- that tells the user this pro was never an option, and it names what to do next.
---
--- Two wordings, both measured live on the same pro hours apart: "Sorry this pro can't do your job, but we
--- know other pros who can." and "This pro is currently not available for Handyman." Knowing only the first
--- meant the second came back as a generic `quote_unavailable` and the user learned nothing.
---
--- Each phrase carries how its sentence STARTS, because a fixed window around the match drags in whatever
--- the page rendered next — `dom.get_text` is textContent, so adjacent blocks arrive with no separator.
Q.REFUSAL_PHRASES = {
  { match = "can't do your job", opens = "sorry" },
  { match = "cannot do your job", opens = "sorry" },
  { match = "can’t do your job", opens = "sorry" },
  { match = "currently not available", opens = "this pro" },
}

function Q.pro_refusal()
  local text = trim(text_of("body"))
  if not text then return nil end
  local lower = text:lower()
  for index = 1, #Q.REFUSAL_PHRASES do
    local phrase = Q.REFUSAL_PHRASES[index]
    local at = lower:find(phrase.match, 1, true)
    if at then
      -- Walk back to the last opening word before the match; the sentence ends at its own period.
      local start, search = 1, 1
      while true do
        local found = lower:find(phrase.opens, search, true)
        if not found or found > at then break end
        start, search = found, found + 1
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
  local label, handles = nil, nil
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
      -- The label op first: it narrows by selector and picks by visible text, which is the one thing CSS
      -- cannot do and the whole reason the ladder below had to be surveyed. When the client implements it,
      -- nothing else runs.
      if click_text(Q.PRO_READY, label) then
        clicked_any = true
        if wait_for(Q.ACTIVE) then return true, nil end
      end
      local handle = Q.handle_selector(candidate)
      if handle and open_with(handle) then return true, nil end
      -- No handle: fall back to the positional candidates, which work when the CTA does lead its region.
      for index = 1, #Q.CTA_SELECTORS do
        local selector = Q.CTA_SELECTORS[index]
        local one = rows_of(selector, { text = true }, 1)
        local text = one and #one > 0 and trim(one[1].text) or nil
        if text and Q.is_cta(text) and open_with(selector) then return true, nil end
      end
    end
  end
  if not label then return false, order end
  return false, order, {
    code = clicked_any and "quote_dialog_did_not_open" or "quote_cta_unreachable",
    label = label,
    handles = handles,
  }
end

Q.STEP_FORM = '[data-test="request-flow-step-form"]'

--- Submits the step's own form. A synthetic click on a `type=submit` button is ignored by many SPAs;
--- `dom.submit_form` calls `requestSubmit()`, which runs the form's real handler.
function Q.submit_step_form()
  local ok = probe(function() return dom.submit_form(Q.STEP_FORM) end, 2)
  if ok == true then pace(400) end
  return ok == true
end

--- What the form looked like at ONE instant: whether the option is checked, and whether the button that
--- should advance is disabled. Together they separate "selected but the page never learned" from
--- "selected and the page is refusing" — a stall that reports neither needs a manual survey, which is
--- exactly what this replaces. One batched round trip when the client has it, three otherwise.
function Q.stall_snapshot()
  local batched = read_many({
    { op = "dom.query_all", params = { selector = Q.OPTION_SELECTOR, fields = Q.OPTION_FIELDS, limit = 8 } },
    { op = "dom.query_all", params = { selector = Q.ACTIVE .. ' button',
      fields = { text = true, disabled = { attr = "disabled" }, type = { attr = "type" } }, limit = 8 } },
    { op = "dom.exists", params = { selector = Q.STEP_FORM } },
  })
  local options = batched and batched[1] or Q.options()
  local buttons = batched and batched[2]
    or rows_of(Q.ACTIVE .. ' button', { text = true, disabled = { attr = "disabled" }, type = { attr = "type" } }, 8)
  local has_form = batched and batched[3] or exists(Q.STEP_FORM)

  local picked = {}
  for index = 1, #options do
    local option = options[index]
    picked[#picked + 1] = tostring(trim(option.text) or "?") .. " checked=" .. tostring(option.checked == true)
  end
  local controls = {}
  for index = 1, #buttons do
    local button = buttons[index]
    controls[#controls + 1] = tostring(trim(button.text) or "?")
      .. " disabled=" .. tostring(button.disabled ~= nil and button.disabled ~= false)
  end
  return "options[" .. table.concat(picked, "; ") .. "] buttons[" .. table.concat(controls, "; ")
    .. "] step_form=" .. tostring(has_form == true)
end

--- What the wizard answered, newest last, as one line.
---
--- Live twice, the report for a dialog that vanished was the pro's PROFILE text — where the browser ended
--- up, nothing about where the WIZARD was. The answers were tracked the whole time and simply never
--- reached the caller, so diagnosing meant re-running and watching. A scalar, because a table of records
--- would have to survive tool-output validation and nobody reads it anyway.
function Q.answered(applied)
  if type(applied) ~= "table" then return nil end
  local parts = {}
  for index = 1, #applied do
    local entry = applied[index]
    local value = entry and entry.value
    if type(value) == "string" and value ~= "" then
      parts[#parts + 1] = value .. (entry.ok == true and "" or "(refused)")
    end
  end
  if #parts == 0 then return nil end
  local line = table.concat(parts, " | ")
  return #line > 300 and (line:sub(1, 300) .. "…") or line
end

--- How many 8s waits fit in the time that is LEFT.
---
--- Deriving this from the whole budget ignored the seconds already spent driving, and the platform killed
--- the tool mid-wait with `lua rpc execution deadline exceeded while waiting` — the sentence the budget
--- exists to replace. Never start a wait the remainder cannot finish.
---
--- Without a host clock there is no remainder to divide, so it falls back to the count that has already
--- run in production rather than guessing a larger one.
Q.WAIT_MS = 8000
--- Waiting may take at most this SHARE of the time left. Handing it the whole remainder let twelve waits
--- eat the budget that driving needed, and the platform killed the call twice — once `while waiting`,
--- once `before dom.read_many`. A step that has not returned after a third of the remaining time is not
--- returning inside this invocation, and the seconds are worth more to the steps that can still run.
Q.WAIT_SHARE = 0.4
function Q.wait_allowance(remaining)
  local left = tonumber(remaining)
  if not left then return 3 end
  local share = left * Q.WAIT_SHARE
  if share < Q.WAIT_MS then return 0 end
  return math.floor(share / Q.WAIT_MS)
end

--- Why the active step is missing: `standing` | `transitional` | `closed`.
---
--- Pure, so the rule is testable without a page. Measured live, two different endings arrive as the same
--- pair of false flags:
---   dialog=false step_form=false surface="Elmer Deleon Painting ... Select a service ..."  -- dismissed
---   dialog=false step_form=false surface=""                                                -- mid-render
--- A dismissed dialog leaves the pro's profile behind. NOTHING at all means the document is between
--- renders, and calling that closed abandons a form that was still going — six steps in, on "How often
--- do you want the house cleaned?".
function Q.classify_absence(dialog, form, surface)
  if dialog == true or form == true then return "standing" end
  local text = type(surface) == "string" and surface:gsub("%s+", "") or ""
  if text == "" then return "transitional" end
  return "closed"
end

--- What the page shows once the active step is gone: whether the dialog frame is still there, and what
--- the surface says. One batched round trip when the client has it.
function Q.closed_snapshot()
  local batched = read_many({
    { op = "dom.exists", params = { selector = Q.DIALOG } },
    { op = "dom.exists", params = { selector = Q.STEP_FORM } },
    { op = "dom.get_text", params = { selector = "main" } },
  })
  local dialog = batched and batched[1] or exists(Q.DIALOG)
  local form = batched and batched[2] or exists(Q.STEP_FORM)
  -- The surface is read by a person. `dom.get_text` is textContent, and a live card put a whole `<img>`
  -- tag in it, so the report reached the user as a wall of HTML.
  local text = trim(batched and batched[3] or text_of("main")) or ""
  text = trim((text:gsub("<[^>]*>", " "))) or ""
  return "dialog=" .. tostring(dialog == true) .. " step_form=" .. tostring(form == true)
    .. " surface=\"" .. text:sub(1, 160) .. "\""
end

--- Navigates to the pro when needed, opens the dialog, and drives every step it can answer. Returns the
--- state fields the quote loop reports on — `pick_quote` builds its outcome line from these names, so
--- they are the durable ones.
function Q.request_quote(args)
  args = type(args) == "table" and args or {}
  -- Support is a fact about the client, and the client can be upgraded between turns. Detect it per call.
  Q.unavailable = {}
  Q.spent = 0
  -- The budget is time from HERE, so it has to be stamped per invocation: a module global survives
  -- nothing between turns, and a stale start would make the first step look like it had already run out.
  Q.started_at = clock()
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
    probe(function() return nav.navigate(url) end, 2)
    -- The TARGET is named: without it the port compares against a baseline it read through a round trip,
    -- so a fast commit makes the wait poll its whole ceiling before answering false. `Q.on_pro` below is
    -- what decides the landing either way, so the ceiling was pure waste out of this tool's budget.
    probe(function() return nav.wait_for_navigation({ url = url, timeout = 12000, interval = 250 }) end, 2)
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
                 .. tostring(blocked.handles) .. ')' }
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
  -- The last question the wizard SAW. Once the step is gone the surface cannot supply it, and that is
  -- exactly when someone needs it: a report of the pro's profile text says where the browser ended up,
  -- never where the wizard was.
  local last_step = nil
  -- How many times a missing step was waited out. Reported, because "gave up at once" and "waited and
  -- the page never came back" are different failures that read identically without it.
  local waits = 0
  local steps, stalled, flow = 0, 0, nil
  local function contact_stop(context)
    local text = context.current_text()
    if not Q.is_contact_boundary(text) then return nil end
    return {
      next = "submit",
      quote_status = "at_contact_boundary",
      quote_reached_submit = false,
      quote_advance_reason = "contact_boundary",
      quote_steps = steps,
      quote_clock = clock() ~= nil,
      quote_answered = Q.answered(applied),
      quote_last_step = text,
    }
  end
  while steps < Q.MAX_STEPS do
    if over_budget() then
      -- Out of round trips. Before calling that a failure, ask the page WHERE it stopped: the wizard's
      -- goal is the submit step, and arriving there and then running out is arrival. Measured live — six
      -- steps driven, `buttons[Submit disabled=false; Back disabled=false]` on screen — and this returned
      -- `quote_budget_spent`, so the user was told the pro had FAILED while the form sat finished.
      -- One read, and only on the way out, so the check cannot itself cost the budget it reports on.
      -- No label argument: the wizard's own defaults are what drove every step above, and a second
      -- vocabulary here would let the exit disagree with the loop about what "Submit" means.
      local advance = W.classify_advance(Q.read_buttons())
      if advance and advance.reached_submit_step then
        return { next = "submit", quote_status = "at_submit_step", quote_reached_submit = true,
                 quote_advance_reason = "budget_spent_at_submit", quote_steps = steps, quote_clock = clock() ~= nil }
      end
      -- Genuinely short: say so, with what was driven and what the form looks like now, instead of
      -- letting the platform kill the call.
      return { next = "error", quote_error = "quote_budget_spent", quote_status = "budget_spent",
               quote_steps = steps, quote_clock = clock() ~= nil, quote_advance_reason = flow and flow.advance_reason or nil,
               quote_answered = Q.answered(applied), quote_last_step = last_step,
               quote_message = Q.stall_snapshot() }
    end
    local context = Q.ctx()
    local stopped = contact_stop(context)
    if stopped then return stopped end
    flow = W.drive_step(context, drive, applied)
    if not flow then
      -- The wizard answers nil when there is no ACTIVE step, and there are THREE reasons for that, not
      -- two. `classify_absence` names them; the fix for each is different.
      -- Bounded by the BUDGET, not by a count. Three attempts was the same kind of proxy the budget
      -- itself used to be: live, the wizard gave up after roughly twenty-four seconds with a
      -- hundred-second budget, and the dialog was open on the next question when checked straight after.
      -- The deadline already knows when to stop, and a wait now costs a host sleep rather than round
      -- trips, so there is nothing left for an arbitrary cap to protect.
      -- DERIVED from what is left, not from the whole budget and not from a number someone picked. Three
      -- attempts stopped the wizard twenty-four seconds into a hundred-second budget while the dialog sat
      -- open on the next question; the whole budget, in turn, queued more waiting than the deadline had
      -- room for and the platform killed the call mid-wait.
      local max_waits = Q.wait_allowance(remaining_ms())
      while waits < max_waits and not over_budget() do
        waits = waits + 1
        local why = Q.classify_absence(exists(Q.DIALOG), exists(Q.STEP_FORM), text_of("main"))
        if why == "standing" then
          -- The frame is there and only the step marker is missing, between renders.
          if wait_for(Q.ACTIVE, 8000) then
            local context = Q.ctx()
            local stopped = contact_stop(context)
            if stopped then return stopped end
            flow = W.drive_step(context, drive, applied)
          end
        elseif why == "transitional" then
          -- Nothing on the page at all: the document is mid-render. Measured live at step six, on "How
          -- often do you want the house cleaned?" — reported as a closed dialog, which abandoned a form
          -- that was still going. Waiting costs a host sleep, not round trips, so re-checking is nearly
          -- free and giving up on the first blank read is indefensible.
          pace(700)
          if exists(Q.ACTIVE) then
            local context = Q.ctx()
            local stopped = contact_stop(context)
            if stopped then return stopped end
            flow = W.drive_step(context, drive, applied)
          end
        end
        if flow or why == "closed" then break end
      end
      if not flow then
        -- Only a dialog that is actually GONE, with a real surface behind it, is reported as closed.
        -- Measured live on a handyman pro: this answered `dialog_closed` while printing
        -- `dialog=true step_form=true` and a "Select a service" picker beside it — a status contradicting
        -- its own evidence, which sends the operator hunting for a dismissal that never happened. What
        -- that pro shows is a surface the wizard has no step for; naming it that way is the difference
        -- between a bug report and a feature request.
        local why = Q.classify_absence(exists(Q.DIALOG), exists(Q.STEP_FORM), text_of("main"))
        local closed = why ~= "standing"
        return { next = "error",
                 quote_error = closed and "quote_dialog_closed" or "quote_no_active_step",
                 quote_status = closed and "dialog_closed" or "no_active_step",
                 quote_steps = steps, quote_clock = clock() ~= nil, quote_answered = Q.answered(applied), quote_last_step = last_step,
                 quote_absence_waits = waits, quote_message = Q.closed_snapshot() }
      end
    end
    steps = steps + 1
    -- `before_text` is the step as it read BEFORE this pass answered it — the question, not the next
    -- screen. The wizard has always returned it; nothing consumed it.
    if type(flow.before_text) == "string" and flow.before_text ~= "" then
      last_step = trim(flow.before_text)
    end

    if flow.request_error then
      return { next = "error", quote_error = flow.request_error.error, quote_status = "request_flow_error",
               quote_message = flow.request_error.message, quote_retry_field = flow.request_error.retry_field,
               quote_steps = steps, quote_clock = clock() ~= nil, quote_advance_reason = flow.advance_reason,
               quote_answered = Q.answered(applied), quote_last_step = last_step }
    end
    -- Reaching the submit step is the goal. `missing_answer` hands off too, because a required step this
    -- cannot answer will not answer itself on a retry. `advance_button_not_found` does NOT: that is
    -- structural or early, and treating it as arrival reported an untouched form as ready to send.
    if flow.reached_submit_step or flow.advance_reason == "missing_answer" then
      return { next = "submit", quote_status = "at_submit_step", quote_reached_submit = flow.reached_submit_step == true,
               quote_advance_reason = flow.advance_reason, quote_steps = steps, quote_clock = clock() ~= nil }
    end
    if flow.advanced then
      stalled = 0
    else
      -- The click reported success and the step did not move. The SDK's note on `dom.submit_form` says
      -- why: it calls `requestSubmit()`, "which fires the form's real submit handler -- unlike a synthetic
      -- button click, which many SPAs ignore". Thumbtack's Next is a `type=submit` inside
      -- `<form data-test="request-flow-step-form">`, so a real submit is the second attempt.
      if flow.advance_reason == "advance_not_confirmed" then
        Q.submit_step_form()
      end
      stalled = stalled + 1
      if stalled >= Q.MAX_STALLED then
        return { next = "error", quote_error = "quote_stalled", quote_status = "stalled",
                 quote_advance_reason = flow.advance_reason, quote_steps = steps, quote_clock = clock() ~= nil,
                 quote_answered = Q.answered(applied), quote_last_step = last_step,
                 quote_message = Q.stall_snapshot() }
      end
    end
  end

  return { next = "error", quote_error = "quote_steps_exhausted", quote_status = "exhausted",
           quote_advance_reason = flow and flow.advance_reason or nil, quote_steps = steps, quote_clock = clock() ~= nil }
end


--- The quote path lives in its own module because the search does not need the wizard, and a module is
--- what the runtime snapshots.
AX_RPC_THUMBTACK = AX_RPC_THUMBTACK or {}
AX_RPC_THUMBTACK.request_quote = Q.request_quote
