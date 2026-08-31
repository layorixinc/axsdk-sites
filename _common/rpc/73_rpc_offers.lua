--- The comparison the user browses, carried in FLOW STATE.
---
--- These three commands were the last `kind: remote` tools, and they stayed durable for one reason: the
--- listing built in one turn has to be paged and filtered in the next, and the runtime's `state: session`
--- is keyed by (session, TOOL) — `rank` has no way to hand anything to `present`.
---
--- Flow state does. `inputSelector` is an allowlist (FLOWS.md §4), so a deterministic `action_contract`
--- reads the snapshot at zero prompt cost while no model node ever selects it. What travels is a SCALAR:
--- an empty Lua table encodes as `{}` and a tool schema expecting an array rejects it, so the snapshot is
--- one JSON string that the consumer decodes.
---
--- The ranking, folding, windowing and refinement are NOT reimplemented here. `54_comparison.lua` and
--- `55_offers.lua` are already loaded as runtime modules and stay the single implementation; this file
--- only moves their snapshot in and out of the flow. That is the whole of what was missing.

AX_RPC_OFFERS = AX_RPC_OFFERS or {}
local O = AX_RPC_OFFERS

local C = AX_COMMERCE
if not C then
  error("_common/scripts/50_commerce_core.lua must be loaded before 73_rpc_offers.lua")
end

-- The same deterministic reply reader the Thumbtack shortlist uses. Sharing it is the point: both loops
-- have to answer "취소" the same way, and one of them is a step away from a cart.
local N = AX_CANDIDATE_BROWSER
if not N then
  error("_common/scripts/46_candidate_browser.lua must be loaded before 73_rpc_offers.lua")
end

local function codec()
  if type(json) ~= "table" then return nil end
  if type(json.encode) ~= "function" or type(json.decode) ~= "function" then return nil end
  return json
end

--- The snapshot as one string, or nil when there is nothing to carry.
---
--- Only the fields a later turn needs: the offers themselves, the identity they were verified against,
--- and which window was on screen. The rendered text is NOT carried — it is derived, and carrying it
--- would let the text and the offers disagree.
local function encode(snapshot)
  local codecs = codec()
  if not codecs or type(snapshot) ~= "table" then return nil end
  local ok, text = pcall(codecs.encode, {
    comparison_id = snapshot.comparison_id,
    identity_id = snapshot.identity_id,
    offers = snapshot.offers,
    all_offers = snapshot.all_offers or snapshot.offers,
    refine_request = snapshot.refine_request,
    -- Store outcomes are part of the answer, and the window is where they ride. `render_comparison` reads
    -- them from `notes`; left out, the line naming the store that hit a bot wall survived only the turn
    -- that BUILT the listing — page once and the comparison starts looking like every store answered.
    notes = snapshot.notes,
    -- The window the user reads is ALWAYS rendered from a restore, so anything the build computed and the
    -- snapshot drops is simply gone. `uniform_currency` picks this when the listing is built; without it
    -- a Korean shopper comparing Korean stores read "총 USD 10.79" beside "상품가 KRW 12,900".
    display_currency = snapshot.display_currency,
    -- The CONDITIONS that produced this listing, not just its rows. Without them each refinement started
    -- from nothing: "무료배송만" then "10달러 이하" re-listed the paid-shipping rows the user had just
    -- excluded — in the window whose numbers they were about to pick from. `sort` rides along for the same
    -- reason the tool publishes `view_sort`.
    filters = snapshot.filters,
    sort = snapshot.sort,
  })
  if not ok then return nil end
  return text
end

--- Restores a snapshot into the module the commands already read from.
---
--- `C.current_comparison` is the same-turn cache those commands consult first, so filling it is what makes
--- them work on a turn that did not build the listing. Nothing else about them changes.
local function restore(text)
  local codecs = codec()
  if not codecs or type(text) ~= "string" or text == "" then return nil end
  local ok, value = pcall(codecs.decode, text)
  if not ok or type(value) ~= "table" or type(value.offers) ~= "table" then return nil end
  C.current_comparison = value
  return value
