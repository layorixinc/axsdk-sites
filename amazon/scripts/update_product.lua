local M = AX_AMAZON
if not M then
  error("amazon/scripts/00_common.lua must be loaded before update_product.lua")
end

local function update_entry_from_spec(name, spec)
  local entry = {}
  local fallback_name = M.non_empty(name)

  if type(spec) == "table" then
    entry.name = M.non_empty(spec.name or spec.id or spec.field or spec.control or fallback_name)
    entry.id = M.non_empty(spec.id or spec.name or spec.field or spec.control or fallback_name)
    entry.label = M.non_empty(spec.label)
    entry.selector = M.non_empty(spec.selector)
    entry.control_id = M.non_empty(spec.control_id)
    entry.product_id = M.normalize_product_id(spec.product_id or spec.asin)
    entry.value = spec.value
    if entry.value == nil then
      entry.value = spec.selected
    end
    if entry.value == nil then
      entry.value = spec.option
    end
  else
    entry.name = fallback_name
    entry.id = fallback_name
    entry.value = spec
  end

  if entry.name or entry.id or entry.label or entry.selector or entry.control_id or entry.product_id or entry.value ~= nil then
    return entry
  end
  return nil
end

local function normalize_update_entries(value)
  local entries = ax.array()
  if type(value) ~= "table" then
    return entries
  end

  if value[1] ~= nil then
    for index = 1, #value do
      local entry = update_entry_from_spec(nil, value[index])
      if entry then
        entries[#entries + 1] = entry
      end
    end
    return entries
  end

  for name, spec in pairs(value) do
    local entry = update_entry_from_spec(name, spec)
    if entry then
      entries[#entries + 1] = entry
    end
  end
  return entries
end

local function update_text_matches(left, right)
  local a = M.non_empty(left)
  local b = M.non_empty(right)
  if not a or not b then
    return false
  end
  return a:lower() == b:lower()
end

local function update_entry_value(entry)
  if entry.value ~= nil then
    return entry.value
  end
  return nil
end

local function update_matches_variation(entry, variation)
  if update_text_matches(entry.id, variation.id) or update_text_matches(entry.name, variation.id) then
    return true
  end
  if update_text_matches(entry.label, variation.label) or update_text_matches(entry.name, variation.label) then
    return true
  end

  if entry.product_id then
    for index = 1, #variation.options do
      if M.normalize_product_id(variation.options[index].product_id) == entry.product_id then
        return true
      end
    end
  end

  return false
end

local function find_variation_update(variation, updates)
  for index = 1, #updates do
    if update_matches_variation(updates[index], variation) then
      return updates[index]
    end
  end
  return nil
end

local function variation_option_matches(entry, option)
  if entry.product_id and M.normalize_product_id(option.product_id) == entry.product_id then
    return true
  end

  if entry.selector and entry.selector == option.selector then
    return true
  end

  if entry.control_id and entry.control_id == option.control_id then
    return true
  end

  local value = update_entry_value(entry)
  if value ~= nil then
    return update_text_matches(value, option.value)
      or update_text_matches(value, option.label)
      or update_text_matches(value, option.product_id)
      or update_text_matches(value, option.control_id)
  end

  return false
end

local function find_variation_option(variation, entry)
  for index = 1, #variation.options do
    local option = variation.options[index]
    if variation_option_matches(entry, option) then
      return option
    end
  end
  return nil
end

local function append_applied(applied, kind, name, value, ok, reason)
  applied[#applied + 1] = {
    kind = kind,
    name = name,
    value = value,
    ok = ok,
    reason = reason
  }
end

local function apply_variation_update(variation, entry, applied)
  local option = find_variation_option(variation, entry)
  local requested = entry.product_id or update_entry_value(entry)
  if not option then
    append_applied(applied, "variation", variation.id, requested, false, "option_not_found")
    return nil
  end

  local option_product_id = M.normalize_product_id(option.product_id)
  local option_value = option.label or option.value or option_product_id
  if option.selected then
    append_applied(applied, "variation", variation.id, option_value, true, "already_selected")
    return nil
  end

  if option_product_id and option_product_id ~= M.current_product_id() then
    nav.navigate(M.AMAZON_PRODUCT_NAVIGATION_URL_PREFIX .. option_product_id, {})
    append_applied(applied, "variation", variation.id, option_value, true, "product_navigated")
    return "product_navigated"
  end

  local selector = M.non_empty(option.selector)
    or M.selector_for_id(option.control_id)
    or M.non_empty(entry.selector)
    or M.selector_for_id(entry.control_id)
  if not selector then
    append_applied(applied, "variation", variation.id, option_value, false, "control_not_found")
    return nil
  end

  if variation.type == "select" then
    dom.set_value(selector, option.value)
  else
    dom.click(selector)
  end

  append_applied(applied, "variation", variation.id, option_value, true, "update_pending")
  return "update_pending"
end

local function apply_variation_updates(variations, updates, applied)
  for variation_index = 1, #variations do
    local variation = variations[variation_index]
    local entry = find_variation_update(variation, updates)
    if entry then
      local pending = apply_variation_update(variation, entry, applied)
      if pending then
        return pending
      end
    end
  end

  return nil
end

local function form_entry_name(entry)
  return M.non_empty(entry.name or entry.id or entry.field or entry.control)
end

local function form_entry_value(entry)
  if entry.value ~= nil then
    return entry.value
  end
  return entry.selected
end

local function apply_form_update(entry, applied)
  local name = form_entry_name(entry)
  local value = form_entry_value(entry)
  local selector = M.non_empty(entry.selector) or M.selector_for_id(entry.control_id)

  if not selector and name == "quantity" and dom.exists(M.selector_for_id("quantity")) then
    selector = M.selector_for_id("quantity")
  end
  if not selector and name then
    selector = M.selector_for_name(name)
  end

  if not selector then
    append_applied(applied, "form", name, value, false, "control_not_found")
    return
  end

  if value == nil then
    local clicked = dom.click(selector)
    append_applied(applied, "form", name, true, clicked == true, clicked == true and "clicked" or "click_failed")
    return
  end

  local ok = dom.set_value(selector, value)
  append_applied(applied, "form", name, value, ok == true, ok == true and "updated" or "update_failed")
end

local function apply_form_updates(updates, applied)
  for index = 1, #updates do
    apply_form_update(updates[index], applied)
  end
end

local function update_variation_args(args)
  return args.variations or args.variation_values or args.variation or args.options
end

local function update_form_args(args)
  if args.form_values then
    return args.form_values
  end
  if args.values then
    return args.values
  end
  if args.fields then
    return args.fields
  end
  if type(args.form) == "table" and args.form.values then
    return args.form.values
  end
  if type(args.form) == "table" and not args.form.controls then
    return args.form
  end
  return nil
end

local function variation_update_is_satisfied(variation, entry)
  local option = find_variation_option(variation, entry)
  return option and option.selected == true
end

local function variation_updates_are_satisfied(variations, updates)
  if #updates == 0 then
    return false
  end

  local matched = 0
  for update_index = 1, #updates do
    local entry = updates[update_index]
    local found = false
    for variation_index = 1, #variations do
      local variation = variations[variation_index]
      if update_matches_variation(entry, variation) then
        found = true
        matched = matched + 1
        if not variation_update_is_satisfied(variation, entry) then
          return false
        end
        break
      end
    end
    if not found then
      return false
    end
  end

  return matched == #updates
end

function AX_update_product(args)
  args = args or {}
  local requested_product_id = M.normalize_product_id(args.product_id or args.id or args.asin)
  local variation_updates = normalize_update_entries(update_variation_args(args))
  local form_updates = normalize_update_entries(update_form_args(args))
  local current = M.current_product_id()
  local product_id = requested_product_id or current

  if requested_product_id and current and current ~= requested_product_id and dom.exists("span#productTitle") and #variation_updates > 0 then
    local current_variations = M.read_variations()
    if variation_updates_are_satisfied(current_variations, variation_updates) then
      product_id = current
    end
  end

  if not product_id then
    return {
      error = "missing_product_id"
    }
  end

  local page_error = M.ensure_product_page(product_id)
  if page_error then
    return page_error
  end

  local applied = ax.array()
  local pending = nil
  if #variation_updates > 0 then
    pending = apply_variation_updates(M.read_variations(), variation_updates, applied)
  end

  local navigation_retries = 0
  while pending == "product_navigated" and navigation_retries <= #variation_updates do
    navigation_retries = navigation_retries + 1
    pending = apply_variation_updates(M.read_variations(), variation_updates, applied)
  end

  if pending == "product_navigated" then
    pending = "variation_navigation_loop"
  end

  if pending then
    return {
      product_id = M.current_product_id() or product_id,
      applied = applied,
      pending = true,
      error = pending
    }
  end

  if #form_updates > 0 then
    apply_form_updates(form_updates, applied)
  end

  return {
    product_id = M.current_product_id() or product_id,
    applied = applied,
    pending = false,
    product = M.read_product_view(M.current_product_id() or product_id)
  }
end
