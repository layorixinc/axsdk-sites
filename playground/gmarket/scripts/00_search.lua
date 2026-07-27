local S = AX_PLAYGROUND_STOREFRONT
if type(S) ~= "table" then
  error("playground/_common/scripts/15_storefront.lua must load before playground/gmarket/scripts/00_search.lua")
end

local CONFIG = {
  site = "gmarket",
  origin = "https://www.gmarket.co.kr",
  hosts = { "gmarket.co.kr" },
  search_url = "https://www.gmarket.co.kr/n/search",
  search_param = "keyword",
  search_path_marker = "/n/search",
  search_input_selector = 'input[name="keyword"]',
  -- data-montelena-goodscode only ever appears on nodes INSIDE a card, so matching it as a result
  -- root filled the read window with duplicates; the container is the one node per item and the
  -- product id comes from the item URL.
  result_selector = '.box__item-container',
  result_url_selector = 'a[href*="goodscode="], a[href*="goodsCode="]',
  result_title_selector = '.text__item, [data-montelena-acode="200003874"]',
  result_image_selector = 'img[alt]',
  result_price_selector = '.text__value, [data-price]',
  result_shipping_selector = '.box__delivery, .text__delivery',
  result_rating_selector = '.image__awards-points, [aria-label*="평점"]',
  result_reviews_selector = '.text__reviews, [data-review-count]',
  result_delivery_selector = '.box__delivery, .text__delivery',
  result_ready_selector = '.box__item-container .text__value',
  search_timeout = 15000,
  result_limit = 24,
  default_currency = "KRW",
  product_id_patterns = { "[?&]goodscode=(%d+)", "[?&]goodsCode=(%d+)" },
  product_url_prefix = "https://item.gmarket.co.kr/Item?goodscode=",
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

function AX_search_product(args)
  return S.search(CONFIG, args)
end
