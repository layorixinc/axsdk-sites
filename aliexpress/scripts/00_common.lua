-- Config-only storefront declaration: read by tools/build-rpc-sites.mjs into the generated
-- _common/rpc/62_rpc_sites.lua, which the RPC reader (_common/rpc/61_rpc_storefront.lua) serves in
-- production. This file loads in a bare Lua state and must depend on nothing.
AX_SITE_CONFIGS = AX_SITE_CONFIGS or {}

local CONFIG = {
  site = "aliexpress",
  home_url = "https://www.aliexpress.com/",
  hosts = { "aliexpress.com" },
  search_path_prefix = "https://www.aliexpress.com/w/wholesale-",
  search_path_suffix = ".html",
  search_path_marker = "/w/wholesale-",
  search_input_selector = 'input[type="search"]',
  result_selector = 'a.search-card-item[href*="/item/"]',
  result_url_from_root = true,
  result_title_selector = 'img[alt]',
  result_image_selector = 'img[alt]',
  price_from_text = true,
  shipping_from_text = true,
  result_rating_selector = '[aria-label*="rating"], [aria-label*="Rating"]',
  result_reviews_selector = '[aria-label*="sold"], [aria-label*="orders"]',
  result_ready_selector = 'a.search-card-item[href*="/item/"], form[action*="captcha"]',
  -- Result paging: page two is the same search URL with this parameter. `max_pages` caps how many
  -- pages one store search may read; each extra page costs a full navigation.
  pagination = { mode = "query", param = "page", start = 1, step = 1, max_pages = 2 },
  product_id_patterns = { "/item/(%d+)" },
  product_url_prefix = "https://www.aliexpress.com/item/",
  product_url_suffix = ".html",
  product_title_selectors = { '[data-pl="product-title"] h1', 'h1[data-pl="product-title"]', 'h1' },
  product_price_selectors = { '[data-pl="product-price"]', '[data-testid="product-price"]' },
  add_selectors = { 'button[data-pl="add-to-cart"]', 'button[data-testid="add-to-cart"]' },
  quantity_selectors = { 'input[type="number"]', 'input[aria-label*="Quantity"]' },
  required_option_selectors = { 'select[required]' },
  confirmation_selector = '[data-pl="add-to-cart-success"], [data-testid="add-to-cart-success"]',
  confirmation_text_selectors = { '[data-pl="add-to-cart-success"]', '[data-testid="add-to-cart-success"]' },
  add_ready_selector = '[data-pl="add-to-cart-success"], [data-testid="add-to-cart-success"], form[action*="login"], form[action*="captcha"]',
  cart_url = "https://www.aliexpress.com/p/shoppingcart/index.html",
  cart_url_markers = { "/shoppingcart/", "/cart" },
  login_urls = { "/login", "login.aliexpress.com" },
  login_selector = 'form[action*="login"] input[type="password"]',
  blocked_selectors = {
    { selector = 'iframe[src*="captcha"], form[action*="captcha"], #captcha', error = "captcha_required" }
  },
  blocked_text = {
    { text = "slide to verify", error = "captcha_required" },
    { text = "security verification", error = "security_verification_required" },
    { text = "access denied", error = "access_denied" }
  }
}

AX_SITE_CONFIGS[CONFIG.site] = CONFIG
