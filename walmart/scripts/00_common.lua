-- Config-only storefront declaration: read by tools/build-rpc-sites.mjs into the generated
-- _common/rpc/62_rpc_sites.lua, which the RPC reader (_common/rpc/61_rpc_storefront.lua) serves in
-- production. This file loads in a bare Lua state and must depend on nothing.
AX_SITE_CONFIGS = AX_SITE_CONFIGS or {}

local CONFIG = {
  site = "walmart",
  home_url = "https://www.walmart.com/",
  hosts = { "walmart.com" },
  search_url = "https://www.walmart.com/search",
  search_param = "q",
  search_path_marker = "/search",
  search_input_selector = 'input[type="search"][name="q"]',
  result_selector = '[data-item-id][data-dca-id]',
  result_id_attr = "data-dca-id",
  result_url_selector = 'a[link-identifier][href*="/ip/"]',
  result_title_selector = '[data-automation-id="product-title"]',
  result_image_selector = 'img[data-testid="productTileImage"], img[alt]',
  -- Walmart A/B tests its result tile: one load carries the price under product-price, another under
  -- unified-global-product-price/ugpp-main-price, and a third renders no price at all. Both stable
  -- automation ids are covered; the old hashed class (.ld_Ec) is exactly what AGENTS.md 10 bans.
  result_price_selector = '[data-automation-id="ugpp-main-price"], [data-automation-id="unified-global-product-price"], [data-automation-id="product-price"]',
  price_text_strategy = "decimal_preferred",
  result_shipping_selector = '[data-automation-id="fulfillment-badge"], [data-testid="fulfillment-speed"]',
  result_rating_selector = '[data-testid="product-ratings"]',
  result_reviews_selector = 'a[href*="#reviews"], [data-testid="product-reviews"]',
  result_delivery_selector = '[data-testid="fulfillment-speed"]',
  result_ready_selector = '[data-item-id][data-dca-id], [data-testid="search-no-results"]',
  -- Result paging: page two is the same search URL with this parameter. `max_pages` caps how many
  -- pages one store search may read; each extra page costs a full navigation.
  pagination = { mode = "query", param = "page", start = 1, step = 1, max_pages = 2 },
  default_currency = "USD",
  product_id_patterns = { "/ip/[^/?]+/(%d+)", "/ip/(%d+)" },
  product_url_prefix = "https://www.walmart.com/ip/",
  product_title_selectors = { 'h1[itemprop="name"]', '[data-testid="product-title"]' },
  product_price_selectors = { '[itemprop="price"][data-seo-id="hero-price"]', '[data-testid="price-wrap"] [itemprop="price"]' },
  add_selectors = { 'main button[data-automation-id="atc"]', 'button[data-automation-id="atc"]' },
  quantity_selectors = { 'select[id*="quantity"]', 'select[aria-label*="Quantity"]' },
  -- Per-add panel ONLY. The cart DRAWER and its rows are structure: `cart_contains` consults this list off
  -- the cart page, so a drawer holding a previous item answered "this add happened", the guard skipped the
  -- click, and the tool reported `added = true`. `add_ready_selector` below may still name the drawer — that
  -- one only decides when to stop waiting, it is not evidence.
  confirmation_selector = '[data-testid="add-to-cart-success"]',
  confirmation_text_selectors = { '[data-testid="add-to-cart-success"]' },
  add_ready_selector = '[data-testid="add-to-cart-success"], [data-testid="cart-drawer"], form[action*="login"]',
  cart_url = "https://www.walmart.com/cart",
  cart_url_markers = { "/cart" },
  login_urls = { "/account/login", "/account/verify" },
  login_selector = 'form[action*="/account/login"] input[type="password"]',
  blocked_selectors = {
    { selector = 'iframe[src*="captcha"], form[action*="captcha"]', error = "captcha_required" }
  },
  blocked_text = {
    { text = "robot or human", error = "captcha_required" },
    { text = "verify your identity", error = "security_verification_required" },
    { text = "access denied", error = "access_denied" }
  }
}

AX_SITE_CONFIGS[CONFIG.site] = CONFIG
