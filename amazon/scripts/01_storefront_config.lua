--- Amazon's SEARCH and CART expressed as a storefront config.
---
--- Like ebay's, this search predates the shared adapter and does the same four things: navigate, wait,
--- classify a captcha or a login, read cards and ask whether a next control is there. Declaring it as
--- data lets the RPC reader serve it, which is what removes the last store from the durable path.
---
--- The cart followed for the same reason, and it is the more valuable half. Amazon had a second, bespoke
--- cart script — 212 lines whose only genuinely amazon-specific steps were declining a protection-plan
--- upsell and comparing a cart counter. Both are config keys, so the runtime cart is ONE implementation
--- instead of two: the guard that stops a wrong-model or higher-price add is then exercised by every store
--- rather than living twice with one copy untested.
---
--- Config-only storefront declaration: read by tools/build-rpc-sites.mjs into the generated
--- _common/rpc/62_rpc_sites.lua, which the RPC reader (_common/rpc/61_rpc_storefront.lua) serves in
--- production. This file loads in a bare Lua state and must depend on nothing.
AX_SITE_CONFIGS = AX_SITE_CONFIGS or {}

-- Selectors that appear in more than one config value are composed here, so a fix cannot land in one
-- copy and miss the others. The generator executes this file and reads the finished table, so the
-- composition happens exactly once, at read time.
local LOGIN_SELECTOR = '#authportal-main-section, #ap_email, #ap_password'
local RESULT_SELECTOR = '[data-component-type="s-search-result"][data-asin]'
-- Per-add panels ONLY. This used to end `, #sc-active-cart, .sc-list-item[data-asin]` — the cart page's own
-- container and its rows — and `cart_contains` consults this list OFF the cart page, where the cart holding
-- ANY item then answered "this add happened": the guard skipped the click and reported `added = true`.
-- Measured 2026-08-16: a real add lands on `/cart/smart-wagon`, which the markers below did not name, so the
-- landing page was treated as off-cart and confirmed through exactly that structural fallback.
local ADD_TO_CART_CONFIRM_SELECTOR = '#sw-atc-confirmation, #NATC_SMART_WAGON_CONF_MSG_SUCCESS, #huc-v2-order-row-confirm-text'
local ATTACH_PANE_SELECTOR = '#attach-warranty-pane:not(.aok-hidden)'

