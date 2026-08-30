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

local function identity_fingerprint(kind, brand, model, category, hard_constraints)
  return table.concat({
    "kind=" .. tostring(kind or ""),
    "brand=" .. identity_text(brand),
    "model=" .. identity_text(model),
    "category=" .. identity_text(category),
    "hard=" .. stable_fields(hard_constraints)
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

  local query = joined_query(brand, model, category)
  if model then
    return {
      next = "lock",
      identity_status = "exact",
      identity_kind = kind,
      product_category = category,
      identity_brand = brand,
      identity_model = model,
      canonical_query = non_empty(args.query or args.canonical_query) or query,
      hard_constraints = copy_table(args.hard_constraints),
      soft_preferences = copy_table(args.soft_preferences)
    }
  end

  -- A commodity has no manufacturer model to discover. The user's category and must-match specs ARE
  -- the identity, so sending it through the model-choice gate can only invent a code or produce an
  -- unnumbered dead end. The collection model decides this kind from the request; Lua merely enforces it.
  if kind == "spec_equivalent" then
    local canonical = non_empty(args.query or args.canonical_query) or query
    return {
      next = "lock",
      identity_status = "exact",
      identity_kind = kind,
      identity_name = canonical,
      product_category = category,
      identity_brand = brand,
      canonical_query = canonical,
      hard_constraints = copy_table(args.hard_constraints),
      soft_preferences = copy_table(args.soft_preferences)
    }
  end

  -- Discovery uses the same bounded sequential store queue as exact-model comparison. Keeping the
  -- request order makes a ten-store run deterministic; `flow.map` owns the one-at-a-time execution and
  -- collects a classified failure without dropping the remaining stores.
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

  return {
    next = "discover",
    identity_status = brand and "family" or "category",
    identity_kind = kind,
    product_category = category,
    identity_brand = brand,
    discovery_query = query,
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
  if kind == "standardized_model" and not model then
    return { next = "invalid", error = "model_required" }
  end
  if kind == "spec_equivalent" and not category then
    return { next = "invalid", error = "category_required" }
  end
  if kind == "unique_listing" and not non_empty(args.source_product_id) then
    return { next = "invalid", error = "source_listing_required" }
  end

  local hard = copy_table(args.hard_constraints)
  local fingerprint = identity_fingerprint(kind, brand, model, category, hard)
  return {
    next = "compare",
    identity_status = "locked",
    identity_id = "identity-" .. stable_hash(fingerprint),
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

function AX_build_product_options(args)
  args = args or {}
  local groups = {}
  local group_order = array()
  local failures = array()
  local results = args.results or args.discovery_results or {}
  local requested_brand = non_empty(args.requested_brand or args.identity_brand)

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
          local model = candidate_model(candidate)
          local brand = non_empty(candidate.brand)
          local kind = model and "standardized_model" or "unique_listing"
          local key = model and ("model|" .. identity_text(brand) .. "|" .. identity_text(model))
            or ("listing|" .. identity_text(site) .. "|" .. identity_text(product_id))
          local option = groups[key]
          if not option then
            option = {
              identity_kind = kind,
              display_name = model and (joined_query(brand, model, nil) or name) or name,
              brand = brand,
              model = model,
              product_category = non_empty(args.product_category),
              identity_confidence = model and "medium" or "low",
              needs_enrichment = model == nil,
              source_refs = array(),
              sample_prices = array(),
              group_key = key,
              source_seen = {},
              site_seen = {},
              has_explicit_model = false
            }
            groups[key] = option
            group_order[#group_order + 1] = key
          end

          if non_empty(candidate.manufacturer_model) then option.has_explicit_model = true end
          local source_key = identity_text(site) .. "|" .. identity_text(product_id)
          if not option.source_seen[source_key] then
            option.source_seen[source_key] = true
            option.site_seen[site] = true
            option.source_refs[#option.source_refs + 1] = {
              site = site,
              product_id = product_id,
              url = url,
              name = name,
              brand_source = non_empty(candidate.brand_source),
              model_source = non_empty(candidate.model_source)
            }
            if tonumber(candidate.price) and non_empty(candidate.currency) then
              option.sample_prices[#option.sample_prices + 1] = {
                site = site,
                product_id = product_id,
                price = tonumber(candidate.price),
                currency = tostring(candidate.currency):upper()
              }
            end
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

  local options = array()
  for index = 1, #group_order do
    local option = groups[group_order[index]]
    local source_sites = array()
    for site in pairs(option.site_seen) do source_sites[#source_sites + 1] = site end
    table.sort(source_sites)
    table.sort(option.source_refs, function(left, right)
      local left_key = tostring(left.site or "") .. "|" .. tostring(left.product_id or "") .. "|" .. tostring(left.url or "")
      local right_key = tostring(right.site or "") .. "|" .. tostring(right.product_id or "") .. "|" .. tostring(right.url or "")
      return left_key < right_key
    end)
    table.sort(option.sample_prices, function(left, right)
      local left_key = tostring(left.site or "") .. "|" .. tostring(left.product_id or "") .. "|" .. tostring(left.currency or "")
      local right_key = tostring(right.site or "") .. "|" .. tostring(right.product_id or "") .. "|" .. tostring(right.currency or "")
      if left_key ~= right_key then return left_key < right_key end
      return (tonumber(left.price) or math.huge) < (tonumber(right.price) or math.huge)
    end)
    option.source_sites = source_sites
    option.source_site_count = #source_sites
    if option.model then
      option.identity_confidence = (option.has_explicit_model or #source_sites > 1) and "high" or "medium"
      option.model_source = option.has_explicit_model and "metadata" or "title_inference"
    end
    option.source_seen = nil
    option.site_seen = nil
    option.has_explicit_model = nil
    options[#options + 1] = option
  end
  table.sort(options, function(left, right)
    if left.source_site_count ~= right.source_site_count then return left.source_site_count > right.source_site_count end
    if #left.source_refs ~= #right.source_refs then return #left.source_refs > #right.source_refs end
    return tostring(left.display_name or "") < tostring(right.display_name or "")
  end)

  -- A number is an executable promise: choosing it must lock an identity on the very next deterministic
  -- step. Real listings without a grounded manufacturer model remain visible as unnumbered observations,
  -- but they cannot consume a number that the resolver will answer with `enrich`.
  local selectable, unresolved_names, unresolved_seen = array(), array(), {}
  for index = 1, #options do
    local option = options[index]
    if option.model and option.needs_enrichment ~= true and option.identity_confidence ~= "low"
       and #(option.source_refs or {}) > 0 then
      selectable[#selectable + 1] = option
    else
      local name = non_empty(option.display_name)
      if name and not unresolved_seen[name] and #unresolved_names < 3 then
        unresolved_seen[name] = true
        unresolved_names[#unresolved_names + 1] = name
      end
    end
  end
  options = selectable

  local limit = math.max(1, math.min(tonumber(args.max_options) or 5, 10))
  while #options > limit do table.remove(options) end
  for index = 1, #options do
    options[index].option_id = "D" .. tostring(index)
    options[index].group_key = nil
  end

  local summary_lines = array()
  for index = 1, #options do
    local option = options[index]
    local sites = table.concat(option.source_sites or {}, ", ")
    local provenance = sites ~= "" and (" — found at " .. sites) or ""
    summary_lines[#summary_lines + 1] = tostring(index) .. ". " .. tostring(option.display_name) .. provenance
  end
  local product_option_summaries = non_empty(table.concat(summary_lines, "\n"))
  local unresolved_product_names = nil
  if #unresolved_names > 0 then
    unresolved_product_names = "- " .. table.concat(unresolved_names, "\n- ")
  end

  local version_snapshot = {
    query = non_empty(args.query or args.discovery_query),
    product_category = non_empty(args.product_category),
    requested_brand = requested_brand,
    hard_constraints = copy_table(args.hard_constraints),
    soft_preferences = copy_table(args.soft_preferences),
    options = options,
    unresolved_product_names = unresolved_product_names,
  }
  local version = "disc-" .. stable_hash(canonical_value(version_snapshot))
  for index = 1, #options do options[index].options_version = version end

  return {
    next = (#options > 0 or unresolved_product_names) and "choose" or "empty",
    options = options,
    options_version = version,
    product_option_summaries = product_option_summaries,
    unresolved_product_names = unresolved_product_names,
    failures = failures
  }
end

function AX_resolve_product_option(args)
  args = args or {}
  local options = args.options or args.product_options or {}
  local version = non_empty(args.options_version)
  local chosen_version = non_empty(args.choice_options_version)
  if not version or not chosen_version then
    return { next = "invalid", error = "product_options_version_required" }
  end
  if version ~= chosen_version then
    return { next = "invalid", error = "stale_product_options" }
  end

  local choice = tonumber(args.choice_index)
  if not choice and non_empty(args.choice_id) then
    for index = 1, #options do
      if tostring(options[index].option_id or "") == tostring(args.choice_id) then choice = index; break end
    end
  end
  if not choice or choice ~= math.floor(choice) or choice < 1 or choice > #options then
    return { next = "invalid", error = "invalid_product_option" }
  end

  local option = options[choice] or {}
  local sources = option.source_refs or {}
  if #sources == 0 then return { next = "invalid", error = "ungrounded_product_option" } end
  if option.needs_enrichment == true or option.identity_confidence == "low" then
    local source = sources[1] or {}
    return {
      next = "enrich",
      selected_option = option,
      selected_option_id = option.option_id,
      source_site = source.site,
      source_product_id = source.product_id,
      source_url = source.url
    }
  end

  local locked = AX_lock_product_identity({
    identity_kind = option.identity_kind,
    identity_name = option.display_name,
    identity_brand = option.brand,
    identity_model = option.model,
    product_category = option.product_category,
    canonical_query = joined_query(option.brand, option.model, option.product_category),
    hard_constraints = args.hard_constraints,
    soft_preferences = args.soft_preferences,
    source_refs = sources
  })
  if locked.next ~= "compare" then return locked end
  locked.next = "lock"
  locked.selected_option = option
  locked.selected_option_id = option.option_id
  locked.product_options_version = version
  return locked
end

-- 다른 commerce 모듈과 공유한다. 파일 순서상 이 아래 모듈들이 헤더에서 집어 간다.
C.worker_value, C.identity_text, C.stable_hash, C.infer_model, C.candidate_model = worker_value, identity_text, stable_hash, infer_model, candidate_model
