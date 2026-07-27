local S = AX_PLAYGROUND_STOREFRONT
if type(S) ~= "table" then
  error("playground/_common/scripts/15_storefront.lua must load before playground/naver-shopping/scripts/00_search.lua")
end

local CONFIG = {
  site = "naver-shopping",
  origin = "https://search.shopping.naver.com",
  hosts = { "search.shopping.naver.com" },
  search_url = "https://search.shopping.naver.com/search/all",
  search_param = "query",
  search_path_marker = "/search/",
  search_input_selector = 'input[type="search"]',
  result_selector = '[data-shp-contents-id]',
  result_id_attr = "data-shp-contents-id",
  result_url_selector = 'a[href*="/products/"], a[href*="/catalog/"]',
  result_title_selector = 'a[title], img[alt]',
  result_image_selector = 'img[alt]',
  result_rating_selector = '[aria-label*="평점"], [aria-label*="rating"]',
  result_reviews_selector = 'a[href*="review"], [data-review-count]',
  result_delivery_selector = '[data-delivery-info]',
  result_ready_selector = '[data-shp-contents-id], [data-testid="SEARCH_PRODUCT_LIST"]',
  search_timeout = 15000,
  result_limit = 24,
  price_from_text = true,
  shipping_from_text = true,
  default_currency = "KRW",
  product_id_patterns = { "/products/(%d+)", "/catalog/(%d+)" },
  login_urls = { "nidlogin.login" },
  login_selector = 'form[action*="nidlogin"] input[type="password"]',
  blocked_selectors = {
    { selector = 'iframe[src*="captcha"], form[action*="captcha"]', error = "captcha_required" }
  },
  blocked_text = {
    { text = "please complete the security verification", error = "security_verification_required" },
    { text = "보안 확인을 완료해 주세요", error = "security_verification_required" },
    { text = "실제 사용자인지 확인", error = "security_verification_required" },
    { text = "접속이 일시적으로 제한", error = "access_denied" },
    { text = "비정상적인 접근", error = "access_denied" },
    { text = "접근이 제한", error = "access_denied" }
  }
}

function AX_search_product(args)
  return S.search(CONFIG, args)
end
