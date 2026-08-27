# AXSDK CDP Extension — CWS Product Readiness Review

Date: 2026-08-18  
Scope: public Chrome Web Store launch readiness, reviewed from end-user journeys rather than implementation inventory.

Re-measured 2026-08-26: the release strategy is now fixed — **R1 embeds every pack** and remote community
packs arrive in **R2**. The execution design lives in `CWS_RELEASE_DESIGN.md`, which also corrects four
numbers below (workspace is 32 assets / 26 modules, `_common/rpc` is 14 files, backend drift is 21 stale +
1 missing, and `build:cws` is a verification step, not a stripping profile) and one status claim outside
this file (the P0-3a domain gate is implemented but **not wired**, so that gate is still open).

## Verdict

**NO-GO for a public CWS submission.**

The CDP execution engine is mature: 835 extension tests pass, the real-browser extension QA is 64/64,
cart mutation is site-confirmed, checkout remains order-free, memory mechanics are 10/10, and cross-site
navigation is 6/6. Test-first work closed the missing-workspace build path, runtime module fallback,
post-navigation timeout misclassification, trace attribution gaps, false session claims, silent widget
delivery errors, shared consent/accessibility gaps, and the final manifest/ZIP verification mechanics.
Public submission remains blocked by consumer authentication/onboarding, the unresolved remote-logic policy
case, extension-specific privacy disclosures, broken advertised journeys, and a production backend registry
that currently fails the atomic release gate.

## Evidence baseline

### Shipping extension

- `bun test`: **813 pass / 0 fail**
- `bunx tsc --project tsconfig.json --noEmit`: pass
- `bun run qa:real`: **64/64**
- Manifest: MV3, version `0.1.0`, six permissions including `debugger`, all HTTP/HTTPS hosts
- `npm run build:cws`: generates and validates the 31-asset package graph at both package root and `dist/`
- Fresh-profile artifact smoke: resolves package sources in memory, leaves legacy source stores untouched, and forces remote site, flow, and Lua sources off
- `npm run release:cws`: read-only production-backend verification, deterministic ZIP construction, extraction,
  and manifest re-verification; currently refuses production revision 125 because 21 retained runtime modules
  are stale. The removed affiliate module is no longer missing evidence.
- `npm run test:cws:artifact`: exact extracted candidate archive, fresh profile, runtime release-id match, no
  harness store writes, and a real Amazon/eBay comparison with refinement, cart confirmation, and checkout stop

### Ten-site sweep, before and after the TDD repair

The baseline `npm run test:commerce:live:all` was **38/41** in 121.5 seconds: Walmart was
`rpc_unavailable`, 11st was falsely `unsearched`, and eBay/SSG contract checks skipped after 4,120-character
tool-output truncation.

The failures had three separate causes, each pinned RED before its fix:

- `nav.navigate` fired and landed on Walmart, then its 2-second acknowledgement timed out; the reader
  discarded the landed page.
- Flow-declared modules under `_common/scripts` were absent from the client module overlay, so runtime tools
  resolved stale backend copies even while browser `scriptIds` reported `stored-lua:`.
- Large candidate arrays were truncated; when a store's incomplete-total rows were folded out of the window,
  the runner mistook missing attribution for `unsearched`.

After target-aware navigation recovery, all-26 module closure, and one bounded outcome/sample per store, the
same shipping-CDP sweep is now **43/43 PASS in three consecutive clean sessions**, with 0 timeouts and 0
retries. All ten stores are attributed and every candidate-bearing store passes its normalized contract;
Naver Shopping's `access_denied` and Etsy's `no_relevant_offers` remain explicit classified outcomes.

### User journeys

| Journey | Result | User-level reading |
|---|---:|---|
| Exact comparison + cancel | 8/8 baseline | Known raw store-code path is fixed; full sweep now exposes no transport code |
| Broad product discovery | 18/18 | Grounded numbered choices are visible; unresolved listings stay unnumbered |
| Shopping search → pick → cart → checkout gate | 3/3 | Real Amazon cart contains the selected UOVO ASIN |
| Checkout idle / cross-site / mid-flow interrupt | 3/3 | Reaches login review only; no order placed |
| Memory save / update / reuse / persist / delete | 20/20 + focused edges | Consumer text only; raw state and wire fields stay internal |
| Cross-site navigation | 6/6 | Domains reached; Thumbtack quote searches still errored |
| Thumbtack quote | 7/7 | Candidate selection, collection, approval, cancellation, and pre-submit stop are proven |
| Coupang affiliate | Removed | HTTP 404 conversion path and its launch surface were deleted; guarded cart remains |
| BlueMoonSoft navigation | Reached | Correct page, but reply does not present requested content |

