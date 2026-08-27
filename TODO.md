# TODO — deferred work register

What is deliberately NOT being worked on right now, why, and the smallest next step for each. English,
because this spans the whole repo (`AGENTS.md` §11); the CWS launch track keeps its own Korean documents
(`CWS_LAUNCH_PLAN.md`, `CWS_RELEASE_DESIGN.md`).

Rules this file follows, so it stays worth reading:

- Every entry carries **measured** evidence with a date, not an impression. A finding nobody re-checked is
  worse than no finding (`AGENTS.md` §13).
- An entry that is blocked names **what** blocks it. "Blocked on a live trace" is a real state; "blocked"
  alone is not.
- Nothing here gets a speculative guard, config value or prompt tweak before it is measured. Three of this
  repo's worst afternoons were spent on fixes for defects that were never confirmed to exist.

---

## 1. Shipping completeness — coupang · walmart · ssg

**Status: open, next in line.**

Measured 2026-08-26 (`npm run test:extraction:live`, eight stores): `shipping_text` fills **0 of 8 rows**
on coupang, walmart and ssg. amazon is 6/8, 11st 3/8, etsy 5/8.

Why it is user-visible rather than cosmetic: a row whose total cost is unknown is **folded out of the
default comparison window** and counted ("배송비/총액 미확인 N건은 접었습니다", `AGENTS.md` §13). So those
three stores disappear from any comparison in which another store states a complete total.

**Next**: measure what each store's card actually says about shipping (card text plus candidate elements,
two query wordings to separate a per-query absence from a structural one), then decide **per store**:

- the card states a fee → fix the selector or the text rule, failing test first;
- the card states nothing (walmart tiles already cannot be priced, §13) → **delete the dead selector and
  keep the total unknown**. Inventing 0 makes that store the cheapest on the page for free.

## 2. Selectors that cannot fill by construction

**Status: open, small; rides with item 1.**

`coupang` and `ssg` both declare `result_title_selector = 'img[alt]'`. The reader asks for that selector's
**text** (`_common/rpc/61_rpc_storefront.lua:177`) while an attribute read is a different declaration
(`:181`, `add("image_alt", config.result_image_selector, "alt")`). An `img` has no text, so the field is
0/8 on every query forever, and the title survives only through the `image_alt` fallback in
`candidate_from`.

This is not drift — it is a declaration that cannot be satisfied, so it is checkable offline. **Next**: a
`check:flows` rule refusing a text-read field whose selector names an `img`/`input`/`meta` element, then
fix or drop the two declarations. coupang's `result_shipping_selector = '[data-badge-type="feePrice"]'`
(0/8 today) is decided by item 1's measurement.

## 3. `etsy` reporting `status: "candidates"` with an empty list

**Status: narrowed, BLOCKED on a live trace.**

Two producers were found and fixed (`_common/scripts/56_store_io.lua:131`,
`_common/scripts/54_comparison.lua:429`/`:555`). What remains is only whether a **third** exists:
`S.run_store_search` derives `status = (branch == "ok") and "candidates"` and strips an empty list on the
way out, but relevance filtering happens one layer up, so no offline test reproduces the shape.

**Next**: capture a live trace that publishes it. Do **not** add a guard at `run_store_search` before that
trace exists — a guard for an unconfirmed producer is the "adjust it until it goes green" failure in
another costume.

## 4. `AGENTS.md` §6.4's eBay cart entry is stale

**Status: open, doc accuracy, one commit.**

The entry still reads "[OPEN, narrowed] eBay's cart configuration is half measured … what is still missing
is the CONFIRMATION half — `cart_url`, `cart_url_markers`, `confirmation_selector`,
`confirmation_text_selectors`". Measured today: `ebay/scripts/01_storefront_config.lua` declares
`cart_url = "https://cart.ebay.com/"` and `cart_url_markers = { "cart.ebay.com" }`; the two confirmation
keys are **deliberately** absent (§13: eBay has no per-add panel, and a text assertion would be
locale-bound — the id on the cart page is the only language-independent evidence); and the in-page-XHR
counter wait that fixed the `added ↔ pending` alternation is implemented at
`_common/rpc/67_rpc_cart.lua:399-415`.

