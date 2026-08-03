--- 순위·표시·정제·해석 — 사용자가 번호로 고르는 표면.
local B = AX_BASE
local C = AX_COMMERCE
if not (B and C) then
  error("_common/scripts/50_commerce_core.lua must be loaded before 55_offers.lua")
end
local non_empty = B.non_empty
local copy_table, array, worker_value, compare_offers, uniform_currency, persist_comparison = C.copy_table, C.array, C.worker_value, C.compare_offers, C.uniform_currency, C.persist_comparison

function AX_rank_store_offers(args)
  args = args or {}
  local offers = array()
  local failures = array()
  local required_identity = non_empty(args.identity_id)

  local function append_offer(value, fallback_site)
    local candidate = copy_table(value)
    candidate.site = non_empty(candidate.site) or fallback_site
    candidate.product_id = non_empty(candidate.product_id or candidate.id)
    candidate.id = candidate.product_id
    candidate.name = non_empty(candidate.name or candidate.title)
    local identity_matches = not required_identity
      or candidate.identity_id == required_identity
      or candidate.identity_match == "exact"
    if identity_matches and candidate.product_id and candidate.name and tonumber(candidate.price) then
      candidate.identity_id = required_identity or candidate.identity_id
      offers[#offers + 1] = candidate
    end
  end

  if args.verified_offers ~= nil then
    for index = 1, #(args.verified_offers or {}) do
      append_offer(args.verified_offers[index], non_empty(args.verified_offers[index] and args.verified_offers[index].site))
    end
    for index = 1, #(args.failures or {}) do failures[#failures + 1] = copy_table(args.failures[index]) end
  else
    local results = args.results or args.store_results or {}
    for index = 1, #results do
      local result = results[index] or {}
      local site = non_empty(result.key) or tostring(index)
      if result.status == "completed" then
        local value = worker_value(result) or {}
        site = non_empty(value.site) or site
        local candidates = value.candidates or {}
        for candidate_index = 1, #candidates do append_offer(candidates[candidate_index], site) end
        if #candidates == 0 then
          failures[#failures + 1] = { site = site, error = value.error or "no_results" }
        end
      else
        failures[#failures + 1] = { site = site, status = result.status or "failed", error = result.error or "store_search_failed" }
      end
    end
  end

  table.sort(offers, compare_offers)
  while #offers > C.MAX_RANKED_OFFERS do table.remove(offers) end

  -- The task is total cost, so a row whose shipping is unknown cannot answer it. Those rows are folded
  -- out of the default window but stay in `all_offers`, one sentence away ("미확인 포함"). Folding them
  -- when there is nothing else left would leave the user with no choice at all, so that case shows them.
  local complete = array()
  local incomplete = 0
  for index = 1, #offers do
    if offers[index].cost_complete == true then
      complete[#complete + 1] = offers[index]
    else
      incomplete = incomplete + 1
    end
  end
  local visible = #complete > 0 and complete or offers
  local hidden_incomplete = #complete > 0 and incomplete or 0

  local notes, status = C.comparison_notes(failures, offers, hidden_incomplete, args.screened_out)
  local snapshot = C.open_comparison(visible, required_identity, {
    all_offers = offers,
    filters = hidden_incomplete > 0 and { complete_cost_only = true } or {},
    notes = notes
  })
  local next_value = "done"
  if #offers == 0 then
    next_value = "empty"
  elseif #failures > 0 then
    next_value = "partial"
  end
  return {
    next = next_value,
    identity_id = required_identity,
    comparison_id = snapshot.comparison_id,
    offers = snapshot.offers,
    all_offers = offers,
    failures = failures,
    comparison_text = snapshot.question,
    store_status = status.text,
    stores_with_offers = status.ok_count,
    stores_failed = status.failed_count,
    incomplete_count = incomplete,
    complete_count = #complete,
    screened_out = tonumber(args.screened_out) or 0,
    base_currency = C.BASE_CURRENCY,
    display_currency = snapshot.display_currency or C.BASE_CURRENCY,
    view_page = snapshot.view.page,
    view_pages = snapshot.view.pages,
    view_total = snapshot.view.total
  }
end

function AX_present_store_offers(args)
  args = args or {}
  local window = C.load_window(args and args.comparison_id)
  if not window then
    return { error = "stale_comparison" }
  end
  return {
    comparison_id = window.comparison_id,
    question = window.question,
    view_page = window.page,
    view_pages = window.pages,
    view_total = window.total
  }
end

-- Browsing the comparison: move the window, filter it, or sort it. The offer list arrives in the call
-- arguments (the browsing node is deterministic and reads flow state), so this survives the Lua context
-- being rebuilt between turns. A window move keeps the comparison id so the numbers the user is looking
-- at stay valid; anything that changes WHICH offers are listed reissues it, and every number from the
-- previous listing then fails resolution.
function AX_refine_store_offers(args)
  args = args or {}
  local comparison_id = non_empty(args.comparison_id)
  local offers = args.offers
  if type(offers) ~= "table" or #offers == 0 then
    -- Nothing to browse without the listing. Answering "ask" sent the model straight back into the same
    -- failing call (seven times in one measured turn); "error" routes to a terminal that explains itself.
    return { next = "error", error = "stale_comparison" }
  end
  local current_id = non_empty(offers[1] and offers[1].comparison_id)
  if not comparison_id or (current_id and current_id ~= comparison_id) then
    return { next = "error", error = "stale_comparison" }
  end

  local all_offers = type(args.all_offers) == "table" and #args.all_offers > 0 and args.all_offers or offers
  local identity_id = non_empty(args.identity_id or (offers[1] and offers[1].identity_id))
  local sort = AX_OFFER_VIEW.SORTS[args.view_sort] and args.view_sort or "total_asc"
  local page = math.max(1, math.floor(tonumber(args.view_page) or 1))

  -- Store outcomes and the folded-row note describe the listing, not one page of it, so every window the
  -- user browses to carries them.
  local function notes_for(list)
    local hidden = #all_offers - #list
    return C.comparison_notes(args.failures, all_offers, hidden > 0 and C.has_incomplete(all_offers) and hidden or 0)
  end

  -- A refinement that did not apply must say so in the window, not only in a state field the model may
  -- forget to mention: the window is the one text the user is guaranteed to see.
  local REFINE_REASONS = {
    price_currency_unknown = "요청하신 금액 조건(원/KRW)은 이 목록의 통화와 달라 적용하지 못했습니다 — 목록에 쓰인 통화로 다시 말씀해 주세요",
    no_matches = "조건에 맞는 상품이 없어 이전 목록을 그대로 보여드립니다",
    unparsed = "말씀하신 조건을 이해하지 못했습니다 — '무료배송만', '3만원 이하', '평점 높은 순'처럼 알려주세요"
  }

  local function window_of(list, list_id, extras)
    local notes, status = notes_for(list)
    local reason = extras and extras.refine_error and REFINE_REASONS[extras.refine_error]
    if reason then table.insert(notes, 1, reason) end
    local snapshot = {
      comparison_id = list_id,
      identity_id = identity_id,
      offers = list,
      all_offers = all_offers,
      sort = sort,
      display_currency = uniform_currency(list),
      notes = notes
    }
    C.render_comparison(snapshot, page)
    persist_comparison(snapshot)
    -- The answer must restate the listing: the flow copies these into state, and returning without them
    -- emptied `offers` so the NEXT browsing call reported a lost comparison.
    local answer = C.comparison_answer(snapshot, extras)
    answer.offers = list
    answer.all_offers = all_offers
    answer.view_sort = sort
    answer.store_status = status.text
    return answer
  end

  local request = non_empty(args.refine_request)
  if request then
    local parsed = AX_OFFER_VIEW.parse_refine(request)
    if parsed.rescope then
      return { next = "research", comparison_id = comparison_id, rescope_request = request }
    end
    if parsed.unparsed then
      return window_of(offers, comparison_id, { refine_error = "unparsed" })
    end

    local filters = parsed.reset and {} or parsed.filters
    -- "미확인 포함" is the one filter expressed as a removal: it clears the default fold instead of
    -- adding a condition, so the listing grows back to everything that survived ranking.
    local unfold = filters.include_incomplete == true
    filters.include_incomplete = nil
    if not unfold and not parsed.reset and C.has_incomplete(all_offers) then
      filters.complete_cost_only = true
    end
    local next_sort = parsed.reset and "total_asc" or (parsed.sort or sort)

    -- A threshold in a currency this listing never quotes cannot be judged. Reporting "0건" would be a
    -- claim about prices that were never compared, so the previous listing stands and says why.
    local ungroundable = AX_OFFER_VIEW.filter_error(all_offers, filters)
    if ungroundable then
      return window_of(offers, comparison_id, { refine_error = ungroundable })
    end

    local visible = AX_OFFER_VIEW.apply(all_offers, { filters = filters, sort = next_sort })
    if #visible == 0 then
      -- An empty result would strand the user with nothing to pick, so the previous listing stands.
      return window_of(offers, comparison_id, { refine_error = "no_matches" })
    end
    local hidden = filters.complete_cost_only and (#all_offers - #visible) or 0
    local notes, status = C.comparison_notes(args.failures, all_offers, hidden)
    local snapshot = C.open_comparison(visible, identity_id, {
      all_offers = all_offers,
      filters = filters,
      sort = next_sort,
      notes = notes
    })
    return C.comparison_answer(snapshot, {
      offers = snapshot.offers,
      all_offers = all_offers,
      view_sort = next_sort,
      store_status = status.text
    })
  end

  page = AX_OFFER_VIEW.resolve_page(page, non_empty(args.page_command), args.page_number,
    math.max(1, math.ceil(#offers / C.VIEW_PAGE_SIZE)))
  return window_of(offers, comparison_id, { all_offers = all_offers, view_sort = sort })
end

function AX_resolve_store_offer(args)
  args = args or {}
  if args.choice_stage ~= "asked" then
    return { next = "invalid", error = "approval_turn_required" }
  end
  local offers = args.offers or {}
  local comparison_id = non_empty(args.comparison_id)
  local choice_comparison_id = non_empty(args.choice_comparison_id)
  if not comparison_id or not choice_comparison_id then
    return { next = "invalid", error = "comparison_version_required" }
  end
  if comparison_id ~= choice_comparison_id then
    return { next = "invalid", error = "stale_comparison" }
  end
  local choice = tonumber(args.choice_index)
  if not choice or choice ~= math.floor(choice) or choice < 1 or choice > #offers then
    return { next = "invalid", error = "invalid_offer_index" }
  end
  local offer = offers[choice] or {}
  if comparison_id and non_empty(offer.comparison_id) and offer.comparison_id ~= comparison_id then
    return { next = "invalid", error = "stale_comparison" }
  end
  local site = non_empty(offer.site)
  local product_id = non_empty(offer.product_id or offer.id)
  local identity_id = non_empty(args.identity_id or offer.identity_id)
  if not site or not product_id then
    return { next = "invalid", error = "invalid_offer" }
  end
  if not identity_id then
    return { next = "invalid", error = "missing_locked_identity" }
  end
  return {
    next = "add",
    selected_offer = offer,
    selected_rank = choice,
    site = site,
    product_id = product_id,
    product_name = non_empty(offer.name or offer.title),
    quantity = tonumber(offer.quantity) or tonumber(args.quantity) or 1,
    expected_unit_price = tonumber(offer.price),
    expected_currency = non_empty(offer.currency),
    expected_identity_model = non_empty(offer.manufacturer_model or offer.model_hint),
    approved_total_base = tonumber(offer.total_base),
    identity_id = identity_id,
    comparison_id = comparison_id or non_empty(offer.comparison_id),
    identity_approval = "locked_product_identity",
    comparison_approval = "current_comparison",
    cart_approval = "user_selected_compared_offer"
  }
end
