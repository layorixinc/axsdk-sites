--- eBay's SEARCH read expressed as a storefront config.
---
--- Its search was a bespoke layer only because it was written before the shared adapter existed: it
--- navigates, waits, classifies a captcha or a login, reads cards and asks whether a next control is
--- there — the shared shape exactly. Declaring it as data means the RPC reader serves it and the
--- generator carries it, so the search path stops being a second implementation to keep in step.
---
--- Config-only storefront declaration: read by tools/build-rpc-sites.mjs into the generated
--- _common/rpc/62_rpc_sites.lua, which the RPC reader (_common/rpc/61_rpc_storefront.lua) serves in
--- production. This file loads in a bare Lua state and must depend on nothing.
AX_SITE_CONFIGS = AX_SITE_CONFIGS or {}

local CONFIG = {
  site = "ebay",
  home_url = "https://www.ebay.com/",
  hosts = { "www.ebay.com", "ebay.com" },
  search_url = "https://www.ebay.com/sch/i.html",
  search_param = "_nkw",
  search_path_marker = "/sch/",
  -- eBay's search cards are `li.s-card` with the listing id on the element itself; the older
  -- `.su-item-card[data-view]` markup is gone (live: 0 matches, 62 `li.s-card`). The first card is
  -- eBay's own "Shop on eBay" placeholder, which carries no price and is dropped by the price check.
  result_selector = "li.s-card[data-listingid], .su-item-card[data-view], .s-item-card[data-view]",
  -- The id lives on the card ROOT, not in the link. Measured live 2026-08-15: every
  -- `a[href*="/itm/"]` on the search page reads `https://ebay.com/itm/123456?itmmeta=…` — a placeholder,
  -- identical across all 143 anchors — while `li.s-card[data-listingid]` carries the real listing id
  -- (e.g. 236940774206, 62 of them). Without this key `product_id_patterns` mined the placeholder, every
  -- row parsed to `123456`, and the dedupe kept ONE candidate out of a full page — the same failure
  -- signature 11st had when its cards moved behind an ad-server redirect.
  result_id_attr = "data-listingid",
  result_ready_selector = "li.s-card, .srp-river-results, .srp-results, .su-item-card, .srp-save-null-search, #signin-main, #captcha_form",
  result_url_selector = "a[href*='/itm/'], .su-link.su-item-card__title, .su-item-card__title",
  result_title_selector = ".s-card__title, .su-item-card__title .su-styled-text, .su-item-card__title, a[href*='/itm/']",
  result_image_selector = ".s-card__image, img.s-item__image-img, .su-card-container__media img, img",
  result_price_selector = ".s-card__price, .su-item-card__price, .s-item__price",
  -- The delivery line rides in the attribute row, not in a field of its own.
  result_shipping_selector = ".s-card__attribute-row, .su-card-container__attributes__primary, .s-item__details",
  result_condition_selector = ".s-card__subtitle, .su-item-card__subtitle .secondary, .su-item-card__header .secondary, .SECONDARY_INFO",
  result_seller_selector = ".s-card__caption, .su-card-container__attributes__secondary, .s-item__seller-info-text",
  result_limit = 24,
  default_currency = "USD",
  product_id_patterns = { "/itm/(%d+)" },
  product_url_prefix = "https://www.ebay.com/itm/",
  -- Product page, all measured live 2026-08-15 on https://www.ebay.com/itm/236940774206:
  --   h1.x-item-title__mainTitle -> "로지텍 M185 무선 마우스 2.4기가헤르츠 …"
  --   .x-price-primary           -> "개당 US $5.34"      (the SELLER's currency)
  --   .x-price-approx__price     -> "KRW7,559.73"        (the buyer's localized approximation)
  --   #atcBtn_btn_1              -> "장바구니에 추가"
  -- The approximation is the number a Korean shopper's comparison window showed, so revalidation has to
  -- be able to read it; without it a correct add refused with `currency_changed`. It is consulted only on
  -- a currency mismatch and still has to pass the amount check.
  product_title_selectors = { "h1.x-item-title__mainTitle", ".x-item-title__mainTitle" },
  product_price_selectors = { ".x-price-primary", ".x-bin-price__content" },
  product_price_approx_selectors = { ".x-price-approx__price" },
  add_selectors = { "#atcBtn_btn_1", "[id^='atcBtn']", ".x-atc-action a" },
  -- Both walls answer with a page rather than an error, so they are named and classified instead of
  -- being read as a store with nothing in it.
  blocked_selectors = { { selector = "#captcha_form, #captcha-box, form[action*='captcha'], input[name='captcha']", error = "captcha_required" } },
  login_selector = "form#signin-form, #signin-main, input#userid, input#pass",
  login_urls = { "/signin" },
  pagination = {
    mode = "query", param = "_pgn", start = 1, step = 1, max_pages = 2,
    next_selector = 'a[type="next"], a.pagination__next',
  },
}

AX_SITE_CONFIGS[CONFIG.site] = CONFIG
