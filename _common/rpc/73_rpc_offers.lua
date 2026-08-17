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
    failures = result.failures,
    incomplete_count = result.incomplete_count,
  }
end

--- Renders the listing, pauses on it, and reads the answer — because the node that pauses is the only
--- node that sees the user's new message.
---
--- Live, twice: the user typed "취소" and the offer was ADDED TO CART. The model gate downstream re-sent
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
    local reply = N.classify_reply(args.requestText)
    if reply.kind == "cancel" then
      return { next = "cancel", ok = true, comparison_id = snapshot.comparison_id }
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
