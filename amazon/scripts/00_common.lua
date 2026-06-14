AX_AMAZON = {}
local M = AX_AMAZON

M.AMAZON_SEARCH_NAVIGATION_URL = "http://www.amazon.com/s"
M.AMAZON_PRODUCT_NAVIGATION_URL_PREFIX = "http://www.amazon.com/dp/"
M.AMAZON_PRODUCT_URL_PREFIX = "https://www.amazon.com/dp/"
M.RESULT_SELECTOR = '[data-component-type="s-search-result"][data-asin]'
M.RESULT_ADD_TO_CART_SELECTOR = 'button[name="submit.addToCart"], input[name="submit.addToCart"]'
M.RESULT_READY_SELECTOR = M.RESULT_SELECTOR .. ', .s-no-results-result, form[action*="validateCaptcha"]'
M.PRODUCT_READY_SELECTOR = 'span#productTitle, #centerCol, #buybox, form[action*="validateCaptcha"]'
M.CART_NAVIGATION_URL = "http://www.amazon.com/gp/cart/view.html"
M.CART_READY_SELECTOR = '#sc-active-cart, .sc-list-item[data-asin], #sc-empty-cart, #sc-subtotal-label-activecart, form[action*="validateCaptcha"]'
M.ADD_TO_CART_READY_SELECTOR = '#NATC_SMART_WAGON_CONF_MSG_SUCCESS, #attachDisplayAddBaseAlert, #attach-added-to-cart-message, #huc-v2-order-row-confirm-text, #sw-atc-confirmation, form[action*="validateCaptcha"]'
M.RESULT_LIMIT = 24

function M.clean_text(value)
  local text = tostring(value or "")
  text = text:gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", "")
  return text
end

function M.non_empty(value)
  local text = M.clean_text(value)
  if text == "" then
    return nil
  end
  return text
end

function M.normalize_query(value)
  return M.clean_text(value):lower():gsub("%s+", " ")
end

function M.truncate_text(value, limit)
  local text = M.clean_text(value)
  if #text <= limit then
    return text
  end
  return text:sub(1, limit - 1) .. "…"
end

function M.parse_number_text(value)
  local text = tostring(value or "")
  local normalized = text:gsub(",", ""):gsub("%s+", "")
  local number_text = normalized:match("(%d+%.%d+)") or normalized:match("(%d+)")
  if not number_text then
    return nil
  end
  return tonumber(number_text)
end

function M.parse_price(price_text)
  local text = M.clean_text(price_text)
  if text == "" then
    return nil, nil
  end

  local currency = nil
  if text:find("KRW", 1, true) or text:find("₩", 1, true) then
    currency = "KRW"
  elseif text:find("US$", 1, true) or text:find("$", 1, true) then
    currency = "USD"
  elseif text:find("€", 1, true) then
    currency = "EUR"
  elseif text:find("£", 1, true) then
    currency = "GBP"
  elseif text:find("¥", 1, true) then
    currency = "JPY"
  end

  local amount = M.parse_number_text(text)
  return amount, currency
end

function M.parse_rating(rating_text)
  local text = M.clean_text(rating_text)
  local rating = tonumber(text:match("(%d+%.%d+)"))
  if rating and rating <= 5 then
    return rating
  end
  return nil
end

function M.parse_review_count(review_text)
  local text = M.clean_text(review_text)
  if text == "" then
    return nil
  end

  local compact = text:gsub("[%(%),%s]", "")
  local korean_count = tonumber(compact:match("(%d+%.?%d*)만"))
  if korean_count then
    return math.floor(korean_count * 10000)
  end

  local korean_thousand = tonumber(compact:match("(%d+%.?%d*)천"))
  if korean_thousand then
    return math.floor(korean_thousand * 1000)
  end

  local thousand = tonumber(compact:match("(%d+%.?%d*)[kK]"))
  if thousand then
    return math.floor(thousand * 1000)
  end

  return tonumber(compact:match("%d+"))
end

function M.parse_total_count(total_text, fallback)
  local text = tostring(total_text or "")
  local largest = tonumber(fallback or 0) or 0

  for token in text:gmatch("[%d,]+") do
    local digits = token:gsub(",", "")
    local value = tonumber(digits)
    if value and value > largest then
      largest = value
    end
  end

  return largest
