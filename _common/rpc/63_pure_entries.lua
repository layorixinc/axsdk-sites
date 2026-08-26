--- Runtime entry points for the commands that never touch the browser.
---
--- Twelve `_common` files use no `dom`/`nav`/`net` at all, so moving them into the runtime changes where
--- they run and nothing else. What DOES change is how their arguments arrive: a `kind: remote` tool
--- receives the tool's `input:` mapping, while a runtime lua tool receives the node's SELECTED FLOW
--- STATE. That difference already cost one live round — every store refused with an empty site — so each
--- mapping is stated here in Lua rather than left in a `input:` block the runtime ignores.
---
--- Each entry returns `{ next = <branch>, ... }` in the shape the node's `next` map already expects, so
--- the flow graph does not move when a tool crosses the line.

AX_RPC_PURE = AX_RPC_PURE or {}
local P = AX_RPC_PURE

local function table_of(value)
  return type(value) == "table" and value or {}
end

local function purpose_of(context)
  return context.discovery_query and "discovery" or "comparison"
end

--- Relevance, provenance, FX and landed-cost normalization for one store's page.
function P.normalize_store_result(args)
  args = table_of(args)
  local item = table_of(args.item)
  local context = table_of(args.context)

  local result = AX_normalize_store_product_result({
    site = item.site,
    query = context.query,
    quantity = context.quantity,
    purpose = purpose_of(context),
    requested_brand = context.requested_brand,
    identity_brand = context.identity_brand,
    identity_model = context.identity_model,
    product_category = context.product_category,
    hard_constraints = context.locked_hard_constraints,
    query_variants = context.query_variants,
    brand_aliases = context.brand_aliases,
    result = args.store_result,
  })

  -- `flow.map` validates this against `resultSchema`, where `candidates` is declared `type: array`. An
  -- empty Lua table encodes as an OBJECT, so a store that found nothing failed validation with
  -- `candidates: expected array, received object` and the fan-out recorded a schema error instead of the
  -- honest answer, "this store had no matches". Absent is the encoding that cannot be mistaken.
  if type(result) == "table" and type(result.candidates) == "table" and #result.candidates == 0 then
    result.candidates = nil
  end

  return { next = "done", store_result = result }
end