## P0 — submission blockers

### P0-1. The CWS package and exact-artifact gate are implemented; production backend evidence is stale

**Status: PARTIAL.**

The original package had no executable workspace source. TDD first pinned a missing-artifact failure;
the current root `npm run build:cws` command now:

1. generates `workspace-manifest.json` and `workspace-assets/<sha256>.txt`;
2. validates the canonical reference-graph digest, exact asset closure, byte counts, every SHA-256,
   and all 25 flow-declared runtime modules;
3. copies the manifest and assets as one package contract;
4. rebuilds `axsdk-core` and the CDP extension; and
5. validates every copied asset in `dist/` again.

The manifest contains no store envelopes and no source pathnames. On each MV3 service-worker lifetime
the extension fetches and verifies all package files in parallel, caches the resolved graph in that
realm, and sends it to each session worker before `AXSDK.init`. Core resolves flow, common Lua and
runtime-module layers from package memory. A new digest writes only that digest, source switches and
empty legacy caches; the same digest reselects local sources without clearing explicit development
overrides. Flow/Lua/module package source never enters `chrome.storage`. All remote site, flow and Lua
switches are forced off.

Only `_common/scripts` remains a browser Lua layer. Storefront site scripts are generator-only
`AX_SITE_CONFIGS` declarations whose runtime data is already in the generated `_common.62_rpc_sites`;
they add no command in the browser and are not shipped as runtime assets. The 25 flow-declared modules
are independent content-addressed files rather than one or more encoded module-store maps.

The release boundary remains executable and read-only. `npm run release:cws` binds extension files,
the package reference graph and asset evidence, all 25 runtime-module hashes, and the backend app,
revision and package hash into one release id. It builds a sorted fixed-timestamp ZIP in staging,
extracts those exact bytes and re-verifies before replacing any approved archive or sidecar. Missing,
stale, orphaned or tampered assets/modules fail before publication.

`npm run test:cws:artifact` proved C3 against a transient matching candidate: **7.93 MiB, 52 entries,
31 assets, 25 modules**. A fresh temporary Chrome profile loaded the extracted directory; the harness
wrote no workspace stores, script ownership was `axsdk-default-form-tools,packaged-lua:` with no
`stored-lua:*`, and package modules drove Amazon/eBay comparison, Amazon-only refinement,
stale-number-safe cancellation with no mutation, guarded cart confirmation, and checkout review with
no order. Measured stages: comparison 21.9s, refinement 7.6s, cancel 5.2s, cart 25.0s, checkout 48.3s.
The transient candidate is deleted and is not production release evidence.

This closes package-local delivery, not every remote-code policy question. The generic SDK's remote
loader implementation and development toggles still exist in the CWS artifact. The installer selects
local sources on install/restart, but a CWS-specific compile profile has not physically removed those
paths. Treat that removal—or written policy confirmation that unreachable, default-off paths suffice—
as a remaining P0-1 item alongside synchronized production backend evidence.

The production invocation correctly remains red. Backend revision 125 retains 21 stale runtime-module
copies, so `release:cws` refused before publishing a ZIP. The deleted affiliate module is no longer a
missing-module blocker. Closing this gate requires the explicitly approved backend release process, followed
by the same read-only verification and exact-archive smoke; the release command deliberately performs no push.

### P0-2. Consumer first-run authentication is still missing

**Status: PARTIAL.**

A new user still has no consumer sign-in. The only setup surface asks for API Key, App ID, and Base URL
alongside raw Lua/flow/memory editors.

The false-success paths are now closed. The options Start button and the toolbar/service-worker start path
both run one credential preflight before any tab is grouped. Missing credentials open Settings and do not
create session state or announce `Agent started`. The widget now reads the delivery acknowledgment and renders
backend/not-ready failures instead of dropping the message.

**Remaining release gate**

