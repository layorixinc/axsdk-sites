--- The guarded cart, from the runtime.
---
--- This is the one place in this repo where a mistake spends the user's money, so almost all of it is
--- about what must NOT happen: no click without every approval marker, none after the product turned out
--- to be a different model, none after the price went up, and never anything that orders.
---
--- The durable adapter answered `pending: true, status: "navigating"` in THREE places — before the product
--- page, after the add, and on the way to the cart — each time because a navigation destroyed its context
--- and the flow had to call it again. A runtime script keeps its stack across the reload, so a single call
--- navigates, revalidates, adds and confirms. That answer does not exist here.
---
--- One implementation, driven by each site's config. Amazon's cart used to be a second bespoke script; the
--- pieces that made it special (a protection-plan upsell to decline, a cart counter to compare) are config
--- keys, not code.

AX_RPC_CART = AX_RPC_CART or {}
local R = AX_RPC_CART

local function trim(value)
  if type(value) ~= "string" then return nil end
  local text = value:gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", "")
  return text ~= "" and text or nil
end

local function lower(value)
  return tostring(value or ""):lower()
end

--- Every wire access goes through these: any op can be refused while the channel re-attaches, and on this
--- path a raised error would abandon a cart action halfway with nothing to report.
local function probe(fn, attempts)
  for attempt = 1, (attempts or 2) do
    local ok, value = pcall(fn)
    if ok then return value end
    if attempt == (attempts or 2) then return nil end
  end
  return nil
end

local function exists(selector) return probe(function() return dom.exists(selector) end) == true end
local function text_of(selector) return probe(function() return dom.get_text(selector) end) end
local function attr_of(selector, name) return probe(function() return dom.get_attr(selector, name) end) end
local function click(selector) return probe(function() return dom.click(selector) end) == true end
local function set_value(selector, value)
  return probe(function() return dom.set_value(selector, value) end) == true
end
local function wait_for(selector, timeout)
  return probe(function()
    return dom.wait_for_selector(selector, { timeout = timeout or 8000, interval = 200 })
  end) == true
end
local function here()
  return probe(function() return dom.get_location_href() end, 3)
end

--- The first selector in `list` that resolves, or nil.
local function first_existing(list)
  for index = 1, #(list or {}) do
    if exists(list[index]) then return list[index] end
  end
  return nil
end

local function first_text(list)
  for index = 1, #(list or {}) do
    local text = trim(text_of(list[index]))
    if text then return text end
  end
  return nil
end

function R.product_id(config, text)
  local patterns = config.product_id_patterns or {}
  local subject = tostring(text or "")
  for index = 1, #patterns do
    local id = subject:match(patterns[index])
    if id then return id end
  end
  return nil
end

function R.product_url(config, product_id)
  return tostring(config.product_url_prefix or "") .. tostring(product_id)
    .. tostring(config.product_url_suffix or "")
end

--- The wall this site puts up, in its own words. `kind` is a finite branch key; `reason` is the site's.
function R.access_error(config, href)
  local low = lower(href)
  for index = 1, #(config.blocked_urls or {}) do
    local item = config.blocked_urls[index]
    if low:find(lower(item.text), 1, true) then return "blocked", item.error or "access_denied" end
  end
  for index = 1, #(config.login_urls or {}) do
    if low:find(lower(config.login_urls[index]), 1, true) then return "login", "login_required" end
  end
  for index = 1, #(config.blocked_selectors or {}) do
    local item = config.blocked_selectors[index]
    if exists(item.selector) then return "blocked", item.error or "access_denied" end
  end
  if config.login_selector and exists(config.login_selector) then return "login", "login_required" end
  return nil, nil
end

function R.on_product_page(config, product_id)
  return R.product_id(config, here()) == tostring(product_id)
    and first_existing(config.product_title_selectors or {}) ~= nil
end

