--- Thumbtack's service search, read from the runtime.
---
--- This is where the durable design cost the most. Every page-level tool had to be re-entrant and
--- page-detecting because a navigation destroyed the Lua context, and resuming across it was measured at
--- 12–21 seconds. A runtime script keeps its own stack, so the read is a straight line: fire the search,
--- wait for the list to stop changing, classify, read.
---
--- The waiting is the part that must not be lost. Thumbtack's results hydrate, so reading the first
--- answer reports a half-rendered page as the final one and a service with fifteen pros comes back with
--- three. The durable version used a `wait_settled` primitive for this; here it is a loop, which is what
--- it always was.

AX_RPC_THUMBTACK = AX_RPC_THUMBTACK or {}
local T = AX_RPC_THUMBTACK

T.HOME_URL = "https://www.thumbtack.com/"
-- The full pro card is the div that DIRECTLY contains the marker; the marker itself holds no service
-- link, so querying it returns rows with no id and every one is dropped. The attribute is data-test in
-- some A/B variants and data-testid in others.
T.CARD_SELECTOR = 'div:has(> [data-test="pro-list-result"]), div:has(> [data-testid="pro-list-result"])'
T.ZIP_REJECTED_SELECTOR = '[data-test="invalid-zip"], [data-test="zip-error"]'
T.RESULT_LIMIT = 24

local function trim(value)
  if type(value) ~= "string" then return nil end
  local text = value:gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", "")
  return text ~= "" and text or nil
end

local function array(value)
  if ax and type(ax.array) == "function" then
    local out = ax.array()
    for index = 1, #(value or {}) do out[index] = value[index] end
    return out
  end
  return value or {}
end

local function url_encode(value)
  return (tostring(value or ""):gsub("[^%w%-%._~]", function(char)
    return string.format("%%%02X", string.byte(char))
  end))
end

--- Category results live at `/k/<slug>/near-me/`. The slug is the service query lowercased with every
--- run of non-alphanumerics collapsed to one hyphen — "House Cleaning" becomes "house-cleaning".
function T.category_slug(query)
  local slug = tostring(query or ""):lower():gsub("[^%w]+", "-")
  return (slug:gsub("^%-+", ""):gsub("%-+$", ""))
end

function T.search_url(query, zip_code)
  local slug = T.category_slug(query)
  if slug == "" then return nil end
  return T.HOME_URL .. "k/" .. slug .. "/near-me/" .. (zip_code and ("?zip_code=" .. url_encode(zip_code)) or "")
end

local function fields()
  return {
    text = true,
    name = { selector = ".pro-title" },
    image_alt = { selector = "img", attr = "alt" },
    url = { selector = 'a[href*="/service/"]', attr = "href" },
  }
end

--- One pro card, or nil when it carries no name to show.
--- The pro id lives in the service URL. A card without one cannot be selected later, so it is dropped
--- rather than shown as a pro nobody can pick.
local function service_id_from(url)
  return tostring(url or ""):match("/service/(%d+)")
end

