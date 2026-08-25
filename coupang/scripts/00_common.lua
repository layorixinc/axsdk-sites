-- Config-only storefront declaration: read by tools/build-rpc-sites.mjs into the generated
-- _common/rpc/62_rpc_sites.lua, which the RPC reader (_common/rpc/61_rpc_storefront.lua) serves in
-- production. This file loads in a bare Lua state and must depend on nothing.
AX_SITE_CONFIGS = AX_SITE_CONFIGS or {}

local CONFIG = {
  site = "coupang",
  home_url = "https://www.coupang.com/",
  hosts = { "coupang.com" },
  search_url = "https://www.coupang.com/np/search",
  search_param = "q",
  search_path_marker = "/np/search",
  result_selector = 'li[data-id]:has(a[href*="/vp/products/"])',
  result_url_selector = 'a[href*="/vp/products/"]',
  result_title_selector = 'img[alt]',
  result_image_selector = 'img[alt]',
  price_from_text = true,
  price_text_strategy = "last_before_shipping",
  result_shipping_selector = '[data-badge-type="feePrice"]',
  shipping_from_text = true,
  result_ready_selector = 'li[data-id]:has(a[href*="/vp/products/"])',
  -- Coupang has no supportable result pagination: every deep-linked ?page=2 renders an empty grid and the
  -- on-page control is a hashed-class button, so a search reads one page (AGENTS.md §10 bans hashed classes).
  default_currency = "KRW",
  product_id_patterns = { "/vp/products/(%d+)", "productId=(%d+)" },
  product_url_prefix = "https://www.coupang.com/vp/products/",
  product_title_selectors = { 'h2.prod-buy-header__title', 'h1[data-product-title]', 'h1' },
  product_price_selectors = { '.total-price strong', '.prod-sale-price .total-price', '[data-product-price]' },
  add_selectors = { 'button.prod-cart-btn', 'button[data-button-name="add-to-cart"]' },
  quantity_selectors = { 'select.prod-quantity__input', 'input[name="quantity"]' },
  required_option_selectors = { 'select[required]' },
  -- Per-add message ONLY. `[data-cart-item-id]` names a row ALREADY IN THE CART, and `cart_contains`
  -- consults this list off the cart page — so a cart holding anything answered "this add happened", the
  -- guard skipped the click, and the tool reported `added = true`.
  confirmation_selector = '.cart-message',
  confirmation_text_selectors = { '.cart-message', '.prod-atf-notice' },
  add_ready_selector = '.cart-message, [data-cart-item-id], form[action*="login"], .captcha',
  cart_url = "https://cart.coupang.com/cartView.pang",
  cart_url_markers = { "cartView.pang", "/cart" },
  login_urls = { "/login", "login.coupang.com" },
  login_selector = 'form[action*="login"] input[type="password"]',
  blocked_selectors = {
    { selector = 'iframe[src*="captcha"], form[action*="captcha"], .captcha', error = "captcha_required" }
  },
  blocked_text = {
    { text = "access denied", error = "access_denied" },
    { text = "비정상적인 접근", error = "access_denied" },
    { text = "자동화된 접근", error = "access_denied" }
  }
}

AX_SITE_CONFIGS[CONFIG.site] = CONFIG