- Consumer sign-in/onboarding; no manual API key requirement
- Explicit readiness state before accepting the first request
- Retry, Settings, and Stop actions on startup/delivery failures
- Raw editors, recording, and remote-source switches behind a separate developer mode or build

### P0-3. Remote logic policy remains unresolved

The package includes Fengari and executes Lua in the session worker. Page operations reach the browser via
`chrome.debugger`, but the Lua interpreter itself is not a Debugger API execution context. CWS policy names
"building an interpreter to run complex commands fetched from a remote source" as a common violation and
limits the Debugger exemption to the code actually covered by that API.

The executable workspace is now packaged and fresh installs force remote sources off. That reduces accidental
remote execution but does not resolve whether later remote Lua/module delivery is acceptable under MV3.

**Release gate**

Obtain a written CWS answer for the exact architecture, or package all executable Lua/flow logic and let the
server return data/model decisions only. Do not submit while this interpretation is open.

Official policy: <https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements>

### P0-4. Extension-specific privacy and Limited Use disclosure is incomplete

The public AXSDK privacy policy is a general SaaS policy. It does not comprehensively describe extension
access to page content, forms, URLs, chat transcripts, contact memory, debug traces, `chrome.debugger`,
backend/model recipients, local retention, deletion, or human access. The options warning is not a substitute.

**Release gate**

- Extension-specific collection/use/share/retention table
- In-product disclosure matching the CWS listing
- Named recipients/categories for backend and model processing
- Chat/memory/debug retention and deletion controls
- Limited Use affirmative statement

Official policies:

- <https://developer.chrome.com/docs/webstore/program-policies/privacy>
- <https://developer.chrome.com/docs/webstore/program-policies/limited-use>

### P0-5. Shared consent and accessibility controls

**Status: CLOSED for the current shared operation surface.**

The original activity host—not the consent host—was `aria-hidden=true`, which hid Stop from assistive
technology. The consent prompt already used `role=alertdialog`, `aria-modal=true`, and initially focused the
safe “Don't” choice, but it lacked an accessible name, Escape handling, and focus restoration.

The activity UI and consent prompt are now present in the accessibility tree with explicit labels. Consent
restores focus and Escape refuses the action. The shared operation table also reads a form's actual submitter
label before `dom.submit_form`: a safe `Next` advances without training users to approve ordinary work, while
a risky `Place order` requires consent and a refusal prevents submission. Unlabelled submissions fail toward
the risky path. Unit tests cover both branches; real-browser QA covers consent semantics and the Stop control.

### P0-6. The atomic release mechanism is implemented; production backend state does not match it

**Status: PARTIAL.**

The client module overlay carries every one of the 26 declared sources, including the 12 scripts/ modules that
previously fell through to stale backend copies. A fresh profile rendered the current localized store status,
and the full sweep reached 43/43 in three consecutive sessions.

The release manifest now makes extension files, workspace stores, runtime modules, and the backend package one
verifiable identity. The service worker exposes that immutable release id through diagnostics, and the
exact-archive smoke refuses a running id that differs from the extracted manifest. Archive publication occurs
only after extraction and a second manifest verification.

The remaining blocker is operational state, not missing release code: the production backend's independently
pushed registry does not match the 26 local module hashes. `release:cws` reports that drift and publishes
nothing. The backend package must be released through its approved process first; only a subsequent green
production gate may produce the CWS submission ZIP.

## P1 — user journeys that must be fixed before public launch

### P1-1. Thumbtack quote journey

**Status: CLOSED.**

The shipping-CDP regression `npm run test:thumbtack:live` now passes **7/7** in **146.08 s** across
house cleaning (`94101`), handyman (`94103`), and lawn mowing (`94101`). It proves that a contact-only
second turn resumes the active house-cleaning request with its service, requirements, and ZIP intact;
all three searches reach classified live candidate windows; a numbered handyman selection resolves;
and both cancellation paths run no `open_quote` or send tool.

The measured failures were ours, not empty Thumbtack inventory. `nav.navigate` could raise
`rpc_timeout` after Chrome had already rendered 61 pros, and the flow mapped that channel error into
`no_results` prose blaming the valid ZIP. Search now fires once, establishes success from the canonical
landing page, and keeps invalid location, empty results, access refusal, and RPC/navigation failure
distinct. Collection questions come from a deterministic pausing presenter, so the next reply resumes
the same flow instead of starting over. The post-selection yes/no gate is deterministic too; live, a
literal `예` had previously been classified as `refine` by its model node.