--- Whether the cart now lists this product. The confirmation panel counts, and so does the cart page
--- listing the id; anything else is "not confirmed", never "probably fine".
function R.cart_contains(config, product_id)
  if config.confirmation_selector and exists(config.confirmation_selector) then return true end
  local href = here()
  local on_cart = false
  for index = 1, #(config.cart_url_markers or {}) do
    if tostring(href or ""):find(config.cart_url_markers[index], 1, true) then on_cart = true end
  end
  if not on_cart then return false end
  local id = tostring(product_id or ""):gsub('["\\]', "")
  if id == "" then return false end
  return exists('a[href*="' .. id .. '"], [data-product-id="' .. id .. '"], [data-item-id="' .. id .. '"]')
end

--- The model the user approved must still be the model on the page. An id can outlive a listing's product.
function R.identity_error(config, args, product_id)
  local expected = trim(args.expected_identity_model)
  if not expected then return nil end
  local title = first_text(config.product_title_selectors or {})
  if not title then
    return { product_id = product_id, added = false, error = "identity_revalidation_failed",
             expected_identity_model = expected }
  end
  local observed = lower(title):gsub("[^%w]+", "")
  local wanted = lower(expected):gsub("[^%w]+", "")
  if wanted == "" or not observed:find(wanted, 1, true) then
    return { product_id = product_id, added = false, error = "identity_changed",
             expected_identity_model = expected, current_product_title = title }
  end
  return nil
end

--- The guard is against paying MORE than what was compared — a lower price is not a problem.
function R.price_error(config, args, product_id)
  local expected_price = tonumber(args.expected_unit_price)
  local expected_currency = trim(args.expected_currency)
  if not expected_price and not expected_currency then return nil end

  local price_text = first_text(config.product_price_selectors or {})
  local current, currency = AX_RPC_STOREFRONT.parse_money(price_text, config.default_currency)
  if not current or not currency then
    return { product_id = product_id, added = false, error = "price_revalidation_failed",
             current_price_text = price_text }
  end
  if expected_currency and currency:upper() ~= expected_currency:upper() then
    return { product_id = product_id, added = false, error = "currency_changed",
             expected_currency = expected_currency:upper(), current_currency = currency:upper(),
             current_price = current, current_price_text = price_text }
  end
  if expected_price and current > expected_price + 0.005 then
    return { product_id = product_id, added = false, error = "price_changed",
             expected_unit_price = expected_price, current_price = current,
             current_currency = currency, current_price_text = price_text }
  end
  return nil
end

--- A variation the site requires and nobody chose. Adding the default would be a different product.
function R.variation_error(config, product_id)
  for index = 1, #(config.required_option_selectors or {}) do
    local selector = config.required_option_selectors[index]
    if exists(selector) and not trim(attr_of(selector, "value")) then
      return { product_id = product_id, added = false, error = "variation_required" }
    end
  end
  return nil
end

--- The cart's item count, when the site shows one. Compared before and after so "the click did something"
--- is observable even on a site whose confirmation panel we cannot read.
function R.cart_count(config)
  local text = first_text(config.cart_count_selectors or {})
  return text and tonumber((text:gsub("[^%d]", ""))) or nil
end