end

local V = AX_OFFER_VIEW
local PAGE_SIZE = 5

local function encode_exploration(snapshot)
  local codecs = codec()
  if not codecs or type(snapshot) ~= "table" then return nil end
  local ok, text = pcall(codecs.encode, {
    exploration_id = snapshot.exploration_id,
    base_exploration_id = snapshot.base_exploration_id or snapshot.exploration_id,
    query = snapshot.query,
    product_category = snapshot.product_category,
    identity_kind = snapshot.identity_kind,
    groups = snapshot.groups,
    all_groups = snapshot.all_groups or snapshot.groups,
    facet_catalog = snapshot.facet_catalog,
    filters = snapshot.filters,
    sort = snapshot.sort,
    page = snapshot.page,
    failures = snapshot.failures,
  })
  return ok and text or nil
end

local function restore_exploration_state(text)
  local codecs = codec()
  if not codecs or type(text) ~= "string" or text == "" then return nil end
  local ok, value = pcall(codecs.decode, text)
  if not ok or type(value) ~= "table" or type(value.groups) ~= "table" then return nil end
  return value
end

local function exploration_catalog_text(snapshot)
  local rows = {}
  for index = 1, #(snapshot.facet_catalog or {}) do
    local entry = snapshot.facet_catalog[index] or {}
    rows[#rows + 1] = tostring(entry.facet or "") .. "=" .. tostring(entry.value or "")
      .. " (" .. tostring(entry.evidence or "") .. ")"
  end
  return table.concat(rows, "\n")
end

local function render_exploration(snapshot, requested_page, reason)
  local groups = snapshot.groups or {}
  local pages = math.max(1, math.ceil(#groups / PAGE_SIZE))
  local page = math.max(1, math.min(math.floor(tonumber(requested_page) or 1), pages))
  local first = (page - 1) * PAGE_SIZE + 1
  local last = math.min(#groups, first + PAGE_SIZE - 1)
  local lines = {
    string.format("상품 탐색 결과 %d-%d/%d — 번호를 선택하면 비교할 상품을 확정합니다.", first, last, #groups),
    "이 단계에서는 장바구니와 주문이 변경되지 않습니다.",
  }
  if reason then lines[#lines + 1] = reason end
  for index = first, last do
    local group = groups[index] or {}
    local sites = tonumber(group.source_site_count) or #(group.source_sites or {})
    local observed = V and V.format_amount(group.observed_total, group.observed_currency) or "미확인"
    local kind = group.identity_kind == "unique_listing" and "[스토어 단일 상품] " or ""
    lines[#lines + 1] = string.format("%d. %s%s · 관측 판매처 %d곳 · 관측 총액 %s",
      index, kind, tostring(group.display_name or "상품명 미확인"), sites, observed)
  end
  lines[#lines + 1] = "필터·정렬·다음/이전·번호 선택이 가능합니다. 취소하려면 '취소'라고 입력하세요."
  snapshot.page = page
  return {
    next = "ask",
    ok = true,
    exploration_id = snapshot.exploration_id,
    exploration_state = encode_exploration(snapshot),
    question = table.concat(lines, "\n"),
    exploration_page = page,
    exploration_pages = pages,
    exploration_total = #groups,
    facet_catalog_text = exploration_catalog_text(snapshot),
    exploration_stage = "asked",
  }
end

local function identity_change_request(text)
  local raw = tostring(text or "")
  local lowered = raw:lower()
  if lowered == "" then return nil end
  local direct = {
    "다른 모델", "모델 바", "모델을 바", "검색 결과로", "아까 목록", "아까 결과",
    "다른 색상", "다른 용량", "다른 사이즈", "other model", "change model", "switch model",
    "back to results",
  }
  for index = 1, #direct do
    if lowered:find(direct[index], 1, true) then return raw end
  end
  local offer_only = {
    "원 이하", "원 이상", "달러", "무료배송", "평점", "별점",
    "amazon", "아마존", "walmart", "월마트", "쿠팡", "11번가", "gmarket", "ssg",
  }
  for index = 1, #offer_only do
    if lowered:find(offer_only[index], 1, true) then return nil end
  end
  if lowered:find("말고", 1, true) and C.infer_model and C.infer_model(raw) then return raw end
  return nil
end

--- Renders the listing the module currently holds and packs it for the flow.
local function present_current(snapshot, page)
  local rendered = C.render_comparison(snapshot, page)
  local view = (type(rendered) == "table" and rendered.view) or {}
  return {
    next = "ask",
    ok = true,
    comparison_id = rendered.comparison_id,
    comparison_state = encode(rendered),
    question = rendered.question,
    view_page = view.page,
    view_pages = view.pages,
    view_total = view.total,
  }
end

--- Builds the listing. The only entry that does not need a snapshot, because it makes one.
function O.rank(args)
  args = type(args) == "table" and args or {}
  if not codec() then
    -- Without an encoder the snapshot cannot travel, and a listing that silently fails to persist looks
    -- to the next turn like a search that found nothing.
    return { next = "error", ok = false, error = "json_unavailable" }
  end
  local result = AX_rank_store_offers(args)
  if type(result) ~= "table" or result.error then
    return { next = "error", ok = false, error = (type(result) == "table" and result.error) or "rank_failed" }
  end
  -- Ranking BUILDS the listing; rendering is what persists it. Measured: `AX_rank_store_offers`
  -- answers `comparison_text` and leaves `C.current_comparison` unset, so a refine on the next turn
  -- answered `stale_comparison` against a listing that had just been built.
  local built = C.load_window(result.comparison_id)
  local snapshot = C.current_comparison
  if type(snapshot) ~= "table" then
    return { next = "error", ok = false, error = "comparison_unreadable" }
  end
  return {
    -- The command picks its own branch (`done`/`partial`/`empty`) and the node routes exactly those.
    -- A constant here answered `ask`, which no branch names, and `invalidNext` threw away a comparison
    -- that had already been searched, screened, verified and issued an id.
    next = result.next,
    ok = true,
    comparison_id = result.comparison_id,
    comparison_state = encode(snapshot),
    -- `comparison_text` is what ranking calls the window; `present` calls the same thing `question`.
    question = result.comparison_text or (built and built.question),
    view_page = result.view_page,
    view_pages = result.view_pages,
    view_total = result.view_total,
    store_status = result.store_status,
    -- Declared by the tool and produced by the command, so the wrapper has to carry them or they are null
    -- on every turn. `failures` is the channel `notes_for` reads to name the store that hit a wall, and
    -- three nodes select it (`normalize_rank`, `browse_offers`, `no_results`); without it the comparison
    -- reads as if every store answered. `incomplete_count` is the folded-row count the flow declares.
    failures = type(result.failures) == "table" and #result.failures > 0 and result.failures or nil,
    incomplete_count = result.incomplete_count,
  }
end

--- Renders the listing, pauses on it, and reads the answer — because the node that pauses is the only
--- node that sees the user's new message.
---
--- A prior `action_unit` between this presenter and the resolver re-sent the SAME requestText on every loop:
--- the previous turn's "3번"; `currentUserText: active_node_only` hands an `action_unit` the text of the
--- turn IT was active for, and the flow pauses here. The Thumbtack shortlist hit the same failure and
--- answered it by keeping no model node in the loop at all. A cancel that buys something is the worst
--- shape the bug can take, so the interpretation lives with the pause.
function O.present(args)
  args = type(args) == "table" and args or {}
  local snapshot = restore(args.comparison_state)
  if not snapshot then
    -- Flow state is text and text can arrive truncated or absent. Rendering an empty window here would
    -- tell the user their comparison found nothing.
    return { next = "error", ok = false, error = "comparison_unreadable" }
  end
  local wanted = args.comparison_id
  if type(wanted) == "string" and wanted ~= "" and wanted ~= snapshot.comparison_id then
    -- The number the user typed belongs to a listing. Answering from a different one hands them a product
    -- they never saw.
    return { next = "error", ok = false, error = "stale_comparison" }
  end

  if args.choice_stage == "asked" then
    local current_text = N.current_user_text(args)
    local change = identity_change_request(current_text)
    if change then
      return {
        next = "change_identity",
        ok = true,
        comparison_id = snapshot.comparison_id,
        identity_change_request = change,
      }
    end
    local reply = N.classify_reply(N.current_user_text(args))
    if reply.kind == "cancel" then
      return { next = "cancel", ok = true, comparison_id = snapshot.comparison_id }
    end
    if reply.kind == "restart" then
      return { next = "restart", ok = true, comparison_id = snapshot.comparison_id }
    end
    if reply.kind == "page" then
      return {
        next = "page", ok = true, comparison_id = snapshot.comparison_id,
        page_command = reply.page_command, page_number = reply.page_number,
      }
    end
    if reply.kind == "refine" then
      return {
        next = "refine", ok = true, comparison_id = snapshot.comparison_id,
        refine_request = reply.refine_request,
      }
    end
    if reply.kind == "choice" then
      local numbers = N.parse_choice_numbers(reply.choice_numbers)
      return {
        next = "select", ok = true,
        comparison_id = snapshot.comparison_id,
        -- The id travels WITH the number: resolving it against another listing hands the user a product
        -- they never saw, one step before the cart.
        choice_comparison_id = snapshot.comparison_id,
        choice_index = numbers[1],
      }
    end
    -- No reply at all is not an instruction. Guessing would page or select on a turn the user did not
    -- answer, so the same window stands and waits.
  end

  local shown = present_current(snapshot, tonumber(args.view_page) or 1)
  shown.choice_stage = "asked"
  return shown
end

--- Filters or sorts, which changes WHICH offers are listed — so the listing is reissued.
function O.refine(args)
  args = type(args) == "table" and args or {}
  local snapshot = restore(args.comparison_state)
  if not snapshot then
    return { next = "error", ok = false, error = "comparison_unreadable" }
  end
  local wanted = args.comparison_id
  if type(wanted) == "string" and wanted ~= "" and wanted ~= snapshot.comparison_id then
    return { next = "error", ok = false, error = "stale_comparison" }
  end
  -- The command reads the listing from its ARGUMENTS, not from the module cache: `args.offers` is what
  -- it filters and `offers[1].comparison_id` is what it checks staleness against. Restoring the module
  -- global is therefore not enough — the snapshot has to be handed in, which is precisely the channel
  -- that (session, TOOL) scoping took away.
  local call = {}
  for key, value in pairs(args) do call[key] = value end
  call.offers = snapshot.offers
  call.all_offers = snapshot.all_offers or snapshot.offers
  call.identity_id = snapshot.identity_id or call.identity_id
  -- The conditions already in force, so a new one is added to them rather than replacing them. The flow
  -- also carries `view_sort` back, but the snapshot is the fallback when it does not.
  call.active_filters = snapshot.filters
  call.view_sort = call.view_sort or snapshot.sort
  local result = AX_refine_store_offers(call)
  if type(result) ~= "table" or result.error then
    return {
      next = "error", ok = false,
      error = (type(result) == "table" and result.error) or "refine_failed",
      -- The previous listing STANDS on a refusal: reporting nothing would look like zero matches, which
      -- is a claim about offers that were never compared.
      comparison_state = encode(snapshot),
      comparison_id = snapshot.comparison_id,
      question = type(result) == "table" and result.question or nil,
    }
  end
  return {
    next = "ask",
    ok = true,
    comparison_id = result.comparison_id,
    comparison_state = encode(C.current_comparison),
    question = result.question,
    view_page = result.view_page,
    view_pages = result.view_pages,
    view_total = result.view_total,
    -- Declared by the tool and produced by the command, and dropping them cost the user's own choices.
    -- `view_sort` is read back by the NEXT refine (`AX_refine_store_offers` falls to `total_asc` without
    -- it), so a chosen "평점 높은 순" silently reverted the moment a price filter followed it.
    -- `store_status` is the line naming the store that failed; `refine_error` is why a condition did not
    -- apply; `rescope_request` is the re-search the user asked for, which the flow maps to `requestText`.
    view_sort = result.view_sort,
    store_status = result.store_status,
    refine_error = result.refine_error,
    rescope_request = result.rescope_request,
  }
end

--- Resolves the number the user typed, against the listing they were reading.
---
--- The pick is the last step before a cart mutation, and it was reading its offers from a separate state
--- field: live, `offers: Invalid input: expected array, received null`, because an empty list travels as
--- absent now while the listing itself lives in the snapshot. Two channels for one comparison can
--- disagree about WHICH offers were numbered, and a wrong number here adds the wrong product.
function O.resolve(args)
  args = type(args) == "table" and args or {}
  local snapshot = restore(args.comparison_state)
  if not snapshot then
    return { next = "error", ok = false, error = "comparison_unreadable" }
  end
  -- The id is what makes a number mean something. A number from another listing must fail here rather
  -- than select whatever happens to sit at that position now.
  local chosen = args.choice_comparison_id
  if type(chosen) == "string" and chosen ~= "" and chosen ~= snapshot.comparison_id then
    return { next = "error", ok = false, error = "stale_comparison" }
  end

  local call = {}
  for key, value in pairs(args) do call[key] = value end
  call.offers = snapshot.offers
  call.all_offers = snapshot.all_offers or snapshot.offers
  call.identity_id = snapshot.identity_id or call.identity_id
  call.comparison_id = snapshot.comparison_id
  call.choice_comparison_id = snapshot.comparison_id

  local result = AX_resolve_store_offer(call)
  if type(result) ~= "table" then
    return { next = "error", ok = false, error = "resolve_failed" }
  end
  return result
end

local function copy_map(value)
  local out = {}
  for key, item in pairs(type(value) == "table" and value or {}) do
    if type(item) == "table" then
      local nested = {}
      for nested_key, nested_value in pairs(item) do nested[nested_key] = nested_value end
      out[key] = nested
    else
      out[key] = item
    end
  end
  return out
end

local function issue_exploration(snapshot, groups, filters, sort)
  snapshot.groups = groups
  snapshot.filters = filters or {}
  snapshot.sort = sort or "total_asc"
  local codecs = codec()
  if not codecs then return nil end
  local ok, signature = pcall(codecs.encode, {
    base = snapshot.base_exploration_id or snapshot.exploration_id,
    filters = snapshot.filters,
    sort = snapshot.sort,
    groups = groups,
  })
  if not ok or type(signature) ~= "string" or not C.stable_hash then return nil end
  snapshot.exploration_id = "exp-" .. C.stable_hash(signature)
  for index = 1, #groups do groups[index].exploration_id = snapshot.exploration_id end
  snapshot.page = 1
  return snapshot
end

local function group_total(group)
  return tonumber(group.observed_total_base) or tonumber(group.observed_total) or math.huge
end

local function sort_exploration(groups, sort)
  table.sort(groups, function(left, right)
    if sort == "total_desc" then
      if group_total(left) ~= group_total(right) then return group_total(left) > group_total(right) end
    elseif sort == "name_asc" then
      local left_name = tostring(left.display_name or ""):lower()
      local right_name = tostring(right.display_name or ""):lower()
      if left_name ~= right_name then return left_name < right_name end
    else
      if group_total(left) ~= group_total(right) then return group_total(left) < group_total(right) end
    end
    return tostring(left.group_id or "") < tostring(right.group_id or "")
  end)
end

local function catalog_match(snapshot, term)
  local needle = tostring(term or ""):lower():gsub("^%s+", ""):gsub("%s+$", "")
  if needle == "" then return nil end
  local matches = {}
  for index = 1, #(snapshot.facet_catalog or {}) do
    local entry = snapshot.facet_catalog[index] or {}
    local value = tostring(entry.value or ""):lower()
    local evidence = tostring(entry.evidence or ""):lower()
    if value == needle or evidence == needle or value:find(needle, 1, true)
        or evidence:find(needle, 1, true) or needle:find(value, 1, true) then
      matches[tostring(entry.facet) .. "|" .. tostring(entry.value)] = entry
    end
  end
  local found = nil
  for _, entry in pairs(matches) do
    if found then return nil end
    found = entry
  end
  return found
end

local function group_has_facet(group, facet, value)
  local record = type(group.facets) == "table" and group.facets[facet] or nil
  return type(record) == "table"
    and tostring(record.value or ""):lower() == tostring(value or ""):lower()
end

local function group_matches_exploration(group, filters)
  filters = filters or {}
  if type(filters.sites) == "table" then
    local allowed = false
    for site_index = 1, #(group.source_sites or {}) do
      for wanted_index = 1, #filters.sites do
        if tostring(group.source_sites[site_index]):lower() == tostring(filters.sites[wanted_index]):lower() then
          allowed = true
          break
        end
      end
      if allowed then break end
    end
    if not allowed then return false end
  end
  local price = tonumber(group.observed_total)
  if filters.price_currency and tostring(group.observed_currency or ""):upper() ~= filters.price_currency then
    price = filters.price_currency == "USD" and tonumber(group.observed_total_base) or nil
  end
  if filters.price_max and (not price or price > filters.price_max) then return false end
  if filters.price_min and (not price or price < filters.price_min) then return false end
  for facet, value in pairs(type(filters.facet_include) == "table" and filters.facet_include or {}) do
    if not group_has_facet(group, facet, value) then return false end
  end
  for facet, value in pairs(type(filters.facet_exclude) == "table" and filters.facet_exclude or {}) do
    if group_has_facet(group, facet, value) then return false end
  end
  return true
end

local function parse_facet_request(snapshot, request)
  local raw = tostring(request or ""):gsub("^%s+", ""):gsub("%s+$", "")
  local exclude = raw:match("^(.-)%s*제외") or raw:match("^(.-)%s*빼고") or raw:match("^(.-)%s*없이")
  local include = raw:match("^(.-)%s*만%s*보") or raw:match("^(.-)%s*만$")
  local term = exclude or include
  if not term then return nil end
  term = term:gsub("^그럼%s*", ""):gsub("^이제%s*", ""):gsub("%s+$", "")
  local entry = catalog_match(snapshot, term)
  if not entry then return { unparsed = true, term = term } end
  return {
    operation = exclude and "exclude" or "include",
    facet = entry.facet,
    value = entry.value,
  }
end

local function model_choice(snapshot, request)
  local lowered = tostring(request or ""):lower()
  local choice = nil
  for index = 1, #(snapshot.groups or {}) do
    local model = tostring(snapshot.groups[index].identity_model or ""):lower()
    if model ~= "" and lowered:find(model, 1, true) then
      if choice then return nil end
      choice = index
    end
  end
  return choice
end

--- Builds the pre-lock listing and carries it as one scalar, separate from a cart-capable comparison.
function O.build_exploration(args)
  args = type(args) == "table" and args or {}
  if not codec() then return { next = "error", error = "json_unavailable" } end
  local result = AX_build_product_exploration({
    results = args.discovery_results or args.store_results,
    query = args.exploration_query or args.discovery_query or args.query,
    product_category = args.product_category,
    identity_kind = args.identity_kind,
    hard_constraints = args.hard_constraints,
    max_groups = args.max_groups,
  })
  if type(result) ~= "table" or result.next == "empty" then
    return { next = "empty", error = type(result) == "table" and result.error or "exploration_build_failed" }
  end
  local snapshot = {
    exploration_id = result.exploration_id,
    base_exploration_id = result.exploration_id,
    query = result.exploration_query,
    product_category = args.product_category,
    identity_kind = args.identity_kind,
    groups = result.groups,
    all_groups = result.groups,
    facet_catalog = result.facet_catalog,
    filters = {},
    sort = "total_asc",
    page = 1,
    failures = result.failures,
  }
  sort_exploration(snapshot.groups, snapshot.sort)
  local shown = render_exploration(snapshot, 1)
  shown.next = "present"
  return shown
end

--- Renders and classifies the exact exploration window that paused.
function O.present_exploration(args)
  args = type(args) == "table" and args or {}
  local snapshot = restore_exploration_state(args.exploration_state)
  if not snapshot then return { next = "error", error = "exploration_unreadable" } end
  if type(args.exploration_id) == "string" and args.exploration_id ~= ""
      and args.exploration_id ~= snapshot.exploration_id then
    return { next = "error", error = "stale_exploration" }
  end
  if args.exploration_stage == "asked" then
    local text = N.current_user_text(args)
    local direct = model_choice(snapshot, text)
    if direct then
      return {
        next = "select", choice_index = direct,
        choice_exploration_id = snapshot.exploration_id,
        exploration_id = snapshot.exploration_id,
      }
    end
    local reply = N.classify_reply(text)
    if reply.kind == "cancel" then return { next = "cancel" } end
    if reply.kind == "restart" then return { next = "restart" } end
    if reply.kind == "choice" then
      local numbers = N.parse_choice_numbers(reply.choice_numbers)
      return {
        next = "select", choice_index = numbers[1],
        choice_exploration_id = snapshot.exploration_id,
        exploration_id = snapshot.exploration_id,
      }
    end
    if reply.kind == "page" then
      return {
        next = "page", page_command = reply.page_command, page_number = reply.page_number,
        exploration_id = snapshot.exploration_id,
      }
    end
    if reply.kind == "refine" then
      return {
        next = "refine", refine_request = reply.refine_request,
        exploration_id = snapshot.exploration_id,
      }
    end
  end
  local shown = render_exploration(snapshot, args.exploration_page or snapshot.page)
  return shown
end

--- Applies deterministic page/filter/sort changes. Unknown facet language is handed to one closed model
--- contract that may select only a value from `facet_catalog_text`.
function O.refine_exploration(args)
  args = type(args) == "table" and args or {}
  local snapshot = restore_exploration_state(args.exploration_state)
  if not snapshot then return { next = "error", error = "exploration_unreadable" } end
  if type(args.exploration_id) == "string" and args.exploration_id ~= ""
      and args.exploration_id ~= snapshot.exploration_id then
    return { next = "error", error = "stale_exploration" }
  end

  if args.page_command or args.page_number then
    local pages = math.max(1, math.ceil(#(snapshot.groups or {}) / PAGE_SIZE))
    local page = V.resolve_page(snapshot.page or 1, args.page_command, args.page_number, pages)
    return render_exploration(snapshot, page)
  end

  local request = tostring(args.refine_request or "")
  local lowered = request:lower()
  local filters = copy_map(snapshot.filters)
  local sort = snapshot.sort or "total_asc"
  local reset = lowered:find("필터 해제", 1, true) or lowered:find("처음 검색", 1, true)
    or lowered:find("clear filter", 1, true) or lowered:find("reset filter", 1, true)
  if reset then
    filters = {}
    sort = "total_asc"
  else
    local filter_facet = args.filter_facet or args.exploration_filter_facet
    local filter_value = args.filter_value or args.exploration_filter_value
    local filter_operation = args.filter_operation or args.exploration_filter_operation
    local facet_request
    if filter_facet and filter_value and (filter_operation == "include" or filter_operation == "exclude") then
      local grounded = catalog_match(snapshot, filter_value)
      if grounded and tostring(grounded.facet) == tostring(filter_facet) then
        facet_request = {
          operation = filter_operation,
          facet = grounded.facet,
          value = grounded.value,
        }
      else
        return render_exploration(snapshot, snapshot.page, "현재 결과에서 확인할 수 없는 조건이라 적용하지 않았습니다.")
      end
    else
      facet_request = parse_facet_request(snapshot, request)
    end
    if facet_request and facet_request.unparsed then
      return {
        next = "interpret",
        exploration_id = snapshot.exploration_id,
        exploration_state = encode_exploration(snapshot),
        exploration_filter_request = request,
        facet_catalog_text = exploration_catalog_text(snapshot),
      }
    elseif facet_request then
      local key = facet_request.operation == "exclude" and "facet_exclude" or "facet_include"
      filters[key] = copy_map(filters[key])
      filters[key][facet_request.facet] = facet_request.value
    end

    local parsed = V.parse_refine(request)
    if parsed.reset then filters = {}; sort = "total_asc" end
    if type(parsed.filters) == "table" then
      for _, key in ipairs({ "sites", "price_max", "price_min", "price_currency" }) do
        if parsed.filters[key] ~= nil then filters[key] = parsed.filters[key] end
      end
    end
    if parsed.sort == "total_asc" then sort = "total_asc" end
    if lowered:find("비싼", 1, true) or lowered:find("highest price", 1, true) then
      sort = "total_desc"
      parsed.sort = sort
    end
    if lowered:find("이름순", 1, true) or lowered:find("name", 1, true) then
      sort = "name_asc"
      parsed.sort = sort
    end
    if not facet_request and parsed.unparsed and not parsed.sort and next(parsed.filters or {}) == nil then
      return render_exploration(snapshot, snapshot.page,
        "말씀하신 조건을 현재 탐색 결과에 적용하지 못했습니다.")
    end
  end

  local visible = {}
  for index = 1, #(snapshot.all_groups or {}) do
    local group = snapshot.all_groups[index]
    if group_matches_exploration(group, filters) then visible[#visible + 1] = group end
  end
  if #visible == 0 then
    return render_exploration(snapshot, snapshot.page,
      "조건에 맞는 상품이 없어 이전 탐색 결과를 그대로 보여드립니다.")
  end
  sort_exploration(visible, sort)
  local issued = issue_exploration(snapshot, visible, filters, sort)
  if not issued then return { next = "error", error = "exploration_encode_failed" } end
  local shown = render_exploration(issued, 1)
  return shown
end


function O.resolve_exploration(args)
  args = type(args) == "table" and args or {}
  local snapshot = restore_exploration_state(args.exploration_state)
  if not snapshot then return { next = "error", error = "exploration_unreadable" } end
  local call = {}
  for key, value in pairs(args) do call[key] = value end
  -- The flow state carrier is named choice_exploration_index; the pure resolver consumes choice_index.
  call.choice_index = args.choice_index or args.choice_exploration_index
  call.groups = snapshot.groups
  call.exploration_id = snapshot.exploration_id
  local result = AX_resolve_product_exploration(call)
  return result
end

--- Restores the last pre-lock surface. A named model already present in it is selected immediately; a
--- generic request re-renders it; an exact-model fast path with no prior snapshot starts broad exploration.
function O.restore_exploration(args)
  args = type(args) == "table" and args or {}
  local snapshot = restore_exploration_state(args.exploration_state)
  if not snapshot then
    local query = args.exploration_query
    if type(query) ~= "string" or query == "" then
      return { next = "error", error = "exploration_unavailable" }
    end
    return {
      next = "search",
      exploration_query = query,
      discovery_query = query,
      query = query,
    }
  end
  local choice = model_choice(snapshot, args.identity_change_request)
  if choice then
    return {
      next = "select",
      exploration_id = snapshot.exploration_id,
      exploration_state = encode_exploration(snapshot),
      choice_exploration_id = snapshot.exploration_id,
      choice_index = choice,
    }
  end
  local shown = render_exploration(snapshot, 1)
  shown.next = "present"
  shown.exploration_stage = nil
  shown.question = nil
  return shown
end
