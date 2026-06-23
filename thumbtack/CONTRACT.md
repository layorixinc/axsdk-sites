# Thumbtack Site Contract (rebuild ground-truth)

Live-measured ground truth for the Thumbtack rebuild. All selectors / URL signatures / navigation
types below were observed on the live site (Chrome 149, dev profile) on the dates of the survey.
Everything in the rebuild (page detector, base module, form wizard, tools, flow) is designed against
this contract. Re-survey and update this file when Thumbtack changes.

## 1. Navigation & execution model (the key finding)

Two tiers, measured by whether a `window` marker survives the action:

| Action | Type | Context | Implication |
|---|---|---|---|
| home → instant-results (search submit) | **FULL reload** | Lua context destroyed | re-entrant tool |
| instant-results → pro profile (open pro) | **FULL reload** | context destroyed | re-entrant tool |
| pro profile → open quote dialog (CTA) | **SPA overlay** (pushState, marker survives) | same context | in-page |
| quote dialog: advance step (Next) | **SPA overlay** (marker survives) | same context | in-page |

**Design rule — minimize durable-nav.** Because every *page* navigation is a full reload that
destroys the Lua context, a tool cannot continue across it without the SDK's slow durable
cross-navigation resume (the measured 12–21s spikes). So:

- **Page-level tools are re-entrant + page-detecting.** On each call: detect the current page; if
  already at the target, read & return `status:"done"`; if a navigation is needed, **fire it and
  return immediately** (`status:"navigating"`) — never await across the reload. The caller (flow
  self-loop / harness loop) re-invokes; `detect_page` then sees the new page and continues. This is
  idempotent and self-healing (a fire-and-forget click that didn't navigate is simply re-fired on
  the next call).
- **The quote dialog is same-context**, so the multi-step form wizard (open → answer steps → reach
  submit) runs within one Lua call — no re-entrancy needed *inside* the dialog.

## 2. Page detector (URL + light DOM → page type)

`detect_page()` returns `{ page, service_id?, zip_code?, keyword_pk?, ready }`. Classification:

| page | signature | extract |
|---|---|---|
| `home` | `pathname == "/"` | — |
| `instant_results` | `pathname == "/instant-results/"` | `zip_code`, `keyword_pk` from query |
| `pro_profile` | `pathname` matches `/service/(%d+)$` | `service_id` from path (or `service_pk` query) |
| `quote_dialog` | `pro_profile` **and** DOM has `[aria-label="Request Flow Dialog"]` + `[data-test="request-flow-step--active"]` | `service_id` + active step |
| `other` / `unknown` | none of the above (e.g. `/k/<cat>/`, login) | — |

`ready` = the page's readiness selector is present (see §3). When the URL matches a target but
`ready` is false, the page is still loading (treat as "navigating", caller waits + re-calls).

Replaces the scattered `is_home_page` / `is_results_page` / `current_results_match` /
`current_service_matches` / `service_id_from_url`.

## 3. Per-surface stable selectors & read strategy

### home  (`https://www.thumbtack.com/`)
- search query input: `input[data-test="search-input"]` (also `aria-label="Search on Thumbtack"`).
- zip input: `input[name="zip_code"]` (also `aria-label="Zip code"`).
- submit: `button[data-test="search-button"]` (aria-label "Search"). NOTE distinct from
  `button[data-test="search-input"]` (the open-search trigger).
- autocomplete suggestions: `[role="option"]` (no data-test; first option matches the typed
  category, e.g. "Handyman"). Selecting one is required for the submit to route correctly.
- readiness: `input[data-test="search-input"]`.
- inputs are duplicated (mobile + desktop) → always pick the visible one (`offsetParent !== null`).
- no useful JSON-LD.

### instant_results  (`/instant-results/?keyword_pk=&zip_code=&ir_referrer=&...`)
- pro card: **`[data-test="pro-list-result"]`** (stable). Sub: `pro-list-result-ratings`,
  `pro-list-result-business-facts`, `pro-list-result__business-image`.
- pro link inside card: `a[href*="/service/"]` → `service_id` from `/service/(%d+)`.
- readiness: `[data-test="pro-list-result"]`.
- filters (service options): survey the left filter panel separately before relying on it; current
  `.tp-title-4` / `div.b.tp-body-2` heuristics are brittle and should be re-derived or dropped.
- no JSON-LD.