**Next**: rewrite the §6.4 paragraph to the measured state and keep the reason the confirmation keys stay
unset. A false settled finding is worse than none.

## 5. BlueMoonSoft answers "navigated" instead of the content

**Status: closed 2026-08-26 — the site was removed from the product.**

bluemoonsoft was removed from the product on 2026-08-26: the flow, its four tools, the site data and
`_common.72_rpc_sitemap` are gone, so there is no reply left to improve. Measured after the removal, one
live turn: "블루문소프트 회사 정보 보여줘" is classified `out_of_scope` and answered
"죄송합니다, 요청을 처리할 수 없습니다." — see item 12, which is where that answer comes from.

## 6. A >256 KiB flow document straight from package assets to the compiler

**Status: closed by measurement (2026-08-26).**

`_common/flows.yaml` is 255,247 B raw / **232.4 KiB canonical (90.8%** of 256 KiB, after the bluemoonsoft removal). `flowsStore.setFlows` and the remote-site loader
cap persisted/remote values at 256 KiB; C3 package assets bypass both, and a regression already builds a
valid >256 KiB flow **asset**. No 256 KiB check was found in the final compiler.

Measured 2026-08-26: `POST /axsdk/v2/sessions` refuses a `clientFlowDocument` over 256 KiB of UTF-8 —
261,747 B accepted, 262,647 B refused with `data.message: "clientFlowDocument is too large"`. The backend
refuses such a document before any compiler sees it, so package assets bypassing the client-side caps does
not remove the production ceiling.

## 7. Watch list — instrumented, no action until it recurs

- **`no-node` turns**: 1 in 48 live turns reached no flow node. Timeouts now carry `stage`, `landed` and
  `stoppedOn`; the sweep retries **only** a `no-node` batch, once, and always reports the retry. Neither
  targeted probe reproduced it.
- **`402 LimitExceeded` on `POST /sessions/message`** (mar 1001/1000) while session creation answers 200.
  Monthly quota; the symptom is "accepted then nothing ran". Same family as the 60 s `reset()` timeouts.
- **gmarket serving `/Notice-checkNotice?edt=05:00`**: the extraction audit fails that store and names the
  landed page, which is the honest outcome for a maintenance window — not a reader defect.

## 8. Owned outside this repo

- **CWS One Stop Support inquiries (2)** — written and ready in `CWS_ONE_STOP_INQUIRIES.md`, not sent.
  Owner: BIZ. Answers gate P0-1's "unreachable, default-off paths" question and the single-purpose wording.
- **P0-3 single-purpose sentence** — three drafted options in `CWS_LAUNCH_PLAN.md` §P0-3. Owner: BIZ + EXT.
- Everything else on the launch track lives in `CWS_RELEASE_DESIGN.md`; this file does not duplicate it.

## 9. Honour a narrowed Site Access on the debugger channel

**Status: deferred by decision (2026-08-26), not blocked.**

A user who narrows this extension's Site Access gets no narrowing of `dom.*`/`nav.*`, because those ops
travel `chrome.debugger`, which Site Access does not bound (measured: `chrome.scripting` refused,
`chrome.userScripts` did not inject, `chrome.debugger` read the page). The install warning for `debugger`
already discloses "Read and change all your data on all websites", so this is a control mismatch rather
than missing consent — see `CWS_RELEASE_DESIGN.md` T4 for why it left the R1 critical path.

**Next, if a reviewer or the One Stop answer (D7) asks**: check
`chrome.permissions.contains({ origins: [url] })` once per document, cached like the existing gate, and
refuse when the user has narrowed access. Do **not** wire `productSitesFromIndex`: measured, its exact-host
allowlist refuses 8 of the 19 hosts our own site data names, including every cart/checkout host on five
stores. One probe first — confirm `contains` reflects the narrowing the way `getAll` does.

## 10. The community charter contradicts the shipped community channel

**Status: open, one decision away; belongs to the R2 track.**

