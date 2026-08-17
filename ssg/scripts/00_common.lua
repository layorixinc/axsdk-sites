-- Config-only storefront declaration: read by tools/build-rpc-sites.mjs into the generated
-- _common/rpc/62_rpc_sites.lua, which the RPC reader (_common/rpc/61_rpc_storefront.lua) serves in
-- production. This file loads in a bare Lua state and must depend on nothing.
AX_SITE_CONFIGS = AX_SITE_CONFIGS or {}

local CONFIG = {
  site = "ssg",
  home_url = "https://www.ssg.com/",
  hosts = { "ssg.com" },
  search_url = "https://www.ssg.com/search.ssg",
  search_param = "query",
  search_extra = { target = "all" },
  search_path_marker = "/search.ssg",
  -- The result grid is a Chakra/emotion build: every class is a hash, so rows are located by their
  -- product link and prices are read from the row text ("… 판매가격 53,100원 무료배송"), last amount
  -- before the shipping fragment. The hydration payload below is the selector-free fallback.
  result_selector = 'div:has(> a[href*="itemId="])',
  result_url_selector = 'a[href*="itemId="]',
  result_title_selector = 'img[alt]',
  result_image_selector = 'img[alt]',
  price_from_text = true,
  price_text_strategy = "last_before_shipping",
  shipping_from_text = true,
  result_ready_selector = 'div:has(> a[href*="itemId="])',
  -- Result paging: page two is the same search URL with this parameter. `max_pages` caps how many
  -- pages one store search may read; each extra page costs a full navigation.
  pagination = { mode = "query", param = "page", start = 1, step = 1, max_pages = 2 },
  prefer_embedded = true,
  embedded_json_selector = 'script#__NEXT_DATA__',
  embedded_item_key = "itemId",
  embedded_fields = {
    url = { "itemUrl" },
    title = { "itemName" },
    image_alt = { "itemName" },
    brand = { "brandName" },
    image_url = { "itemImgUrl" },
    price_text = { "rawPrimaryPrice", "primaryPrice" },
    rating_text = { "reviewScore" },
    reviews_text = { "reviewCount" }
  },
  default_currency = "KRW",
  product_id_patterns = { "[?&]itemId=([%w]+)" },
  product_url_prefix = "https://www.ssg.com/item/itemView.ssg?itemId=",
  product_title_selectors = { '.cdtl_info_tit h2', 'h1' },
  product_price_selectors = { '.cdtl_new_price .ssg_price', '.ssg_price' },
  add_selectors = { '#btn_cart', 'button[data-react-tarea-dtl-cd="00020_000000000"]' },
  quantity_selectors = { 'select[name="quantity"]', 'input[name="quantity"]' },
  required_option_selectors = { 'select[required]' },
  confirmation_selector = '[data-layer-name="cart_success"].on, .cart_layer.on',
  confirmation_text_selectors = { '[data-layer-name="cart_success"].on', '.cart_layer.on' },
  add_ready_selector = '[data-layer-name="cart_success"].on, .cart_layer.on, form[action*="login"]',
  cart_url = "https://pay.ssg.com/cart/dmsShpp.ssg",
  cart_url_markers = { "pay.ssg.com/cart", "/cart/" },
  login_urls = { "/login", "member.ssg.com" },
  login_selector = 'form[action*="login"] input[type="password"]',
  blocked_selectors = {
    { selector = 'iframe[src*="captcha"], form[action*="captcha"]', error = "captcha_required" }
  },
  blocked_text = {
    { text = "접속이 잠시 제한되었습니다", error = "access_denied" },
    { text = "자동화된 환경", error = "access_denied" },
    { text = "비정상적인 접근", error = "access_denied" },
    { text = "access denied", error = "access_denied" }
  }
}

AX_SITE_CONFIGS[CONFIG.site] = CONFIG
