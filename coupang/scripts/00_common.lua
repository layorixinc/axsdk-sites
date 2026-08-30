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
  -- Measured live 2026-08-29: every sampled Next-layout card exposes exactly one buyer-facing current
  -- price here. Whole-row text also carries a per-egg amount, which is not the tray total the user pays.
  result_price_selector = '.fw-font-bold > span',
  price_from_text = false,
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
  -- Measured live 2026-08-29 on `/vp/products/9629131654`: the current Next layout exposes one
  -- `.price-layout-container` saying exactly `9,400,000원`; all three legacy selectors match 0.
  product_price_selectors = { '.price-layout-container', '.total-price strong',
    '.prod-sale-price .total-price', '[data-product-price]' },
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
  -- Cart LINES: measured live 2026-08-26 `[id^="item_"]` matched exactly the two rows in the cart, the
  -- `#cart-reco-widget` contains none of them, and a product present ONLY in that widget scored 0 inside
  -- the scope and 1 inside the widget. 19 of the page 40 product links are recommendations.
  cart_item_scopes = { '[id^="item_"]' },
  login_urls = { "/login", "login.coupang.com" },
  login_selector = 'form[action*="login"] input[type="password"]',
  blocked_selectors = {
    { selector = 'iframe[src*="captcha"], form[action*="captcha"], .captcha', error = "captcha_required" },
    -- Coupang's own 403 page, measured live 2026-08-27 on the search URL: 3,531 bytes, `<div id="error403">`,
    -- visible text "요청하신 페이지의 사용권한이 없습니다." None of the `blocked_text` phrases below appear on
    -- it, so the reader answered `no_results` — a claim about listings nobody was shown, and the flow told
    -- the user their product does not exist there. The element is the marker because it is locale-free.
    { selector = "#error403", error = "access_denied" }
  },
  blocked_text = {
    { text = "access denied", error = "access_denied" },
    { text = "비정상적인 접근", error = "access_denied" },
    { text = "자동화된 접근", error = "access_denied" },
    -- The 403 page's own sentence, for a rendering that drops the id.
    { text = "사용권한이 없습니다", error = "access_denied" }
  }
}

AX_SITE_CONFIGS[CONFIG.site] = CONFIG
