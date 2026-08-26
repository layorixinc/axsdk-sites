-- Config-only storefront declaration: read by tools/build-rpc-sites.mjs into the generated
-- _common/rpc/62_rpc_sites.lua, which the RPC reader (_common/rpc/61_rpc_storefront.lua) serves in
-- production. This file loads in a bare Lua state and must depend on nothing.
AX_SITE_CONFIGS = AX_SITE_CONFIGS or {}

local CONFIG = {
  site = "etsy",
  home_url = "https://www.etsy.com/",
  hosts = { "etsy.com" },
  search_url = "https://www.etsy.com/search",
  search_param = "q",
  search_path_marker = "/search",
  result_selector = '[data-listing-id]',
  result_id_attr = "data-listing-id",
  result_url_selector = 'a[href*="/listing/"]',
  result_title_selector = 'h3, [data-listing-card-title]',
  result_image_selector = 'img[alt]',
  result_price_selector = '.currency-value, [data-buy-box-region="price"]',
  result_shipping_selector = '[data-shipping-cost], [data-delivery-estimate]',
  result_rating_selector = '[aria-label*="out of 5 stars"]',
  result_reviews_selector = 'a[href*="#reviews"]',
  result_delivery_selector = '[data-delivery-estimate]',
  shipping_from_text = true,
  result_ready_selector = '[data-listing-id], iframe[src*="captcha"]',
  default_currency = "USD",
  product_id_patterns = { "/listing/(%d+)" },
  product_url_prefix = "https://www.etsy.com/listing/",
  product_title_selectors = { 'h1[data-buy-box-listing-title]', 'h1' },
  product_price_selectors = { '[data-buy-box-region="price"] .currency-value', '[data-buy-box-region="price"]' },
  -- Measured live 2026-08-26 on `/listing/1848131106`: BOTH configured selectors matched 0, which is why
  -- every etsy add answered `add_control_missing` and the matrix recorded that as a made-to-order
  -- listing's own limit. The real control is the submit of etsy's own cart form, and it must be SCOPED:
  -- `form[action*="/cart/listing.php"] button[type="submit"]` matches 5 on that page (the buy box plus
  -- four related-item cards), so clicking the first in document order could add a different listing.
  -- `#listing-page-cart` and `[data-buy-box]` each scope it to exactly 1.
  add_selectors = { '#listing-page-cart button[type="submit"]',
                    '[data-buy-box] form[action*="/cart/listing.php"] button[type="submit"]' },
  quantity_selectors = { 'select[name="quantity"]' },
  required_option_selectors = { 'select[required]' },
  -- Per-add panel ONLY. `[data-cart-listing-id]` names a LISTING ALREADY IN THE CART and
  -- `[aria-live="polite"]` is a page-wide live region — either one made `cart_contains` true off the cart
  -- page for a cart holding anything at all, so the guard skipped the click and reported `added = true`.
  confirmation_selector = '[data-add-to-cart-success]',
  confirmation_text_selectors = { '[data-add-to-cart-success]' },
  add_ready_selector = '[data-add-to-cart-success], [data-cart-listing-id], form[action*="signin"], iframe[src*="captcha"]',
  cart_url = "https://www.etsy.com/cart",
  cart_url_markers = { "/cart" },
  login_urls = { "/signin" },
  login_selector = 'form[action*="signin"] input[type="password"]',
  blocked_selectors = {
    { selector = 'iframe[src*="captcha"], form[action*="captcha"]', error = "captcha_required" }
  },
  blocked_text = {
    { text = "enable javascript and cookies to continue", error = "captcha_required" },
    { text = "verify you are human", error = "captcha_required" },
    { text = "access denied", error = "access_denied" }
  }
}

AX_SITE_CONFIGS[CONFIG.site] = CONFIG
