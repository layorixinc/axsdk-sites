# Multi-Store Total-Cost Shopping

## 1. Goal

Implement one production agentic shopping cycle that searches two real commerce sites, normalizes landed cost, presents comparable evidence, obtains scoped user approval, and prepares the selected cart without entering checkout or placing an order.

The first supported pair is Amazon US and eBay US. V1 is intentionally sequential because the current `flow.map` runtime has `concurrency: 1`.

## 2. User contract

A request such as:

> Compare a Logitech M185 across Amazon and eBay by total cost and add the best option to my cart.

runs this cycle:

```text
collect exact product query
  -> search Amazon and eBay with a keyed task map
  -> normalize price + shipping into USD
  -> rank with deterministic tie-breaks
  -> show the comparison and incomplete fields
  -> ask which offer to add
  -> validate the user's selection
  -> re-read the selected offer's price
  -> add it to that site's cart
  -> report the verified outcome
```

The flow never enters checkout. The existing `checkout` intent remains a separate user-approved action and never places an order.

## 3. Current gaps

| Requirement | Before this cycle | Required change |
|---|---|---|
| Two real commerce adapters | Amazon only | Add an eBay search/cart adapter |
| Cross-site execution | Site-local `AX_search_product` and `AX_add_to_cart` | Add common registry-based dispatch commands that survive navigation |
| Bounded deterministic fan-out | LLM-managed single-site loop | Use keyed `flow.map` with per-site budgets and collected failures |
| Common offer schema | Amazon-specific candidates | Normalize both adapters to the schema in section 5 |
| Cross-currency comparison | Raw site currency only | Freeze public USD FX rates for the search result and retain source/date |
| Total-cost ranking | Product price only | Add explicit shipping coverage and deterministic landed-cost ranking |
| Scoped cart approval | Product refinement implies mutation | Ask specifically which compared offer to add, then validate its index |
| Stale-price protection | Add command does not compare approved price | Re-read the selected product page and reject a higher or different-currency price |
| Partial failure | Single-site skip | Preserve each map result and report failed/unknown stores and fields |
| Live evidence | Amazon-only scenarios | Exercise both real adapters and the full extension conversation |

A multi-store result is not considered complete when one store is mocked. Both adapters read live public pages.

## 4. Scope

### Included in this cycle

- one product query and quantity per task run;
- Amazon US and eBay US;
- search-result evidence: site, product ID, title, URL, item price, currency, shipping, delivery text when exposed, rating/review signals when exposed, condition, and return text when exposed;
- FX conversion to USD through the public Frankfurter endpoint, with conversion date and source recorded;
- deterministic ranking;
- explicit offer selection for cart preparation;
- price revalidation immediately before mutation;
- add-to-cart verification;
- structured partial failure and login/CAPTCHA reporting.

### Excluded from this cycle

- tax, coupons, membership-only discounts, duties, and address-dependent charges that the public search result does not expose;
- automatic substitution between materially different models, conditions, or options;
- parallel map execution;
- checkout, payment, or order placement;
- automatic recovery from CAPTCHA or authentication;
- transaction rollback across stores.

The comparison labels incomplete totals. It does not claim an exact cheapest offer when a required cost component is unknown.

## 5. Commerce adapter contract

A site adapter registers with `AX_COMMERCE.register_adapter(site, adapter)` and provides:

```text
site                 stable slug
home_url             canonical site entry URL
host_matches(url)    target-host predicate
search(args)         live search returning candidates
add_to_cart(args)    live mutation returning verification
```

`AX_search_store_product` and `AX_add_store_product_to_cart` are common, re-entrant dispatchers. The flow first calls `AX_open_site`; after the destination reload registers its site adapter, the dispatcher invokes that adapter. Site-specific selectors remain under `<site>/scripts/`.

A normalized candidate has:

```text
site, product_id, name, url
price, price_text, currency
shipping_cost, shipping_text, shipping_currency
unit_total, total_for_quantity
base_currency, price_base, shipping_base, total_base
cost_complete
fx_rate, fx_date, fx_source
rating, review_count
condition, delivery_text, return_terms
```

Unknown fields are null/absent, not invented. `cost_complete` is true only when item price, shipping, currency, and required FX rate are known.

## 6. Deterministic normalization and ranking

For a candidate in currency `c`, Frankfurter returns `r_c` units of `c` for one USD. The USD conversion is:

$$
P_{USD} = \frac{P_c}{r_c}, \qquad
S_{USD} = \frac{S_c}{r_c}, \qquad
T_{USD} = qP_{USD} + S_{USD}
$$

where `q` is the requested quantity. The shipping amount is treated as one listing-level amount. The flow labels this as a search-page estimate and revalidates the item price before cart mutation.

Sorting is stable and deterministic:

