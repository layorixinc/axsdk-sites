local S = AX_STOREFRONT
if not S then error("_common/scripts/60_storefront.lua must be loaded before gmarket/scripts/00_common.lua") end

local CONFIG = {
  site = "gmarket",
  home_url = "https://www.gmarket.co.kr/",
  hosts = { "gmarket.co.kr" },
  search_url = "https://www.gmarket.co.kr/n/search",
  search_param = "keyword",
  search_path_marker = "/n/search",
  search_input_selector = 'input[name="keyword"]',
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
  add_selectors = { '#btn_add_cart', 'button.button__add-cart', 'button[data-montelena-acode="200000911"]' },
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

function AX_search_product(args) return S.search(CONFIG, args) end
function AX_add_to_cart(args) return S.add_to_cart(CONFIG, args) end
S.register(CONFIG)
