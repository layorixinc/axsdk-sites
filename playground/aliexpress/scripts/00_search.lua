local S = AX_PLAYGROUND_STOREFRONT
if type(S) ~= "table" then
  error("playground/_common/scripts/15_storefront.lua must load before playground/aliexpress/scripts/00_search.lua")
end

local CONFIG = {
  site = "aliexpress",
  origin = "https://ko.aliexpress.com",
  hosts = { "ko.aliexpress.com" },
  search_path_prefix = "https://ko.aliexpress.com/w/wholesale-",
  search_path_suffix = ".html",
  search_path_marker = "/w/wholesale-",
  search_input_selector = 'input[type="search"]',
  result_selector = 'a.search-card-item[href*="/item/"]',
  result_url_from_root = true,
  result_title_selector = 'img[alt]',
  result_image_selector = 'img[alt]',
  result_rating_selector = '[aria-label*="rating"], [aria-label*="Rating"]',
  result_reviews_selector = '[aria-label*="sold"], [aria-label*="orders"]',
  result_ready_selector = 'a.search-card-item[href*="/item/"], form[action*="captcha"]',
  search_timeout = 15000,
  result_limit = 24,
  price_from_text = true,
  shipping_from_text = true,
  product_id_patterns = { "/item/(%d+)" },
  product_url_prefix = "https://ko.aliexpress.com/item/",
  product_url_suffix = ".html",
  login_urls = { "/login", "login.aliexpress.com" },
  login_selector = 'form[action*="login"] input[type="password"]',
  blocked_selectors = {
    { selector = 'iframe[src*="captcha"], form[action*="captcha"], #captcha', error = "captcha_required" }
  },
  blocked_text = {
    { text = "slide to verify", error = "captcha_required" },
    { text = "security verification", error = "security_verification_required" },
    { text = "access denied", error = "access_denied" }
  }
}

function AX_search_product(args)
  return S.search(CONFIG, args)
end
