--- eBay's SEARCH read expressed as a storefront config.
---
--- Its search was a bespoke layer only because it was written before the shared adapter existed: it
--- navigates, waits, classifies a captcha or a login, reads cards and asks whether a next control is
--- there — the shared shape exactly. Declaring it as data means the RPC reader serves it and the
--- generator carries it, so the search path stops being a second implementation to keep in step.
---
--- The selectors are eBay's own, moved rather than rewritten: `AX_EBAY` still owns the product page and
--- the cart, which are not part of this port.
local M = AX_EBAY
if not M then
  error("ebay/scripts/00_common.lua must be loaded before 01_storefront_config.lua")
end

local S = AX_STOREFRONT
if not S then
  error("_common/scripts/60_storefront.lua must be loaded before ebay/scripts/01_storefront_config.lua")
end

local CONFIG = {
  site = "ebay",
  home_url = M.HOME_URL,
  hosts = { "www.ebay.com", "ebay.com" },
  search_url = M.SEARCH_URL,
  search_param = "_nkw",
  search_path_marker = "/sch/",
  result_selector = M.RESULT_SELECTOR,
  result_ready_selector = M.RESULT_READY_SELECTOR,
  result_url_selector = "a[href*='/itm/'], .su-link.su-item-card__title, .su-item-card__title",
  result_title_selector = ".s-card__title, .su-item-card__title .su-styled-text, .su-item-card__title, a[href*='/itm/']",
  result_image_selector = ".s-card__image, img.s-item__image-img, .su-card-container__media img, img",
  result_price_selector = ".s-card__price, .su-item-card__price, .s-item__price",
  -- The delivery line rides in the attribute row, not in a field of its own.
  result_shipping_selector = ".s-card__attribute-row, .su-card-container__attributes__primary, .s-item__details",
  result_condition_selector = ".s-card__subtitle, .su-item-card__subtitle .secondary, .su-item-card__header .secondary, .SECONDARY_INFO",
  result_seller_selector = ".s-card__caption, .su-card-container__attributes__secondary, .s-item__seller-info-text",
  result_limit = M.RESULT_LIMIT,
  default_currency = "USD",
  product_id_patterns = { "/itm/(%d+)" },
  product_url_prefix = M.ITEM_URL_PREFIX,
  -- Both walls answer with a page rather than an error, so they are named and classified instead of
  -- being read as a store with nothing in it.
  blocked_selectors = { { selector = M.CAPTCHA_SELECTOR, error = "captcha_required" } },
  login_selector = M.LOGIN_SELECTOR,
  login_urls = { "/signin" },
  pagination = {
    mode = "query", param = "_pgn", start = 1, step = 1, max_pages = 2,
    next_selector = 'a[type="next"], a.pagination__next',
  },
}

S.register(CONFIG)
