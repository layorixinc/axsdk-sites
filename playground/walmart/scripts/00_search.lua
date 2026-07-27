local S = AX_PLAYGROUND_STOREFRONT
if type(S) ~= "table" then
  error("playground/_common/scripts/15_storefront.lua must load before playground/walmart/scripts/00_search.lua")
end

local CONFIG = {
  site = "walmart",
  origin = "https://www.walmart.com",
  hosts = { "walmart.com" },
  search_url = "https://www.walmart.com/search",
  search_param = "q",
  search_path_marker = "/search",
  search_input_selector = 'input[type="search"][name="q"]',
  result_selector = '[data-item-id][data-dca-id]',
  result_id_attr = "data-dca-id",
  result_url_selector = 'a[link-identifier][href*="/ip/"]',
  result_title_selector = '[data-automation-id="product-title"]',
  result_image_selector = 'img[data-testid="productTileImage"], img[alt]',
  -- The visible price node concatenates dollars and cents ("$1452"); the container's aria-label
  -- carries the decimal current price ("Price $ 14.52 Was $ 13.83 ...").
  result_price_selector = '[data-testid="unified-global-product-price"]',
  result_price_attr = "aria-label",
  result_shipping_selector = '[data-automation-id="fulfillment-badge"], [data-testid="fulfillment-speed"]',
  result_rating_selector = '[data-testid="product-ratings"]',
  result_reviews_selector = 'a[href*="#reviews"], [data-testid="product-reviews"]',
  result_delivery_selector = '[data-testid="fulfillment-speed"]',
  -- Ad/module wrappers carry [data-item-id][data-dca-id] before the product tiles hydrate, so
  -- readiness requires a tile that already exposes its price.
  result_ready_selector = '[data-item-id][data-dca-id] [data-testid="unified-global-product-price"], [data-testid="search-no-results"]',
  search_timeout = 15000,
  result_limit = 24,
  default_currency = "USD",
  product_id_patterns = { "/ip/[^/?]+/(%d+)", "/ip/(%d+)" },
  product_url_prefix = "https://www.walmart.com/ip/",
  login_urls = { "/account/login", "/account/verify" },
  login_selector = 'form[action*="/account/login"] input[type="password"]',
  blocked_selectors = {
    { selector = 'iframe[src*="captcha"], form[action*="captcha"]', error = "captcha_required" }
  },
  blocked_text = {
    { text = "robot or human", error = "captcha_required" },
    { text = "verify your identity", error = "security_verification_required" },
    { text = "access denied", error = "access_denied" }
  }
}

function AX_search_product(args)
  return S.search(CONFIG, args)
end
