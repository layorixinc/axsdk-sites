--- 고른 오퍼를 클릭 직전에 다시 읽어 신원과 가격을 재확인한다.
local B = AX_BASE
local C = AX_COMMERCE
if not (B and C) then
  error("_common/scripts/50_commerce_core.lua must be loaded before 53_verify.lua")
end
local non_empty = B.non_empty
local copy_table, array, worker_value, identity_text, candidate_model = C.copy_table, C.array, C.worker_value, C.identity_text, C.candidate_model

local function candidate_variant(candidate, key)
  local variants = candidate and (candidate.variants or candidate.identity_variants)
  return type(variants) == "table" and variants[key] or nil
end

function AX_verify_product_offers(args)
  args = args or {}
  local identity_id = non_empty(args.identity_id)
  local kind = non_empty(args.identity_kind) or "standardized_model"
  local expected_brand = non_empty(args.identity_brand)
  local expected_model = non_empty(args.identity_model)
  local expected_category = non_empty(args.product_category)
  local hard = args.hard_constraints or args.locked_hard_constraints or {}
  local verified = array()
  local ambiguous = array()
  local excluded = array()
  local failures = array()
  local results = args.results or args.store_results or {}

  for result_index = 1, #results do
    local result = results[result_index] or {}
    local site = non_empty(result.key) or tostring(result_index)
    if result.status == "completed" then
      local value = worker_value(result) or {}
      site = non_empty(value.site) or site
      local candidates = value.candidates or {}
      for candidate_index = 1, #candidates do
        local candidate = copy_table(candidates[candidate_index])
        candidate.site = non_empty(candidate.site) or site
        local reason = nil
        local outcome = "exact"
        local observed_model = candidate_model(candidate)
        local observed_brand = non_empty(candidate.brand)

        if kind == "standardized_model" then
          if not observed_model then
            outcome, reason = "ambiguous", "manufacturer_model_missing"
          elseif identity_text(observed_model) ~= identity_text(expected_model) then
            outcome, reason = "mismatch", "model_mismatch"
          elseif expected_brand and observed_brand and identity_text(observed_brand) ~= identity_text(expected_brand) then
            outcome, reason = "mismatch", "brand_mismatch"
          end
        elseif kind == "spec_equivalent" then
          local category = non_empty(candidate.product_category or candidate.category)
          if not category then
            outcome, reason = "ambiguous", "category_missing"
          elseif expected_category and identity_text(category) ~= identity_text(expected_category) then
            outcome, reason = "mismatch", "category_mismatch"
          end
        elseif kind == "unique_listing" then
          outcome, reason = "ambiguous", "unique_listing_not_comparable"
        end

        if outcome ~= "mismatch" then
          local keys = array()
          for key in pairs(hard) do keys[#keys + 1] = key end
          table.sort(keys)
          for key_index = 1, #keys do
            local key = keys[key_index]
            local expected = hard[key]
            if expected ~= nil then
              local observed = candidate_variant(candidate, key)
              if observed == nil then
                outcome, reason = "ambiguous", "variant_missing:" .. tostring(key)
                break
              elseif identity_text(observed) ~= identity_text(expected) then
                outcome, reason = "mismatch", "variant_mismatch:" .. tostring(key)
                break
              end
            end
          end
        end

        candidate.identity_id = identity_id
        candidate.identity_match = outcome
        candidate.observed_model = observed_model
        if outcome == "exact" then
          verified[#verified + 1] = candidate
        elseif outcome == "ambiguous" then
          candidate.reason = reason
          ambiguous[#ambiguous + 1] = candidate
        else
          candidate.reason = reason
          excluded[#excluded + 1] = candidate
        end
      end
      if #candidates == 0 then
        failures[#failures + 1] = { site = site, error = value.error or "no_results" }
      end
    else
      failures[#failures + 1] = { site = site, status = result.status or "failed", error = result.error or "store_search_failed" }
    end
  end

  -- An empty Lua table encodes as a JSON OBJECT, and every schema that types these as arrays rejects it.
  -- Live: every store answered, so `failures` was empty, and the next tool died with `failures: Invalid
  -- input` — after the search, the screening and the verification had all already run. Absent, not empty.
  local function listed(values)
    return #values > 0 and values or nil
  end

  return {
    next = #verified > 0 and (#failures > 0 and "partial" or "done") or "empty",
    identity_id = identity_id,
    verified_offers = listed(verified),
    ambiguous_offers = listed(ambiguous),
    excluded_offers = listed(excluded),
    failures = listed(failures)
  }
end
