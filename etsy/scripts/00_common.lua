local S = AX_STOREFRONT
if not S then error("_common/scripts/60_storefront.lua must be loaded before etsy/scripts/00_common.lua") end

local CONFIG = {
  site = "etsy",
  home_url = "https://www.etsy.com/",
  hosts = { "etsy.com" },
  search_url = "https://www.etsy.com/search",
  search_param = "q",
  search_path_marker = "/search",
  search_input_selector = 'input[name="search_query"]',
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
  add_selectors = { 'button[data-add-to-cart-button]', 'button[name="add_to_cart"]' },
  quantity_selectors = { 'select[name="quantity"]' },
  required_option_selectors = { 'select[required]' },
  confirmation_selector = '[data-cart-listing-id], [data-add-to-cart-success]',
  confirmation_text_selectors = { '[data-add-to-cart-success]', '[aria-live="polite"]' },
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

function AX_search_product(args) return S.search(CONFIG, args) end
function AX_add_to_cart(args) return S.add_to_cart(CONFIG, args) end
S.register(CONFIG)