`community/release-policy.json` is validated by `build:cws` on every run and declares
`trust.registrySigned: true`, `trust.unsignedScripts: false`, `trust.arbitraryUrlImport: false`. The
shipped channel does the opposite by design: `community/from-url.ts` installs from a manifest URL the
user pastes, with **no signature** — "the trust is that the USER chose the URL, which is how Tampermonkey
and every other userscript manager works" (`from-url.ts:1-21`) — and the options page offers exactly that
(`options.html:117`, "Install from a manifest URL").

So a gate is enforcing a statement the product no longer makes. Neither side is wrong on its own: the
unsigned from-URL model was a deliberate later decision, and the JSON was written before it.

**Next**: when the R2 charter is written (D1 scoping), rewrite the trust block to the model that ships —
unsigned user-chosen URLs with declared-digest verification, signed only for a reviewed registry if one
ever exists — and keep the gate. Do not weaken the gate to accept both.

## 11. The rendered comparison window is Korean by construction

**Status: open, product work; surfaced by the listing assets.**

The listing is bilingual and `_locales/{en,ko}` localize the store name and description, but the window
the user actually reads is assembled from Korean literals in the flow layer. Measured 2026-08-26: **87
lines with Korean string literals** across the renderers — `_common/scripts/45_offer_view.lua` 60,
`54_comparison.lua` 24, `55_offers.lua` 3 — covering store names (`아마존`, `11번가`), the shipping and
rating labels, the folded-row note, and every refusal sentence (`price_currency_unknown`, `no_matches`,
`unparsed`).

So an English request today produces an English reply wrapped around a Korean window. That is why
`LISTING_ASSET_LOCALES` is `["ko"]` alone: an `en` capture would misrepresent the product rather than
localize it, and the store takes one screenshot set for all locales.

**Next**: decide whether R1 ships Korean-only UI (then the English listing must say so plainly, which it
now does) or the renderers take a language parameter. The refine parser already accepts English phrases
(`include unknown`, `show all`, `free shipping`, `under`), so input is not the gap — output is.

## 12. An out-of-scope request never reaches our own refusal text

**Status: open, small; observed 2026-08-26 while verifying the bluemoonsoft removal.**

`router.fallbackIntent` is `unsupported_request`, whose terminal states what the product DOES do
("service quotes, shopping, checkout review, and explicit memory requests"). That text has never been
measured reaching a user. A planner `out_of_scope` answer carries `intents: []`, so the router runs
nothing and the app's own terminal answers — measured live, the whole reply is
"죄송합니다, 요청을 처리할 수 없습니다.", with a trace of the capture hook plus an app-level
`site_resolve` and no flow node of ours. `fallbackIntent` covers an intent NAME that does not resolve,
which is a different case.

Not a regression and not urgent: a bare apology is honest and claims no functionality, which is what §1
cares about. It is a quality gap — the one place the product could state its purpose in the user's own
language, it says nothing.

**Next**: decide between (a) the planner emitting `replace_current` with `intent: unsupported_request`
for an out-of-scope message plus a route for it, or (b) leaving the app terminal and accepting the bare
apology. (a) needs a live turn to confirm the branch, and a gate pinning that the route exists — a route
nobody reaches is exactly what this entry is about.

## 13. The app document still carries the surfaces the store profile removed

**Status: open, owned outside this repo (BIZ/platform); measured 2026-08-27.**

The platform app document (`browser-extension`, revision 126, 78,713 B) declares its own
`hooks.beforeIntent: [record_memory]`, a `record_memory` flow whose tools are `memory_record`/
`memory_skip`, a memory demo flow, and `defaultIntent: site_intent_resolution`. Our overlay overrides the
default intent and REPLACES the hook flow with a no-op, so the shipped behaviour matches the single
purpose — proven by the artifact smoke, which asks the package for a quote and reads its refusal.

Why it still matters: the neutralisation is a shadow, not a removal. An app-document change (or a
store-specific app id) is what would remove the memory surface at the source, and an app push replaces
production (`AGENTS.md` §9), so it is not ours to do.

**Next**: BIZ decides whether R1 ships against `browser-extension` as it stands (overlay shadowing, which
the gates now pin) or a narrowed app document/app id is created for the store build.

## 14. The backend module set no longer matches the shipped package

