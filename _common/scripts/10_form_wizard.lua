-- Generic multi-step form-wizard DECISION CORE (AX_WIZARD), site-agnostic and DOM-free.
-- Loaded from _common/scripts/ after 00_base.lua. The pure functions here decide WHAT to do for a
-- step (which options to pick, whether a step is required, whether the advance button is safe or is
-- a submit/send that must STOP). A site driver supplies the DOM glue (option/button selectors,
-- positional click builder, contact map) and calls these to drive its own step machine.
-- This file has NO selectors and reads NO DOM — it operates on values the caller already gathered.
AX_WIZARD = {}
local W = AX_WIZARD
local B = AX_BASE

-- Default advance/skip/submit label sets. submit_* labels are the STOP set: a step whose only
-- actionable button is submit-like (Send/Submit/Request/Get quotes) must never be auto-clicked.
W.DEFAULT_LABELS = {
  advance = { "next", "continue", "loadingnext", "loadingcontinue" },
  skip = { "skip" },
  submit = { "send", "submit", "quote", "request" }
}

-- Keys (in args) whose values describe what the user wants; used to score auto-answers.
W.DEFAULT_REQUIREMENT_KEYS = { "user_requirements", "requirements", "requestText", "description", "details", "message" }

local function contains(list, value)
  for index = 1, #(list or {}) do
    if list[index] == value then
      return true
    end
  end
  return false
end

local function find_sub(haystack, needle)
  return haystack:find(needle, 1, true) ~= nil
end

-- Explicit user choices from args: selections[] (multi) or a single selection/value/option/answer.
function W.choice_values(args)
  args = args or {}
  local choices = ax.array()
  if type(args.selections) == "table" then
    for index = 1, #args.selections do
      local value = B.non_empty(args.selections[index])
      if value then
        choices[#choices + 1] = value
      end
    end
  else
    local value = B.non_empty(args.selection or args.value or args.option or args.answer)
    if value then
      choices[#choices + 1] = value
    end
  end
  return choices
end

-- Free-text answer the user supplied (for textarea steps).
function W.text_value(args)
  args = args or {}
  return args.text or args.details or args.message
end

function W.auto_enabled(args)
  args = args or {}
  return args.auto == true or args.auto_answer == true
end

-- Normalized concatenation of the requirement-bearing args; "" when none.
function W.requirement_text(args, keys)
  args = args or {}
  keys = keys or W.DEFAULT_REQUIREMENT_KEYS
  local parts = ax.array()
  for index = 1, #keys do
    local value = B.non_empty(args[keys[index]])
    if value then
      parts[#parts + 1] = value
    end
  end
  if #parts == 0 then
    return ""
  end
  return B.normalize_text(table.concat(parts, " "))
end

-- Score an option's fitness for the requirements. Generic service-quote heuristics: prefer
-- requirement-matching text, "home", negative/none/standard/one-time answers; mildly avoid
-- "business". Sites can override by supplying explicit selections instead of relying on auto.
function W.option_score(option, requirements)
  local text = B.normalize_text(option and option.text or "")
  if text == "" then
    return -1
  end
  requirements = requirements or ""
  local score = 0
  if requirements ~= "" then
    if find_sub(requirements, text) or find_sub(text, requirements) then
      score = score + 100
    end
    for word in text:gmatch("[%w]+") do
      if #word >= 3 and find_sub(requirements, word) then
        score = score + 5
      end
    end
  end
  if find_sub(text, "home") then
    score = score + 8
  end
  if find_sub(text, "no pet") or text == "no" or find_sub(text, "none") then
    score = score + 6
  end
  if find_sub(text, "standard") or find_sub(text, "basic") then
    score = score + 5
  end
  if find_sub(text, "one time") or find_sub(text, "once") then
    score = score + 3
  end
  if find_sub(text, "business") then
    score = score - 2
  end
  return score
end

-- Given the step's option rows ({ text, control, group }), auto-pick choices: one best per radio
-- group; for checkbox groups, options that strongly match requirements or read as none/negative.
-- Returns an array of option texts to select (consumed by the site's select-by-text).
function W.auto_choice_values(options, requirements)
  options = options or {}
  requirements = requirements or ""
  local groups = {}
  local order = ax.array()
  for index = 1, #options do
    local option = options[index]
    local text = B.non_empty(option.text)
    local control = B.normalize_text(option.control or "")
    if text and (control == "radio" or control == "checkbox") then
      local group = B.non_empty(option.group) or (control .. ":" .. tostring(index))
      if not groups[group] then
        groups[group] = { control = control, options = ax.array() }
        order[#order + 1] = group
      end
      groups[group].options[#groups[group].options + 1] = option
    end
  end

  local values = ax.array()
  for order_index = 1, #order do
    local group = groups[order[order_index]]
    local best, best_score = nil, nil
    for option_index = 1, #group.options do
      local option = group.options[option_index]
      local score = W.option_score(option, requirements)
      if best == nil or score > best_score then
        best, best_score = option, score
      end
    end
    if group.control == "radio" and best then
      values[#values + 1] = best.text
    elseif group.control == "checkbox" then
      for option_index = 1, #group.options do
        local option = group.options[option_index]
        local score = W.option_score(option, requirements)
        local normalized = B.normalize_text(option.text or "")
        if score >= 100 or find_sub(normalized, "none") or find_sub(normalized, "no ") then
          values[#values + 1] = option.text
        end
      end
    end
  end
  return values
end

-- A step can be auto-skipped (advance with no answer) only when it has no radio (radios always
-- require a pick), and its sole controls are optional checkboxes (no textarea/select/other inputs).
-- `extra_control_count` = number of non-radio/checkbox inputs the caller found in the step.
function W.can_auto_skip(options, extra_control_count)
  options = options or {}
  local has_checkbox = false
  for index = 1, #options do
    local control = B.normalize_text(options[index].control or "")
    if control == "radio" then
      return false
    elseif control == "checkbox" then
      has_checkbox = true
    end
  end
  return has_checkbox and (extra_control_count or 0) == 0
end

-- Classify the step's buttons into an advance decision. `buttons` = array of label strings or
-- { text, aria, title } rows. Returns { kind, label, can_advance, allow_without_answer,
-- reached_submit_step }. kind: "advance" | "skip" | "none". reached_submit_step=true means the only
-- actionable button is submit-like -> the wizard MUST stop (never auto-submit).
function W.classify_advance(buttons, labels)
  buttons = buttons or {}
  labels = labels or W.DEFAULT_LABELS
  local fallback = nil
  local submit_like = false
  local function is_submit(normalized)
    for index = 1, #(labels.submit or {}) do
      if find_sub(normalized, labels.submit[index]) then
        return true
      end
    end
    return false
  end
  for index = 1, #buttons do
    local b = buttons[index]
    local label
    if type(b) == "table" then
      label = B.non_empty(b.text) or B.non_empty(b.aria) or B.non_empty(b.title)
    else
      label = B.non_empty(b)
    end
    local normalized = B.normalize_text(label)
    if label and not fallback then
      fallback = label
    end
    submit_like = submit_like or is_submit(normalized)
    if contains(labels.advance, normalized) then
      return { kind = "advance", label = label, can_advance = true, reached_submit_step = false }
    end
    if contains(labels.skip, normalized) then
      return { kind = "skip", label = label, can_advance = true, allow_without_answer = true, reached_submit_step = false }
    end
  end
  submit_like = submit_like or is_submit(B.normalize_text(fallback))
  return { kind = "none", label = fallback, can_advance = false, reached_submit_step = submit_like }
end