end

function M.css_attr_string(value)
  local text = tostring(value or "")
  text = text:gsub("\\", "\\\\"):gsub('"', '\\"')
  return text
end

function M.selector_for_id(id)
  local text = M.non_empty(id)
  if not text then
    return nil
  end
  return '[id="' .. M.css_attr_string(text) .. '"]'
end

function M.selector_for_name(name)
  local text = M.non_empty(name)
  if not text then
    return nil
  end
  return '[name="' .. M.css_attr_string(text) .. '"]'
end

function M.product_url(asin, href)
  local id = M.non_empty(asin)
  if id then
    return M.AMAZON_PRODUCT_URL_PREFIX .. id
  end
  return M.non_empty(href)
end

function M.normalize_product_id(value)
  local text = M.non_empty(value)
  if not text then
    return nil
  end

  local asin = text:match("/dp/([A-Za-z0-9]+)")
    or text:match("/gp/product/([A-Za-z0-9]+)")
    or text:match("[?&]asin=([A-Za-z0-9]+)")
    or text:match("([Bb][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9][A-Za-z0-9])")
  if asin then
    return asin:upper()
  end

  local compact = text:gsub("[^A-Za-z0-9]", "")
  if #compact == 10 then
    return compact:upper()
  end
  return nil
end

function M.current_product_id()
  return M.normalize_product_id(dom.get_attr("#ASIN", "value"))
    or M.normalize_product_id(dom.get_location_href())
end

function M.product_page_matches(product_id)
  local current = M.current_product_id()
  return current == product_id and dom.exists("span#productTitle")
end

function M.navigate_product(product_id)
  nav.navigate(M.AMAZON_PRODUCT_NAVIGATION_URL_PREFIX .. product_id, {})
end

function M.ensure_product_page(product_id)
  M.navigate_product(product_id)
  dom.wait_for_selector(M.PRODUCT_READY_SELECTOR, { timeout = 30000 })

  if dom.exists('form[action*="validateCaptcha"]') then
    return {
      product_id = product_id,
      error = "captcha_required"
    }
  end

  return nil
end

function M.result_fields()
  return {
    asin = { attr = "data-asin" },
    title = { selector = "h2 span" },
    title_alt = { selector = "h2 a span" },
    url = { selector = 'h2 a, a.a-link-normal.s-no-outline, a[href*="/dp/"], a[href*="/gp/product/"]', attr = "href" },
    image_url = { selector = "img.s-image", attr = "src" },
    price_text = { selector = ".a-price .a-offscreen" },
    rating_text = { selector = "i.a-icon-star-small span.a-icon-alt, .a-icon-alt" },
    reviews_text = { selector = 'a[href*="#customerReviews"] span, a[href*="#customerReviews"]' },
    badge = { selector = ".a-badge-text, .s-label-popover-default" },
    sponsored = { selector = '.s-sponsored-label-info-icon, [aria-label="Sponsored"], [aria-label="후원"]', exists = true },
    add_to_cart = { selector = M.RESULT_ADD_TO_CART_SELECTOR, exists = true },
    text = true
  }
end

function M.candidate_from_row(row)
  local asin = M.non_empty(row.asin)
  local title = M.non_empty(row.title) or M.non_empty(row.title_alt)
  if not asin or not title then
    return nil
  end

  local price, currency = M.parse_price(row.price_text)
  local rating = M.parse_rating(row.rating_text)
  local review_count = M.parse_review_count(row.reviews_text)
  local row_text = M.clean_text(row.text)
  local sponsored = row.sponsored == true
    or row_text:find("^Sponsored") ~= nil
    or row_text:find("^후원") ~= nil

  return {
    product_id = asin,
    id = asin,
    name = title,
    url = M.product_url(asin, row.url),
    image_url = M.non_empty(row.image_url),
    price = price,
    price_text = M.non_empty(row.price_text),
    currency = currency,
    rating = rating,
    review_count = review_count,
    badge = M.non_empty(row.badge),
    sponsored = sponsored,
    summary = M.truncate_text(row_text, 280)
  }
end

