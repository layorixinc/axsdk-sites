-- Config-only storefront declaration: read by tools/build-rpc-sites.mjs into the generated
-- _common/rpc/62_rpc_sites.lua, which the RPC reader (_common/rpc/61_rpc_storefront.lua) serves in
-- production. This file loads in a bare Lua state and must depend on nothing.
AX_SITE_CONFIGS = AX_SITE_CONFIGS or {}

local CONFIG = {
  site = "gmarket",
  home_url = "https://www.gmarket.co.kr/",
  hosts = { "gmarket.co.kr" },
  search_url = "https://www.gmarket.co.kr/n/search",
  search_param = "keyword",
  search_path_marker = "/n/search",
  result_selector = '.box__item-container, [data-montelena-goodscode]',
  result_id_attr = "data-montelena-goodscode",
  result_url_selector = 'a[href*="goodscode="], a[href*="goodsCode="]',
  result_title_selector = '.text__item, [data-montelena-acode="200003874"]',
  result_image_selector = 'img[alt]',
  result_price_selector = '.text__value, [data-price]',
  result_shipping_selector = '.box__delivery, .text__delivery',
  result_rating_selector = '.image__awards-points, [aria-label*="평점"]',
  result_reviews_selector = '.text__reviews, [data-review-count]',
  result_delivery_selector = '.box__delivery, .text__delivery',
  result_ready_selector = '.box__item-container, [data-montelena-goodscode]',
  default_currency = "KRW",
  product_id_patterns = { "[?&]goodscode=(%d+)", "[?&]goodsCode=(%d+)" },
  product_url_prefix = "https://item.gmarket.co.kr/Item?goodscode=",
  product_title_selectors = { 'h1.itemtit', 'h1' },
  product_price_selectors = { '.price_real', '.price_innerwrap strong', '[data-price]' },
  -- `.btn_mycart` is what the live buy box carries (measured 2026-08-26 on `item.gmarket.co.kr/Item`:
  -- `btn_primary btn_white btn_mycart`, rendered twice as a responsive duplicate). The two selectors that
  -- stood alone here matched NOTHING, so every add refused with `add_to_cart_unavailable`. Word-based
  -- design-system classes, not build hashes (§10). `.btn_round.btn_blue` ("장바구니로") is the confirmation
  -- popup's link to the cart, never the add.
  add_selectors = { '#btn_add_cart', 'button.button__add-cart', '.btn_mycart', 'button[data-montelena-acode="200000911"]' },
  quantity_selectors = { 'input[name="orderQty"]', 'select[name="quantity"]' },
  required_option_selectors = { 'select[required]' },
  confirmation_selector = '[data-cart-layer="success"], .box__layer-cart.is-active',
  confirmation_text_selectors = { '[data-cart-layer="success"]', '.box__layer-cart.is-active' },
  add_ready_selector = '[data-cart-layer="success"], .box__layer-cart.is-active, form[action*="login"]',
  cart_url = "https://cart.gmarket.co.kr/ko/cart",
  cart_url_markers = { "cart.gmarket.co.kr", "/cart" },
  login_urls = { "/login", "signin.gmarket" },
  login_selector = 'form[action*="login"] input[type="password"]',
  blocked_selectors = {
    { selector = 'iframe[src*="challenge"], iframe[src*="captcha"], form[action*="captcha"]', error = "captcha_required" }
  },
  blocked_text = {
    { text = "just a moment", error = "security_verification_required" },
    { text = "봇 확인 절차", error = "security_verification_required" },
    { text = "간단한 확인만 완료", error = "security_verification_required" },
    { text = "access denied", error = "access_denied" }
  }
}

AX_SITE_CONFIGS[CONFIG.site] = CONFIG