local CONFIG = {
  site = "amazon",
  home_url = "https://www.amazon.com/",
  hosts = { "www.amazon.com", "amazon.com" },
  search_url = "https://www.amazon.com/s",
  search_param = "k",
  search_path_marker = "/s",
  result_selector = RESULT_SELECTOR,
  result_ready_selector = RESULT_SELECTOR .. ', .s-no-results-result, ' .. LOGIN_SELECTOR .. ', form[action*="validateCaptcha"]',
  -- The ASIN sits on the row itself, so no selector is needed beside the attribute name.
  result_id_attr = "data-asin",
  result_url_selector = 'h2 a, a.a-link-normal.s-no-outline, a[href*="/dp/"], a[href*="/gp/product/"]',
  -- Measured live: a card carries TWO headings — the brand first, the product title second — and only
  -- the title sits inside the card's anchor. A CSS list matches in DOCUMENT order, so `"h2, h2 a"` took
  -- the brand and every branded row came back named "Logitech". Relevance REQUIRES the model code, so a
  -- search for M185 then matched nothing and the comparison reported no products at all. Both
  -- alternatives here demand an anchor ancestor, which the brand heading does not have.
  --
  -- This fix once lived in `_common/rpc/62_rpc_sites.lua`, which is GENERATED and says so at the top:
  -- regenerating erased it. The adapter is the source; the generated reader is a copy.
  result_title_selector = "a h2 span, a h2",
  result_image_selector = "img.s-image",
  result_price_selector = ".a-price .a-offscreen",
  result_shipping_selector = '[data-cy="delivery-block"], [data-cy="delivery-recipe"]',
  result_rating_selector = "i.a-icon-star-small span.a-icon-alt, .a-icon-alt",
  result_reviews_selector = 'a[href*="#customerReviews"] span, a[href*="#customerReviews"]',
  result_limit = 24,
  default_currency = "USD",
  -- An ASIN is ten alphanumerics; the id also appears in the product href, so both sources are tried.
  product_id_patterns = { "/dp/([A-Z0-9]+)", "/gp/product/([A-Z0-9]+)", "^([A-Z0-9]+)$" },
  product_url_prefix = "https://www.amazon.com/dp/",
  blocked_selectors = { { selector = 'form[action*="validateCaptcha"]', error = "captcha_required" } },
  login_selector = LOGIN_SELECTOR,
  login_urls = { "/ap/signin" },
  -- Cart. The selectors are amazon's own, lifted from the retired durable cart script.
  product_title_selectors = { "span#productTitle", "#title span#productTitle", "h1#title" },
  product_price_selectors = {
    "#corePrice_feature_div .a-offscreen",
    ".priceToPay .a-offscreen",
    "#price_inside_buybox",
    "#apex_desktop .a-offscreen",
  },
  add_selectors = {
    "#add-to-cart-button",
    'input[name="submit.add-to-cart"]',
    '#submit.add-to-cart input',
    'input[name="submit.addToCart"]',
  },
  quantity_selectors = { "#quantity" },
  add_ready_selector = ADD_TO_CART_CONFIRM_SELECTOR .. ', ' .. ATTACH_PANE_SELECTOR .. ', ' .. LOGIN_SELECTOR .. ', form[action*="validateCaptcha"]',
  confirmation_selector = ADD_TO_CART_CONFIRM_SELECTOR,
  confirmation_text_selectors = {
    "#NATC_SMART_WAGON_CONF_MSG_SUCCESS",
    "#attachDisplayAddBaseAlert",
    "#attach-added-to-cart-message",
    "#huc-v2-order-row-confirm-text",
    "#sw-atc-confirmation",
    "#ewc-content",
  },
  -- "Add a protection plan" stands between the click and the confirmation. Declining is the default:
  -- nobody approved a second product.
  upsell_pane_selector = ATTACH_PANE_SELECTOR,
  upsell_decline_selector = ATTACH_PANE_SELECTOR .. ' #attachSiNoCoverage input, ' .. ATTACH_PANE_SELECTOR .. ' #attachSiNoCoverage .a-button-input, ' .. ATTACH_PANE_SELECTOR .. ' #attachSiNoCoverage',
  cart_url = "https://www.amazon.com/gp/cart/view.html",
  -- `/cart/smart-wagon` is deliberately NOT a marker. A real add lands there (`?newItems=<uuid>,N`) and it
  -- REDIRECTS to `/gp/cart/view.html`, which the first marker already names and where the 18 rows and their
  -- `data-asin` actually live (measured 2026-08-16). Naming the landing page made `review` believe it was
  -- already on the cart, skip the navigation, find none of the cart selectors, and tell the user the cart
  -- was EMPTY while it held 67 items. The add path needs no marker there either: with the structural
  -- fallback gone from `confirmation_selector`, an unconfirmed add navigates to `cart_url` and the id probe
  -- runs on the canonical page.
  cart_url_markers = { "/gp/cart/view.html", "/cart/view.html", "/cart?" },
  -- Cart LINES, measured live 2026-08-26 on a populated cart: `.sc-list-item` = 5, exactly the five rows,
  -- and all five [data-asin] elements are those rows. The same page carried 60 `a[href*="/dp/"]` of which
  -- **26 were inside recommendation carousels**, so a document-wide id probe there confirms a suggestion.
  --
  -- The unscoped `.sc-list-item` that stood beside this is GONE, and it was not a redundancy. Measured live
  -- 2026-08-27: amazon renders **"Saved for later" with the same `.sc-list-item[data-asin]` markup and its
  -- own `input[value="Delete"]`**, on the same page, below the cart. With the unscoped scope the id probe
  -- confirmed against a SAVED row — so an add could be reported for an item sitting in the wrong list, and
  -- a removal pressed that list's Delete: the page's own announcements read "<title> was removed from Saved
  -- for Later." while the cart's own count stayed 0. Only the container tells the two lists apart.
  cart_item_scopes = { "#sc-active-cart .sc-list-item" },
  cart_count_selectors = { "#nav-cart-count", "#sc-subtotal-label-activecart" },
  -- Removing ONE line. Measured live 2026-08-27 on a populated cart: five delete controls, one per row,
  -- reachable as `input[value="Delete"]` and as `[data-feature-id="item-delete-button"]`. `{id}` is where
  -- the product id goes — a specific line can only be pressed through a selector that carries its id,
  -- because the runtime's `query_all` answers text with no per-element selector.
  --
  -- Every one of them is scoped to `#sc-active-cart` for the reason above: the same control exists in the
  -- saved list, and a press that lands there mutates a list the user never named.
  cart_remove_selectors = {
    '#sc-active-cart .sc-list-item[data-asin="{id}"] input[value="Delete"]',
    '#sc-active-cart [data-asin="{id}"] input[value="Delete"]',
    '#sc-active-cart [data-asin="{id}"] [data-feature-id="item-delete-button"] input',
    '#sc-active-cart [data-asin="{id}"] [data-action="delete"] input',
  },
  -- Checkout REVIEW only. `place_order_selectors` is read to tell the user whether the button is there;
  -- nothing clicks it. The cart-page keys are here too because reaching the review starts from the cart.
  cart_ready_selector = '#sc-active-cart, .sc-list-item[data-asin], #sc-empty-cart, #sc-subtotal-label-activecart',
  cart_empty_selector = "#sc-empty-cart",
  -- Scoped for the same measured reason as `cart_item_scopes`: unscoped, this listed "Saved for later"
  -- rows as cart lines, and the window offered the user a number for a product that was not in the cart.
  cart_item_selector = '#sc-active-cart .sc-list-item[data-asin]',
  -- Where a cart LINE states its own id. Measured live: the five `.sc-list-item` rows are exactly the five
  -- `[data-asin]` elements on the page, so the row IS the element that names the product. A cart the
  -- listing surface cannot identify line by line is refused by name rather than rendered as empty.
  cart_item_id_attr = "data-asin",
  -- What separates a cart LINE from the panel amazon leaves in its place after a delete. Measured live
  -- 2026-08-27 INSIDE `#sc-active-cart`, in the instant after a removal that worked: the removed line's
  -- `data-asin` is still there, `input[value="Delete"]` count is **0**, and one `Undo` control has
  -- appeared — so the id probe answered "still in the cart" and every successful removal reported
  -- `remove_unconfirmed`. Pointing the other way, an ADD could be confirmed against the Undo panel of a
  -- line that had just been removed. A line that is IN the cart carries its own remove control; the panel
  -- does not. The word "Removed" is not usable: `dom` resolves standard CSS only, and it is locale-bound.
  cart_active_line_filter = ':has(input[value="Delete"])',
  cart_subtotal_selectors = { "#sc-subtotal-amount-activecart", "#sc-subtotal-label-activecart" },
  checkout_button_selectors = {
    'input[name="proceedToRetailCheckout"]',
    "#sc-buy-box-ptc-button input",
    '[data-feature-id="proceed-to-checkout-action"] input',
    "#hlb-ptc-btn-native",
  },
  checkout_ready_selector = LOGIN_SELECTOR .. ', #submitOrderButtonId, #placeYourOrder, input[name="placeYourOrder1"], #spc-orders, #subtotals, #deliver-to-customer-text, #checkout-payment-option-panel, form[action*="validateCaptcha"]',
  checkout_url_markers = { "/gp/buy/", "/checkout/" },
  checkout_summary_selector = "#subtotals",
  checkout_delivering_to_selector = "#deliver-to-customer-text",
  checkout_address_selector = "#deliver-to-address-text",
  checkout_payment_selectors = { "#checkout-payment-option-panel", "#checkout-paymentOptionPanel" },
  place_order_selectors = { "#submitOrderButtonId", 'input[name="placeYourOrder1"]', "#bottomSubmitOrderButtonId" },
  product_timeout = 8000,
  pagination = {
    mode = "query", param = "page", start = 1, step = 1, max_pages = 2,
    next_selector = "a.s-pagination-next",
  },
}

AX_SITE_CONFIGS[CONFIG.site] = CONFIG