The wizard drives safe intermediate steps and stops at Thumbtack's measured pre-contact boundary:
`Send a message to the pro … You don’t need to include contact info yet` with only `Skip`/`Back`.
Auto-clicking `Skip` had produced Thumbtack's request-flow error after 8–11 completed steps. The runtime
now leaves that earlier irreversible boundary untouched, exposes no `submit_quote` flow tool, and the
terminal states that no quote was sent and no professional was contacted. This is stricter than waiting
for a later Submit button.

### P1-2. Broad commerce discovery

**Status: CLOSED.**

The current shipping-CDP baseline no longer reproduced the older raw-field prose; it failed one step
earlier by asking for a number without displaying any options. The replacement surface is deterministic.
It shows only grounded manufacturer models as numbered lines with natural store provenance, and keeps real
listings whose model is unresolved in a separate **unnumbered** section. A number is now an executable
promise: every numbered option passes directly through `shopping_resolve_product_option` to identity lock;
low-confidence/no-model listings cannot consume option 1.

`npm run test:commerce:live:discovery` passes **18/18** in **67.16 s** on the shipping CDP extension:
the deterministic preflight retains `11st,walmart`; the visible list contains lockable options from both
stores without `identity_confidence`, `source_sites`, `source_refs`, JSON or sample prices; selecting `1`
locks identity, searches, screens and ranks; and cancellation performs no cart mutation. Compact
post-screening outcomes attributed both stores even when the large per-worker trace could parse only 11st,
which retired the runner's old trace-truncation false negative. A genuinely absent fan-out child is now
materialized as `unsearched`, so it cannot silently disappear from downstream screening or user outcomes.

### P1-3. Memory replies expose wire output

**Status: CLOSED.**

The shipping-CDP baseline stored and deleted the right values but rendered successful operations as raw
`memory_result`, `next`, `ok`, and `operation` fields. Memory results now pass through one deterministic
presenter and a data terminal, so the terminal model never receives the whole flow state. Set, update,
delete, list, exact read, topic search, empty results, and failures each have bounded Korean/English
consumer text; read values and search excerpts remain verbatim, while raw failure reasons remain internal.

The shipping-CDP response journey passed **20/20** in **240.80 s**, verifying store state around each
mutation, reset persistence, quote-contact recall, all three read surfaces, and wire-field refusal. Final
source was then re-proven live on the mutation and category edges: save and exact delete returned consumer
confirmations with the store empty afterward; a category no-match deleted nothing; category cancellation
preserved both candidates. The combined runner now retries one observed session-open/reset failure and
releases its session in `finally`.

The quote-reuse assertion stops at the deterministic memory boundary. Across eight clean-session
measurements the same complete six-field `recall_saved_contact` output reached `verify_request` three
times, an unrelated collection-model cancellation four times, and a contact re-ask once. Those downstream
quote outcomes are not evidence that memory failed to rehydrate.

### P1-4. Storefront failures expose transport codes

**Status: CLOSED for the measured sweep.**

The baseline exposed `월마트(walmart): rpc_unavailable`. Module closure restored the current localized
renderer, navigation recovery stopped discarding landed pages, and a dedicated post-screening outcome tool
eliminated attribution lost to trace truncation. The post-fix sweep is **43/43 in three consecutive clean
sessions** with no raw transport/schema code, timeouts, or retries.

### P1-5. Affiliate is removed from the launch surface

**Status: CLOSED.** A direct POST to `https://api.axsdk.ai/v1/affiliate/deeplink` still returned HTTP 404.
The Coupang program declaration, affiliate flow nodes/tool/state, `_common.74_rpc_affiliate`, and its unit
suite were deleted. An approved offer now reaches the existing guarded cart path directly. The exact CWS
artifact still proves cancellation without mutation, site-confirmed cart addition, and checkout without an
order.

