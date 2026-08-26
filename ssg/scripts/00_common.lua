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
  -- CORRECTED 2026-08-26, and the earlier note in this place was wrong in a way that could add the wrong
  -- product. `.ssgitem_btn_cart` matches **9** elements on an item page — related-item icon buttons, not
  -- variant rows of this product — and clicking one NAVIGATED to `itemId=1000728596071` with
  -- `click=itemMidArea23`. The product's own control is `#actionCart` (`cdtl_btn_dgray cdtl_btn_cart`),
  -- with the sticky bar's duplicate at `#_bar_actionCart`; clicking it stays on the item page. `#btn_cart`
  -- matched nothing and is gone.
  add_selectors = { '#actionCart', '#_bar_actionCart' },
  quantity_selectors = { 'select[name="quantity"]', 'input[name="quantity"]' },
  required_option_selectors = { 'select[required]' },
  -- No per-add panel is configured because there is none to read: after a real click on `#actionCart` the
  -- page carries **0** `[data-layer-name]` elements, so the previous
  -- `[data-layer-name="cart_success"].on` matched nothing and could never confirm. Measured further: the
  -- guest cart stays EMPTY after a correct add, so ssg keeps a cart only for a signed-in user and the
  -- honest outcome is `cart_empty` from the phrase below.
  add_ready_selector = 'form[action*="login"], iframe[src*="captcha"]',
  cart_url = "https://pay.ssg.com/cart/dmsShpp.ssg",
  cart_url_markers = { "pay.ssg.com/cart", "/cart/" },
  -- Measured live 2026-08-26 on the empty cart: "장바구니에 담긴 상품이 없습니다." gmarket deliberately has
  -- NO phrase — the only "…상품이 없습니다" on its cart page is 최근 본 상품이 없습니다, the recently-viewed
  -- rail reporting that IT is empty, and reading that as the cart is the rail defect pointing the other way.
  cart_empty_phrases = { "장바구니에 담긴 상품이 없습니다" },
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
