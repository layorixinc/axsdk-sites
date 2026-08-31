--- 제품 동일성 확정과 옵션 스냅샷. 같은 물건인지를 여기서만 판단한다.
local B = AX_BASE
local C = AX_COMMERCE
if not (B and C) then
  error("_common/scripts/50_commerce_core.lua must be loaded before 52_identity.lua")
end
local clean, non_empty = B.clean_text, B.non_empty
local lower, copy_table, array = C.lower, C.copy_table, C.array

local function worker_value(result)
  if type(result) ~= "table" then return nil end
  local value = result.value
  if type(value) ~= "table" then return nil end
  if type(value.store_result) == "table" then return value.store_result end
  return value
end

local function identity_text(value)
  return lower(value):gsub("%s+", ""):gsub("[%p%c]", "")
end

local function stable_hash(value)
  local hash = 5381
  local text = tostring(value or "")
  for index = 1, #text do
    hash = ((hash * 33) + text:byte(index)) % 4294967296
  end
  return string.format("%.0f", math.floor(hash))
end

local function canonical_value(value, active)
  local kind = type(value)
  if kind == "nil" then return "z" end
  if kind == "boolean" then return value and "b1" or "b0" end
  if kind == "number" then
    local text = tostring(value)
    return "n" .. tostring(#text) .. ":" .. text
  end
  if kind == "string" then
    return "s" .. tostring(#value) .. ":" .. value
  end
  if kind ~= "table" then return "x" .. kind end

  active = active or {}
  if active[value] then return "cycle" end
  active[value] = true
  local entries = array()
  for key in pairs(value) do
    entries[#entries + 1] = { key = key, canonical_key = canonical_value(key, active) }
  end
  table.sort(entries, function(left, right) return left.canonical_key < right.canonical_key end)
  local fields = array()
  for index = 1, #entries do
    local entry = entries[index]
    fields[#fields + 1] = entry.canonical_key .. canonical_value(value[entry.key], active)
  end
  active[value] = nil
  return "t" .. tostring(#fields) .. ":" .. table.concat(fields)
end

local function stable_fields(value)
  if type(value) ~= "table" then return "t0:" end
  return canonical_value(value)
end

local function joined_query(brand, model, category)
  local parts = array()
  local seen = {}
  local function add(value)
    local text = non_empty(value)
    local key = text and identity_text(text)
    if text and key ~= "" and not seen[key] then
      seen[key] = true
      parts[#parts + 1] = text
    end
  end
  add(brand)
  add(model)
  add(category)
  return non_empty(table.concat(parts, " "))
end

-- A measurement is digits followed by a UNIT, and a model code is not: M185, S27C390 and RF285 all start
-- with letters, while 500ml, 60Hz, 1.5L, 1200mah and 2P do not. The old guard was a five-entry substring
-- blacklist (`ghz mah gb tb dpi`), so every other letter+digit token won and a bottled-water listing
-- resolved to model `500ml` — which then becomes the discovery GROUPING key and can be locked as an
-- identity, so two listings of the same water verify as different products. The blacklist stays as well:
-- it also rejects a unit sitting mid-token, which the shape rule alone would keep.
local UNIT_SUFFIXES = {
  ml = true, l = true, kg = true, g = true, mg = true, mm = true, cm = true, m = true,
  w = true, wh = true, v = true, hz = true, khz = true, mhz = true, ghz = true,
  ah = true, mah = true, kb = true, mb = true, gb = true, tb = true, dpi = true,
  p = true, k = true, ea = true, pcs = true, pack = true, inch = true, oz = true, lb = true,
}

--- True when the token reads as a quantity: leading digits and nothing after them but a known unit.
local function measurement_token(normalized)
  local tail = normalized:match("^%d+(%a+)$")
  return tail ~= nil and UNIT_SUFFIXES[tail] == true
end
local function infer_model(value)
  local text = clean(value)
  -- A LEADING bracket is merchandising, not the product. Korean storefronts put one on nearly every
  -- title, and the first token carrying both letters and digits was being read out of it: measured live,
  -- "[11Pay3%포인트] 로지텍 코리아 정품 리프트 LIFT 버티컬 …" was offered to the user as model `11Pay3`,
  -- a points promotion. The choice then locks onto a product that does not exist and the comparison finds
  -- nothing. Only LEADING brackets are stripped, so "(국내정품) 로지텍코리아 M170 …" still resolves to M170.
  local stripped = text
  for _ = 1, 3 do
    local rest = stripped:match("^%s*%b[]%s*(.*)$") or stripped:match("^%s*%b()%s*(.*)$")
    if not rest or rest == "" then break end
    stripped = rest
  end
  if stripped ~= "" then text = stripped end
  for token in text:gmatch("[%w%-]+") do
    local normalized = token:lower()
    local has_letter = token:match("%a") ~= nil
    local has_digit = token:match("%d") ~= nil
    local unit = normalized:find("ghz", 1, true)
      or normalized:find("mah", 1, true)
      or normalized:find("gb", 1, true)
      or normalized:find("tb", 1, true)
      or normalized:find("dpi", 1, true)
      or measurement_token(normalized)
    if has_letter and has_digit and not unit and #token >= 2 then return token end
  end
  return nil
end

local function candidate_model(candidate)
  return non_empty(candidate and (candidate.manufacturer_model or candidate.model_hint or candidate.model))
    or infer_model(candidate and (candidate.name or candidate.title))
end

local function identity_fingerprint(kind, brand, model, category, hard_constraints, source_product_id)
  return table.concat({
    "kind=" .. tostring(kind or ""),
    "brand=" .. identity_text(brand),
    "model=" .. identity_text(model),
    "category=" .. identity_text(category),
    "hard=" .. stable_fields(hard_constraints),
    "source=" .. identity_text(source_product_id)
  }, "|")
end

function AX_prepare_product_identity(args)
  args = args or {}
  local category = non_empty(args.product_category or args.category)
  local brand = non_empty(args.requested_brand or args.brand)
  local model = non_empty(args.requested_model or args.model)
  local kind = non_empty(args.identity_kind) or "standardized_model"
  if not category and not model then
    return {
      next = "ask_scope",
      identity_status = "missing",
      error = "missing_product_scope"
    }
  end

  -- Both paths retain the same deterministic store frontier. An exact model skips exploration on the
  -- first turn, but "다른 모델 보여줘" needs a model-free query and the original stores later.
  local discovery_sites = array()
  local seen_sites = {}
  for index = 1, #(args.stores or {}) do
    local item = args.stores[index] or {}
    local site = non_empty(item.site)
    if site and not seen_sites[site] then
      seen_sites[site] = true
      discovery_sites[#discovery_sites + 1] = { site = site }
    end
  end

  local exact_query = non_empty(args.query or args.canonical_query) or joined_query(brand, model, category)
  local exploration_query = model and joined_query(brand, nil, category) or exact_query
  if model then
    return {
      next = "lock",
      identity_status = "exact",
      identity_kind = kind,
      product_category = category,
      identity_brand = brand,
      identity_model = model,
      canonical_query = exact_query,
      exploration_query = exploration_query,
      discovery_sites = discovery_sites,
      hard_constraints = copy_table(args.hard_constraints),
      soft_preferences = copy_table(args.soft_preferences)
    }
  end

  -- A category or a spec-equivalent commodity is enough to SEARCH, never a reason to invent a model.
  -- The user sees grounded results first and may refine them repeatedly before choosing one identity.
  return {
    next = "explore",
    identity_status = kind == "spec_equivalent" and "specification" or (brand and "family" or "category"),
    identity_kind = kind,
    product_category = category,
    identity_brand = brand,
    exploration_query = exploration_query,
    discovery_query = exploration_query,
    discovery_sites = discovery_sites,
    hard_constraints = copy_table(args.hard_constraints),
    soft_preferences = copy_table(args.soft_preferences)
  }
end

function AX_lock_product_identity(args)
  args = args or {}
  local kind = non_empty(args.identity_kind) or "standardized_model"
  local category = non_empty(args.product_category or args.category)
  local brand = non_empty(args.identity_brand or args.brand)
  local model = non_empty(args.identity_model or args.model)
  local source_product_id = non_empty(args.source_product_id)
  if kind == "standardized_model" and not model then
    return { next = "invalid", error = "model_required" }
  end
  if kind == "spec_equivalent" and not category then
    return { next = "invalid", error = "category_required" }
  end
  if kind == "unique_listing" and not source_product_id then
    return { next = "invalid", error = "source_listing_required" }
  end

  local hard = copy_table(args.hard_constraints)
  local fingerprint = identity_fingerprint(kind, brand, model, category, hard, source_product_id)
  return {
    next = "compare",
    identity_status = "locked",
    identity_id = "identity-" .. stable_hash(fingerprint),
    identity_revision = math.max(0, math.floor(tonumber(args.identity_revision) or 0)) + 1,
    identity_fingerprint = fingerprint,
    identity_kind = kind,
    identity_name = non_empty(args.identity_name or args.display_name) or joined_query(brand, model, category),
    identity_brand = brand,
    identity_model = model,
    product_category = category,
    canonical_query = non_empty(args.canonical_query) or joined_query(brand, model, category),
    locked_hard_constraints = hard,
    locked_soft_preferences = copy_table(args.soft_preferences),
    identity_source_refs = args.source_refs,
    identity_approval = "locked_product_identity"
  }
end

local function candidate_facets(candidate)
  local out = {}
  for facet, record in pairs(type(candidate and candidate.facets) == "table" and candidate.facets or {}) do
    local value = type(record) == "table" and non_empty(record.value) or non_empty(record)
    local evidence = type(record) == "table" and non_empty(record.evidence) or value
    if non_empty(facet) and value and evidence then
      out[tostring(facet)] = { value = value, evidence = evidence }
    end
  end
  return out
end

local function facet_values(facets)
  local out = {}
  for facet, record in pairs(facets or {}) do
    if type(record) == "table" and non_empty(record.value) then out[facet] = record.value end
  end
  return out
end

local function facet_label(facets)
  local parts = array()
  for facet, value in pairs(facet_values(facets)) do
    parts[#parts + 1] = tostring(facet) .. "=" .. tostring(value)
  end
  table.sort(parts)
  return table.concat(parts, " · ")
end

--- Groups every screened live row into the surface the user can browse before identity lock.
--- A model is one cross-store group; observable commodity specs form a spec-equivalent group; a
--- remaining grounded listing is still selectable, but only as that exact store listing.
function AX_build_product_exploration(args)
  args = args or {}
  local grouped, order, failures = {}, array(), array()
  local catalog, catalog_seen = array(), {}
  local request_kind = non_empty(args.identity_kind) or "standardized_model"
  local category = non_empty(args.product_category)
  local results = args.results or args.discovery_results or {}

  local function remember_facet(facet, record)
    local value = record and non_empty(record.value)
    local evidence = record and non_empty(record.evidence)
    if not value or not evidence then return end
    local key = identity_text(facet) .. "|" .. identity_text(value)
    if catalog_seen[key] then return end
    catalog_seen[key] = true
    catalog[#catalog + 1] = { facet = facet, value = value, evidence = evidence }
  end

  for result_index = 1, #results do
    local result = results[result_index] or {}
    local site = non_empty(result.key) or tostring(result_index)
    if result.status == "completed" then
      local value = worker_value(result) or {}
      site = non_empty(value.site) or site
      local candidates = value.candidates or {}
      for candidate_index = 1, #candidates do
        local candidate = candidates[candidate_index] or {}
        local product_id = non_empty(candidate.product_id or candidate.id)
        local url = non_empty(candidate.url)
        local name = non_empty(candidate.name or candidate.title)
        if product_id and url and name then
          local facets = candidate_facets(candidate)
          for facet, record in pairs(facets) do remember_facet(facet, record) end
          local values = facet_values(facets)
          local model = request_kind ~= "spec_equivalent" and candidate_model(candidate) or nil
          local brand = non_empty(candidate.brand)
          local kind, key, display_name
          if model then
            kind = "standardized_model"
            key = "model|" .. identity_text(brand) .. "|" .. identity_text(model)
            display_name = joined_query(brand, model, category) or name
          elseif request_kind == "spec_equivalent" and next(values) ~= nil then
            kind = "spec_equivalent"
            key = "spec|" .. identity_text(category) .. "|" .. stable_fields(values)
            local details = facet_label(facets)
            display_name = category and (category .. (details ~= "" and (" · " .. details) or "")) or name
          else
            kind = "unique_listing"
            key = "listing|" .. identity_text(site) .. "|" .. identity_text(product_id)
            display_name = name
          end

          local group = grouped[key]
          if not group then
            group = {
              identity_kind = kind,
              display_name = display_name,
              identity_brand = brand,
              identity_model = model,
              product_category = category,
              facets = facets,
              source_refs = array(),
              source_sites = array(),
              source_seen = {},
              site_seen = {},
              observed_total = nil,
              observed_currency = nil,
              observed_total_base = nil,
            }
            grouped[key] = group
            order[#order + 1] = key
          end

          local source_key = identity_text(site) .. "|" .. identity_text(product_id)
          if not group.source_seen[source_key] then
            group.source_seen[source_key] = true
            group.source_refs[#group.source_refs + 1] = {
              site = site,
              product_id = product_id,
              url = url,
              name = name,
            }
          end
          if not group.site_seen[site] then
            group.site_seen[site] = true
            group.source_sites[#group.source_sites + 1] = site
          end

          local amount = tonumber(candidate.unit_total or candidate.total or candidate.price)
          local currency = non_empty(candidate.currency)
          local total_base = tonumber(candidate.total_base)
          if total_base and (not group.observed_total_base or total_base < group.observed_total_base) then
            group.observed_total_base = total_base
          end
          if amount and currency and (not group.observed_total
              or (group.observed_currency == currency and amount < group.observed_total)) then
            group.observed_total = amount
            group.observed_currency = currency
          end
        end
      end
      if #candidates == 0 then
        failures[#failures + 1] = { site = site, error = value.error or "no_results" }
      end
    else
      failures[#failures + 1] = { site = site, error = result.error or "store_search_failed" }
    end
  end

  local groups = array()
  for index = 1, #order do
    local group = grouped[order[index]]
    table.sort(group.source_sites)
    table.sort(group.source_refs, function(left, right)
      return tostring(left.site or "") .. "|" .. tostring(left.product_id or "")
        < tostring(right.site or "") .. "|" .. tostring(right.product_id or "")
    end)
    group.source_site_count = #group.source_sites
    group.source_seen = nil
    group.site_seen = nil
    groups[#groups + 1] = group
  end
  table.sort(groups, function(left, right)
    local left_kind = left.identity_kind == "unique_listing" and 1 or 0
    local right_kind = right.identity_kind == "unique_listing" and 1 or 0
    if left_kind ~= right_kind then return left_kind < right_kind end
    if left.source_site_count ~= right.source_site_count then return left.source_site_count > right.source_site_count end
    local left_total = tonumber(left.observed_total_base) or math.huge
    local right_total = tonumber(right.observed_total_base) or math.huge
    if left_total ~= right_total then return left_total < right_total end
    return tostring(left.display_name or "") < tostring(right.display_name or "")
  end)

  local limit = math.max(1, math.min(tonumber(args.max_groups) or 15, 30))
  while #groups > limit do table.remove(groups) end
  for index = 1, #groups do groups[index].group_id = "G" .. tostring(index) end
  table.sort(catalog, function(left, right)
    local left_key = tostring(left.facet or "") .. "|" .. tostring(left.value or "")
    local right_key = tostring(right.facet or "") .. "|" .. tostring(right.value or "")
    return left_key < right_key
  end)

  local version_input = {
    query = non_empty(args.query or args.exploration_query),
    product_category = category,
    identity_kind = request_kind,
    hard_constraints = copy_table(args.hard_constraints),
    groups = groups,
    facet_catalog = catalog,
  }
  local exploration_id = "exp-" .. stable_hash(canonical_value(version_input))
  for index = 1, #groups do groups[index].exploration_id = exploration_id end
  return {
    next = #groups > 0 and "present" or "empty",
    exploration_id = exploration_id,
    exploration_query = version_input.query,
    groups = groups,
    facet_catalog = catalog,
    failures = failures,
  }
end

--- Resolves only a number from the current exploration snapshot. It never creates cart approval.
function AX_resolve_product_exploration(args)
  args = args or {}
  local groups = args.groups or args.exploration_groups or {}
  local exploration_id = non_empty(args.exploration_id)
  local chosen_id = non_empty(args.choice_exploration_id)
  if not exploration_id or not chosen_id then
    return { next = "invalid", error = "exploration_version_required" }
  end
  if exploration_id ~= chosen_id then
    return { next = "invalid", error = "stale_exploration" }
  end

  local choice = tonumber(args.choice_index)
  if not choice and non_empty(args.choice_id) then
    for index = 1, #groups do
      if tostring(groups[index].group_id or "") == tostring(args.choice_id) then choice = index; break end
    end
  end
  if not choice or choice ~= math.floor(choice) or choice < 1 or choice > #groups then
    return { next = "invalid", error = "invalid_exploration_choice" }
  end

  local group = groups[choice] or {}
  local sources = group.source_refs or {}
  if #sources == 0 then return { next = "invalid", error = "ungrounded_exploration_choice" } end
  local hard = copy_table(args.hard_constraints)
  if group.identity_kind == "spec_equivalent" then
    for facet, value in pairs(facet_values(group.facets)) do
      if hard[facet] == nil then hard[facet] = value end
    end
  end
  local source = sources[1] or {}
  local locked = AX_lock_product_identity({
    identity_kind = group.identity_kind,
    identity_name = group.display_name,
    identity_brand = group.identity_brand,
    identity_model = group.identity_model,
    product_category = group.product_category,
    canonical_query = group.identity_kind == "unique_listing" and group.display_name
      or joined_query(group.identity_brand, group.identity_model, group.product_category)
      or group.display_name,
    hard_constraints = hard,
    soft_preferences = args.soft_preferences,
    source_refs = sources,
    source_product_id = group.identity_kind == "unique_listing" and source.product_id or nil,
    identity_revision = args.identity_revision,
  })
  if locked.next ~= "compare" then return locked end
  locked.next = "lock"
  locked.selected_exploration_group = group
  locked.selected_exploration_group_id = group.group_id
  locked.selected_exploration_id = exploration_id
  return locked
end

-- 다른 commerce 모듈과 공유한다. 파일 순서상 이 아래 모듈들이 헤더에서 집어 간다.
C.worker_value, C.identity_text, C.stable_hash, C.infer_model, C.candidate_model = worker_value, identity_text, stable_hash, infer_model, candidate_model
