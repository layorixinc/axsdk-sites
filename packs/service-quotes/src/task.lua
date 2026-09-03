-- Comparative service quotes: agent task commands (EXTERNAL_PACK_TASK_PLAN §9, authored as Lua).
-- The real work is UNIT NORMALISATION WITH GRADED PROVENANCE, not price scraping: every amount
-- carries its unit and what KIND of claim it is (pro_stated · listing_price · site_average), a
-- missing figure stays absent, and a figure the normaliser cannot compare keeps its stated text
-- and produces NO guess.

local function clean(value, maximum)
  return text.clean(value, maximum or 240)
end

local KIND_ALLOWED = { pro_stated = true, listing_price = true, site_average = true }

local function prepare_service_query(input)
  local query = clean(type(input) == "table" and input.query or nil)
  if query == "" then error("query_required") end
  local out = { query = query, limit = 6 }
  local region = clean(type(input) == "table" and input.region or nil, 40)
  if region ~= "" then out.region = region end
  return out
end

local function usd_amounts(lowered)
  local amounts = {}
  for digits in string.gmatch(lowered, "%$%s*(%d[%d,]*%.?%d?%d?)") do
    local amount = tonumber((string.gsub(digits, ",", "")))
    if amount ~= nil then amounts[#amounts + 1] = amount end
  end
  return amounts
end

local function krw_amounts(lowered)
  local amounts = {}
  for digits in string.gmatch(lowered, "(%d[%d,]*)%s*원") do
    local amount = tonumber((string.gsub(digits, ",", "")))
    if amount ~= nil then amounts[#amounts + 1] = amount end
  end
  return amounts
end

local function unit_of(lowered)
  if string.find(lowered, "per%s+visit") or string.find(lowered, "방문당", 1, true) then return "per_visit" end
  if string.find(lowered, "per%s+hour") or string.find(lowered, "시간당", 1, true) then return "per_hour" end
  if string.find(lowered, "건당", 1, true) then return "per_job" end
  if string.find(lowered, "~", 1, true) or string.find(lowered, "부터", 1, true) then return "starting_at" end
  return nil
end

-- One claim → one row. A row without a recognisable single amount AND unit stays text-only:
-- fabricating a number here is the failure this repo has paid for twice (AGENTS.md §13).
local function normalise_claim(claim)
  local kind = type(claim) == "table" and claim.kind or nil
  local raw = clean(type(claim) == "table" and claim.text or nil)
  if KIND_ALLOWED[kind] ~= true or raw == "" then error("claim_invalid") end
  local row = { kind = kind, text = raw, comparable = false }
  local lowered = string.lower(raw)
  local unit = unit_of(lowered)

  local usd = usd_amounts(lowered)
  local krw = krw_amounts(lowered)
  local currency = nil
  local amounts = {}
  if #usd > 0 and #krw == 0 then
    currency, amounts = "USD", usd
  elseif #krw > 0 and #usd == 0 then
    currency, amounts = "KRW", krw
  end

  if kind == "site_average" then
    -- A band is the SITE's claim about the whole service: never an amount, never comparable.
    if currency ~= nil and #amounts == 2 and unit ~= nil then
      row.currency = currency
      row.unit = unit
      row.band = { low = math.min(amounts[1], amounts[2]), high = math.max(amounts[1], amounts[2]) }
    end
    return row
  end

  if currency ~= nil and #amounts == 1 and unit ~= nil then
    row.amount = amounts[1]
    row.currency = currency
    row.unit = unit
    row.comparable = true
  end
  return row
end

local function normalise_service_price(input)
  local claims = type(input) == "table" and input.claims or nil
  if type(claims) ~= "table" or #claims < 1 then error("claims_required") end
  local rows = {}
  for index = 1, #claims do
    rows[index] = normalise_claim(claims[index])
  end
  return { rows = json.array(rows) }
end

local function reputation_bits(candidate)
  local bits = {}
  if candidate.rating ~= nil and candidate.review_count ~= nil then
    bits[#bits + 1] = string.format("평점 %s (%d)", tostring(candidate.rating), candidate.review_count)
  end
  if candidate.hires ~= nil then bits[#bits + 1] = string.format("고용 %d회", candidate.hires) end
  if candidate.experience_years ~= nil then
    bits[#bits + 1] = string.format("경력 %d년", candidate.experience_years)
  end
  return table.concat(bits, " · ")
end

local function amount_label(row)
  if row.band ~= nil then
    return string.format("%s %d–%d %s", row.currency, row.band.low, row.band.high, row.unit)
  end
  return string.format("%s %d %s", row.currency, row.amount, row.unit)
end

local function rank_service_estimates(input)
  -- The flow boundary hands the provider result as one envelope (`marketplaceResult`); the command
  -- path hands `candidates`/`site_claims` directly. One reader for both, no third shape.
  local source = type(input) == "table" and input or {}
  if type(source.marketplaceResult) == "table" then source = source.marketplaceResult end
  local candidates = source.candidates
  if type(candidates) ~= "table" or #candidates < 1 then error("candidates_required") end

  local priced = {}
  local reputation_only = {}
  for index = 1, #candidates do
    local candidate = candidates[index]
    local row = {
      site = candidate.site,
      name = candidate.name,
      url = candidate.url,
      rating = candidate.rating,
      review_count = candidate.review_count,
      hires = candidate.hires,
      experience_years = candidate.experience_years,
    }
    local best = nil
    local claim_list = candidate.claims
    if type(claim_list) ~= "table" and candidate.claim_kind ~= nil and candidate.claim_text ~= nil then
      claim_list = { { kind = candidate.claim_kind, text = candidate.claim_text } }
    end
    if type(claim_list) == "table" then
      for claim_index = 1, #claim_list do
        local normalised = normalise_claim(claim_list[claim_index])
        if best == nil and normalised.comparable then best = normalised end
      end
    end
    if best ~= nil then
      row.amount = best.amount
      row.currency = best.currency
      row.unit = best.unit
      row.provenance = best.kind
      priced[#priced + 1] = row
    else
      -- The honest row for most pros: reputation only, amount ABSENT — never filled from a band.
      row.provenance = "amount_not_published"
      reputation_only[#reputation_only + 1] = row
    end
  end
  table.sort(priced, function(left, right)
    if left.currency ~= right.currency then return left.currency < right.currency end
    if left.unit ~= right.unit then return left.unit < right.unit end
    if left.amount ~= right.amount then return left.amount < right.amount end
    return left.name < right.name
  end)

  local rows = {}
  for index = 1, #priced do rows[#rows + 1] = priced[index] end
  for index = 1, #reputation_only do rows[#rows + 1] = reputation_only[index] end

  local site_rows = {}
  local site_claims = type(source.site_claims) == "table" and source.site_claims or {}
  for index = 1, #site_claims do
    local entry = site_claims[index]
    local normalised = normalise_claim({ kind = "site_average", text = entry.text })
    normalised.site = entry.site
    normalised.provenance = "site_average"
    site_rows[#site_rows + 1] = normalised
  end

  local lines = {}
  for index = 1, #rows do
    local row = rows[index]
    local label
    if row.amount ~= nil then
      label = string.format("%s (%s)", amount_label(row), row.provenance)
    else
      label = "공개 금액 없음"
    end
    local reputation = reputation_bits(row)
    if reputation ~= "" then label = label .. " · " .. reputation end
    lines[#lines + 1] = string.format("%d. %s (%s) — %s", index, row.name, tostring(row.site), label)
  end
  for index = 1, #site_rows do
    local row = site_rows[index]
    if row.band ~= nil then
      lines[#lines + 1] = string.format("사이트 평균 (%s): %s (site_average — 개별 업체의 견적이 아님)",
        tostring(row.site), amount_label(row))
    end
  end

  return {
    rows = json.array(rows),
    site_rows = json.array(site_rows),
    comparisonText = table.concat(lines, "\n"),
  }
end

register({
  prepare_service_query = prepare_service_query,
  normalise_service_price = normalise_service_price,
  rank_service_estimates = rank_service_estimates,
})
