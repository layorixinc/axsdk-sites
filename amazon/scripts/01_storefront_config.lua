--- Amazon's SEARCH read expressed as a storefront config.
---
--- Like ebay's, this search predates the shared adapter and does the same four things: navigate, wait,
--- classify a captcha or a login, read cards and ask whether a next control is there. Declaring it as
--- data lets the RPC reader serve it, which is what removes the last store from the durable path.
---
--- `AX_AMAZON` keeps the product page, the cart and the checkout: those are not part of this port, and
--- the selectors below are its own, moved rather than rewritten.
local M = AX_AMAZON
if not M then
  error("amazon/scripts/00_common.lua must be loaded before 01_storefront_config.lua")
end

local S = AX_STOREFRONT
if not S then
  error("_common/scripts/60_storefront.lua must be loaded before amazon/scripts/01_storefront_config.lua")
end

local CONFIG = {
  site = "amazon",
  home_url = "https://www.amazon.com/",
  hosts = { "www.amazon.com", "amazon.com" },
  search_url = M.AMAZON_SEARCH_NAVIGATION_URL,
  search_param = "k",
  search_path_marker = "/s",
  result_selector = M.RESULT_SELECTOR,
  result_ready_selector = M.RESULT_READY_SELECTOR,
  -- The ASIN sits on the row itself, so no selector is needed beside the attribute name.
  result_id_attr = "data-asin",
  result_url_selector = 'h2 a, a.a-link-normal.s-no-outline, a[href*="/dp/"], a[href*="/gp/product/"]',
  result_title_selector = "h2, h2 a",
  result_image_selector = "img.s-image",
  result_price_selector = ".a-price .a-offscreen",
  result_shipping_selector = '[data-cy="delivery-block"], [data-cy="delivery-recipe"]',
  result_rating_selector = "i.a-icon-star-small span.a-icon-alt, .a-icon-alt",
  result_reviews_selector = 'a[href*="#customerReviews"] span, a[href*="#customerReviews"]',
  result_limit = M.RESULT_LIMIT,
  default_currency = "USD",
  -- An ASIN is ten alphanumerics; the id also appears in the product href, so both sources are tried.
  product_id_patterns = { "/dp/([A-Z0-9]+)", "/gp/product/([A-Z0-9]+)", "^([A-Z0-9]+)$" },
  product_url_prefix = M.AMAZON_PRODUCT_URL_PREFIX,
  blocked_selectors = { { selector = 'form[action*="validateCaptcha"]', error = "captcha_required" } },
  login_selector = M.LOGIN_SELECTOR,
  login_urls = { "/ap/signin" },
  pagination = {
    mode = "query", param = "page", start = 1, step = 1, max_pages = 2,
    next_selector = "a.s-pagination-next",
  },
}

S.register(CONFIG)
