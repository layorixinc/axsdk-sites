local S = AX_PLAYGROUND_STOREFRONT
if type(S) ~= "table" then
  error("playground/_common/scripts/15_storefront.lua must load before playground/etsy/scripts/00_search.lua")
end

local CONFIG = {
  site = "etsy",
  origin = "https://www.etsy.com",
  hosts = { "etsy.com" },
  search_url = "https://www.etsy.com/search",
  search_param = "q",
  search_path_marker = "/search",
  search_input_selector = 'input[name="search_query"]',
  -- data-listing-id repeats on nested nodes (card, link, favorite button, video), so the read
  -- window would fill with duplicates of the first few listings; keep only the outermost card.
  result_selector = '[data-listing-id]:not([data-listing-id] [data-listing-id])',
  result_id_attr = "data-listing-id",
  result_url_selector = 'a[href*="/listing/"]',
  result_title_selector = 'h3, [data-listing-card-title]',
  result_image_selector = 'img[alt]',
  result_price_selector = '.currency-value, [data-buy-box-region="price"]',
  result_shipping_selector = '[data-shipping-cost], [data-delivery-estimate]',
  result_rating_selector = '[aria-label*="out of 5 stars"]',
  result_reviews_selector = 'a[href*="#reviews"]',
  result_delivery_selector = '[data-delivery-estimate]',
  result_ready_selector = '[data-listing-id] .currency-value, iframe[src*="captcha"]',
  search_timeout = 15000,
  result_limit = 24,
  shipping_from_text = true,
  default_currency = "USD",
  product_id_patterns = { "/listing/(%d+)" },
  product_url_prefix = "https://www.etsy.com/listing/",
  login_urls = { "/signin" },
  login_selector = 'form[action*="signin"] input[type="password"]',
  blocked_selectors = {
    { selector = 'iframe[src*="captcha"], form[action*="captcha"]', error = "captcha_required" }
  },
  blocked_text = {
    { text = "enable javascript and cookies to continue", error = "captcha_required" },
    { text = "verify you are human", error = "captcha_required" },
    { text = "access denied", error = "access_denied" }
  }
}

function AX_search_product(args)
  return S.search(CONFIG, args)
end
