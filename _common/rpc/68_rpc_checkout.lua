--- The checkout REVIEW, from the runtime.
---
--- This takes the user to the page where the order total, the address and the payment method are shown,
--- and stops. It exists so a person can decide — so the one thing it must never do is decide for them.
--- `#submitOrderButtonId` and its siblings are READ, to report whether the button is there, and never
--- clicked.
---
--- It lives in its own module so the cart module stays provably order-free: `check:flows` asserts the
--- cart's code contains no checkout or order words at all, and that only holds while the checkout is here.
---
--- The durable version guarded its first step with a re-entry check ("are we already on the checkout
--- page?") because a replay that re-navigated to the cart would undo the click. One runtime call cannot
--- replay, but it can still be invoked while already there, so the check stays.

AX_RPC_CHECKOUT = AX_RPC_CHECKOUT or {}
local K = AX_RPC_CHECKOUT

local function trim(value)
  if type(value) ~= "string" then return nil end
  local text = value:gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", "")
  return text ~= "" and text or nil
end

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
local function click(selector) return probe(function() return dom.click(selector) end) == true end
local function here() return probe(function() return dom.get_location_href() end, 3) end
local function wait_for(selector, timeout)
  return probe(function()
    return dom.wait_for_selector(selector, { timeout = timeout or 30000, interval = 250 })
  end) == true
end

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

local function url_has(href, markers)
  local low = tostring(href or ""):lower()
  for index = 1, #(markers or {}) do
    if low:find(tostring(markers[index]):lower(), 1, true) then return true end
  end
  return false
end

--- The wall this site puts up, in its own words.
function K.access_error(config, href)
  local low = tostring(href or ""):lower()
  for index = 1, #(config.blocked_urls or {}) do
    local item = config.blocked_urls[index]
    if low:find(tostring(item.text):lower(), 1, true) then return "blocked", item.error or "access_denied" end
  end
  for index = 1, #(config.login_urls or {}) do
    if low:find(tostring(config.login_urls[index]):lower(), 1, true) then return "login", "login_required" end
  end
  for index = 1, #(config.blocked_selectors or {}) do
    local item = config.blocked_selectors[index]
    if exists(item.selector) then return "blocked", item.error or "access_denied" end
  end
  if config.login_selector and exists(config.login_selector) then return "login", "login_required" end
  return nil, nil
end

function K.on_checkout_page(config)
  if url_has(here(), config.checkout_url_markers) then return true end
  return first_existing(config.checkout_review_selectors or config.place_order_selectors or {}) ~= nil
    or (config.checkout_summary_selector ~= nil and exists(config.checkout_summary_selector))
end

--- Whether the page still offers a place-order button. READ ONLY — the answer is what the user needs in
--- order to decide, and pressing it is not this tool's business.
function K.place_order_available(config)
  return first_existing(config.place_order_selectors or {}) ~= nil
end

--- The order totals, keyed by the labels the page itself used.
function K.order_summary(config)
  local text = config.checkout_summary_selector and trim(text_of(config.checkout_summary_selector))
  if not text then return nil end
  local function value(label)
    local at = text:find(label, 1, true)
    if not at then return nil end
    return trim(text:sub(at + #label):match("^%s*([^%a]*%d[%d%.,]*)") or nil)
  end
  local summary = {
    items = value("Items:"),
    shipping_handling = value("Shipping & handling:"),
    estimated_tax = value("Estimated tax to be collected:"),
    order_total = value("Order total:"),
  }
  -- An empty table reads downstream as "a summary exists", and the terminal then has nothing to say about a
  -- total it never saw. Measured live: amazon's current pipeline has no `#subtotals` at all.
  if next(summary) == nil then return nil end
  return summary
end

--- `dom.get_text` is textContent, so a partially loaded panel arrives with its inline <script> source
--- attached. Measured live on amazon's payment panel: reporting that to the user as their payment method is
--- nonsense, so the text is cut at the first script marker.
K.SCRIPT_MARKERS = { "//<![CDATA[", "(function", "function(", "PaymentsPortal", "<![CDATA[", "{" }

--- Phrases a panel shows while it is still resolving. Measured live: amazon's payment panel answered
--- "Payment method Setting your payment method... Payment method" — its own label plus a loading sentence.
--- Printing that as the user's payment method is worse than saying nothing, because it looks like an
--- answer. A value nobody read is nil.
K.UNRESOLVED = { "setting your payment method", "loading", "please wait" }

function K.clean_panel(text)
  local subject = trim(text)
  if not subject then return nil end
  local cut = nil
  for index = 1, #K.SCRIPT_MARKERS do
    local at = subject:find(K.SCRIPT_MARKERS[index], 1, true)
    if at and (not cut or at < cut) then cut = at end
  end
  local cleaned = trim(cut and subject:sub(1, cut - 1) or subject)
  if not cleaned then return nil end
  local low = cleaned:lower()
  for index = 1, #K.UNRESOLVED do
    if low:find(K.UNRESOLVED[index], 1, true) then return nil end
  end
  return cleaned
end
function K.delivering_to(config)
  local text = config.checkout_delivering_to_selector and trim(text_of(config.checkout_delivering_to_selector))
  if not text then return nil end
  return trim(text:match("^[Dd]elivering to%s*(.+)$")) or text
end

function K.read_review(config)
  return {
    url = here(),
    delivering_to = K.delivering_to(config),
    shipping_address = config.checkout_address_selector and trim(text_of(config.checkout_address_selector)) or nil,
    payment_method = K.clean_panel(first_text(config.checkout_payment_selectors or {})),
    order_summary = K.order_summary(config),
    place_order_available = K.place_order_available(config),
  }
end

--- Takes the browser to the checkout review page and reads it. Never places an order.
function K.review(args)
  args = type(args) == "table" and args or {}
  local config = type(args.config) == "table" and args.config or nil
  if not config then
    local site = trim(args.site) or "amazon"
    config = type(RPC_SITES) == "table" and RPC_SITES[site] or nil
  end
  if not config then return { next = "error", error = "site_not_ported" } end

  if not K.on_checkout_page(config) then
    if not url_has(here(), config.cart_url_markers) then
      local from = here()
      probe(function() return nav.navigate(config.cart_url) end)
      probe(function() return nav.wait_for_navigation({ timeout = 20000, interval = 250 }) end)
    end
    if config.cart_ready_selector then wait_for(config.cart_ready_selector, 30000) end

    local kind, reason = K.access_error(config, here())
    if kind == "blocked" then return { next = "error", error = reason } end
    if kind == "login" then
      return { next = "error", status = "login_required", login_required = true, error = "login_required" }
    end

    if url_has(here(), config.cart_url_markers) then
      -- An empty cart has nothing to review, and a cart with no checkout control cannot be reviewed. Both
      -- are answers, and neither is a click.
      local empty = config.cart_empty_selector and exists(config.cart_empty_selector)
      local items = config.cart_item_selector and exists(config.cart_item_selector)
      if empty or not items then
        return { next = "error", status = "cart_empty", error = "cart_empty" }
      end
      if not first_existing(config.checkout_button_selectors or {}) then
        return { next = "error", status = "checkout_unavailable", error = "checkout_unavailable" }
      end
    end

    local button = first_existing(config.checkout_button_selectors or {})
    if not button then
      return { next = "error", status = "checkout_unavailable", error = "checkout_unavailable" }
    end
    click(button)
  end

  if config.checkout_ready_selector then wait_for(config.checkout_ready_selector, 30000) end

  local kind, reason = K.access_error(config, here())
  if kind == "blocked" then return { next = "error", error = reason } end
  if kind == "login" then
    return { next = "error", status = "login_required", login_required = true, error = "login_required" }
  end

  if K.on_checkout_page(config) then
    return { next = "done", status = "checkout", login_required = false, url = here(),
             checkout = K.read_review(config) }
  end
  -- Reporting a review that was never reached would have the flow tell the user to look at a total nobody
  -- read.
  return { next = "done", status = "checkout_pending", login_required = false, url = here() }
end