### pro_profile  (`/<state>/<city>/<category>/<slug>/service/<id>?service_pk=&category_pk=&...`)
Read **selector-first**: every field = an ordered list of **candidate selectors** (first non-empty
wins), one paradigm (`data-test` → semantic/structural). When a selector is fragile, add **another
selector** as fallback — not another data source. Missing field → null (partial result, never
hard-fail); record which selector fed each field so drift is visible.

| field | candidate selectors (in order) | parse |
|---|---|---|
| service_id / zip_code / keyword_pk | URL (from `detect_page`) | — |
| name | `h1` | text |
| rating | `[data-test="review-summary"]` → `[data-test="pro-list-result-ratings"]` | parse_rating |
| review_count | `[data-test="review-summary"]` | parse_review_count |
| services_offered | `[data-test="specialties-section__interested-item"]` (array) | text[] |
| price_text | survey pro price area → confirm a `data-test`/structural selector | parse_price_text |
| quote CTA | `button` text `Request estimate` / `Request a call` (no stable attr) | `query_all{text=true}` + verify label before click |

- **`data-test` is the primary anchor** — Thumbtack's own QA hooks (`review-summary`,
  `specialties-section__interested-item`, …) are kept stable for their testing.
- JSON-LD / `__APOLLO_STATE__` are **dropped**: JSON-LD lacks price+services (selectors needed
  anyway) and Apollo is query-shaped/app-internal (more fragile than `data-test`). At most keep
  JSON-LD as a single *optional last-resort* fallback selector for name/rating, behind the same
  first-non-empty interface.
- Return a `sources` map (which selector fed each field) + a `partial` flag so drift is visible.
- readiness: `h1` present (also `[data-test="review-summary"]`).
- **Replaces** the old `section_between(get_text("body"), "About", …)` body-text scraping.

### quote_dialog  (overlay on pro_profile; URL gains `lp_request_pk` via pushState, no reload)
- container: `[aria-label="Request Flow Dialog"]`.
- active step: `[data-test="request-flow-step--active"]` (exactly one active).
- all steps pre-rendered: `form[data-test="request-flow-step-form"]` (9–10 forms);
  `[data-test^="request-flow-step"]` for the broader set. Detect "open" by the **active** step, never
  by a generic modal selector (the page pre-renders empty modal placeholders).
- step controls: `input[type=radio]` / `input[type=checkbox]` / `textarea` inside the active step.
  Radio group name is generated (`-launchRequestFlow-segment-steps-...`), shared per group.
- **`input.required` is NOT reliable** (observed `required:false` on a required radio). Required-ness
  must be inferred another way (e.g. presence of a `Skip` button = optional; else treat a step with
  controls as requiring a selection). Re-derive during form-wizard design.
- advance button: `button[type="submit"]` labelled `Next` inside the active step (also `Continue`).
  Optional steps also expose `Skip`.
- submit step: final step shows `Send`/`Submit`/`Request`/`Get quotes` instead of `Next` — the wizard
  must STOP here and never auto-click it (submit only on explicit confirmation).
- error popup: `#request-flow-error`.

## 4. ZIP / locale assumptions (US-only today)
- ZIP = 5-digit (`%d%d%d%d%d`). Resolution: address text → embedded ZIP → Census onelineaddress
  (full street only) → Zippopotam `us/<st>/<city>` fallback. All US-only. Gate behind a country
  check if non-US is ever needed.

## 5. Rebuild implications (carried into later steps)
- **Re-entrant page-detect tool contract**: every page-level tool = `f(detect_page(), args) →
  {page, status: done|navigating|needs_input|error, payload}`; navigation is fire-and-return.
- **Form wizard** is a same-context engine over the quote dialog: `{activeStepSelector, optionSelector,
  submitMatcher, contactFieldMap}`; reusable across quote/booking sites.
- **Reads = selector-first with per-field fallback chains + partial-tolerance + drift detection**:
  each field tries an ordered list of **candidate selectors** (`data-test` → semantic/structural,
  first non-empty wins), staying in one paradigm; URL supplies IDs/zip. JSON-LD/Apollo dropped
  (selectors needed for price/services regardless). Records which selector fed each field so drift
  surfaces instead of silently breaking.
- **Selector health**: a smoke check should assert each readiness selector + `data-test` anchor still
  resolves, to catch drift early.
