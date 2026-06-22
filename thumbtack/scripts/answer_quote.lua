local M = AX_THUMBTACK
if not M then
  error("thumbtack/scripts/00_common.lua must be loaded before answer_quote.lua")
end

local function append_answer_updates(applied, answers)
  if type(answers) ~= "table" then
    return
  end
  for name, value in pairs(answers) do
    local ok = false
    local reason = "answer_label_matching_not_available_without_selector"
    if type(value) == "table" and value.selector then
      if value.value ~= nil then
        ok = dom.set_value(value.selector, value.value) == true
        reason = ok and "updated" or "update_failed"
      else
        ok = dom.click(value.selector) == true
        reason = ok and "clicked" or "click_failed"
      end
    end
    applied[#applied + 1] = {
      kind = "answer",
      name = tostring(name),
      value = type(value) == "table" and (value.value or value.selector) or value,
      ok = ok,
      reason = reason
    }
  end
end

local function contact_from_args(args)
  local contact = {}
  local function set(name, keys)
    local value = M.request_flow_arg_value(args, keys)
    if value then
      contact[name] = value
    end
  end
  set("email", { "email" })
  set("first_name", { "first_name", "firstName", "given_name", "givenName" })
  set("last_name", { "last_name", "lastName", "family_name", "familyName" })
  set("phone", { "phone", "phone_number", "phoneNumber", "tel" })
  set("zip_code", { "zip_code", "zip", "postal_code", "postalCode" })
  return next(contact) and contact or nil
end

local function needs_user_answer(flow, form)
  local reason = flow and flow.advance_reason
  if reason ~= "missing_answer" and reason ~= "answer_not_applied" then
    return false
  end
  local before_text = M.non_empty(flow and flow.before_text)
  local current_text = M.non_empty(form and form.text)
  if before_text and current_text and before_text ~= current_text then
    return false
  end
  return true
end

local function missing_answer_question(form)
  local fields = form and form.fields or {}
  local missing_fields = {}
  local choices = {}
  for index = 1, #fields do
    local field = fields[index]
    local field_type = M.normalize_text(field.type or "")
    local placeholder = M.normalize_text(field.placeholder or "")
    local aria = M.normalize_text(field.aria or "")
    local autocomplete = M.normalize_text(field.autocomplete or "")
    local value = M.non_empty(field.value)
    if field_type ~= "radio" and field_type ~= "checkbox" and field_type ~= "hidden" and field_type ~= "file" and not value then
      if autocomplete == "given-name" or placeholder:find("first name", 1, true) or aria:find("first name", 1, true) then
        missing_fields[#missing_fields + 1] = "first name"
      elseif autocomplete == "family-name" or placeholder:find("last name", 1, true) or aria:find("last name", 1, true) then
        missing_fields[#missing_fields + 1] = "last name"
      elseif field_type == "email" or autocomplete == "email" or placeholder:find("email", 1, true) or aria:find("email", 1, true) then
        missing_fields[#missing_fields + 1] = "email address"
      elseif field_type == "tel" or autocomplete == "tel" or placeholder:find("phone", 1, true) or aria:find("phone", 1, true) then
        missing_fields[#missing_fields + 1] = "phone number"
      elseif autocomplete == "postal-code" or placeholder:find("zip", 1, true) or aria:find("zip", 1, true) then
        missing_fields[#missing_fields + 1] = "ZIP code"
      elseif M.non_empty(field.placeholder) or M.non_empty(field.aria) then
        missing_fields[#missing_fields + 1] = M.non_empty(field.placeholder) or M.non_empty(field.aria)
      end
    end

    local text = M.non_empty(field.text)
    if text
      and (field_type == "radio" or field_type == "checkbox")
      and not M.normalize_text(text):find("remember me", 1, true)
      and not M.normalize_text(text):find("marketing texts", 1, true) then
      choices[#choices + 1] = text
      if #choices >= 8 then
        break
      end
    end
  end
  if #missing_fields > 0 then
    return "Please provide " .. table.concat(missing_fields, " and ") .. " for the current Thumbtack quote step."
  end
  if #choices > 0 then
    return "Please choose one of the visible Thumbtack options: " .. table.concat(choices, ", ")
  end
  local text = M.non_empty(form and form.text)
  if text then
    return "Please answer the current Thumbtack quote step: " .. M.truncate_text(text, 240)
  end
  return "Please answer the current Thumbtack quote step."
end

function AX_answer_quote(args)
  args = args or {}
  local applied = M.apply_form_values(args.form_values or args.values or args.fields)
  append_answer_updates(applied, args.answers)
  local flow = M.update_request_flow_step(args, applied, #applied)
  local form = M.read_project_form()
  local request_error = (flow and flow.request_error) or form.request_error
  local contact = contact_from_args(args)
  local result = {
    applied = applied,
    flow = flow,
    form = form,
    questions = form.questions,
    all_questions_available = form.all_questions_available,
    question_collection_status = form.question_collection_status,
    contact = contact
  }
  if request_error then
    result.status = request_error.retry_field and "contact_update_required" or "request_flow_error"
    if not request_error.retry_field then
      result.error = request_error.error
    end
    result.request_error = request_error
    result.retry_field = request_error.retry_field
    result.bad_value = request_error.bad_value
    result.message = request_error.message
    result.question = request_error.question
  elseif needs_user_answer(flow, form) then
    result.status = "needs_answer"
    result.retry_field = "answer"
    result.message = missing_answer_question(form)
    result.question = result.message
  end
  return result
end