**Status: open, blocks `release:cws`; measured 2026-08-27.**

`release:cws` refuses with `backend module drift: stale _common.66_rpc_navigate` — the bluemoonsoft cutover
changed that module and the app revision the release binds to still carries the old bytes. The artifact
smoke passes because it synthesises its own backend evidence for a transient candidate.

**Next**: push the runtime modules to the app the release binds to, then re-run `release:cws`. The five
modules the store profile dropped stay at the backend and are recorded as `unusedBackendModules` — inert,
because the flow document is what names modules.

## 15. `community_script` is routable in the store package and is not in the sentence

**Status: open, decision; surfaced 2026-08-27 by the release evidence.**

The release manifest records what the shipped package can route:

```json
"singlePurpose": { "defaultIntent": "shopping_multi_store_total_cost",
  "routableIntents": ["checkout", "community_script", "end_conversation",
                      "shopping_multi_store_total_cost", "shopping_single_site"],
  "neutralHooks": ["record_memory"] }
```

The single purpose is "compare one product’s total cost across supported stores, add the one the user
picked, open the checkout review" (`store/single-purpose.md`). `community_script` answers about the
community scripts a user installed on the page they are on — it postdates the three-option table in
`CWS_LAUNCH_PLAN.md`, so no option ever said whether it belongs inside the sentence.

Both readings are defensible: it is a control surface for scripts the user installed themselves (not a
second product), or it is a second entry point of the kind §1 names. Nobody has decided.

**Next**: BIZ decides. Removing it is one line — add `community_script` to `STORE_EXCLUDED_INTENTS` in
`tools/build-store-flows.mjs` and rebuild; the closure drops its flow, tools and modules, and the gates
prove the rest. Keeping it means the listing should say so in words a reviewer can match to the surface.

## 16. The engine leaks the model’s harmony wrapper into replies

**Status: open, owned by the runtime team (`RPC_LUA_RUNTIME_REQUESTS_21.md`); measured 2026-08-27.**

A user-facing reply can carry `<|channel|>commentary to=functions.<tool> <|constrain|>json<|message|>{…}`
in front of the real sentence. Measured on two flows and two packages; one `test:thumbtack:live` run
carried 52 occurrences. The leak appears in every run, including the pre-edit planner document (52 occurrences there too), so it
is not our authoring. The first A/B recorded for it was measured during an exhausted-API-balance outage
and is retracted.

Our side is done: the shared session driver flags it per turn, the artifact smoke fails on it, and the
quote suite names how many replies were polluted. There is nothing further to fix in this repo — the
text is assembled by the engine.

**Next**: runtime team applies one of the three options in the request document.

## 17. `test:thumbtack:live` is 5/7 — one channel error, twice counted

**Status: open, measured 2026-08-27 on a healthy provider; not a flow defect.**

Both failures come from one `search_service(error)` — "브라우저 연결을 확인할 수 없어서" — on the RESUMED
turn of the house-cleaning case. Retention itself worked: `present_quote_collection: resume` →
`collect` → `done` → `verify_request: ok`, and only the search errored. The cancel case then fails
downstream, because the flow had already ended and "취소" reached no node.

Reproduced identically on the pre-edit planner document, and the other two searches in the same run
succeeded — so it is transient on that turn, not a site or planner problem.

**Next**: instrument which op refused (`AGENTS.md` §13: a transient op refusal is not a page fact) and
decide whether the search should retry once on a channel refusal, as the quote wizard already does for
its own dom reads. Does not block the CWS release: the store package has no quote flow.

## 18. The store profile must never edit the authored planner prompt

**Status: closed 2026-08-27 by measurement, recorded so it is not retried.**

Splitting three mixed sentences in `_common/flows.yaml` so the store narrowing could filter them took the
live quote suite from **5/7 to 2/7** (3 turns reached no node, 3 were misrouted into shopping); restoring
them and moving the rewrite into `STORE_PROMPT_OVERRIDES` returned it to **5/7**. The overrides are keyed
on the exact authored text, so a rewording fails the build instead of silently missing, and
`build-store-flows.test.mjs` pins the authored sentences verbatim.