The removal reduced declared runtime modules **26 → 25** and RPC modules **14 → 13**. In the legacy
persisted development path, the packed common slot fell from **258,643 B (98.7%)** to **249,710 B
(95.3%)** and the second slot is 188,544 B (71.9%). C3 no longer uses either slot: every runtime
module is one package asset, while stored chunking remains only for explicit development overrides.
The remaining hard module failure is a tool's resolved Lua closure exceeding the platform's ~64 KiB
execute limit.

The common flow source is still 251,083 B (**95.8%** of 256 KiB). Core `flowsStore.setFlows` and the
remote-site loader enforce that limit on persisted/remote development values, but C3 package assets
do not pass through either one. A regression builds a valid >256 KiB flow asset, verifying that the
producer and package format have no inherited store-value cap.

No 256 KiB final compiler check was found in inspected source. The remaining capacity experiment is
therefore precise: send a valid >256 KiB flow document from package assets directly to the compiler.
If it succeeds, C3 has already removed the production storage boundary; canonical YAML remains a useful
21,629 B transport/review reduction, not a launch prerequisite. Named/importable runtime actions or
document imports remain the long-term way to shrink the 135.5 KiB `flowTools` section by construction.

### P1-6. BlueMoonSoft navigates but does not answer

The correct DocuRay/news page opens, but the assistant only says it navigated. Present the requested content or
state clearly that the user should read the opened page.

### P1-7. Existing browser groups are no longer adopted implicitly

**Status: GREEN.** A tab reuses its group only when that group already owns a live AXSDK session. Starting
from a normal browser group moves the chosen tab into a new dedicated agent group; the other tabs remain
outside agent scope unless the user visibly drags them into that group.

### P1-8. Consumer UX is still a developer console

Use a consumer product name/description, explain the all-sites/debugger permissions, provide localized help and
troubleshooting, and move raw Lua/flow/widget editors out of the default options surface. Prepare CWS listing
copy, screenshots, permission rationales, support, and privacy links.

Single-purpose guidance: <https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines-faq>

## TDD execution order

Every item starts with a test that fails for the observed user contract, then the smallest production change,
then focused tests, the package suite, and finally a shipping-CDP smoke.

| Order | RED contract | GREEN completion | Status on 2026-08-18 |
|---:|---|---|---|
| 1 | clean CWS build accepts a missing/incomplete workspace | guarded build produces and validates both workspace copies | **GREEN** |
| 2 | missing credentials claim a tab group and report success | options and toolbar refuse before grouping | **GREEN**; consumer sign-in still open |
| 3 | widget command rejection is swallowed | rejected delivery renders a visible error | **GREEN** |
| 4 | Stop/consent controls fail accessibility assertions | labelled controls, safe focus, Escape, focus restoration | **GREEN** |
| 5 | `dom.submit_form` bypasses irreversible-action consent | submitter label uses the shared consent decision | **GREEN** |
| 6 | declared scripts resolve stale backend runtime modules | all 26 sources ride in bounded client module chunks | **GREEN** |
| 7 | fired navigation times out and discards its landed page | target postcondition recovers without re-firing | **GREEN** |
| 8 | truncated trace/folded rows become `unsearched` | bounded outcome and normalized sample per store | **GREEN** |
| 9 | singleton targeted runs measure the wrong flow | reject singleton query batches before Chrome | **GREEN** |
| 10 | release manifest accepts mismatched client/server digests | atomic release verification fails on drift | **GREEN**; production registry currently fails closed |
| 11 | Thumbtack loses collected fields/no-results cause | state continuity and classified outcome | **GREEN**; 7/7 shipping-CDP journey |
| 12 | discovery/memory errors render internal fields | localized consumer text contracts | **GREEN**; discovery and memory |
| 13 | existing tab group is adopted silently | scope confirmation or dedicated group | **GREEN**; dedicated agent group |
| 14 | package-only fresh profile cannot run the product | self-install plus exact extracted-archive real turn | **GREEN** |

## Launch decision rule

Public submission becomes `GO` only when every P0 gate is automated, the advertised P1 journeys pass through
the shipping CDP extension, the full ten-site sweep has no unclassified/wire-code outcome across repeated runs,
and the submitted ZIP can be reproduced from a clean checkout with the same release manifest that the backend
reports at runtime.

---

## Addendum 2026-08-22 — two measured findings that change P0-3

### P0-3a. A user's Site Access restriction does not restrict our page reach — measured

