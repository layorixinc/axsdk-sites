--- 어댑터 등록·환율·공용 헬퍼. 다른 commerce 모듈이 모두 이것부터 읽는다.
local B = AX_BASE
if not B then
  error("_common/scripts/00_base.lua must be loaded before 50_commerce_core.lua")
end

AX_COMMERCE = AX_COMMERCE or {}
local C = AX_COMMERCE
local clean, non_empty = B.clean_text, B.non_empty

C.adapters = C.adapters or {}
C.BASE_CURRENCY = "USD"
C.FX_URL = "https://api.frankfurter.dev/v1/latest"
C.MAX_OFFERS_PER_SITE = 3
-- Relevance is decided in two stages. The deterministic pass keeps what COULD be the product, up to
-- SCREEN_LIMIT_PER_SITE per store, because token rules cannot tell a mouse from a mouse pad; one model
-- call then says which rows actually are it, and MAX_OFFERS_PER_SITE is applied to what survives. The
-- screening list is the only part of this that ever enters a prompt, so it is bounded too.
C.SCREEN_LIMIT_PER_SITE = 6
C.SCREEN_MAX_ROWS = 30
C.SCREEN_TITLE_CHARS = 70
-- Ranking keeps more offers than one window shows: browsing pages through them, and only the window is
-- ever rendered into a prompt. The cap bounds the serialized flow state, not the model's context.
C.MAX_RANKED_OFFERS = 15
C.MAX_DISCOVERY_RESULTS = 6
C.SITE_HOMES = {
  ["11st"] = "https://www.11st.co.kr/",
  aliexpress = "https://www.aliexpress.com/",
  amazon = "https://www.amazon.com/",
  coupang = "https://www.coupang.com/",
  ebay = "https://www.ebay.com/",
  etsy = "https://www.etsy.com/",
  gmarket = "https://www.gmarket.co.kr/",
  ["naver-shopping"] = "https://search.shopping.naver.com/search/all?query=%EC%87%BC%ED%95%91",
  ssg = "https://www.ssg.com/",
  walmart = "https://www.walmart.com/"
}

local function lower(value)
  return clean(value):lower()
end

local function copy_table(value)
  local out = {}
  if type(value) == "table" then
    for key, item in pairs(value) do
      out[key] = item
    end
  end
  return out
end

local function array()
  if ax and type(ax.array) == "function" then
    return ax.array()
  end
  return {}
end

function C.register_adapter(site, adapter)
  local slug = lower(site)
  if slug == "" or type(adapter) ~= "table" then
    return false
  end
  adapter.site = slug
  C.adapters[slug] = adapter
  return true
end

function C.adapter(site)
  return C.adapters[lower(site)]
end

function C.current_url()
  return non_empty(dom.get_location_href()) or ""
end

local function home_matches_url(home, url)
  local target_host = tostring(home or ""):match("^https?://([^/]+)")
  local current_host = tostring(url or ""):match("^https?://([^/]+)")
  if not target_host or not current_host then return false end
  local base = target_host:lower():gsub("^www%.", "")
  local host = current_host:lower()
  return host == base or host:sub(-(#base + 1)) == "." .. base
end

function C.ensure_adapter(site)
  local slug = lower(site)
  local adapter = C.adapters[slug]
  local href = C.current_url()
  local on_target = adapter and type(adapter.host_matches) == "function" and adapter.host_matches(href)
  if on_target then return adapter, nil, nil end

  local home = non_empty((adapter and adapter.home_url) or C.SITE_HOMES[slug])
  if not home then return nil, adapter and "site_home_unavailable" or "site_adapter_unavailable", nil end
  if not adapter and home_matches_url(home, href) then
    return nil, nil, "loading_adapter"
  end
  if home_matches_url(home, href) then return nil, "site_navigation_failed", nil end

  if nav and type(nav.clear_beforeunload) == "function" then nav.clear_beforeunload() end
  nav.navigate(home, {}, { reload = true })
  return nil, nil, "navigating"
end

local function free_shipping(text)
  local value = lower(text)
  if value == "" then
    return false
  end
  return value:find("free shipping", 1, true) ~= nil
    or value:find("free delivery", 1, true) ~= nil
    or value:find("shipping: free", 1, true) ~= nil
    or value:find("무료 배송", 1, true) ~= nil
    or value:find("배송비 무료", 1, true) ~= nil
end

local function collect_currencies(candidates)
  local set = {}
  for index = 1, #(candidates or {}) do
    local candidate = candidates[index] or {}
    local currency = non_empty(candidate.currency)
    local shipping_currency = non_empty(candidate.shipping_currency)
    if currency then set[currency:upper()] = true end
    if shipping_currency then set[shipping_currency:upper()] = true end
  end
  return set
end

-- Normalization runs per store, so a worker only ever sees its own store's currency. Skipping the
-- conversion there looked cheap but left each store in its own units, and the parent ranked 13,190 KRW
-- against 13.95 USD as if both were the base. Every offer is therefore converted to one fixed base;
-- the comparison chooses its display currency later, when all offers are visible.
function C.fetch_fx_rates(currencies)
  local rates = { USD = 1 }
  local symbols = {}
  for currency in pairs(currencies or {}) do
    local code = tostring(currency):upper()
    if code ~= "USD" then
      symbols[#symbols + 1] = code
    end
  end
  table.sort(symbols)
  if #symbols == 0 then
    return { rates = rates, base = C.BASE_CURRENCY, date = nil, source = C.FX_URL }
  end

  local fetch = (net and net.fetch) or (http and http.fetch)
  if not fetch then
    return { rates = rates, source = C.FX_URL, error = "fx_fetch_unavailable" }
  end
  local response = fetch(C.FX_URL .. "?base=USD&symbols=" .. B.url_encode(table.concat(symbols, ",")), {
    method = "GET",
    headers = { accept = "application/json" },
    credentials = "omit",
    response = "json",
    timeout = 5000
  })
  -- One transport, two shapes. Measured live: the runtime's `net.fetch` answers `{body, headers, ok,
  -- status}` and NEVER a `json` field, whatever `response = "json"` asks for; the durable one does supply
  -- `json`. Reading only `json` turned a 200 with a perfectly good rate table into `fx_fetch_failed` — no
  -- `price_base`, no total, and every row of a TOTAL-COST comparison printed "총 미확인" with the shipping
  -- cost right beside the price. `71_rpc_zip.lua` already learned this.
  local payload = B.response_json(response)
  if response and response.reason == "pending" then
    return { pending = true, source = C.FX_URL }
  end
  if not payload then
    return { rates = rates, source = C.FX_URL, error = "fx_fetch_failed" }
  end

  local body_rates = payload.rates
  if type(body_rates) == "table" then
    for code, amount in pairs(body_rates) do
      local numeric = tonumber(amount)
      if numeric and numeric > 0 then
        rates[tostring(code):upper()] = numeric
      end
    end
  end
  return {
    rates = rates,
    date = non_empty(payload.date),
    source = C.FX_URL
  }
end

local function convert_to_base(amount, currency, rates)
  local numeric = tonumber(amount)
  local code = non_empty(currency)
  if not numeric or not code then
    return nil, nil
  end
  code = code:upper()
  local rate = tonumber((rates or {})[code])
  if not rate or rate <= 0 then
    return nil, nil
  end
  return numeric / rate, rate
end

-- 다른 commerce 모듈과 공유한다. 파일 순서상 이 아래 모듈들이 헤더에서 집어 간다.
C.lower, C.copy_table, C.array, C.free_shipping, C.collect_currencies, C.convert_to_base = lower, copy_table, array, free_shipping, collect_currencies, convert_to_base
