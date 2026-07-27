local S = AX_PLAYGROUND_STOREFRONT
if type(S) ~= "table" then
  error("playground/_common/scripts/15_storefront.lua must load before playground/ssg/scripts/00_search.lua")
end

local CONFIG = {
  site = "ssg",
  origin = "https://www.ssg.com",
  hosts = { "ssg.com" },
  search_url = "https://www.ssg.com/search.ssg",
  search_param = "query",
  search_extra = { target = "all" },
  search_path_marker = "/search.ssg",
  search_input_selector = 'input[name="query"]',
  result_selector = 'li:has(a[href*="itemId="]), [data-react-unit-id][data-observable-item]',
  result_url_selector = 'a[href*="itemId="]',
  result_title_selector = '[data-info="prd_name"], .tx_ko, img[alt]',
  result_image_selector = 'img[alt]',
  result_price_selector = '.ssg_price, [data-info="price"]',
  result_shipping_selector = '.txt_delivery, .tx_deal, [data-info="delivery"]',
  result_rating_selector = '[aria-label*="평점"], .rate_bg',
  result_reviews_selector = '.rating_count, [data-info="review_count"]',
  result_delivery_selector = '.txt_delivery, .tx_deal, [data-info="delivery"]',
  result_ready_selector = 'li:has(a[href*="itemId="]), [data-observable-item]',
  search_timeout = 15000,
  result_limit = 24,
  default_currency = "KRW",
  product_id_patterns = { "[?&]itemId=([%w]+)" },
  product_url_prefix = "https://www.ssg.com/item/itemView.ssg?itemId=",
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

function AX_search_product(args)
  return S.search(CONFIG, args)
end
