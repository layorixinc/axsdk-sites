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

  return { next = "done", store_result = result }
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

  return {
    next = result.next,
    page = result.page,
    query = result.query,
    tried_queries = result.tried_queries,
    collected = result.collected,
    page_stop_reason = result.stop_reason,
    store_result = result.store_result,
  }
end
