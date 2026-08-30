--- LLM 관련성 판정이 남긴 오퍼에 잠긴 상품 신원을 결합한다.
local B = AX_BASE
local C = AX_COMMERCE
-- This file runs AFTER the LLM relevance gate. It attaches the locked identity to the rows that gate kept;
-- it must never perform a second semantic model/brand/variant judgement in code.
if not (B and C and C.worker_value) then
  error("_common/scripts/52_identity.lua must be loaded before 53_verify.lua")
end
local non_empty = B.non_empty
local copy_table, array, worker_value = C.copy_table, C.array, C.worker_value


function AX_verify_product_offers(args)
  args = args or {}
  local identity_id = non_empty(args.identity_id)
  local verified = array()
  local failures = array()
  local results = args.results or args.store_results or {}

  for result_index = 1, #results do
    local result = results[result_index] or {}
    local site = non_empty(result.key) or tostring(result_index)
    if result.status == "completed" then
      local value = worker_value(result) or {}
      site = non_empty(value.site) or site
      local candidates = value.candidates or {}
      local accepted = 0
      for candidate_index = 1, #candidates do
        local candidate = copy_table(candidates[candidate_index])
        candidate.site = non_empty(candidate.site) or site
        candidate.product_id = non_empty(candidate.product_id or candidate.id)
        candidate.name = non_empty(candidate.name or candidate.title)
        if candidate.product_id and candidate.name and tonumber(candidate.price) then
          candidate.identity_id = identity_id
          verified[#verified + 1] = candidate
          accepted = accepted + 1
        end
      end
      if accepted == 0 then
        failures[#failures + 1] = {
          site = site,
          error = value.error or (#candidates > 0 and "invalid_screened_offer" or "no_results")
        }
      end
    else
      failures[#failures + 1] = {
        site = site,
        status = result.status or "failed",
        error = result.error or "store_search_failed"
      }
    end
  end

  -- An empty Lua table encodes as a JSON OBJECT, and every schema that types these as arrays rejects it.
  local function listed(values)
    return #values > 0 and values or nil
  end

  return {
    next = #verified > 0 and (#failures > 0 and "partial" or "done") or "empty",
    verified_offers = listed(verified),
    failures = listed(failures)
  }
end
