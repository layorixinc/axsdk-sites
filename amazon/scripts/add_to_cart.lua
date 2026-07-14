local M = AX_AMAZON
if not M then
  error("amazon/scripts/00_common.lua must be loaded before add_to_cart.lua")
end

local function has_update_args(args)
  -- A bare quantity is applied directly on the buy box in the add path (no AX_update_product
  -- navigation + full product-view read); only real variation/form changes need the update flow.
  return args.variations ~= nil
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

local function product_is_confirmed(product_id)
  if M.cart_page_matches() then
    local asin = tostring(product_id or ""):gsub("[^%w]", "")
    return asin ~= "" and dom.exists('.sc-list-item[data-asin="' .. asin .. '"]')
  end
  return dom.exists(M.ADD_TO_CART_CONFIRM_SELECTOR)
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

  -- A durable replay re-enters AFTER the add navigated off the product page (to the confirmation/cart or
  -- a login/captcha interstitial). Re-applying updates or re-navigating there would undo the add or bounce
  -- off the result page, so only update + add while we have NOT yet landed on a post-add page; otherwise
  -- fall through to read the result. This check MUST precede apply_update_args (which navigates).
  local post_add = product_is_confirmed(product_id)
    or M.is_login_page()
    or dom.exists('form[action*="validateCaptcha"]')

  local before_count = M.read_cart_count()

  if not post_add then
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
    before_count = M.read_cart_count()

    local page_error = M.ensure_product_page(product_id)
    if page_error then
      return page_error
    end

    -- Add the item while on the product page. The add click (and the optional "Add to your order"
    -- protection-plan sidesheet) navigates to the confirmation page; the post_add guard above lets a
    -- durable replay fall through to read the result instead of re-evaluating the buy box.
    if M.product_page_matches(product_id) then
      local expected_price = tonumber(args.expected_unit_price)
      local expected_currency = M.non_empty(args.expected_currency)
      if expected_price or expected_currency then
        local current = M.read_product_view(product_id)
        if not current.price or not current.currency then
          return {
            product_id = product_id,
            added = false,
            error = "price_revalidation_failed",
            current_price_text = current.price_text
          }
        end
        if expected_currency and current.currency:upper() ~= expected_currency:upper() then
          return {
            product_id = product_id,
            added = false,
            error = "currency_changed",
            expected_currency = expected_currency:upper(),
            current_currency = current.currency:upper(),
            current_price = current.price,
            current_price_text = current.price_text
          }
        end
        if expected_price and current.price > expected_price + 0.005 then
          return {
            product_id = product_id,
            added = false,
            error = "price_changed",
            expected_unit_price = expected_price,
            current_price = current.price,
            current_currency = current.currency,
            current_price_text = current.price_text
          }
        end
      end
      -- Apply a non-default quantity directly on the buy box (avoids AX_update_product's extra
      -- navigation + product-view read). Quantity may arrive as a float (e.g. 1.0), so compare numerically.
      local qty = tonumber(M.non_empty(args.quantity))
      if qty and qty > 1 and dom.exists("#quantity") then
        dom.set_value("#quantity", tostring(math.floor(qty)))
      end

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

      dom.wait_for_selector(M.ADD_TO_CART_READY_SELECTOR, { timeout = 8000 })

      -- Decline the optional "Add to your order" protection-plan sidesheet by default.
      if dom.exists(M.ATTACH_PANE_SELECTOR) then
        dom.click(M.ATTACH_DECLINE_SELECTOR)
        dom.wait_for_selector(M.ADD_TO_CART_CONFIRM_SELECTOR, { timeout = 8000 })
      end
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

  local confirmed = product_is_confirmed(product_id)
  local add_error = nil
  if not confirmed then add_error = "add_to_cart_pending" end
  local confirmation = nil
  if confirmed then
    confirmation = add_confirmation_text()
  end

  return {
    product_id = M.current_product_id() or product_id,
    added = confirmed,
    pending = not confirmed,
    error = add_error,
    previous_cart_count = before_count,
    cart_count = M.read_cart_count(),
    confirmation = confirmation
  }
end
