local M = AX_AMAZON
if not M then
  error("amazon/scripts/00_common.lua must be loaded before add_to_cart.lua")
end

local function has_update_args(args)
  return args.quantity ~= nil
    or args.variations ~= nil
    or args.variation_values ~= nil
    or args.variation ~= nil
    or args.options ~= nil
    or args.form_values ~= nil
    or args.values ~= nil
    or args.fields ~= nil
    or args.form ~= nil
end

local function apply_update_args(args)
  if not has_update_args(args) then
    return nil
  end

  if type(AX_update_product) == "function" then
    local updated = AX_update_product(args)
    if updated and (updated.pending or updated.error) then
      return updated
    end
    local quantity = M.non_empty(args.quantity)
    if quantity and dom.exists("#quantity") then
      dom.set_value("#quantity", quantity)
    end
    return nil
  end

  local quantity = M.non_empty(args.quantity)
  if quantity and dom.exists("#quantity") then
    dom.set_value("#quantity", quantity)
  end
  return nil
end

local function add_button_selector()
  return M.first_existing_selector({
    "#add-to-cart-button",
    'input[name="submit.add-to-cart"]',
    '#submit.add-to-cart input',
    'input[name="submit.addToCart"]'
  })
end

local function add_confirmation_text()
  return M.first_text({
    "#NATC_SMART_WAGON_CONF_MSG_SUCCESS",
    "#attachDisplayAddBaseAlert",
    "#attach-added-to-cart-message",
    "#huc-v2-order-row-confirm-text",
    "#sw-atc-confirmation",
    "#ewc-content"
  })
end

function AX_add_to_cart(args)
  args = args or {}
  local requested_product_id = M.normalize_product_id(args.product_id or args.id or args.asin)
  local product_id = requested_product_id or M.current_product_id()
  if not product_id then
    return {
      error = "missing_product_id"
    }
  end

  local update_result = apply_update_args(args)
  if update_result then
    return {
      product_id = update_result.product_id or product_id,
      pending = update_result.pending == true,
      error = update_result.error,
      update = update_result
    }
  end

  product_id = requested_product_id or M.current_product_id() or product_id
  local page_error = M.ensure_product_page(product_id)
  if page_error then
    return page_error
  end

  local before_count = M.read_cart_count()

  -- Add the item while on the product page. The add click (and the optional
  -- "Add to your order" protection-plan sidesheet) navigates to the confirmation
  -- page, so on a durable replay we re-enter here off the product page and fall
  -- through to read the result instead of re-evaluating the buy box.
  if M.product_page_matches(product_id) then
    local selector = add_button_selector()
    if not selector then
      return {
        product_id = M.current_product_id() or product_id,
        error = "add_to_cart_unavailable"
      }
    end

    local clicked = dom.click(selector)
    if clicked ~= true then
      return {
        product_id = M.current_product_id() or product_id,
        added = false,
        error = "click_failed"
      }
    end

    dom.wait_for_selector(M.ADD_TO_CART_READY_SELECTOR, { timeout = 30000 })

    -- Decline the optional "Add to your order" protection-plan sidesheet by default.
    if dom.exists(M.ATTACH_PANE_SELECTOR) then
      dom.click(M.ATTACH_DECLINE_SELECTOR)
      dom.wait_for_selector(M.ADD_TO_CART_CONFIRM_SELECTOR, { timeout = 30000 })
    end
  end

  if dom.exists('form[action*="validateCaptcha"]') then
    return {
      product_id = M.current_product_id() or product_id,
      added = false,
      error = "captcha_required"
    }
  end

  if M.is_login_page() then
    return M.login_required_result()
  end

  local confirmed = dom.exists(M.ADD_TO_CART_CONFIRM_SELECTOR)
  local confirmation = nil
  if confirmed then
    confirmation = add_confirmation_text()
  end

  return {
    product_id = M.current_product_id() or product_id,
    added = confirmed,
    pending = not confirmed,
    error = (not confirmed) and "add_to_cart_pending" or nil,
    previous_cart_count = before_count,
    cart_count = M.read_cart_count(),
    confirmation = confirmation
  }
end
