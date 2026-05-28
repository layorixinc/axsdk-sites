local function resolve_form(args)
  return args.form or args.name or "demo-checkout"
end

local function read_form_fields(form)
  local fields = dom.get_form_field_names(form)
  local values = {}

  for index = 1, #fields do
    local field = fields[index]
    values[field] = dom.get_form_field_value(form, field)
  end

  values._script = "bluemoonsoft/form.lua"
  return values
end

function AX_get_form(args)
  local form = resolve_form(args)
  return {
    form = form,
    source = "bluemoonsoft/form.lua",
    fields = read_form_fields(form)
  }
end

function AX_set_form(args)
  local form = resolve_form(args)
  local values = args.values or args.fields or {}
  local fields = dom.get_form_field_names(form)
  local changed = {}

  for index = 1, #fields do
    local field = fields[index]
    if values[field] ~= nil then
      changed[field] = dom.set_form_field_value(form, field, values[field])
    end
  end

  return {
    form = form,
    source = "bluemoonsoft/form.lua",
    changed = changed
  }
end

function AX_submit_form(args)
  local form = resolve_form(args)
  local result = dom.submit_form(form)
  result.source = "bluemoonsoft/form.lua"
  return result
end
