-- Store X fixture provider, authored and distributed as Lua (LUA_PACK_DESIGN.md).
-- The second producer of the storefront contract: proves a contributed provider composes additively.

local function clean(value, maximum)
  return text.clean(value, maximum or 500)
end

local function canonical_product_url(value, product_id)
  local parsed = url.parse(value)
  if parsed == nil then return nil end
  if parsed.origin ~= "https://www.store-x.example"
    or parsed.username ~= "" or parsed.password ~= "" then return nil end
  if parsed.pathname ~= "/product/" .. url.encode_component(product_id)
    or parsed.search ~= "" or parsed.hash ~= "" then return nil end
  return parsed.href
end

local function search_target(input)
  local params = { { "q", input.query } }
  if input.page > 1 then
    params[#params + 1] = { "page", string.format("%d", input.page) }
  end
  return url.with_params("https://www.store-x.example/search", params)
end

local function shows_search(input)
  local parsed = url.parse(page.href())
  if parsed == nil then return false end
  local page_param = tonumber(parsed.params.page or "1")
  return parsed.origin == "https://www.store-x.example"
    and parsed.pathname == "/search"
    and parsed.params.q == input.query
    and page_param == input.page
end

local function search_products(input)
  if not shows_search(input) then
    return { step = "navigate", url = search_target(input) }
  end

  local limit = math.max(1, math.min(6, input.limit))
  local rows = dom.query_all("[data-store-x-product]")
  local candidates = {}
  local seen = {}
  local document_changed = false
  for index = 1, #rows do
    local row = rows[index]
    local product_id = clean(dom.attr(row, "data-product-id") or "", 128)
    local name = clean(dom.attr(row, "data-name") or "")
    local product_url = canonical_product_url(clean(dom.attr(row, "data-url") or "", 2048), product_id)
    local price = tonumber(dom.attr(row, "data-price") or "")
    local currency = string.upper(clean(dom.attr(row, "data-currency") or "", 3))
    local currency_ok = string.match(currency, "^%u%u%u$") ~= nil
    local base_ok = product_id ~= "" and name ~= "" and price ~= nil and price > 0 and currency_ok
    if base_ok and product_url == nil then
      -- Everything else reads valid while the URL points off-host: the document is not the page
      -- this provider was reviewed against.
      document_changed = true
    end
    if base_ok and product_url ~= nil and seen[product_id] ~= true then
      seen[product_id] = true
      candidates[#candidates + 1] = {
        product_id = product_id,
        name = name,
        url = product_url,
        price = price,
        currency = currency,
      }
      if #candidates >= limit then break end
    end
  end

  if #candidates == 0 and document_changed then
    return { step = "blocked", classification = "document_changed" }
  end
  local status = "no_results"
  if #candidates > 0 then
    status = "candidates"
  elseif #rows > 0 then
    status = "price_unavailable"
  end
  local result = {
    schema_version = 1,
    status = status,
    query = input.query,
    page = input.page,
    cards_seen = #rows,
    has_more = dom.exists("[data-store-x-next]"),
  }
  if #candidates > 0 then result.candidates = json.array(candidates) end
  return { step = "done", result = result }
end

register({ search_products = search_products })