--- A card renders the name twice ("NameName"), sometimes followed by a rating badge. The largest
--- immediately-repeated prefix is the clean name.
local function dedupe_name(value)
  local text = trim(value)
  if not text then return nil end
  for half = math.floor(#text / 2), 3, -1 do
    if text:sub(1, half) == text:sub(half + 1, half * 2) then return trim(text:sub(1, half)) end
  end
  return text
end

--- The card's numbers, read off the FULL text. The stored summary is bounded, so parsing the bounded
--- copy would silently drop the hire count of any card whose review quote runs long.
local function digits(value)
  return value and tonumber((value:gsub(",", ""))) or nil
end

--- The card concatenates the amount and its label ("$110Starting price"); the shortlist window is read
--- by a person, so the space goes back. Only the separator is touched, never the amount.
local function price_text(text)
  local price = text:match("Contact for price")
    or text:match("(%$[%d,]+[^%$]-Starting price)") or text:match("(%$[%d,]+)")
  return trim(price and price:gsub("(%d)(%a)", "%1 %2") or nil)
end

local function candidate_from(row)
  local url = trim(row.url)
  local service_id = service_id_from(url)
  if not service_id then return nil end
  local alt = trim(row.image_alt)
  local name = (alt and trim((alt:gsub("^[Aa]vatar [Ff]or%s+", "")))) or dedupe_name(row.name)
  if not name then return nil end
  local text = trim(row.text) or ""
  local rating = tonumber(text:match("(%d+%.%d+)"))
  return {
    service_id = service_id,
    id = service_id,
    name = name,
    rating = (rating and rating <= 5) and rating or nil,
    review_count = digits(text:match("%(([%d,]+)%)")),
    hire_count = digits(text:match("([%d,]+)%s*hires on Thumbtack")),
    -- "Contact for price" is an answer, not a missing price: the pro quotes on request.
    price_text = price_text(text),
    response_time = trim(text:match("(Online [Nn]ow %- responds [^%.\"]+)")
      or text:match("(Responds in [^%.\"]+)") or text:match("(responds [^%.\"]+)")),
    location = trim(text:match("(Serves [A-Za-z%s%.%-]+, [A-Z][A-Z])")),
    url = url,
    -- The card text repeats itself and carries the avatar markup; the view layer strips markup when it
    -- renders, but an unbounded card multiplies the flow state by ten. The durable reader kept 360.
    summary = trim(text:sub(1, 360)),
  }
end

local function read_cards()
  local rows = dom.query_all(T.CARD_SELECTOR, fields(), T.RESULT_LIMIT)
  local candidates = {}
  local seen = {}
  for index = 1, #rows do
    local candidate = candidate_from(rows[index] or {})
    if candidate and not seen[candidate.service_id] then
      seen[candidate.service_id] = true
      candidates[#candidates + 1] = candidate
    end
  end
  return candidates
end

--- Reads the list once it stops changing.
---
--- `attempts` bounds the wait the way the durable primitive's `timeout` did; `quiet` is how many
--- identical counts in a row count as settled. A single stable reading is not enough: the first and
--- second polls of a list that has not started rendering are both zero.
function T.settle(attempts, quiet)
  local last, stable, candidates = nil, 0, {}
  for _ = 1, (attempts or 8) do
    candidates = read_cards()
    if #candidates == last then
      stable = stable + 1
      if stable >= (quiet or 1) then return candidates end
    else
      stable = 0
    end
    last = #candidates
  end
  return candidates
end

--- Searches Thumbtack for a service near a ZIP and returns the pros it settled on.
function T.search_service(args)
  args = type(args) == "table" and args or {}
  -- The node selects `service_query`; the tool's `input:` renamed it to `query` and a runtime lua tool
  -- never sees that block. Reading only the renamed key answered `query_required` live, and the user was
  -- told the ZIP was probably invalid — a wrong explanation for a mapping mistake.
  local query = trim(args.query) or trim(args.service_query)
  local zip_code = trim(args.zip_code)
  if not query then return { next = "error", error = "query_required" } end

  local ok, from = pcall(dom.get_location_href)
  if not ok then return { next = "error", error = "rpc_unavailable" } end

  local target = T.search_url(query, zip_code)
  if not target then return { next = "error", error = "query_not_sluggable" } end
  nav.navigate(target)
  nav.wait_for_navigation({ timeout = 8000, interval = 200 })

  local candidates = T.settle(8, 2)

  -- A bad postcode answers with a banner and an empty list. Reporting `no_results` would send the user
  -- looking for another service when the ZIP is what Thumbtack disliked.
  if dom.exists(T.ZIP_REJECTED_SELECTOR) then
    return { next = "invalid_zip", query = query, zip_code = zip_code,
             candidates = array({}), error = "invalid_zip" }
  end

  if #candidates == 0 then
    return { next = "no_results", query = query, zip_code = zip_code,
             candidates = array({}), error = "no_results" }
  end

  -- `next` is the flow's branch key, and the quote node enumerates `done`. Answering "ok" — a word the
  -- map does not contain — fell through `invalidNext` live: ten real pros were read and the user was
  -- told the request had failed. The service the user asked for and the count the results table prints
  -- travel with it, because the next node selects them from state, not from this tool's arguments.
  return {
    next = "done",
    query = query,
    service_query = query,
    zip_code = zip_code,
    href = dom.get_location_href(),
    total_count = #candidates,
    candidates = array(candidates),
  }
end
