local M = AX_AMAZON
if not M then
  error("amazon/scripts/00_common.lua must be loaded before update_cart.lua")
end

local function normalize_quantity(value)
  local number = tonumber(value)
  if not number then
    return nil
  end
  if number < 0 then
    return nil
  end
  return math.floor(number)
end

local function cart_row_selector(product_id)
  return '.sc-list-item[data-asin="' .. M.css_attr_string(product_id) .. '"]'
end

local function scoped(row_selector, selector)
  return row_selector .. ' ' .. selector
end

local function read_cart_item(product_id)
  local rows = dom.query_all(cart_row_selector(product_id), {
    asin = { attr = "data-asin" },
    item_id = { attr = "data-itemid" },
    price_attr = { attr = "data-price" },
    quantity = { attr = "data-quantity" },
    out_of_stock = { attr = "data-outofstock" },
    title = { selector = ".sc-product-title .a-truncate-cut, .a-truncate-cut, .sc-grid-item-product-title, .sc-product-title" },
    url = { selector = "a.sc-product-link, a[href*='/dp/'], a[href*='/gp/product/']", attr = "href" },
    image_url = { selector = "img.sc-product-image", attr = "src" },
    price_text = { selector = ".sc-product-price .a-offscreen, .a-price .a-offscreen, .sc-price" },
    quantity_text = { selector = ".sc-action-quantity" },
    availability = { selector = ".sc-product-availability, .a-color-success, .a-color-price" },
    variations = { selector = ".sc-product-variation", all = true }
  }, 1)

  if #rows == 0 then
    return nil
  end
  return M.cart_item_from_row(rows[1])
end

local function delete_cart_item(product_id, row_selector)
  local delete_selector = scoped(row_selector, 'input[name^="submit.delete-active."], input[data-feature-id="item-delete-button"]')
  if not dom.exists(delete_selector) then
    return false, "delete_control_not_found"
  end

  local clicked = dom.click(delete_selector)
  if clicked ~= true then
    return false, "delete_click_failed"
  end

  dom.wait_for_selector(M.CART_READY_SELECTOR, { timeout = 30000 })
  if dom.exists(row_selector) then
    return true, "delete_pending"
  end
  return true, "deleted"
end

local function set_cart_quantity(product_id, row_selector, quantity)
  local text_selector = scoped(row_selector, 'input.sc-quantity-textfield[name="quantityBox"], input[name="quantityBox"]')
  local select_selector = scoped(row_selector, 'select[name="quantity"], select[id*="quantity"]')
  local update_selector = scoped(row_selector, '[data-action="update"], .sc-quantity-update-button input, .sc-quantity-update-button a')

  if dom.exists(text_selector) then
    local set_ok = dom.set_value(text_selector, tostring(quantity))
    if set_ok ~= true then
      return false, "quantity_update_failed"
    end
  elseif dom.exists(select_selector) then
    local set_ok = dom.set_value(select_selector, tostring(quantity))
    if set_ok ~= true then
      return false, "quantity_update_failed"
    end
  else
    return false, "quantity_control_not_found"
  end

  if dom.exists(update_selector) then
    dom.click(update_selector)
  end

  dom.wait_for_selector(M.CART_READY_SELECTOR, { timeout = 30000 })
  return true, "updated"
end

function AX_update_cart(args)
  args = args or {}
  local product_id = M.normalize_product_id(args.product_id or args.id or args.asin)
  local quantity = normalize_quantity(args.quantity)

  if not product_id then
    return {
      error = "missing_product_id"
    }
  end

  if quantity == nil then
    return {
      product_id = product_id,
      error = "invalid_quantity"
    }
  end

  local navigated = M.navigate_cart_if_needed()
  if navigated then
    return {
      product_id = product_id,
      quantity = quantity,
      pending = true,
      error = "navigation_pending"
    }
  end

  dom.wait_for_selector(M.CART_READY_SELECTOR, { timeout = 30000 })

  if dom.exists('form[action*="validateCaptcha"]') then
    return {
      product_id = product_id,
      quantity = quantity,
      error = "captcha_required"
    }
  end

  local row_selector = cart_row_selector(product_id)
  local before = read_cart_item(product_id)
  if not before then
    if quantity == 0 then
      return {
        product_id = product_id,
        requested_quantity = quantity,
        ok = true,
        reason = "already_absent",
        pending = false,
        cart = M.read_cart_view()
      }
    end

    return {
      product_id = product_id,
      quantity = quantity,
      error = "product_not_in_cart",
      cart = M.read_cart_view()
    }
  end

  local ok, reason
  if quantity == 0 then
    ok, reason = delete_cart_item(product_id, row_selector)
  else
    ok, reason = set_cart_quantity(product_id, row_selector, quantity)
  end

  local after = read_cart_item(product_id)
  local pending = reason == "delete_pending"
    or (quantity > 0 and after and after.quantity ~= quantity)

  return {
    product_id = product_id,
    requested_quantity = quantity,
    ok = ok == true,
    reason = reason,
    pending = pending,
    before = before,
    after = after,
    cart = M.read_cart_view()
  }
end