1. complete landed cost before incomplete cost;
2. lower `total_base` (or lower known price estimate when incomplete);
3. higher rating;
4. higher review count;
5. lexical site slug;
6. lexical product ID.

After sorting, the approval list is capped at the best six offers. This bounds flow state and keeps every selectable offer visible while preserving up to three normalized candidates per store for deterministic comparison.

Placeholder advertisements, rows without a real product ID, and rows without a numeric item price are excluded. A valid sponsored listing remains eligible with `sponsored:true` so the approval summary exposes that fact; Amazon's known irrelevant sponsored-card variants remain filtered by its existing adapter.

## 7. Flow design

New planner intent: `shopping_multi_store_total_cost`.

Routing rule:

- explicit multiple stores, cross-store comparison, cheapest total, shipping-inclusive cost, or Amazon/eBay comparison -> `shopping_multi_store_total_cost`;
- ordinary product purchase on one shopping site -> existing `shopping_single_site`.

Primary flow nodes:

```text
collect_multi_store_request (action_unit)
search_stores              (action_contract -> keyed flow.map)
normalize_rank             (action_contract -> sandboxed Lua)
choose_offer               (action_unit, always asks before mutation)
resolve_offer              (action_contract -> validates integer index)
open_selected_store        (action_contract -> re-entrant site open)
add_selected_offer         (action_contract, mutation + consent metadata)
report_cart                (terminal)
```

Mapped subflow:

```text
shopping_search_one_store.open
  -> AX_open_site (an off-site navigation resumes the worker on arrival)
  -> shopping_search_one_store.search
  -> AX_search_store_product
  -> terminal
```

Task-map invariants:

- unique key: `site`;
- maximum two items for this cycle;
- `onItemError: collect`;
- zero model calls inside workers;
- two remote calls per worker: open/confirm the store, then search;
- validated result schema;
- partial results retained in input order.

## 8. Approval and mutation safety

The comparison prompt must always be shown before mutation, even when one candidate is clearly cheapest. The user must select an offer number or explicitly cancel. A deterministic resolver then:

- checks that the index is an integer in the current ranked list;
- copies site, product ID, name, approved price, and currency from that list;
- emits the scoped approval marker consumed by the mutation adapter.

The cart adapter requires the scoped marker and re-reads the product page. It stops with `price_changed`, `currency_changed`, `login_required`, `captcha_required`, `variation_required`, or `add_to_cart_unavailable` instead of clicking when the precondition is not satisfied.

A successful outcome requires a site-visible cart confirmation. Navigation or a click alone is not success.

## 9. Implementation sequence

1. Add failing offline scenarios for eBay parsing, cost normalization, ranking, invalid approval, stale price, and partial store failure.
2. Add the common commerce registry, dispatchers, FX normalization, and ranking core.
3. Extend Amazon candidate shipping evidence and pre-add price validation.
4. Add the eBay selector-first search and cart adapter.
5. Add the keyed task-map flow and planner route.
6. Add the live extension scenario runner.
7. Build Lua, run flow conformance, run focused offline tests, then run live read and mutation scenarios.

Before eBay is published to the remote index, the live runner uses CDP Fetch to serve the working copy's `index.md` to the dedicated dev tab. The extension still executes only the store-synced Lua/flow layers with remote sources disabled; the override exists solely so the unpublished eBay domain resolves to its stored site bundle across reloads.

## 10. Acceptance scenarios

| Scenario | Expected result |
|---|---|
| Same product, free shipping on both sites | Lower normalized landed cost ranks first |
| KRW eBay offer vs USD Amazon offer | FX source/date are recorded and USD totals are comparable |
| Paid eBay shipping | Shipping is included once in the landed total |
| Unknown Amazon shipping | Candidate is marked incomplete and the terminal explains the missing component |
| One store returns no results | Other store remains usable; partial status is reported |
| Duplicate or placeholder eBay row | Invalid rows are excluded and item IDs are deduplicated; valid sponsored status remains visible |
| User chooses an out-of-range number | No mutation; flow asks for a valid number |
| User cancels | No cart mutation and no checkout |
| Product price increases before add | Mutation stops with stale-price evidence |
| eBay requires login or CAPTCHA | Flow hands control to the user; no repeated click |
| Successful Amazon selection | Amazon cart confirmation is reported; checkout is not opened |
| Successful eBay selection | eBay cart confirmation is reported; checkout is not opened |

## 11. Release evidence

Completion requires all of the following:

- Lua bundle validation;
- common flow conformance compilation;
- deterministic offline scenarios for normalization and both adapters;
- live `AX_search_store_product` results from Amazon and eBay;
- one full extension conversation that searches both stores, displays a comparison, receives a user selection, adds the selected offer, and stops before checkout;
- public-safety scan of every changed artifact.