function M.read_candidates()
  local rows = dom.query_all(M.RESULT_SELECTOR, M.result_fields(), M.RESULT_LIMIT)
  local candidates = ax.array()
  local seen = {}

  for index = 1, #rows do
    local row = rows[index]
    local asin = M.non_empty(row.asin)
    if asin and not seen[asin] and row.add_to_cart == true then
      local candidate = M.candidate_from_row(row)
      if candidate then
        seen[asin] = true
        candidates[#candidates + 1] = candidate
      end
    end
  end

  return candidates
end

function M.read_total_count(fallback)
  local text = M.non_empty(dom.get_text(".s-breadcrumb"))
    or M.non_empty(dom.get_text('[data-component-type="s-result-info-bar"]'))
    or M.non_empty(dom.get_text(".s-result-info-bar"))
    or M.non_empty(dom.get_text(".s-desktop-toolbar"))

  return M.parse_total_count(text, fallback)
end

function M.read_next_cursor()
  return M.non_empty(dom.get_attr("a.s-pagination-next", "href"))
end

function M.looks_like_url(value)
  local text = M.non_empty(value)
  return text and (text:find("^https?://") or text:find("^/"))
end

function M.is_search_page_href(href)
  local value = M.non_empty(href) or ""
  return value:find("/s?", 1, true) ~= nil or value:match("/s$") ~= nil
end

function M.url_param(url, key)
  local value = M.non_empty(url)
  if not value then
    return nil
  end
  return value:match("[?&]" .. key .. "=([^&#]+)")
end

function M.force_full_navigation_url(url)
  local value = M.non_empty(url)
  if not value then
    return nil
  end
  if value:find("^https://www%.amazon%.com") then
    return "http://" .. value:sub(9)
  end
  if value:find("^/") then
    return "http://www.amazon.com" .. value
  end
  return value
end

function M.current_page_matches_query(query)
  if not query or query == "" then
    return true
  end

  local href = M.non_empty(dom.get_location_href()) or ""
  if not M.is_search_page_href(href) then
    return false
  end

  local current_query = M.normalize_query(dom.get_attr("#twotabsearchtextbox", "value"))
  if current_query ~= M.normalize_query(query) then
    return false
  end

  local page = href:match("[%?&]page=(%d+)")
  return not page or page == "1"
end

function M.current_page_matches_cursor(cursor)
  local target = M.non_empty(cursor)
  if not target then
    return true
  end

  local href = M.non_empty(dom.get_location_href()) or ""
  if href == target then
    return true
  end

  if M.is_search_page_href(href) and M.looks_like_url(target) then
    local target_page = M.url_param(target, "page") or "1"
    local current_page = M.url_param(href, "page") or "1"
    local target_query = M.url_param(target, "k")
    local current_query = M.url_param(href, "k")
    return target_page == current_page and (not target_query or target_query == current_query)
  end

  local page = tostring(tonumber(target) or "")
  if page ~= "" and M.is_search_page_href(href) then
    return (M.url_param(href, "page") or "1") == page
  end

  return false
end

function M.navigate_search(query, cursor)
  local target = M.non_empty(cursor)

  if target then
    if M.looks_like_url(target) then
      nav.navigate(M.force_full_navigation_url(target), {})
      return
    end

    local page = tonumber(target)
    if page then
      nav.navigate(M.AMAZON_SEARCH_NAVIGATION_URL, { k = query or "", page = page })
      return
    end
  end

  if query and query ~= "" then
    nav.navigate(M.AMAZON_SEARCH_NAVIGATION_URL, { k = query })
  end
end

function M.first_text(selectors)
  for index = 1, #selectors do
    local value = M.non_empty(dom.get_text(selectors[index]))
    if value then
      return value
    end
  end
  return nil
end

function M.safe_availability(value)
  local text = M.clean_text(value)
  local script_at = text:find("P.when", 1, true)
  if script_at then
    text = text:sub(1, script_at - 1)
  end
  local json_at = text:find("{", 1, true)
  if json_at then
    text = text:sub(1, json_at - 1)
  end
  return M.non_empty(text)
end

function M.read_text_array(selector, limit)
  local rows = dom.query_all(selector, { text = true }, limit)
  local values = ax.array()
  local seen = {}

  for index = 1, #rows do
    local value = M.non_empty(rows[index].text)
    if value and not seen[value] then
      seen[value] = true
      values[#values + 1] = value
    end
  end

  return values
end

function M.append_key_values(target, selector, key_selector, value_selector, limit, seen)
  local rows = dom.query_all(selector, {
    key = { selector = key_selector },
    value = { selector = value_selector }
  }, limit)

  for index = 1, #rows do
    local key = M.non_empty(rows[index].key)
    local value = M.non_empty(rows[index].value)
    if key and value and key ~= value and not seen[key] then
      seen[key] = true
      target[#target + 1] = {
        name = key,
        value = value
      }
    end
  end
end

function M.append_detail_bullets(target, seen)
  local rows = dom.query_all("#detailBullets_feature_div li, #detailBulletsWrapper_feature_div li", { text = true }, 40)
  for index = 1, #rows do
    local text = M.non_empty(rows[index].text)
    if text then
      local key, value = text:match("^(.-)%s*[:：]%s*(.+)$")
      key = M.non_empty(key)
      value = M.non_empty(value)
      if key and value and not seen[key] then
        seen[key] = true
        target[#target + 1] = {
          name = key,
          value = value
        }
      end
    end
  end
end

function M.read_product_details()
  local details = ax.array()
  local seen = {}

  M.append_key_values(details, "#productOverview_feature_div tr, #poExpander tr", "td:first-child, th:first-child", "td:nth-child(2), th:nth-child(2)", 40, seen)
  M.append_key_values(details, "#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr, table.prodDetTable tr", "th", "td", 80, seen)
  M.append_detail_bullets(details, seen)

  return details
end

function M.read_images()
  local rows = dom.query_all("#landingImage, #imgTagWrapperId img, #altImages img, #imageBlock img", {
    url = { attr = "src" },
    alt = { attr = "alt" }
  }, 60)
  local images = ax.array()
  local seen = {}

  for index = 1, #rows do
    local url = M.non_empty(rows[index].url)
    if url and not seen[url] and not url:find("grey%-pixel", 1, false) then
      seen[url] = true
      images[#images + 1] = {
        url = url,
        alt = M.non_empty(rows[index].alt)
      }
    end
  end

  return images
end

function M.read_quantity_options()
  local selected = M.non_empty(dom.get_attr("#quantity", "value"))
  local rows = dom.query_all("#quantity option", {
    value = { attr = "value" },
    text = true
  }, 100)
  local options = ax.array()

  for index = 1, #rows do
    local value = M.non_empty(rows[index].value) or M.non_empty(rows[index].text)
    if value then
      options[#options + 1] = {
        value = value,
        label = M.non_empty(rows[index].text) or value,
        selected = value == selected
      }
    end
  end

  return {
    name = "quantity",
    label = "quantity",
    type = "select",
    selector = M.selector_for_id("quantity"),
    selected = selected,
    options = options
  }
end

function M.split_dimension_heading(value)
  local text = M.clean_text(value)
  local label, selected = text:match("^(.-)%s*[:：]%s*(.+)$")
  return M.non_empty(label) or M.non_empty(text), M.non_empty(selected)
end

function M.clean_option_label(value, price_text)
  local text = M.non_empty(value)
  if not text then
    return nil
  end

  local css_at = text:find("/*", 1, true)
  if css_at then
    text = text:sub(1, css_at - 1)
  end

  local json_at = text:find("{", 1, true)
  if json_at then
    text = text:sub(1, json_at - 1)
  end

  local price = M.non_empty(price_text)
  if price then
    local price_at = text:find(price, 1, true)
    if price_at then
      text = text:sub(1, price_at - 1)
    end
  end

  text = text:gsub("사용 가능한 옵션 보기", "")
  text = text:gsub("현재 사용할 수 없습니다%.", "")
  text = text:gsub("재고 있음", "")
  return M.non_empty(text)
end

function M.option_label(row)
  local price = M.non_empty(row.price_text)
  return M.clean_option_label(row.image_alt, price)
    or M.clean_option_label(row.title_text, price)
    or M.clean_option_label(row.title, price)
    or M.clean_option_label(row.text, price)
end

function M.bool_attr(value)
  local text = tostring(value or ""):lower()
  return text == "true" or text == "1" or text == "selected"
end

function M.append_variation_option(options, row)
  local asin = M.normalize_product_id(row.asin or row.default_asin or row.dp_url or row.value)
  local label = M.option_label(row) or asin
  if not label and not asin then
    return
  end

  local class_name = tostring(row.class_name or "")
  local unavailable = M.bool_attr(row.unavailable)
    or class_name:find("Unavailable") ~= nil
    or class_name:find("unavailable") ~= nil
    or class_name:find("disabled") ~= nil
  local selected = M.bool_attr(row.selected)
    or class_name:find("selected") ~= nil
    or class_name:find("swatchSelect") ~= nil

  local control_id = M.non_empty(row.control_id)
  options[#options + 1] = {
    value = label or asin,
    label = label,
    product_id = asin,
    url = asin and M.product_url(asin, nil) or nil,
    selected = selected,
    available = not unavailable,
    image_url = M.non_empty(row.image_url),
    price_text = M.non_empty(row.price_text),
    control_id = control_id,
    selector = M.selector_for_id(control_id)
  }
end

function M.read_inline_variations()
  local rows = dom.query_all('[id^="inline-twister-row-"]', {
    id = { attr = "id" }
  }, 12)
  local variations = ax.array()

  for index = 1, #rows do
    local row_id = M.non_empty(rows[index].id)
    local dimension = row_id and row_id:match("^inline%-twister%-row%-(.+)$")
    if dimension then
      local heading = M.first_text({
        "#inline-twister-dim-title-" .. dimension,
        "#inline-twister-expander-header-" .. dimension
      })
      local label, selected_value = M.split_dimension_heading(heading or dimension)
      local options = ax.array()
      local option_rows = dom.query_all("#" .. row_id .. " li.inline-twister-swatch", {
        asin = { attr = "data-asin" },
        selected = { attr = "data-initiallyselected" },
        unavailable = { attr = "data-initiallyunavailable" },
        text = true,
        title_text = { selector = ".swatch-title-text" },
        image_alt = { selector = "img", attr = "alt" },
        image_url = { selector = "img", attr = "src" },
        price_text = { selector = ".twister_swatch_price" },
        control_id = { selector = ".a-button-toggle", attr = "id" },
        class_name = { attr = "class" }
      }, 80)

      for option_index = 1, #option_rows do
        M.append_variation_option(options, option_rows[option_index])
      end

      if #options > 0 then
        variations[#variations + 1] = {
          id = dimension,
          label = label,
          selected = selected_value,
          type = "inline_twister",
          options = options
        }
      end
    end
  end

  return variations
end

function M.read_legacy_swatch_options(row_id)
  local options = ax.array()
  local rows = dom.query_all("#" .. row_id .. " li", {
    default_asin = { attr = "data-defaultasin" },
    dp_url = { attr = "data-dp-url" },
    title = { attr = "title" },
    text = true,
    title_text = { selector = ".swatch-title-text" },
    image_alt = { selector = "img", attr = "alt" },
    image_url = { selector = "img", attr = "src" },
    class_name = { attr = "class" }
  }, 80)

  for index = 1, #rows do
    rows[index].asin = rows[index].default_asin or rows[index].dp_url
    rows[index].image_alt = rows[index].image_alt or rows[index].title
    M.append_variation_option(options, rows[index])
  end

  return options
end

function M.read_legacy_select_options(row_id)
  local selected = M.non_empty(dom.get_attr("#" .. row_id .. " select", "value"))
  local rows = dom.query_all("#" .. row_id .. " select option", {
    value = { attr = "value" },
    text = true
  }, 120)
  local options = ax.array()

  for index = 1, #rows do
    local value = M.non_empty(rows[index].value)
    local label = M.non_empty(rows[index].text)
    if value and label and value ~= "-1" then
      local asin = M.normalize_product_id(value)
      local selector = M.selector_for_id(row_id)
      options[#options + 1] = {
        value = value,
        label = label,
        product_id = asin,
        url = asin and M.product_url(asin, nil) or nil,
        selected = value == selected,
        available = true,
        selector = selector and (selector .. " select") or nil
      }
    end
  end

  return options
end

function M.read_legacy_variations()
  local rows = dom.query_all('div[id^="variation_"]', {
    id = { attr = "id" },
    heading = { selector = ".a-form-label, label" },
    selected = { selector = ".selection, .a-color-secondary" }
  }, 12)
  local variations = ax.array()

  for index = 1, #rows do
    local row_id = M.non_empty(rows[index].id)
    local dimension = row_id and row_id:match("^variation_(.+)$")
    if dimension then
      local options = M.read_legacy_swatch_options(row_id)
      local variant_type = "swatch"
      if #options == 0 then
        options = M.read_legacy_select_options(row_id)
        variant_type = "select"
      end

      if #options > 0 then
        local label, selected = M.split_dimension_heading(M.non_empty(rows[index].heading) or dimension)
        variations[#variations + 1] = {
          id = dimension,
          label = label,
          selected = M.non_empty(rows[index].selected) or selected,
          type = variant_type,
          options = options
        }
      end
    end
  end

  return variations
end

function M.read_variations()
  local variations = M.read_inline_variations()
  if #variations > 0 then
    return variations
  end
  return M.read_legacy_variations()
end

function M.read_selected_options(variations)
  local selected = ax.array()
  for index = 1, #variations do
    local variation = variations[index]
    local selected_option = nil
    for option_index = 1, #variation.options do
      local option = variation.options[option_index]
      if option.selected then
        selected_option = option
        break
      end
    end

    if variation.selected or selected_option then
      selected[#selected + 1] = {
        id = variation.id,
        label = variation.label,
        value = variation.selected or selected_option.label or selected_option.value,
        product_id = selected_option and selected_option.product_id or nil
      }
    end
  end
  return selected
end

function M.read_purchase_form(variations)
  local controls = ax.array()
  local quantity = M.read_quantity_options()
  if #quantity.options > 0 then
    controls[#controls + 1] = quantity
  end

  for index = 1, #variations do
    controls[#controls + 1] = {
      name = variations[index].id,
      label = variations[index].label,
      type = "variation",
      selected = variations[index].selected,
      options = variations[index].options
    }
  end

  return {
    id = "addToCart",
    action = M.non_empty(dom.get_attr("#addToCart", "action")),
    method = M.non_empty(dom.get_attr("#addToCart", "method")) or "post",
    controls = controls,
    buttons = {
      add_to_cart = dom.exists("#add-to-cart-button"),
      buy_now = dom.exists("#buy-now-button")
    }
  }
end

function M.read_product_view(product_id)
  local asin = M.current_product_id() or product_id
  local title = M.first_text({ "span#productTitle", "#title span#productTitle", "h1#title" })
  local price_text = M.first_text({
    "#corePrice_feature_div .a-offscreen",
    ".priceToPay .a-offscreen",
    "#price_inside_buybox",
    "#apex_desktop .a-offscreen"
  })
  local price, currency = M.parse_price(price_text)
  local variations = M.read_variations()

  return {
    product_id = asin,
    id = asin,
    title = title,
    name = title,
    url = M.product_url(asin, nil),
    page_url = M.non_empty(dom.get_location_href()),
    brand = M.first_text({ "#bylineInfo", "#brand", "#productOverview_feature_div tr.po-brand td:nth-child(2)" }),
    price = price,
    price_text = M.non_empty(price_text),
    currency = currency,
    unit_price_text = M.first_text({ "#pricePerUnit", ".a-price-unit" }),
    rating = M.parse_rating(M.first_text({ "#acrPopover .a-icon-alt", "#averageCustomerReviews .a-icon-alt" })),
    review_count = M.parse_review_count(M.first_text({ "#acrCustomerReviewText", "#averageCustomerReviews #acrCustomerReviewText" })),
    availability = M.safe_availability(M.first_text({
      "#availability .a-color-success",
      "#availability .a-color-price",
      "#availability .primary-availability-message",
      "#availability",
      ".primary-availability-message"
    })),
    breadcrumbs = M.read_text_array("#wayfinding-breadcrumbs_feature_div a, ul.a-unordered-list.a-horizontal.a-size-small a", 20),
    images = M.read_images(),
    feature_bullets = M.read_text_array("#feature-bullets li:not(.aok-hidden)", 20),
    details = M.read_product_details(),
    variations = variations,
    selected_options = M.read_selected_options(variations),
    form = M.read_purchase_form(variations)
  }
end

function M.first_existing_selector(selectors)
  for index = 1, #selectors do
    local selector = selectors[index]
    if dom.exists(selector) then
      return selector
    end
  end
  return nil
end

function M.cart_page_matches()
  local href = M.non_empty(dom.get_location_href()) or ""
  return href:find("/gp/cart/view.html", 1, true) ~= nil
    or href:find("/cart/view.html", 1, true) ~= nil
    or href:find("/cart?", 1, true) ~= nil
end

function M.navigate_cart()
  nav.navigate(M.CART_NAVIGATION_URL, {})
end

function M.read_cart_count()
  local count_text = M.non_empty(dom.get_text("#nav-cart-count"))
    or M.non_empty(dom.get_text("#sc-subtotal-label-activecart"))
  return M.parse_total_count(count_text, 0)
end

function M.clean_cart_title(value)
  local text = M.clean_text(value)
  text = text:gsub("%s*Opens in a new tab%s*", " ")
  text = M.clean_text(text)
  local half = math.floor(#text / 2)
  if half > 0 and text:sub(1, half) == text:sub(half + 1) then
    text = text:sub(1, half)
  end
  return M.non_empty(text)
end

function M.cart_variations_from_texts(texts)
  local variations = ax.array()
  if type(texts) ~= "table" then
    return variations
  end

  for index = 1, #texts do
    local text = M.non_empty(texts[index])
    if text then
      local name, value = text:match("^(.-)%s*[:：]%s*(.+)$")
      name = M.non_empty(name)
      value = M.non_empty(value)
      if name and value then
        variations[#variations + 1] = {
          name = name,
          value = value
        }
      end
    end
  end

  return variations
end

function M.cart_item_from_row(row)
  local asin = M.normalize_product_id(row.asin or row.url)
  local price_text = M.non_empty(row.price_text)
  local price = tonumber(row.price_attr)
  local currency = nil
  if not price then
    price, currency = M.parse_price(price_text)
  else
    local ignored
    ignored, currency = M.parse_price(price_text)
  end

  return {
    product_id = asin,
    id = asin,
    item_id = M.non_empty(row.item_id),
    title = M.clean_cart_title(row.title),
    name = M.clean_cart_title(row.title),
    url = M.product_url(asin, row.url),
    image_url = M.non_empty(row.image_url),
    price = price,
    price_text = price_text,
    currency = currency,
    quantity = tonumber(row.quantity) or M.parse_total_count(row.quantity_text, 0),
    availability = M.safe_availability(row.availability),
    variations = M.cart_variations_from_texts(row.variations),
    out_of_stock = tostring(row.out_of_stock or "") == "1"
  }
end

function M.read_cart_items()
  local rows = dom.query_all(".sc-list-item[data-asin]", {
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
  }, 200)
  local items = ax.array()
  local seen = {}

  for index = 1, #rows do
    local item = M.cart_item_from_row(rows[index])
    local key = item.item_id or item.product_id or tostring(index)
    if item.product_id and not seen[key] then
      seen[key] = true
      items[#items + 1] = item
    end
  end

  return items
end

function M.read_cart_subtotal()
  local text = M.non_empty(dom.get_text("#sc-subtotal-amount-activecart .a-offscreen"))
    or M.non_empty(dom.get_text("#sc-subtotal-amount-activecart"))
    or M.non_empty(dom.get_text("[data-name='Subtotals']"))
  local amount, currency = M.parse_price(text)
  return {
    amount = amount,
    currency = currency,
    text = text
  }
end

function M.read_cart_view()
  local items = M.read_cart_items()
  local subtotal = M.read_cart_subtotal()
  return {
    url = M.non_empty(dom.get_location_href()),
    item_count = M.read_cart_count(),
    items = items,
    subtotal = subtotal.amount,
    subtotal_text = subtotal.text,
    currency = subtotal.currency,
    empty = #items == 0
  }
end
