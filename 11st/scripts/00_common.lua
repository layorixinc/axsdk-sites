-- Config-only storefront declaration: read by tools/build-rpc-sites.mjs into the generated
-- _common/rpc/62_rpc_sites.lua, which the RPC reader (_common/rpc/61_rpc_storefront.lua) serves in
-- production. This file loads in a bare Lua state and must depend on nothing.
AX_SITE_CONFIGS = AX_SITE_CONFIGS or {}

local CONFIG = {
  site = "11st",
  home_url = "https://www.11st.co.kr/",
  hosts = { "11st.co.kr" },
  search_url = "https://search.11st.co.kr/pc/total-search",
  search_param = "kwd",
  search_extra = { tabId = "TOTAL_SEARCH" },
  search_path_marker = "/pc/total-search",
  result_selector = 'li.c-search-list__item, li:has(> .c-card-item)',
  result_url_selector = 'a.c-card-item__anchor[href*="/products/"]',
  -- 11st routes every result card through its ad server, so the anchor href carries no product id; the
  -- card's own log payload is where the id survives. Measured live: 156 cards on the page, 1 read.
  result_id_selector = 'a.c-card-item__anchor[data-log-body]',
  result_id_attr = 'data-log-body',
  result_title_selector = '.c-card-item__name dd, img[alt]',
  result_image_selector = 'img[alt]',
  result_price_selector = '.c-card-item__price .value, .c-card-item__lowest .value',
  -- Measured on the live search page (logged-in dev profile, "로지텍 M170"): 6 result cards, and exactly
  -- ONE carries a shipping cell —
  -- `<dd class="c-card-item__price-delivery"><span class="sr-only">배송비</span><span class="value">무료</span></dd>`.
  -- The old `.c-card-item__delivery` / `.c-card-item__shipping` exist nowhere on the card, so even that
  -- one row read as "this store says nothing about shipping".
  --
  -- The other five state no shipping at all: that is the page, not a selector gap, and those rows keep an
  -- unknown total on purpose. Guessing zero there would make 11st look like the cheapest store on screen.
  result_shipping_selector = '.c-card-item__price-delivery, .c-card-item__price-delivery .value',
  result_rating_selector = '.c-starrate, [aria-label*="평점"]',
  result_reviews_selector = '.c-starrate, [data-review-count]',
  -- Live card text is in this delivery cell ("배송비무료"); the older delivery/shipping classes match 0.
  result_delivery_selector = 'dd.c-card-item__price-delivery',
  shipping_from_text = true,
  result_ready_selector = 'li.c-search-list__item, li:has(> .c-card-item)',
  search_timeout = 5000,
  default_currency = "KRW",
  product_id_patterns = { "/products/(%d+)", '"content_no"%s*:%s*"(%d+)"' },
  product_url_prefix = "https://www.11st.co.kr/products/",
  product_title_selectors = { 'h1.title' },
  product_price_selectors = { '#finalDscPrcArea .value' },
  add_selectors = { 'button.btn_cart[data-log-actionid-label="cart"]' },
  quantity_selectors = { 'input[name="quantity"]', 'select[name="quantity"]' },
  required_option_selectors = { 'select[required]' },
  cart_url = "https://buy.11st.co.kr/cart/CartAction.tmall?method=getCartList",
  cart_url_markers = { "buy.11st.co.kr/cart", "CartAction.tmall" },
  login_urls = { "/login", "login.11st.co.kr" },
  login_selector = 'form[action*="login"] input[type="password"]',
  blocked_selectors = {
    { selector = 'iframe[src*="captcha"], form[action*="captcha"]', error = "captcha_required" }
  },
  blocked_text = {
    { text = "비정상적인 접근", error = "access_denied" },
    { text = "보안 확인", error = "security_verification_required" },
    { text = "access denied", error = "access_denied" }
  }
}

AX_SITE_CONFIGS[CONFIG.site] = CONFIG
