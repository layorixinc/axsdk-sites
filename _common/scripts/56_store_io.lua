--- 스토어별 페이지 수집과 장바구니 담기. 브라우저에 실제로 닿는 층.
local B = AX_BASE
local C = AX_COMMERCE
if not (B and C) then
  error("_common/scripts/50_commerce_core.lua must be loaded before 56_store_io.lua")
end
local non_empty = B.non_empty
local copy_table, array, matches_query, infer_model = C.copy_table, C.array, C.matches_query, C.infer_model

function C.normalize_search_result(args, raw_result)
  args = args or {}
  local site = non_empty(args.site)
  local query = non_empty(args.query)
  if not site then return { error = "missing_site", candidates = array() } end
  if not query then return { site = site, error = "missing_query", candidates = array() } end

  local result = copy_table(raw_result or args.result)
  if result.status == "navigating" or result.navigated == true then
    result.status = "navigating"
    result.pending = true
  end
  if result.pending or result.error or result.login_required then
    result.site = site
    result.candidates = result.candidates or array()
    return result
  end

  local candidates, fx = C.normalize_candidates(site, result.candidates or {}, args.quantity, query, args)
  if not candidates then
    return { site = site, pending = fx and fx.pending == true, error = fx and fx.error, candidates = array() }
  end
  for index = 1, #candidates do
    local candidate = candidates[index]
    local explicit_model = non_empty(candidate.manufacturer_model)
    candidate.manufacturer_model = explicit_model
    candidate.model_hint = explicit_model or non_empty(candidate.model_hint) or infer_model(candidate.name)
    candidate.model_source = explicit_model and (non_empty(candidate.model_source) or "metadata")
      or (candidate.model_hint and "title_inference" or nil)

    local observed_brand = non_empty(candidate.brand)
    if observed_brand then
      candidate.brand = observed_brand
      candidate.brand_source = non_empty(candidate.brand_source) or "metadata"
    else
      local requested_brand = non_empty(args.requested_brand or args.identity_brand)
      if requested_brand and matches_query({ name = candidate.name }, requested_brand, args) then
        candidate.brand = requested_brand
        candidate.brand_source = "title"
      else
        candidate.brand = nil
        candidate.brand_source = nil
      end
    end
    candidate.identity_confidence = explicit_model and "high" or (candidate.model_hint and "medium" or "low")
  end
  if #candidates == 0 then result.error = "no_results" end
  result.site = site
  result.query = query
  result.candidates = candidates
  result.fx_date = fx.date
  result.fx_source = fx.source
  return result
end

function AX_normalize_store_product_result(args)
  return C.normalize_search_result(args, args and (args.result or args.store_result))
end

