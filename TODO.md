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

**Status: open, product quality (readiness review P1-6).**

The correct DocuRay page opens and the reply is "BlueMoonSoft 페이지로 이동했습니다". The navigation work
is closed (`AGENTS.md` §6.1: a fragment-only target is answered as `already_open`); what is missing is a
flow that presents the opened page's content, or says plainly that the user should read it.

**Next**: decide whether the bluemoonsoft overlay gets a read-and-present node or an honest terminal. This
is flow/prompt work, not navigation — do not reopen the fragment investigation.

## 6. A >256 KiB flow document straight from package assets to the compiler

**Status: open, single experiment; the last M1 capacity question.**

`_common/flows.yaml` is 251,083 B (**95.8%** of 256 KiB). `flowsStore.setFlows` and the remote-site loader
cap persisted/remote values at 256 KiB; C3 package assets bypass both, and a regression already builds a
valid >256 KiB flow **asset**. No 256 KiB check was found in the final compiler.

**Next**: pass a valid >256 KiB document from package assets directly to the compiler and record the
answer. If it compiles, C3 has already removed the production ceiling and canonical YAML (21,629 B saved)
is transport/review convenience, not a launch prerequisite.

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