--- Adds ONE approved offer to the cart. Never checks out and never orders.
---
--- The approval markers are checked first and cost no round trip: a call that should not touch the page
--- must not touch it.
function R.add_to_cart(args)
  args = type(args) == "table" and args or {}
  local config = type(args.config) == "table" and args.config or nil
  if not config then
    local site = trim(args.site)
    config = site and type(RPC_SITES) == "table" and RPC_SITES[site] or nil
  end
  -- Two callers, two gates, and BOTH are gates. The multi-store flow approves a compared OFFER, so it must
  -- carry the identity and comparison markers with it. The single-site flow has no comparison at all: its
  -- gate is the step where the user picks one product out of the searched list. Requiring comparison
  -- markers there would break a flow that never had a comparison; accepting a call with no marker at all
  -- would leave the guard off for half the callers.
  local approval = args.cart_approval
  if approval ~= "user_selected_compared_offer" and approval ~= "user_picked_searched_product" then
    return { next = "error", added = false, error = "approval_required" }
  end
  if approval == "user_selected_compared_offer"
    and (not trim(args.identity_id) or args.identity_approval ~= "locked_product_identity"
      or not trim(args.comparison_id) or args.comparison_approval ~= "current_comparison") then
    return { next = "error", added = false, error = "identity_approval_required" }
  end
  if not config then
    return { next = "error", added = false, error = trim(args.site) and "site_not_ported" or "missing_site" }
  end
  if config.cart_supported == false then
    return { next = "error", site = config.site, added = false, error = "add_to_cart_unsupported" }
  end

  local product_id = R.product_id(config, args.product_id or args.id) or trim(args.product_id) or trim(args.id)
  if not product_id then
    return { next = "error", site = config.site, added = false, error = "missing_product_id" }
  end

  local function refuse(result)
    result.next = "error"
    result.site = config.site
    result.added = false
    return result
  end

  if not R.cart_contains(config, product_id) then
    if not R.on_product_page(config, product_id) then
      local from = here()
      probe(function() return nav.navigate(R.product_url(config, product_id)) end)
      probe(function()
        return nav.wait_for_navigation(from, { timeout = 15000, interval = 250 })
      end)
      wait_for("body", config.product_timeout or 10000)
    end

    -- The wall is read on the page we actually landed on, before anything is touched.
    local kind, reason = R.access_error(config, here())
    if kind == "blocked" then
      return refuse({ product_id = product_id, error = reason, blocked = true })
    end
    if kind == "login" then
      return refuse({ product_id = product_id, status = "login_required", login_required = true,
                      error = "login_required" })
    end
    if not R.on_product_page(config, product_id) then
      return refuse({ product_id = product_id, error = "product_navigation_failed", href = here() })
    end

    local wrong_identity = R.identity_error(config, args, product_id)
    if wrong_identity then return refuse(wrong_identity) end
    local wrong_price = R.price_error(config, args, product_id)
    if wrong_price then return refuse(wrong_price) end
    local needs_choice = R.variation_error(config, product_id)
    if needs_choice then return refuse(needs_choice) end

    local quantity = math.max(1, math.floor(tonumber(args.quantity) or 1))
    if quantity > 1 then
      local selector = first_existing(config.quantity_selectors or {})
      -- Adding one unit when three were approved is the wrong order, quietly.
      if not selector then return refuse({ product_id = product_id, error = "quantity_unavailable" }) end
      set_value(selector, tostring(quantity))
    end

    local before = R.cart_count(config)
    local add_selector = first_existing(config.add_selectors or {})
    if not add_selector then
      return refuse({ product_id = product_id, error = "add_to_cart_unavailable" })
    end
    if not click(add_selector) then
      return refuse({ product_id = product_id, error = "click_failed" })
    end
    if config.add_ready_selector then wait_for(config.add_ready_selector, config.product_timeout or 8000) end

    -- An optional upsell pane ("add a protection plan") stands between the click and the confirmation.
    -- Declining is the default: nobody approved a second product.
    if config.upsell_pane_selector and exists(config.upsell_pane_selector) then
      if config.upsell_decline_selector then click(config.upsell_decline_selector) end
      if config.confirmation_selector then wait_for(config.confirmation_selector, 8000) end
    end

    if not R.cart_contains(config, product_id) and config.cart_url then
      local from = here()
      probe(function() return nav.navigate(config.cart_url) end)
      probe(function() return nav.wait_for_navigation(from, { timeout = 15000, interval = 250 }) end)
      wait_for("body", config.product_timeout or 10000)
    end
    R.last_count_before = before
  end

  local kind, reason = R.access_error(config, here())
  if kind == "blocked" then return refuse({ product_id = product_id, error = reason, blocked = true }) end
  if kind == "login" then
    return refuse({ product_id = product_id, status = "login_required", login_required = true,
                    error = "login_required" })
  end

  local confirmed = R.cart_contains(config, product_id)
  return {
    -- The flow enumerates `done` and `error`; a click the site never confirmed is not `done`, because
    -- reporting it would tell the user a cart line exists that does not.
    next = confirmed and "done" or "error",
    site = config.site,
    product_id = product_id,
    added = confirmed,
    error = (not confirmed) and "add_to_cart_pending" or nil,
    previous_cart_count = R.last_count_before,
    cart_count = R.cart_count(config),
    confirmation = confirmed
      and (first_text(config.confirmation_text_selectors or {}) or "Added to cart") or nil,
    cart_url = confirmed and here() or nil,
  }
end
