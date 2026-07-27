local S = AX_STOREFRONT
if not S then error("_common/scripts/60_storefront.lua must be loaded before naver-shopping/scripts/00_common.lua") end

local CONFIG = {
  site = "naver-shopping",
  home_url = "https://search.shopping.naver.com/search/all?query=%EC%87%BC%ED%95%91",
  hosts = { "shopping.naver.com", "search.shopping.naver.com" },
  search_url = "https://search.shopping.naver.com/search/all",
  search_param = "query",
  search_path_marker = "/search/",
  search_input_selector = 'input[type="search"]',
  -- The rendered grid carries only tracking ids (data-shp-contents-id holds a link, not a product) and
  -- routes every offer through a cr.shopping.naver.com redirect, so the price-comparison records are
  -- read from the hydration payload instead. DOM selectors stay as the fallback path.
  result_selector = '[data-shp-contents-id]:not([data-shp-contents-id] [data-shp-contents-id])',
  result_url_selector = 'a[href*="cr.shopping.naver.com"], a[href*="/products/"], a[href*="/catalog/"]',
  result_title_selector = 'a[title], img[alt]',
  result_image_selector = 'img[alt]',
  price_from_text = true,
  shipping_from_text = true,
  result_rating_selector = '[aria-label*="평점"], [aria-label*="rating"]',
  result_reviews_selector = 'a[href*="review"], [data-review-count]',
  result_delivery_selector = '[data-delivery-info]',
  result_ready_selector = '[data-shp-contents-id], [data-testid="SEARCH_PRODUCT_LIST"]',
  -- Naver Shopping paging is unverified: the live search intermittently answers with the security wall, so
  -- no page-2 read could be observed. Left single-page until a clean live run can confirm the parameter.
  prefer_embedded = true,
  embedded_json_selector = 'script#__NEXT_DATA__',
  embedded_item_key = "mallProductId",
  embedded_fields = {
    url = { "crUrl" },
    title = { "productTitle", "productName" },
    image_alt = { "productTitle", "productName" },
    brand = { "maker" },
    image_url = { "imageUrl" },
    price_text = { "price", "lowPrice" },
    shipping_text = { "dlvryFee" },
    rating_text = { "scoreInfo" },
    reviews_text = { "reviewCount" }
  },
  default_currency = "KRW",
  product_id_patterns = { "/products/(%d+)", "/catalog/(%d+)" },
  cart_supported = false,
  product_title_selectors = { 'h1' },
  product_price_selectors = { '[data-price]' },
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

function AX_search_product(args) return S.search(CONFIG, args) end
function AX_add_to_cart(args) return S.add_to_cart(CONFIG, args) end
S.register(CONFIG)
