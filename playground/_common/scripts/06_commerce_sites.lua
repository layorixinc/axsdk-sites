-- Explicit store targets shared by the portable opener and site-local durable searches.
-- Search-host entries avoid making a non-portable AX_search_product operation cross an origin.

AX_PLAYGROUND_COMMERCE = AX_PLAYGROUND_COMMERCE or {}
local C = AX_PLAYGROUND_COMMERCE

C.SITES = {
  ["11st"] = {
    site = "11st",
    origin = "https://search.11st.co.kr",
    entry_url = "https://search.11st.co.kr/pc/total-search?kwd=shopping&tabId=TOTAL_SEARCH"
  },
  aliexpress = {
    site = "aliexpress",
    origin = "https://ko.aliexpress.com",
    entry_url = "https://ko.aliexpress.com/"
  },
  amazon = {
    site = "amazon",
    origin = "https://www.amazon.com",
    entry_url = "https://www.amazon.com/"
  },
  coupang = {
    site = "coupang",
    origin = "https://www.coupang.com",
    entry_url = "https://www.coupang.com/"
  },
  ebay = {
    site = "ebay",
    origin = "https://www.ebay.com",
    entry_url = "https://www.ebay.com/"
  },
  etsy = {
    site = "etsy",
    origin = "https://www.etsy.com",
    entry_url = "https://www.etsy.com/"
  },
  gmarket = {
    site = "gmarket",
    origin = "https://www.gmarket.co.kr",
    entry_url = "https://www.gmarket.co.kr/"
  },
  ["naver-shopping"] = {
    site = "naver-shopping",
    origin = "https://search.shopping.naver.com",
    entry_url = "https://search.shopping.naver.com/search/all?query=%EC%87%BC%ED%95%91"
  },
  ssg = {
    site = "ssg",
    origin = "https://www.ssg.com",
    entry_url = "https://www.ssg.com/"
  },
  walmart = {
    site = "walmart",
    origin = "https://www.walmart.com",
    entry_url = "https://www.walmart.com/"
  }
}

function C.clean(value)
  local text = tostring(value or "")
  return text:gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", "")
end

function C.non_empty(value)
  local text = C.clean(value)
  if text == "" then return nil end
  return text
end

function C.array()
  if type(ax) == "table" and type(ax.array) == "function" then return ax.array() end
  return {}
end

function C.site(value)
  local key = C.non_empty(value)
  return key and C.SITES[key:lower()] or nil
end
