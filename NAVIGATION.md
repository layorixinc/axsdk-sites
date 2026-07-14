# Navigation contract (`nav.navigate`)

Environment-independent primitive for driving and confirming a navigation. Its responsibility is
**narrow on purpose**: report only two facts —

- **fired** — a navigation was actually initiated (else it was a no-op), and
- **arrived** — a new document (or a same-document URL change) was committed.

It says **nothing** about *where* you landed, whether the page is *ready/usable*, or whether it is the
*right* page. Those are separate concerns owned by `detect_page` (where), `wait_settled` (ready), and
the caller (correct). Keeping `navigate` this narrow is what makes it reliable and portable.

## 1. Why narrow, and why not URL/DOM matching

The old `nav.navigate` conflated three things — transport (soft SPA vs hard document load), arrival
detection (a URL path-prefix match), and state freshness. That produced the failures we hit:

- home-nav no-op (an empty expected path `/` matched every URL, so "already home" → never navigated),
- soft-nav contamination (a pushState nav let the SPA re-attach session state, e.g. Thumbtack
  re-attaching an active `project_pk` to a new slug URL, rendering the previous service's results),
- reading a stale same-type page (a `/instant-results/` page matched any service),
- reading mid-hydration (URL/`load` fired before the content rendered).

Neither **URL** nor **DOM** is a correct *freshness* signal for *fired* / *arrived*:

- URL: a soft nav changes the URL without a document load; a reload/redirect-back keeps the URL; a
  pushState changes it without a real navigation; query params get appended (`project_pk`).
- DOM: content selectors drift, and "a specific element exists" answers *ready*, not *a document
  loaded*.

The correct, environment-independent freshness signal is the **document/context lifecycle**
(`performance.timeOrigin`). URL is not the freshness signal, but a **durable, re-entrant** implementation
— one whose marker persists across many activations (the SDK) — additionally uses a **host-tolerant
target match** as a *gate*: a persisted stale marker would otherwise satisfy `timeOrigin > firedAt`
against an unrelated *later* document and report a false `arrived`, so arrival is confirmed only when the
fresh document also matches the fired target (path-subsequence + query-subset). A self-contained
implementation that captures the pre-nav baseline per call (the CDP harness) has no persisted marker and
needs no gate.

## 2. Contract

```
navigate(target, opts?) -> Result
  target : URL string. A "document" navigation is fired via location.assign (forces a real load).
  opts   : { firedTimeout = 1500 }        // ms to wait before declaring a no-op

Result (resolved):
  { fired: bool, arrived: bool, kind: 'document' | 'within_document' | 'none', url: string }
Result (pending):
  { status: 'navigating' }                // not yet resolved; caller re-invokes (durable suspend/resume)
```

- **Idempotent.** On entry it first resolves any *pending* navigation for `target`; it only fires a
  new one if none is pending. Safe to re-invoke across durable replay / document re-activation.
- **No readiness, no identity, no classification.** `arrived: true` means "a fresh document is live"
  (durable model: *matching the fired target*) — it may still be an empty result, a hub, or a same-path
  redirect target; interpreting *that* is downstream. In the durable model a redirect to a **different
  path** (login gate, canonical-slug change) does not match the target and resolves as `kind: 'none'`
  after `firedTimeout`, not `arrived`; the caller then re-runs `detect_page` on whatever actually loaded
  (§5).

## 3. Environment-independent mechanism

A cross-document navigation **destroys the JS execution context**, so *fired* and *arrived* cannot be
observed in one continuous execution. The only portable design embraces this: persist a small marker
across the navigation and **resolve on every activation** (this is exactly the durable / re-entrant
model). The mechanism uses **only web-standard APIs available to any page JS**, so it runs identically
in an extension content script, a plain injected library, or under a CDP harness.

Signals (all web-standard):

- `location.href` (read) — same-document URL change.
- `pagehide` — leaving a document (cross-document nav committing).
- `performance.timeOrigin` — the ms-epoch time the **current document's** global was created.
- `sessionStorage` (same-origin marker) + `window.name` mirror (survives cross-origin).

State machine:

```
FIRE (navigate, no pending marker):
  clearBeforeunload()                              // (③) else a blocked "Leave?" prompt looks like a no-op
  writeMarker({ seq: prevSeq+1, from: location.href, target, firedAt: Date.now() })
  location.assign(target)                          // (②) real document load — never an SPA-router click
  return { status: 'navigating' }                  // context will die for a cross-doc nav; resolved on the new doc

RESOLVE (navigate re-invoked, or runtime bootstrap, with a pending marker m):
  onTarget = matches(location.href, m.target)      // durable gate: path-subsequence + query-subset (host-tolerant)
  if performance.timeOrigin > m.firedAt and onTarget:  // (①) fresh document AT the target = real load
      clearMarker(); return { fired:true, arrived:true, kind:'document', url: location.href }
  else if location.href != m.from and onTarget:    // same document, URL changed to the target = pushState
      clearMarker(); return { fired:true, arrived:true, kind:'within_document', url: location.href }
  else if now() - m.firedAt > firedTimeout:        // not on target within the window = no-op / off-target
      clearMarker(); return { fired:false, arrived:false, kind:'none' }
  else:
      return { status: 'navigating' }              // still pending — re-resolve on the next activation
// A non-persistent implementation (fresh baseline per call, e.g. the CDP harness) omits `onTarget`:
// with no stale marker, `timeOrigin > baseline` alone is unambiguous.
```

Refinements baked in (each fixes a concrete case — see §7):

- **① `arrived` via `performance.timeOrigin > firedAt`** (freshness), not `location != from`; in the
  durable model **gated by a host-tolerant target match**. `timeOrigin` detects a **same-URL reload**
  that a `location != from` comparison misses; the target gate binds that freshness to the fired
  destination, so a *stale* persisted marker cannot resolve against an unrelated *later* document. A
  redirect to a **different** path is therefore not `arrived` (it resolves `none` after `firedTimeout`);
  re-detect the landed page with `detect_page`.
- **② Fire hard navigations via `location.assign`** (a real document load). An in-app `<a>` click would
  be intercepted by the SPA router → pushState → soft nav → session/`project_pk` contamination.
- **③ Clear beforeunload before firing.** Otherwise a "Leave?" prompt blocks the nav and yields a false
  no-op.
- **④ Idempotent (resolve-pending-then-fire).** Durable replay or the destination-document bootstrap
  re-invokes `navigate`; it must resolve the pending marker (arrived/no-op) rather than re-fire.

## 4. Optional enhancements (never required for correctness)

The web-standard base above is complete. When more privilege is available, it can be *refined* — but
correctness never depends on it:

- **Extension background** — `chrome.webNavigation` (`onCommitted` / `onErrorOccurred` /
  `onHistoryStateUpdated`) gives exact per-tab commit / error / soft-nav events and survives the page
  reload; it can replace the `pagehide`/timeout heuristic and track redirect chains precisely.
- **Dev harness (CDP)** — `Page.frameNavigated` + `loaderId` precisely identifies distinct document
  loads and redirect chains. **CDP is a dev-only enhancement, not the production signal.**

## 5. Responsibility boundary — the pipeline

```
navigate  ──▶ (arrived?) ──▶ detect_page ──▶ wait_settled ──▶ read / verify
 fired/arrived            where / gated     ready / empty / overlay-step   right page?
```

| Concern | Owner |
|---|---|
| A navigation happened / landed somewhere | `navigate` |
| What page is this? Is it a login / consent / error gate? | `detect_page` |
| Is the content usable (hydrated), empty, or a mid-transition state? | `wait_settled` |
| Is this the *right* page/instance for the intent? | caller / verify |

**Explicit exclusions (do NOT model these as navigations):**

- **In-page transitions** — opening the quote/request-flow dialog and advancing its steps are DOM
  state changes, not navigations. They may not load a document and may not change the URL, so
  `navigate` would misreport them (`within_document`, or a false `none`). Handle them with
  `wait_settled` on the dialog's active-step readiness signal
  (`[data-test="request-flow-step--active"]`), never with `navigate`.
- **Gated pages** — a redirect to login/consent lands on a **different path**. In the durable model it
  does not match the fired target, so `navigate` resolves `none` (not `arrived`) after `firedTimeout`;
  the base/harness model reports `arrived` (any fresh document). Either way the caller re-runs
  `detect_page` on the landed document; recognising the destination as a gate is `detect_page`'s job.

## 6. Thumbtack application

| Tool | Transition | Uses |
|---|---|---|
| `start_search` / `M.go` | home or stale results → `/k/<slug>/near-me/` (hard) | `navigate` (document) |
| `view_service` | → pro `/…/service/<id>` (hard) | `navigate` (document) |
| search cursor / pagination | → cursor URL (hard) | `navigate` (document) |
| `open_quote` | pro → request-flow dialog (in-page overlay) | `wait_settled` (active-step) — NOT `navigate` |
| `answer_quote` | dialog step advance (in-page) | `wait_settled` (active-step) — NOT `navigate` |
| `resolve_zip` | network fetch, no navigation | — |

Composition (search): `navigate(/k/<slug>/)` → `arrived` → `detect_page` (category_results? gated?) →
`wait_settled` (pro-count quiescence → completed / no_results) → read.

All Thumbtack navigations are **same-origin**, so the `sessionStorage` marker (and the durable command
state) survive them.

## 7. Case matrix

| Transition | Kind | `navigate` handles | Note |
|---|---|---|---|
| home→results, **stale→different service**, results→pro, pagination | cross-doc, same-origin | Yes | fresh doc (timeOrigin > firedAt) |
| `/k/plumbing/`→`/k/plumbers/` (301) | cross-doc redirect | Durable: `none` (off-target); base: yes | slug changes the path → target gate misses; caller re-detects the landed `/k/plumbers/` |
| invalid slug `/k/yard-work/` (empty doc) | cross-doc | Yes (`arrived`) | emptiness → `wait_settled` → `no_results` |
| **same-URL reload** | cross-doc reload | Yes (via ①) | `location != from` would miss it — timeOrigin catches it |
| home nav (old no-op) | cross-doc | Yes | `location.assign` performs a real load |
| submit no-op / blocked nav | none | Yes (`none`) | clear beforeunload first (③) |
| already at `target` | none | caller guards via `detect_page` | avoids a redundant reload |
| login/consent **redirect** | cross-doc | Durable: `none` (off-target); base: `arrived` | different path; caller re-detects, `detect_page` classifies as gated |
| consent/geo **modal** (overlay) | overlay | `navigate` reports the document `arrived`; modal is dismissed downstream | separation OK |
| **quote dialog open** | **in-page overlay** | **No — out of scope** | `wait_settled` on active-step |
| **quote step advance** | **in-page** | **No — out of scope** | form-wizard readiness |

## 8. Cross-origin & limitations (honest)

- **Same-origin** (all Thumbtack navs): `sessionStorage` marker survives; full support.
- **Cross-origin**: the `window.name` mirror carries the marker across, so `fired`/`arrived` still
  resolve. But large **durable command state** cannot survive a cross-origin navigation in pure page
  JS — that needs the extension's `chrome.storage`. The narrow `navigate` facts remain valid.
- **Late JS redirect chains** (a JS redirect firing after resolution), **bfcache**, **prerender**: edge
  cases the web-standard base bounds but does not perfectly disambiguate; the §4 enhancements refine
  them when available.
- **Navigation API** (`window.navigation`) is Chromium-only and is deliberately **not** part of the
  base (kept cross-browser via `pagehide`/`performance`); it may be used as an enhancement.

## 9. Rollout

1. **Harness** (this repo, `tools/harness/cdp.mjs`): implement the base **without** the durable target
   gate (fresh baseline per call); CDP `loaderId` as an optional enhancement for precise redirect
   tracking. Uses a longer `firedTimeout` (~2500ms) to absorb CDP eval round-trip latency.
2. **SDK** (`axsdk-sdk-js`): implement the durable base in the `nav` capability — **timeOrigin freshness
   gated by a host-tolerant target match** (`luaNavigationMatches` = path-subsequence + query-subset),
   replacing path-prefix-as-arrival; expose `{fired, arrived, kind}` to Lua. A higher-level
   `nav.ensure(url, { ready, identity })` may compose `navigate` + a `wait_settled` on `ready` + an
   identity check — but `navigate` itself stays narrow.
3. **Thumbtack** (`thumbtack/scripts`): compose `navigate → detect_page → wait_settled → read`; move
   `open_quote` / `answer_quote` off `navigate` onto `wait_settled` (active-step).