--- Drops rows that are a different product from the one the user asked for, for the SINGLE-SITE list.
---
--- The comparison path has screened for relevance all along; this list had nothing, so row one was
--- whatever the grid rendered. Measured live on eBay: "첫 번째로 해줘" picked eBay's own "Shop on eBay"
--- promo tile and the cart refused with `product_navigation_failed`, because that id has no product page.
--- §13 records that no structural signature separates that tile from a listing — what removes it is that
--- it carries none of the query's words.
---
--- `matches_query` and not `relevance_match`: the comparison rule ANCHORS on a model code and brand, and
--- a single-site request usually has neither ("USB C cable", "신발"), so that rule would empty every
--- ordinary list. Every query token must appear, nothing more.
---
--- Screening everything away would leave the user nothing to pick from, so that case keeps the original
--- rows and reports the fallback instead of a count — the count is what the user is told, and telling
--- them "N개 제외" while showing them those same N rows would be a false statement.
function P.screen_site_candidates(args)
  args = table_of(args)
  local query = args.query
  local candidates = type(args.candidates) == "table" and args.candidates or {}
  local total = #candidates
  if total == 0 then
    return { next = "done", screened_out = 0 }
  end
  if type(query) ~= "string" or query:gsub("%s", "") == "" then
    return { next = "done", candidates = candidates, screened_out = 0 }
  end

  local kept = AX_COMMERCE.array()
  for index = 1, total do
    local candidate = candidates[index]
    if type(candidate) == "table" and AX_COMMERCE.matches_query(candidate, query, args) then
      kept[#kept + 1] = candidate
    end
  end
  if #kept == 0 then
    return { next = "done", candidates = candidates, screened_out = 0, screen_fallback = true }
  end
  return { next = "done", candidates = kept, screened_out = total - #kept }
end

--- Merges one read page into the store's accumulated candidates and decides whether another page — or
--- another wording — is worth a navigation.
function P.collect_store_page(args)
  args = table_of(args)
  local item = table_of(args.item)
  local context = table_of(args.context)

  local result = AX_collect_store_page({
    result = args.store_result,
    collected = args.collected,
    page = args.page,
    site = item.site,
    query = args.query,
    tried_queries = args.tried_queries,
    context = context,
    purpose = purpose_of(context),
  })

  -- An EMPTY accumulator must not cross as `{}`. Measured live on the discovery path, twice in one turn:
  --   `schema rejected value: collected: Invalid input`
  -- The node declares `[array, "null"]`, an empty Lua table encodes as an OBJECT, and the array-type
  -- marker is not honoured on an empty list. So the tool wrote `{}` into state, the model relayed it back
  -- as an argument, and the schema refused it — a store that found nothing stopped the whole comparison.
  -- `null` is the one encoding that cannot be mistaken, and the schema already allows it.
  local collected = result.collected
  if type(collected) == "table" and #collected == 0 then collected = nil end

  return {
    next = result.next,
    page = result.page,
    query = result.query,
    tried_queries = result.tried_queries,
    collected = collected,
    page_stop_reason = result.stop_reason,
    store_result = result.store_result,
  }
end

--- The `input:` renames of every ported pure command, in one table.
---
--- A runtime lua tool never sees the tool's `input:` block, so each rename has to be restated. Nine
--- hand-written entries would be nine chances to mistype a key the runtime then passes as nil — the
--- failure that already made every store refuse with an empty site. Keeping them here means a rename is
--- one line and a review reads them side by side.
---
--- `<key>` maps a node-state key; a table `{ value = x }` is a constant that belongs to the contract
--- rather than to the state.
local ARGUMENT_MAPS = {
  AX_prepare_product_identity = {
    product_category = "product_category", requested_brand = "requested_brand",
    requested_model = "requested_model", hard_constraints = "hard_constraints",
    soft_preferences = "soft_preferences", stores = "stores",
  },
  AX_lock_product_identity = {
    identity_kind = "identity_kind", identity_name = "identity_name", identity_brand = "identity_brand",
    identity_model = "identity_model", product_category = "product_category",
    canonical_query = "canonical_query", hard_constraints = "hard_constraints",
    soft_preferences = "soft_preferences", source_refs = "identity_source_refs",
  },
  AX_build_product_options = {
    results = "discovery_results", query = "discovery_query", product_category = "product_category",
    requested_brand = "requested_brand", hard_constraints = "hard_constraints",
    soft_preferences = "soft_preferences", max_options = { value = 6 },
  },
  AX_resolve_product_option = {
    options = "product_options", options_version = "options_version",
    choice_index = "product_choice_index", choice_id = "product_choice_id",
    choice_options_version = "choice_options_version", hard_constraints = "hard_constraints",
    soft_preferences = "soft_preferences",
  },
  AX_complete_store_results = {
    stores = "stores", store_results = "store_results",
  },
  AX_verify_product_offers = {
    results = "store_results", identity_id = "identity_id", identity_kind = "identity_kind",
    identity_brand = "identity_brand", identity_model = "identity_model",
    product_category = "product_category", hard_constraints = "locked_hard_constraints",
  },
  AX_build_offer_screening = {
    store_results = "store_results", identity_brand = "identity_brand",
    identity_model = "identity_model", product_category = "product_category",
  },
  AX_apply_offer_screening = {
    store_results = "store_results", screening_ids = "screening_ids", keep = "screening_keep",
  },
  AX_summarize_store_outcomes = {
    store_results = "store_results",
  },
  AX_resolve_store_offer = {
    offers = "offers", choice_index = "choice_index", choice_comparison_id = "choice_comparison_id",
    comparison_id = "comparison_id", identity_id = "identity_id", choice_stage = "choice_stage",
    quantity = "quantity",
  },
  AX_browse_service_candidates = {
    request_text = "requestText", user_messages = "userMessages",
    candidates = "candidates", refine_request = "refine_request",
    page_command = "page_command", page_number = "page_number", choice_numbers = "choice_numbers",
    page = "view_page",
  },
}

--- Calls a ported pure command with the node state mapped onto its arguments.
function P.run(command, args)
  local map = ARGUMENT_MAPS[command]
  local fn = _ENV[command]
  -- Calling an unmapped command would pass it the raw node state, where almost every key has a
  -- different name: it would answer as if the user had asked for nothing.
  if not map or type(fn) ~= "function" then
    return { next = "error", error = "unmapped_command", command = command }
  end

  local state = table_of(args)
  local mapped = {}
  for target, source in pairs(map) do
    if type(source) == "table" then mapped[target] = source.value else mapped[target] = state[source] end
  end
  return fn(mapped)
end
