--- 비교 창(윈도) · 스토어 결과 문구 · 관련성 스크리닝.
local B = AX_BASE
local C = AX_COMMERCE
-- Names what this file READS at load time: `split_list` from 51, `worker_value`/`stable_hash` from 52, and the
-- view layer as its own namespace. The old guard named `50_commerce_core` and tested only `C`, so a tool that
-- omitted 51, 52 or 45 passed every check and died at call time on a nil upvalue.
if not (B and C and C.split_list and C.worker_value and AX_OFFER_VIEW) then
  error("_common/scripts/52_identity.lua and 45_offer_view.lua must be loaded before 54_comparison.lua")
end
local non_empty = B.non_empty
local lower, copy_table, array, split_list, worker_value, stable_hash = C.lower, C.copy_table, C.array, C.split_list, C.worker_value, C.stable_hash

local function offer_cost(offer)
  return tonumber(offer.total_base) or tonumber(offer.known_cost_base) or math.huge
end

local function offer_rating(offer)
  return tonumber(offer.rating) or ((tonumber(offer.seller_rating_percent) or 0) / 20)
end

local function compare_offers(left, right)
  local left_complete = left.cost_complete == true
  local right_complete = right.cost_complete == true
  if left_complete ~= right_complete then
    return left_complete
  end
  local left_cost, right_cost = offer_cost(left), offer_cost(right)
  if left_cost ~= right_cost then return left_cost < right_cost end
  local left_rating, right_rating = offer_rating(left), offer_rating(right)
  if left_rating ~= right_rating then return left_rating > right_rating end
  local left_reviews = tonumber(left.review_count) or 0
  local right_reviews = tonumber(right.review_count) or 0
  if left_reviews ~= right_reviews then return left_reviews > right_reviews end
  local left_site, right_site = tostring(left.site or ""), tostring(right.site or "")
  if left_site ~= right_site then return left_site < right_site end
  return tostring(left.product_id or "") < tostring(right.product_id or "")
end

local function money(value, currency)
  local numeric = tonumber(value)
  local code = non_empty(currency) or C.BASE_CURRENCY
  if not numeric then return "unknown" end
  -- Zero-decimal currencies (KRW, JPY) read wrong with cents, and a single-currency comparison keeps
  -- its own currency rather than a converted one, so the code travels with the amount.
  if code == "KRW" or code == "JPY" then
    return string.format("%s %d", code, math.floor(numeric + 0.5))
  end
  return string.format("%s %.2f", code, numeric)
end

-- A store that returned nothing is a fact the user has to see: "네이버는 보안 확인 필요" is actionable,
-- a silently missing store is indistinguishable from "this product is not sold there". Codes come from
-- the adapters; anything unmapped is still reported verbatim rather than swallowed.
local STORE_NAMES = {
  ["naver-shopping"] = "네이버쇼핑",
  ["11st"] = "11번가",
  coupang = "쿠팡", ssg = "SSG", gmarket = "지마켓", amazon = "아마존",
  walmart = "월마트", ebay = "이베이", aliexpress = "알리익스프레스", etsy = "엣시"
}

local STORE_ERRORS = {
  security_verification_required = "보안 확인 필요 (브라우저에서 확인 후 다시 시도)",
  captcha_required = "보안 확인(캡차) 필요 (브라우저에서 직접 통과해야 함)",
  login_required = "로그인 필요 (브라우저에서 로그인 후 다시 시도)",
  access_denied = "접근 차단됨",
  no_results = "검색 결과 없음",
  price_unavailable = "상품은 있었지만 가격을 읽지 못했습니다 (사이트 표시 방식 변경)",
  store_search_failed = "검색 실패",
  search_unsupported = "이 사이트는 검색을 지원하지 않음",
  pagination_unsupported = "추가 페이지를 지원하지 않음",
  missing_query = "검색어를 만들지 못함",
  -- OURS, and frequent. A live window printed "월마트(walmart): rpc_unavailable" at the user, which is a
  -- string they can do nothing with. The unknown-code fallback stays as it is — a NEW code must still name
  -- its store rather than vanish — but a code we ship ourselves gets a sentence.
  rpc_unavailable = "사이트와 통신하지 못했습니다 (잠시 후 다시 시도)",
  navigation_stuck = "사이트가 검색 결과로 이동하지 않았습니다 (잠시 후 다시 시도)",
  unsearched = "검색 작업이 실행되지 않았습니다 (다시 시도)"
}