-- One store's search can span more than one result page. The Lua context dies on every navigation, so
-- the accumulator cannot live here: the worker hands back what it has collected so far and this command
-- merges the page it just read, re-applies the per-store cap, and decides whether another page is worth
-- the extra navigation. Every stop names itself so a thin store result can explain itself.
function AX_collect_store_page(args)
  args = args or {}
  local result = copy_table(args.result or args.store_result)
  local purpose = non_empty(args.purpose) or "comparison"
  local target = math.max(1, math.floor(tonumber(args.target)
    or (purpose == "discovery" and C.MAX_DISCOVERY_RESULTS or C.MAX_OFFERS_PER_SITE)))
  local page = math.max(1, math.floor(tonumber(args.page) or tonumber(result.page) or 1))

  local merged = AX_PAGINATION.merge_pages(args.collected, result.candidates or {}, page)
  local collected = array()
  -- `target` is the paging goal (is another navigation worth it), `keep_limit` is how many rows are
  -- carried forward for screening. Raising the goal to the wider limit would buy a second page for every
  -- store just to fill a list the model is about to cut down.
  local keep_limit = math.max(target, purpose == "discovery" and C.MAX_DISCOVERY_RESULTS or C.SCREEN_LIMIT_PER_SITE)
  for index = 1, math.min(#merged.items, keep_limit) do collected[index] = merged.items[index] end

  -- An empty page is not a broken store: "no_results" means this page held nothing relevant, and the
  -- next page is exactly where the match tends to be. Only a wall (captcha, login, access) stops here.
  local page_error = non_empty(result.error)
  local blocking = (page_error ~= nil and page_error ~= "no_results") or result.blocked == true
  local decision
  if blocking then
    decision = { continue = false, reason = "store_error" }
    page_error = page_error or "blocked"
  else
    page_error = nil
    decision = AX_PAGINATION.should_continue({
      collected = #collected,
      target = target,
      page = page,
      max_pages = tonumber(args.max_pages),
      added = merged.added,
      remote_used = tonumber(args.remote_used),
      remote_budget = tonumber(args.remote_budget),
      has_more = result.has_more
    })
  end

  local store_result = copy_table(result)
  -- An empty Lua table encodes as a JSON OBJECT, and the fan-out validates each task result against
  -- `candidates: [array, "null"]`. Live, every run: walmart searched three wordings, found nothing, and
  -- came back `result does not satisfy task.resultSchema: candidates: Invalid input` — reported as a
  -- technical failure rather than as a store with no matches, so every comparison was single-store.
  store_result.candidates = #collected > 0 and collected or nil
  store_result.total_count = #collected
  store_result.pages_read = page
  store_result.page = page
  store_result.has_more = result.has_more == true and decision.continue ~= true
  store_result.stop_reason = decision.reason
  store_result.error = nil
  store_result.blocked = nil
  store_result.page_error = page_error
  if #collected == 0 then
    -- With nothing collected the page error IS the store's outcome; downstream ranking reports it.
    store_result.error = page_error or "no_results"
  end

  -- A store that answered nothing may simply have been asked in the wrong language: a Korean store lists
  -- "로지텍 M185" and never matches "Logitech M185". Before giving up on it, the same search is retried in
  -- the other wordings the model wrote for this request. A store that DID answer never pays for the extra
  -- navigation, and a blocked store is not retried at all — the wall will not move for a synonym.
  local attempted = non_empty(args.tried_queries) or ""
  -- What was ACTUALLY searched, from wherever it survived. The caller does not always echo `query`, and
  -- `result.query` is nil whenever the normalizer wraps the store's answer — its own reply then sits at
  -- `store_result.store_result`. Traced live: with none of these consulted, `tried_queries` stayed empty,
  -- the next pass picked the first wording again, and discovery burned its whole node budget re-asking
  -- one store the same question until the subflow was killed and no product options existed.
  local nested = type(result.store_result) == "table" and result.store_result or nil
  local active_query = non_empty(args.query)
    or non_empty(result.query)
    or (nested and non_empty(nested.query))
    or non_empty((args.context or {}).query)
  if active_query and not attempted:find(active_query, 1, true) then
    attempted = attempted == "" and active_query or (attempted .. "|" .. active_query)
  end

  if not decision.continue and #collected == 0 and not blocking then
    local context = args.context or {}
    local wordings = C.query_variants({
      query = non_empty(context.query) or active_query,
      query_variants = non_empty(args.query_variants) or non_empty(context.query_variants)
    })
    for index = 1, #wordings do
      local wording = wordings[index]
      if not attempted:find(wording, 1, true) then
        return {
          next = "retry_query",
          page = 1,
          query = wording,
          tried_queries = attempted,
          stop_reason = "retry_query",
          collected = #collected > 0 and collected or nil,
          collected_count = #collected,
          store_result = store_result
        }
      end
    end
    decision = { continue = false, reason = "queries_exhausted" }
    store_result.stop_reason = decision.reason
  end

  return {
    next = decision.continue and "more" or "done",
    page = decision.continue and (page + 1) or page,
    query = active_query,
    tried_queries = attempted,
    stop_reason = decision.reason,
    collected = #collected > 0 and collected or nil,
    collected_count = #collected,
    store_result = store_result
  }
end

function AX_search_store_product(args)
  args = args or {}
  local site = non_empty(args.site)
  local query = non_empty(args.query)
  if not site then return { error = "missing_site", candidates = array() } end
  if not query then return { site = site, error = "missing_query", candidates = array() } end

  local adapter, adapter_error, pending_status = C.ensure_adapter(site)
  if not adapter then
    return {
      site = site,
      status = pending_status,
      pending = pending_status ~= nil,
      error = adapter_error,
      candidates = array()
    }
  end
  if type(adapter.search) ~= "function" then
    return { site = site, error = "search_unsupported", candidates = array() }
  end

  local result = adapter.search(args) or {}
  return C.normalize_search_result(args, result)
end

function AX_add_store_product_to_cart(args)
  args = args or {}
  if args.cart_approval ~= "user_selected_compared_offer" then
    return { added = false, error = "approval_required" }
  end
  if not non_empty(args.identity_id) or args.identity_approval ~= "locked_product_identity"
      or not non_empty(args.comparison_id) or args.comparison_approval ~= "current_comparison" then
    return { added = false, error = "identity_approval_required" }
  end
  local site = non_empty(args.site)
  if not site then return { added = false, error = "missing_site" } end
  local adapter, adapter_error, pending_status = C.ensure_adapter(site)
  if not adapter then
    return {
      site = site,
      added = false,
      status = pending_status,
      pending = pending_status ~= nil,
      error = adapter_error
    }
  end
  if type(adapter.add_to_cart) ~= "function" then
    return { site = site, added = false, error = "add_to_cart_unsupported" }
  end
  local result = adapter.add_to_cart(args) or {}
  result.site = site
  return result
end
