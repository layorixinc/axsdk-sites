local S = AX_PLAYGROUND_STOREFRONT
if type(S) ~= "table" then
  error("playground/_common/scripts/15_storefront.lua must load before playground/11st/scripts/00_search.lua")
end

local CONFIG = {
  site = "11st",
  origin = "https://search.11st.co.kr",
  hosts = { "search.11st.co.kr" },
  search_url = "https://search.11st.co.kr/pc/total-search",
  search_param = "kwd",
  search_extra = { tabId = "TOTAL_SEARCH" },
  search_path_marker = "/pc/total-search",
  search_input_selector = 'input[type="search"]',
  -- The recommend rail renders the same c-card-item markup but links through an adoffice click
  -- redirect, so scope results to tiles that expose a real /products/ link.
  result_selector = 'li:has(a.c-card-item__anchor[href*="/products/"])',
  result_url_selector = 'a.c-card-item__anchor[href*="/products/"]',
  result_title_selector = '.c-card-item__name dd',
  result_image_selector = 'img[alt]',
  result_price_selector = '.c-card-item__price .value, .c-card-item__lowest .value',
  result_shipping_selector = '.c-card-item__price-delivery, .c-card-item__delivery',
  result_rating_selector = '.c-starrate, [aria-label*="평점"]',
  result_reviews_selector = '.c-starrate, [data-review-count]',
  result_delivery_selector = '.c-card-item__price-delivery, .c-card-item__delivery',
  result_ready_selector = 'li:has(a.c-card-item__anchor[href*="/products/"])',
  search_timeout = 15000,
  result_limit = 24,
  shipping_from_text = true,
  default_currency = "KRW",
  product_id_patterns = { "/products/(%d+)" },
  product_url_prefix = "https://www.11st.co.kr/products/",
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

function AX_search_product(args)
  return S.search(CONFIG, args)
end