Set this extension's Site Access to *On click*, so `chrome.permissions.getAll()` answers
`origins: []`, then try each channel against a local page:

| Channel | With zero host permissions |
|---|---|
| `chrome.scripting.executeScript` | refused |
| `chrome.debugger.attach` + `Runtime.evaluate` | **succeeded and read the page text** |
| `chrome.userScripts.register` | registered, **did not inject** |

Our `dom.*`/`nav.*` ops reach the page through `chrome.debugger`, whose only stated requirement is the
`debugger` permission. So a user who deliberately narrows this extension to specific sites still has
every page reachable by the agent. That is a user-expectation violation on its own terms, separate
from the remote-code question, and it is a plausible review objection: the control the store surfaces
to the user does not bound what the extension does.

It also corrects an assumption worth naming: our manifest's `host_permissions` are for backend fetch
and the DNR rule. They were never the page boundary.

**Revised 2026-08-26 — this is NOT a release gate, and the earlier wording overstated it.** The install
warning Chrome shows for `debugger` is, in its own words, *"Access the page debugger backend."* and
*"Read and change all your data on all websites."*
(<https://developer.chrome.com/docs/extensions/reference/permissions-list>). So there is no narrower
promise for a domain allowlist to keep: the broadest possible disclosure is what the user accepted at
install, in Chrome's UI, before anything ran. Chrome also shows its debugging banner for the whole time a
session is attached and documents `DetachReason: "canceled_by_user"`, so the user holds a kill switch we
neither control nor can hide. And page ops are already bounded by session tab-group membership
(`dispatcher.ts:83-88`), a group the user creates and drags tabs into (P1-7).

What survives is narrower and worth stating plainly: a user who later narrows **Site Access** gets no
narrowing on this channel. That is a post-install control mismatch, not missing consent, and no policy
text we have read names it as a rejection reason.

**Cost of the allowlist, measured 2026-08-26.** `productSitesFromIndex` approves exact hostnames from
`index.md`, and **8 of the 19 hosts our own site data names would be refused** — every cart/checkout host
(`cart.ebay.com`, `cart.payments.ebay.com`, `cart.coupang.com`, `pay.ssg.com`, `cart.gmarket.co.kr`),
plus `item.gmarket.co.kr`, `buy.11st.co.kr` and the www-less `ebay.com`. Redirect landings are worse:
gmarket search lands on `browse.gmarket.co.kr`, which the index never names. Wiring the gate as built
would break the guarded cart and checkout review on five stores.

**If the control is to mean something, honour the user's own choice instead of inventing a list.** Check
`chrome.permissions.contains({ origins: [url] })` once per document and refuse when the user has narrowed
access: a default install (all sites granted) behaves exactly as today with no host list to maintain,
while a narrowed profile is honoured precisely. That is the whole objection, at a fraction of the cost,
and it needs one probe to confirm `contains` reflects the narrowing the way `getAll` does.

The domain-gate module and its 25 tests stay in the tree, unwired, for the case where a reviewer or the
One Stop answer (D7) asks for a product-scoped boundary.

### P0-3b. `chrome.userScripts` is the sanctioned channel, and it is now proven live

P0-3 has been waiting on a policy interpretation. The User Scripts API removes the need for one for
the dynamic part: its documented purpose is running "scripts provided by the user that cannot be
shipped as part of your extension package", which is exactly the community-script product. Proven on
Chrome 151 through the shipping CDP extension: a signed registry release is verified, cached,
installed disabled, enabled by the user, registered in a dedicated `USER_SCRIPT` world, handshakes on
an authenticated port, answers a read command from the real DOM, refuses an undeclared command, and
injects on neither an unapproved path nor after unregister. A mid-flight tampered artifact is refused
as `artifact_invalid`.

So the launch path for P0-3 is not a written answer about Fengari — it is **migration**: move
site-specific automation onto the community path and remove the interpreter and remote-Lua fetch from
the consumer build. That reframes Phases 8–9 of the implementation plan from cleanup to the actual
launch work.

**Unchanged:** the current artifact still ships Fengari (`fengari-*.js`, 227.83 kB in the
service-worker chunk) and still references `raw.githubusercontent.com` from three bundles. Nothing
here is closable until that is gone from the CWS profile.
