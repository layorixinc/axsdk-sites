local S = AX_PLAYGROUND_STOREFRONT
if type(S) ~= "table" then
  error("playground/_common/scripts/15_storefront.lua must load before playground/ebay/scripts/00_search.lua")
end

local CONFIG = {
  site = "ebay",
  origin = "https://www.ebay.com",
  hosts = { "ebay.com" },
  search_url = "https://www.ebay.com/sch/i.html",
  search_param = "_nkw",
  search_path_marker = "/sch/i.html",
  search_input_selector = '#gh-ac, input[aria-label="Search for anything"]',
  -- eBay's search results render as `li.s-card` tiles carrying the listing id; the older
  -- `su-item-card` / `s-item` markup is gone. Shipping has no stable node, so it is parsed from the
  -- card text (shipping_from_text) where the "+배송비 …" / "shipping" fragment appears.
  result_selector = 'li.s-card[data-listingid]',
  result_id_attr = "data-listingid",
  result_url_selector = "a[href*='/itm/']",
  result_title_selector = '.s-card__title .su-styled-text, .s-card__title',
  result_image_selector = 'img[alt]',
  result_price_selector = '.s-card__price',
  result_condition_selector = '.s-card__subtitle',
  -- Readiness requires a tile that already carries its price, not just the results container.
  result_ready_selector = 'li.s-card[data-listingid] .s-card__price, .srp-save-null-search, #signin-main, #captcha_form',
  search_timeout = 15000,
  result_limit = 24,
  shipping_from_text = true,
  default_currency = "USD",
  product_id_patterns = { "/itm/(%d+)", "[?&]item=(%d+)" },
  product_url_prefix = "https://www.ebay.com/itm/",
  login_urls = { "signin.ebay.com", "/signin/" },
  login_selector = 'form#signin-form, #signin-main, input#userid, input#pass',
  blocked_selectors = {
    { selector = "#captcha_form, #captcha-box, form[action*='captcha'], input[name='captcha']", error = "captcha_required" }
  },
  blocked_text = {
    { text = "access denied", error = "access_denied" }
  }
}

function AX_search_product(args)
  return S.search(CONFIG, args)
end
