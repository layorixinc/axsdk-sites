local M = AX_THUMBTACK
if not M then
  error("thumbtack/scripts/00_common.lua must be loaded before update_project.lua")
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
function AX_update_project(args)
  args = args or {}
  local applied = M.apply_form_values(args.form_values or args.values or args.fields)
  append_answer_updates(applied, args.answers)
  return {
    applied = applied,
    form = M.read_project_form()
  }
end
