local S = AX_PLAYGROUND_STOREFRONT
if type(S) ~= "table" then
  error("playground/_common/scripts/15_storefront.lua must load before playground/coupang/scripts/00_search.lua")
end

local CONFIG = {
  site = "coupang",
  origin = "https://www.coupang.com",
  hosts = { "coupang.com" },
  search_url = "https://www.coupang.com/np/search",
  search_param = "q",
  search_path_marker = "/np/search",
  search_input_selector = 'input[name="q"]',
  result_selector = 'li[data-id]:has(a[href*="/vp/products/"])',
  result_url_selector = 'a[href*="/vp/products/"]',
  result_title_selector = 'img[alt]',
  result_image_selector = 'img[alt]',
  result_shipping_selector = '[data-badge-type="feePrice"]',
  result_rating_selector = '[aria-label*="rating"]',
  result_ready_selector = 'li[data-id]:has(a[href*="/vp/products/"])',
  search_timeout = 15000,
  result_limit = 24,
  price_from_text = true,
  price_text_strategy = "last_before_shipping",
  shipping_from_text = true,
  default_currency = "KRW",
  product_id_patterns = { "/vp/products/(%d+)", "productId=(%d+)" },
  product_url_prefix = "https://www.coupang.com/vp/products/",
  login_urls = { "/login", "login.coupang.com" },
  login_selector = 'form[action*="login"] input[type="password"]',
  blocked_selectors = {
    { selector = 'iframe[src*="captcha"], form[action*="captcha"], .captcha', error = "captcha_required" }
  },
  blocked_text = {
    { text = "access denied", error = "access_denied" },
    { text = "비정상적인 접근", error = "access_denied" },
    { text = "자동화된 접근", error = "access_denied" }
  }
}

function AX_search_product(args)
  return S.search(CONFIG, args)
end