function C.store_label(site)
  local slug = lower(site)
  local name = STORE_NAMES[slug]
  if not name then return non_empty(site) or "알 수 없는 사이트" end
  return name .. "(" .. slug .. ")"
end

-- A worker failure arrives in whatever shape the layer that produced it used: a code string, a nested
-- record, or only a status. A live run rendered "네이버쇼핑: table: 0x2af" because the value was pushed
-- straight into the sentence, so every shape is reduced to readable text here.
local function failure_text(failure)
  local direct = non_empty(type(failure.error) ~= "table" and failure.error or nil)
  if direct then return STORE_ERRORS[direct] or direct end
  if type(failure.error) == "table" then
    for _, key in ipairs({ "error", "code", "reason", "message" }) do
      local nested = non_empty(type(failure.error[key]) ~= "table" and failure.error[key] or nil)
      if nested then return STORE_ERRORS[nested] or nested end
    end
  end
  local status = non_empty(type(failure.status) ~= "table" and failure.status or nil)
  if status and status ~= "failed" then return STORE_ERRORS[status] or status end
  return STORE_ERRORS.store_search_failed
end

--- One line describing which stores answered and what the others need from the user.
function C.store_status(failures, offers)
  local ok_sites = {}
  local ok_count = 0
  for index = 1, #(offers or {}) do
    local site = lower(offers[index].site)
    if site ~= "" and not ok_sites[site] then
      ok_sites[site] = true
      ok_count = ok_count + 1
    end
  end

  local parts = array()
  local failed_count = 0
  local seen = {}
  for index = 1, #(failures or {}) do
    local failure = failures[index] or {}
    local site = lower(failure.site)
    local text = failure_text(failure)
    local key = site .. "|" .. text
    if not seen[key] then
      seen[key] = true
      failed_count = failed_count + 1
      parts[#parts + 1] = C.store_label(failure.site) .. ": " .. text
    end
  end

  if failed_count == 0 then
    return { text = "", ok_count = ok_count, failed_count = 0 }
  end
  local total = ok_count + failed_count
  local header = string.format("사이트 %d곳 중 %d곳에서 결과를 받았습니다", total, ok_count)
  return {
    text = header .. " · " .. table.concat(parts, " · "),
    ok_count = ok_count,
    failed_count = failed_count
  }
end


-- Ranking always compares the converted base amount, but a comparison whose offers all quote the same
-- currency reads better in that currency than in a converted one, so the display currency is chosen
-- once per comparison and the native total is shown when it is exact.
local function comparison_line(offer, display_currency)
  local base = non_empty(offer.base_currency) or C.BASE_CURRENCY
  local native = non_empty(display_currency) and display_currency == non_empty(offer.currency)
  local total_value = native and offer.total_for_quantity or offer.total_base
  local total_currency = native and offer.currency or base
  local total = offer.cost_complete and money(total_value, total_currency)
    or (money(offer.known_cost_base, base) .. " + unknown shipping/fees")
  local rating = tonumber(offer.rating) and string.format("%.1f/5", tonumber(offer.rating))
    or (tonumber(offer.seller_rating_percent) and string.format("seller %.1f%%", tonumber(offer.seller_rating_percent)) or "unrated")
  local condition = non_empty(offer.condition) or "condition not shown"
  -- price_text/shipping_text may be a whole row dump on text-parsed storefronts; the parsed numbers are
  -- what the user must compare, so the line shows those and keeps raw text out of the prompt.
  local item_price = money(offer.price, offer.currency or base)
  local shipping = tonumber(offer.shipping_cost)
  local shipping_label = shipping == nil and "shipping unknown"
    or (shipping == 0 and "free shipping" or ("shipping " .. money(shipping, offer.shipping_currency or offer.currency or base)))
  return tostring(offer.rank) .. ". [" .. tostring(offer.site) .. "] " .. tostring(offer.name)
    .. " — total " .. total .. "; item " .. item_price
    .. "; " .. shipping_label
    .. "; " .. rating .. "; " .. condition
end

-- The single currency every offer quotes, or nil when the comparison spans currencies.
local function uniform_currency(offers)
  local seen = nil
  for index = 1, #offers do
    local code = non_empty(offers[index].currency)
    if not code then return nil end
    if seen and seen ~= code then return nil end
    seen = code
  end
  return seen
end

-- What the user is browsing has to outlive the Lua context: every user turn (and every navigation)
-- rebuilds the runtime. The offer list therefore travels in FLOW state — the browsing node is
-- deterministic and reads it from there — and only the rendered window is kept in the chat session, for
-- the model-called presentation tool that cannot read flow state. The session store accepts strings
-- only, so nothing but text goes in. Either way the model's context stays the same size whether the
-- comparison holds three offers or thirty.
C.VIEW_PAGE_SIZE = 5
C.VIEW_BUDGET_CHARS = 1200
C.COMPARISON_SESSION_PREFIX = "commerce.comparison."

local function session_store()
  if type(session_state) == "table" and type(session_state.set) == "function" then return session_state end
  return nil
end

local function session_read(field)
  local store = session_store()
  if not store then return nil end
  local value = store.get(C.COMPARISON_SESSION_PREFIX .. field)
  return type(value) == "string" and value ~= "" and value or nil
end

local function persist_comparison(snapshot)
  C.current_comparison = snapshot
  local store = session_store()
  if not store then return snapshot end
  store.set(C.COMPARISON_SESSION_PREFIX .. "id", tostring(snapshot.comparison_id))
  store.set(C.COMPARISON_SESSION_PREFIX .. "window", tostring(snapshot.question))
  store.set(C.COMPARISON_SESSION_PREFIX .. "page", tostring(snapshot.view.page))
  store.set(C.COMPARISON_SESSION_PREFIX .. "pages", tostring(snapshot.view.pages))
  store.set(C.COMPARISON_SESSION_PREFIX .. "total", tostring(snapshot.view.total))
  return snapshot
end

--- The window the given comparison id is currently showing, from this turn's cache or the chat session.
function C.load_window(comparison_id)
  local id = non_empty(comparison_id)
  local current = C.current_comparison
  if type(current) == "table" and (id == nil or current.comparison_id == id) then
    return {
      comparison_id = current.comparison_id,
      question = current.question,
      page = current.view.page,
      pages = current.view.pages,
      total = current.view.total
    }
  end
  local stored_id = session_read("id")
  if not stored_id or (id ~= nil and stored_id ~= id) then return nil end
  return {
    comparison_id = stored_id,
    question = session_read("window") or "",
    page = tonumber(session_read("page")) or 1,
    pages = tonumber(session_read("pages")) or 1,
    total = tonumber(session_read("total")) or 0
  }
end

function C.render_comparison(snapshot, page)
  local view = AX_OFFER_VIEW.render(snapshot.offers, {
    page = page or snapshot.view and snapshot.view.page or 1,
    page_size = C.VIEW_PAGE_SIZE,
    budget_chars = C.VIEW_BUDGET_CHARS,
    display_currency = snapshot.display_currency,
    -- What the user must know beyond the rows themselves: which stores failed, and how many rows were
    -- folded away for having no known total.
    notes = snapshot.notes
  })
  snapshot.view = view
  snapshot.question = view.text
  return snapshot
end

--- Opens (or reopens) the current comparison over `offers` and renders its first window.
function C.open_comparison(offers, identity_id, options)
  options = options or {}
  local fingerprint = array()
  for index = 1, #offers do
    fingerprint[#fingerprint + 1] = tostring(offers[index].site or "") .. ":"
      .. tostring(offers[index].product_id or "") .. ":" .. tostring(offers[index].total_base or "")
  end
  local comparison_id = "cmp-" .. stable_hash(tostring(identity_id or "") .. "|"
    .. AX_OFFER_VIEW.signature(options.filters, options.sort) .. "|" .. table.concat(fingerprint, "|"))

  for index = 1, #offers do
    offers[index].rank = index
    offers[index].comparison_id = comparison_id
  end

  local snapshot = {
    comparison_id = comparison_id,
    identity_id = identity_id,
    offers = offers,
    all_offers = options.all_offers or offers,
    filters = options.filters or {},
    sort = options.sort or "total_asc",
    display_currency = uniform_currency(offers),
    notes = options.notes
  }
  C.render_comparison(snapshot, 1)
  if #offers == 0 then return snapshot end
  return persist_comparison(snapshot)
end

--- Whether a listing contains rows the default window folds away (no known total).
function C.has_incomplete(offers)
  for index = 1, #(offers or {}) do
    if offers[index].cost_complete ~= true then return true end
  end
  return false
end

--- Which stores lost rows to the fold, most rows first. The COUNT and the NAMES come out of one list, so
--- the sentence cannot say "3건" while naming two: a fold can remove a whole store from the window, and a
--- bare count leaves that store indistinguishable from one that answered nothing (§13's rule, applied to
--- the fold rather than to a failure). A row whose site is absent is still counted and never named — an
--- invented store name in a comparison is worse than an unattributed row.
local FOLD_NAMED_MAX = 3

function C.fold_attribution(folded)
  local counts = {}
  local order = array()
  local total = 0
  for index = 1, #(folded or {}) do
    total = total + 1
    local site = lower((folded[index] or {}).site)
    if site ~= "" then
      if counts[site] == nil then
        counts[site] = 0
        order[#order + 1] = site
      end
      counts[site] = counts[site] + 1
    end
  end

  local entries = array()
  for index = 1, #order do
    entries[#entries + 1] = { site = order[index], count = counts[order[index]] }
  end
  table.sort(entries, function(left, right)
    if left.count ~= right.count then return left.count > right.count end
    return left.site < right.site
  end)

  local parts = array()
  for index = 1, math.min(#entries, FOLD_NAMED_MAX) do
    local entry = entries[index]
    parts[#parts + 1] = (STORE_NAMES[entry.site] or entry.site) .. " " .. entry.count .. "건"
  end
  if #entries > FOLD_NAMED_MAX then
    parts[#parts + 1] = "외 " .. (#entries - FOLD_NAMED_MAX) .. "곳"
  end
  return { count = total, entries = entries, text = table.concat(parts, " · ") }
end

--- The lines a window carries beyond the offers: store outcomes and rows folded for an unknown total.
--- `answered` is the WHOLE listing, not the visible page: a folded row still proves its store answered.
--- `folded` is the LIST of rows the default window removed, never a count: the sentence names the stores
--- that lost them, and one list is the only way the number and the names cannot drift apart.
function C.comparison_notes(failures, answered, folded, screened_out)
  local notes = array()
  local status = C.store_status(failures, answered)
  if status.text ~= "" then notes[#notes + 1] = status.text end
  if (tonumber(screened_out) or 0) > 0 then
    notes[#notes + 1] = string.format("관련 없는 %d건은 제외했습니다", math.floor(tonumber(screened_out)))
  end
  local fold = C.fold_attribution(type(folded) == "table" and folded or {})
  if fold.count > 0 then
    notes[#notes + 1] = string.format(
      "배송비/총액 미확인 %d건은 접었습니다%s — '미확인 포함'이라고 하면 함께 보여드려요",
      fold.count,
      fold.text ~= "" and (" (" .. fold.text .. ")") or "")
  end
  return notes, status
end

--- Records a window move without reissuing the comparison.
function C.move_comparison(snapshot, page)
  C.render_comparison(snapshot, page)
  return persist_comparison(snapshot)
end

--- The answer shape every browsing turn returns: the rendered window plus where it sits in the list.
function C.comparison_answer(snapshot, extras)
  local answer = {
    next = "ask",
    comparison_id = snapshot.comparison_id,
    question = snapshot.question,
    view_page = snapshot.view.page,
    view_pages = snapshot.view.pages,
    view_total = snapshot.view.total
  }
  for key, value in pairs(extras or {}) do answer[key] = value end
  return answer
end

-- Reading the worker records once, in one place: every store loop below needs the same unwrap.
local function each_store_result(results, visit)
  for index = 1, #(results or {}) do
    local record = results[index] or {}
    local value = record.status == "completed" and worker_value(record) or nil
    visit(record, value, non_empty(value and value.site) or non_empty(record.key) or tostring(index), index)
  end
end

--- Complete the user-selected frontier before screening. `flow.map` can return without one child result;
--- omitting that store makes a session failure look like the user never asked for it. `unsearched` says
--- exactly what happened and lets every downstream renderer preserve the missing store as a failure.
function AX_complete_store_results(args)
  args = args or {}
  local requested = args.stores or {}
  local completed, seen = array(), {}
  each_store_result(args.store_results or args.results, function(record, _, site)
    local slug = lower(site)
    if slug ~= "" then seen[slug] = true end
    completed[#completed + 1] = record
  end)
  for index = 1, #requested do
    local item = requested[index]
    local site = non_empty(type(item) == "table" and item.site or item)
    local slug = lower(site)
    if slug ~= "" and not seen[slug] then
      seen[slug] = true
      completed[#completed + 1] = {
        key = slug,
        status = "failed",
        error = "unsearched",
        value = { site = slug, error = "unsearched" }
      }
    end
  end
  return {
    next = #requested > 0 and "done" or "error",
    store_results = completed
  }
end

--- The numbered list of live listings a model screens for relevance, and the ids that back the numbers.
--- Stores take turns so a store listed later is not starved by one that returned more rows.
local function summarize_store_outcomes(results)
  local per_store = array()
  local outcomes = array()
  each_store_result(results, function(record, value, site)
    local candidates = value and value.candidates or {}
    if value then per_store[#per_store + 1] = { site = site, candidates = candidates } end

    local failure = non_empty(value and value.error) or non_empty(record.error)
    local claimed = non_empty(value and value.status)
    local status = #candidates > 0 and "candidates"
      or failure
      or (claimed ~= "candidates" and claimed)
      or (record.status ~= "completed" and non_empty(record.status))
      or "no_results"
    local outcome = { site = site, status = status, candidate_count = #candidates }
    if failure then outcome.error = failure end
    local sample = candidates[1]
    if sample then
      outcome.sample = {
        site = site,
        product_id = AX_OFFER_VIEW.clip(sample.product_id or sample.id, 96),
        name = AX_OFFER_VIEW.clip(sample.name or sample.title, 160),
        price = tonumber(sample.price),
        currency = AX_OFFER_VIEW.clip(sample.currency, 12),
        url = AX_OFFER_VIEW.clip(sample.url, 512)
      }
    end
    outcomes[#outcomes + 1] = outcome
  end)
  return outcomes, per_store
end

function AX_build_offer_screening(args)
  args = args or {}
  local store_outcomes, per_store = summarize_store_outcomes(args.store_results or args.results)
  local lines = array()
  local ids = array()
  local rank = 1
  while #ids < C.SCREEN_MAX_ROWS do
    local placed = false
    for store_index = 1, #per_store do
      local store = per_store[store_index]
      local candidate = store.candidates[rank]
      if candidate and #ids < C.SCREEN_MAX_ROWS then
        local product_id = non_empty(candidate.product_id or candidate.id)
        local name = non_empty(candidate.name or candidate.title)
        if product_id and name then
          placed = true
          ids[#ids + 1] = store.site .. ":" .. product_id
          local title = AX_OFFER_VIEW.clip(name, C.SCREEN_TITLE_CHARS)
          local price = money(candidate.price, candidate.currency)
          local line = string.format("%d. [%s] %s", #ids, store.site, title)
          if price ~= "" then line = line .. " · " .. price end
          if candidate.match_level == "partial" then line = line .. " · (유사)" end
          lines[#lines + 1] = line
        end
      end
    end
    if not placed then break end
    rank = rank + 1
  end

  return {
    next = #ids > 0 and "judge" or "empty",
    screening_text = table.concat(lines, "\n"),
    screening_ids = table.concat(ids, "|"),
    screening_count = #ids,
    -- One bounded row per store. Chat truncates large candidate payloads at 4120 characters; this is
    -- the durable attribution/contract evidence the sweep can still parse.
    store_outcomes = store_outcomes
  }
end

--- Compact post-screening attribution in its own tool result. `screening_text` can push the builder's
--- otherwise-small outcome rows past the chat trace limit; this answer carries no prompt text and therefore
--- remains parseable even when every store returned the full screening budget.
function AX_summarize_store_outcomes(args)
  args = args or {}
  local store_outcomes = summarize_store_outcomes(args.store_results or args.results)
  return { next = "done", store_outcomes = store_outcomes }
end

--- Applies a screening verdict: keeps the numbered rows, caps each store at the comparison limit, and
--- reports what was removed. An ABSENT verdict (a stalled or failed screening node) keeps everything —
--- losing precision costs a wrong row in the window, losing the offers costs the whole turn.
function AX_apply_offer_screening(args)
  args = args or {}
  local ids = split_list(args.screening_ids)
  local verdict = args.keep
  local skipped = verdict == nil

  local keep = {}
  local kept_total = 0
  if not skipped then
    for number in tostring(verdict):gmatch("%d+") do
      local position = tonumber(number)
      local id = position and ids[position]
      if id and not keep[id] then
        keep[id] = true
        kept_total = kept_total + 1
      end
    end
  end

  local results = array()
  local screened_out = 0
  local capped_out = 0
  local remaining = 0
  each_store_result(args.store_results or args.results, function(record, value, site)
    if not value then
      results[#results + 1] = record
      return
    end
    local candidates = value.candidates or {}
    local kept = array()
    for index = 1, #candidates do
      local candidate = candidates[index]
      local product_id = non_empty(candidate.product_id or candidate.id)
      local wanted = skipped or (product_id and keep[site .. ":" .. product_id]) or false
      if not wanted then
        screened_out = screened_out + 1
      elseif #kept >= C.MAX_OFFERS_PER_SITE then
        capped_out = capped_out + 1
      else
        kept[#kept + 1] = candidate
      end
    end
    remaining = remaining + #kept
    local store_result = copy_table(value)
    -- An empty list crosses as ABSENT, never as the JSON object `{}` a schema validating an array
    -- refuses — §13, and this repo has paid for it at four separate boundaries.
    store_result.candidates = #kept > 0 and kept or nil
    store_result.total_count = #kept
    if #kept == 0 then
      -- And the status has to say what happened. It is copied from the reader, so a store whose every row
      -- the model rejected kept `status = "candidates"` beside nothing — an outcome no caller can name,
      -- which the sweep then reported as `unknown`, the label for a reader that could not say.
      store_result.error = non_empty(store_result.error) or "no_relevant_offers"
      store_result.status = store_result.error
    end
    results[#results + 1] = { key = non_empty(record.key) or site, status = "completed", value = { store_result = store_result } }
  end)

  return {
    next = remaining > 0 and "done" or "empty",
    store_results = results,
    screened_out = screened_out,
    capped_out = capped_out,
    screened_kept = remaining,
    screening_skipped = skipped or nil
  }
end

-- 다른 commerce 모듈과 공유한다. 파일 순서상 이 아래 모듈들이 헤더에서 집어 간다.
C.compare_offers, C.uniform_currency, C.persist_comparison = compare_offers, uniform_currency, persist_comparison
