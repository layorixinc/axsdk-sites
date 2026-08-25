# AXSDK Community Script Implementation Plan

## 1. Purpose

Product charter:

> AXSDK installs, manages, and runs user-selected community web-automation scripts on websites explicitly authorized by the user.

This plan implements the architecture in `COMMUNITY_SCRIPT_ARCHITECTURE.md`. It is test-first, uses clean cutovers, and treats Chrome Web Store policy compliance as a product invariant rather than a final review task.

The target product is a consumer script manager. The target is not a developer console, a remotely programmable agent runtime, or a general interpreter distributed through the Chrome Web Store.

**The remaining work is §10, and its design is [`COMMUNITY_SCRIPT_LIVE_LOOP.md`](COMMUNITY_SCRIPT_LIVE_LOOP.md)** — the live loop in which a user designates a script, the extension loads it with the packaged flow that can reach it, and the AI answers from what the script read on the real page. Read that document before implementing §10; where the two differ, the live-loop design is the current one, because it is the one measured against this working tree.

## 2. Delivery strategy

The work proceeds through independently verifiable gates:

1. Freeze policy and product decisions that affect every contract. **(done)**
2. Prove the minimum `chrome.userScripts` runtime on the real target Chrome version. **(done)**
3. Build and verify immutable, signed community-script releases. **(done)**
4. Add trusted local storage, verification and atomic install state to the extension. **(done)**
5. Bound page ops to a domain allowlist the user can see, so the store's own site-access control means something.
6. Request exact hosts, register through `chrome.userScripts`, and reconcile across extension update.
7. Give the broker the vocabulary a script actually needs — commands, storage, declared-host fetch — with consent on every effect that leaves the page.
8. Reach the model through catalog context, read prerun, and one confirmed invocation.
9. Replace the developer options experience with a consumer installation and management UI.
10. Publish the registry from a signed, content-addressed origin.
11. Ship a small pilot set, then migrate existing behaviours one at a time.
12. Remove the interpreter, the remote loaders and the developer surfaces from the CWS build, and add consumer sign-in.
13. Verify the exact release artifact and only then perform release operations.

No phase is complete because scaffolding exists. Each phase ends with an observable contract and a failing test written before its implementation.

## 3. Fixed implementation decisions

The following decisions are inputs to the plan, not topics to reopen during implementation:

- Dynamic community code executes only through `chrome.userScripts` in `USER_SCRIPT` worlds.
- The registry distributes exact JavaScript artifacts. JavaScript may be authored directly or produced by deterministic Lua conversion before review; the resulting JavaScript bytes are the reviewed, signed, and distributed release.
- The initial CWS product accepts only registry-reviewed and registry-signed releases.
- Users explicitly approve every install, enable, update, host expansion, and capability expansion, and explicitly initiate disable or removal.
- The model may recommend a script but cannot install it, grant host access, enable it, or accept an update.
- Community scripts are registered only for explicitly approved hosts.
- The initial target is Chrome 138 or newer so onboarding can name and detect the extension-specific **Allow User Scripts** control.
- The extension exposes installed commands to the agent as catalog data and dispatches them through one fixed packaged `community.invoke` tool.
- V1 has no generic cross-origin network broker, arbitrary navigation broker, purchase capability, order placement, payment operation, or background mutation autorun.
- Mutation retries are not automatic. A disconnected page, changed document, timeout, or uncertain outcome is reported, not replayed.
- Developer-only Lua, raw-flow, recording, and arbitrary-import features are excluded from the CWS build at compile time, not hidden with CSS or runtime flags.
- Registry review and signatures are security boundaries because a user script can directly manipulate the authorized page DOM.

Any proposed change to these decisions requires a written architecture revision and corresponding test-plan revision before code changes.

## 4. Repository and ownership map

The paths below are proposed ownership boundaries. Exact filenames may follow an existing convention discovered during implementation, but no second convention should be introduced beside an equivalent existing one.

| Area | Repository | Primary responsibility |
|---|---|---|
| Community source and release metadata | `axsdk-sites` | Script source, command schemas, host declarations, disclosures, review records |
| Registry compiler and verifier | `axsdk-sites` | Canonical manifests, signatures, content-addressed assets, index, revocations |
| Extension manager | `axsdk-sdk-js/packages/axsdk-extension-cdp` | Install UI, permission requests, artifact verification, cache, state, reconciliation |
| User-script runtime | `axsdk-sdk-js/packages/axsdk-extension-cdp` | Bootstrap, world registration, authenticated port, invocation broker |
| Agent catalog/context | `axsdk-sdk-js/packages/axsdk-core` | Installed command descriptions visible to the planner/model |
| Fixed invocation tool | Platform app/backend plus core client contract | Dispatch to the extension without distributing per-script executable flows |
| Release orchestration | Existing extension and sites build tools | CWS profile, exact-artifact checks, release evidence |

Proposed `axsdk-sites` source layout:

```text
community/
  <script-id>/
    manifest.yaml
    src/index.js
    test/                         # only if the script needs script-local behavior tests
tools/community/
  build.mjs
  verify.mjs
  schema.mjs
  canonicalize.mjs
  sign.mjs
  forbidden-source.mjs
tools/community/*.test.mjs
dist/community/                  # generated, gitignored unless release policy says otherwise
  index.json
  revocations.json
  scripts/<id>/<version>/manifest.json
  assets/<sha256>.js
```

Proposed extension ownership:

```text
src/community/
  contracts.ts
  crypto.ts
  artifact-cache.ts
  store.ts
  registry-client.ts
  permissions.ts
  registrar.ts
  broker.ts
  consent.ts
  catalog.ts
  errors.ts
  community-script-bootstrap.ts
src/options/community/           # or the existing options component convention
src/background/service-worker.ts
src/shared/runtime-messages.ts
src/manifest.json
```

The implementation must first inspect current repository conventions and reuse them. These paths are boundaries, not authorization to create parallel frameworks.

## 5. Test-first rule

Every behavioral slice follows this sequence:

1. Add the smallest test that expresses the user-visible or security contract.
2. Run it and record the expected failure.
3. Implement the minimum complete behavior.
4. Run the focused test until green.
5. Run the relevant repository suite.
6. Exercise the real changed path: a browser scenario for UI/runtime changes, an exact generated artifact for build changes, or an end-to-end agent turn for integration changes.
7. Only after the smoke proof, perform cleanup: remove obsolete paths, update generated documentation, and run broader gates.

Tests must defend behavior, not source spelling. Static checks are appropriate only for contracts that are intrinsically static, such as manifest permissions, forbidden release imports, signature coverage, generated-file drift, or the absence of an executor from a CWS bundle.

## 6. Phase 0 — Policy and product gates

**Status:** Complete on 2026-08-18.

### 6.1 RED contract

`tools/community-release-policy.test.mjs` was added first and failed because the validator and checked-in policy did not exist. A second RED test proved that `build:cws` did not invoke the policy check. A third RED test proved that the design documents still carried obsolete policy-question gates.

### 6.2 Locked contract

[`community/release-policy.json`](community/release-policy.json) fixes:

- Chrome 138+, `chrome.userScripts`, and `USER_SCRIPT`;
- JavaScript as the execution and distribution language;
- JavaScript authored directly or produced by deterministic Lua conversion before review;
- no downloaded Lua or remote interpreter;
- explicit user approval for install, enable, every update, host expansion, and capability expansion;
- no automatic updates;
- registry review and registry signature;
- no arbitrary URL or unsigned-script import in the CWS build;
- allowed effects `read`, `page_write`, `external_send`, and `cart_mutation`;
- forbidden purchase, order-placement, and payment effects; and
- no model authority to manage scripts.

`tools/community-release-policy.mjs` validates a closed schema: an unknown decision, missing decision, weaker trust value, alternate executor, automatic approval, or added effect fails. `npm run check:community-policy` exposes the check, and `build:cws` runs it before building any release artifact.

### 6.3 Acceptance

- The focused policy suite passes.
- The checked-in policy has no undecided field.
- Converted Lua output is treated as the exact JavaScript release; Lua source is not remotely interpreted.
- Every lifecycle approval named by the contract is manual.
- The product charter is exact.
- Production registry publication remains separately gated on signing and reviewer ownership.

### 6.4 Rollback

No runtime behavior ships in this phase. Any change to the locked values requires a policy-file edit, a failing contract-test update, architecture review, and a new explicit product decision.

## 7. Phase 1 — Executable `chrome.userScripts` spike

**Status:** Complete on 2026-08-18 for the isolated execution mechanism.

This phase proves browser mechanics before registry, durable install state, UI, or agent integration adds complexity. Persistent startup/update reconciliation remains in Phases 3–4 because it requires the trusted local state those phases define. Full removal of the legacy interpreter from the CWS artifact remains in Phase 9.

### 7.1 RED tests

`src/community/user-scripts.test.ts` was added first in `axsdk-extension-cdp` and failed because the registration planner did not exist. A second RED test failed because the package exposed no real-browser smoke command.

The tests require:

1. one named `USER_SCRIPT` world for an exact approved match;
2. ordered sources: packaged bootstrap, generated release initialization, exact JavaScript artifact;
3. messaging-enabled world CSP;
4. missing registration creation, identical registration no-op, and atomic update;
5. refusal of broad hosts, malformed release identity, malformed digest, and empty artifact;
6. manifest `userScripts` permission and Chrome 138 minimum; and
7. a packaged bootstrap copied into the built extension.

### 7.2 Implementation

- `src/community/user-scripts.ts` validates a verified release and builds the exact Chrome registration.
- `src/community/community-script-bootstrap.js` exposes the frozen `AXSDK.register` surface, opens `runtime.connect({name:"axsdk-community-v1"})`, sends the release handshake, dispatches declared commands, and refuses an undeclared command.
- `src/manifest.json` declares `userScripts` and Chrome 138.
- `scripts/copy-static.mjs` copies the bootstrap as a package file.
- `scripts/community-user-scripts-smoke.ts` drives a local HTTP fixture through the real extension.
- `test:user-scripts:live` builds the extension before running the smoke.

The spike is read-only. It adds no install endpoint, model management path, cross-origin network broker, generic navigation broker, or persistent fixture registration.

### 7.3 Live acceptance

Measured on Chrome 151 with the harness profile:

- the disabled **Allow User Scripts** state made `chrome.userScripts` unavailable and produced an actionable refusal;
- after explicit enablement, the extension registered the fixture in a dedicated `USER_SCRIPT` world;
- the packaged bootstrap authenticated the release token through `runtime.onUserScriptConnect`;
- an undeclared command returned `command_unavailable`;
- `read_heading` returned the real fixture `<h1>`;
- an unapproved path did not inject;
- unregistering prevented a later matching page from injecting; and
- the smoke removed the registration, world configuration, and fixture tabs afterward.

Focused result: 6 unit tests pass. Live result: `USER SCRIPTS SMOKE PASS`.

### 7.4 Deferred lifecycle proof

Browser restart and extension-update restoration cannot be honest before an installed release and verified artifact cache exist. Phases 3–4 must add that state, wire reconciliation at worker startup and `runtime.onInstalled(reason="update")`, and prove both in a real browser. Phase 9 must prove the exact CWS artifact contains no legacy remote-code executor.

The spike must never fall back to Lua, debugger evaluation, `chrome.scripting`, or a sandbox interpreter when User Scripts is disabled.

## 8. Phase 2 — Community registry build in `axsdk-sites`

**Status:** The signed compiler core and fixture verification command are complete as of 2026-08-18. Twelve focused tests cover canonicalization, exact JavaScript bytes, Ed25519 signatures, verify-before-inspect ordering, strict published schemas, command registration, forbidden loaders, size limits, deterministic output, signed index/revocations, and tampering. `build:cws` now runs both policy and registry checks before packaging.

Production publication is not enabled: signing/reviewer ownership, a production key loader, monotonic non-empty revocation updates, registry output writing, and hosting remain gated. The checked command uses a derived public fixture key only and writes no registry artifact.

### 8.1 RED unit and contract tests

Write tests before the registry compiler. Cover:

- valid release compiles to one canonical manifest and one content-addressed JavaScript asset;
- malformed ids, versions, hosts, command names, schemas, effect declarations, or disclosures fail;
- `matches` are normalized and limited to allowed HTTP(S) patterns;
- command ids are unique within a release;
- version plus digest is immutable;
- index entries point to the exact manifest URL and digest;
- artifact byte count and SHA-256 are verified;
- manifest signatures cover the canonical JSON payload, artifact digest, and release identity;
- key id and signature algorithm are explicit;
- an unknown, expired, or revoked signing key fails;
- revocations are signed and monotonic;
- duplicate content is stored once by digest;
- a release cannot reference an asset outside the derived content-addressed path;
- unreferenced generated assets fail the clean-build check;
- generated output is deterministic across consecutive builds;
- source maps, if produced for development, are not referenced by CWS releases unless reviewed and content-addressed;
- forbidden executable-loading constructs fail review: `eval`, `new Function`, dynamic import used as a code loader, script-tag injection, WebAssembly compilation, secondary source download, or a generic command interpreter;
- commands present in code but absent from the manifest fail build-time registration validation;
- manifest commands not registered by the artifact fail a fixture execution check;
- unsigned or reviewer-unattested releases do not enter the production index.

Static source checks are defense in depth, not a JavaScript security proof. Registry review remains mandatory.

### 8.2 Compiler implementation

Implement the registry compiler with these outputs:

- `/v1/community/index.json` equivalent artifact;
- immutable per-release canonical manifests;
- content-addressed JavaScript assets;
- signed revocation list;
- build report with release ids, versions, hosts, commands, effects, bytes, digests, reviewer, and key id.

Use RFC 8785 JSON Canonicalization Scheme or a verified equivalent implementation for signed JSON. Sign an explicit payload version. Keep private keys outside the repository and outside generated artifacts. Local tests use fixture keys only.

### 8.3 Script review contract

A production release requires:

- publisher identity;
- reviewer identity distinct from an untrusted community submitter;
- human-readable source URL and license;
- exact hosts;
- commands and input schemas;
- effects and data disclosures;
- no hidden autorun behavior;
- no mutation outside a declared command;
- no secondary code loading;
- deterministic generated artifact;
- signature over the exact distributed bytes.

### 8.4 Acceptance

- Clean build produces byte-identical output on repeated runs except explicitly excluded build timestamps; signed payloads must not contain nondeterministic timestamps.
- Tampering with one asset byte, manifest field, index pointer, signature, or revocation entry causes verification to fail.
- The generated index includes only reviewed and signed releases.
- Public-safety scan finds no secret key, token, private endpoint, PII, or unpublished customer data.

### 8.5 Rollback

Registry publication is append-only by release identity. A bad release is revoked and removed from the current index; immutable historical bytes are never silently replaced under the same version or digest.

## 9. Phase 3 — Extension contracts, verification, and local state

**Status:** Complete on 2026-08-21 for verification, the verified artifact cache, and trusted local state. Registration wiring into the service worker, host-permission requests, the broker, and consent remain Phase 4.

Delivered in `axsdk-extension-cdp/src/community/`:

- `registry.ts` — canonical JSON, packaged Ed25519 trust roots via WebCrypto, signed index/manifest/revocation verification, paths derived from signed identity and digest, document and artifact size ceilings, Chrome and runtime compatibility floors, and classified failures (`registry_unreachable`, `document_invalid`, `document_too_large`, `untrusted_signature`, `not_indexed`, `incompatible_runtime`, `artifact_unavailable`, `artifact_invalid`, `revoked`).
- `artifact-cache.ts` — content-addressed cache that re-verifies on read, drops a corrupted entry, and prunes only digests no installed release names.
- `store.ts` — versioned `axsdk:community-scripts` state holding what the user approved, disabled-by-default installs, exact-approval matching, capability-token rotation, revocation handling, strict parsing, and a token-free consumer summary. Artifact code is never stored here.
- `installer.ts` — two-step preview/commit composition; bytes are cached before the state entry exists, and a failed state write leaves the previous release installed and enabled.

Cross-repository agreement is pinned by a committed test vector: `axsdk-sites` emits `src/community/testdata/registry-vector.json` with `node tools/community-registry.mjs --emit-vector`, and `check:flows` fails if the committed bytes are not what the generator produces now. The extension verifies those exact bytes, so a canonicalization or signature divergence between the two repositories is a red test rather than a field failure.

Live evidence, real Chrome 151 and a local HTTP registry serving the signed vector: `test:user-scripts:live` resolves and verifies the release, refuses a mid-flight tampered artifact as `artifact_invalid`, installs it disabled, produces no registration until it is enabled, registers from cached bytes only, answers `read_heading` with the real page heading, refuses an inherited command name, and injects on neither an unapproved path nor after unregister. The tamper assertion was mutation-checked: with the tamper pass disabled the smoke fails.

Focused results: 47 community unit tests, 864 extension tests, typecheck clean, `check:flows` 179.

Still open here: an IndexedDB-backed `CommunityArtifactStore` (the interface and its faithful in-memory implementation exist; the browser-backed one lands with its Phase 4 consumer), telemetry field tests once a telemetry surface exists, and permission-failure rollback, which needs the Phase 4 permission request.

### 9.1 RED tests

Add focused extension tests for:

- strict manifest/index/revocation parsing with unknown critical fields rejected;
- signature verification against packaged trust roots;
- digest and byte-length verification after download and after cache read;
- URL derivation that refuses caller-supplied arbitrary artifact locations;
- media type and size ceilings;
- compatibility checks for runtime and Chrome version;
- install state transitions;
- disabled-by-default state after download;
- immutable installed release identity;
- atomic replacement during update;
- prior release remains installed if update download, signature, hash, cache, permission, or registration fails;
- revoked release is disabled and unregistered;
- offline startup uses only a previously verified cached release;
- offline startup never treats an unreachable revocation feed as proof that a release is current;
- token rotation on update, reinstall, revocation, and host/capability expansion;
- artifact eviction never removes an active installed digest;
- no code, command arguments, command results, page content, forms, or capability tokens enter telemetry.

### 9.2 Implementation

Implement or extend the existing storage convention with one versioned store, proposed key:

```text
chrome.storage.local["axsdk:community-scripts"]
```

Persist only trusted metadata needed to reconcile installations:

- script id and installed version;
- manifest digest and artifact digest;
- approved hosts and capabilities;
- enabled state;
- registration id and world id;
- install/update decision timestamps;
- last successful verification and registration state;
- revocation state;
- non-secret user preferences.

Store verified manifest and artifact bytes in IndexedDB keyed by digest. Store capability tokens only where needed for the active runtime and never in logs or exported settings.

Registry fetch sequence:

1. Fetch index or exact manifest derived from a trusted registry base.
2. Parse with size ceilings.
3. Verify release identity and trusted signature.
4. Derive artifact URL from the verified digest.
5. Fetch bytes.
6. Verify media type, byte length, and SHA-256.
7. Scan compatibility and prohibited metadata.
8. Write artifact and manifest to a temporary cache record.
9. Commit installed metadata atomically only after all checks succeed.

### 9.3 Acceptance

- Unit tests prove tamper refusal and atomic rollback.
- A browser smoke installs a fixture release, restarts Chrome offline, and runs only the verified cached bytes.
- Clearing or corrupting the cache results in `artifact_unavailable` or `artifact_invalid`, never a network-executed fallback.
- No community artifact is written into `chrome.storage.local` as executable source.

### 9.4 Rollback

A failed new release leaves the old release and registration intact. A trust-root emergency disables affected releases through a packaged key revocation or signed registry revocation, depending on the incident.

## 10. Remaining work — ordered execution plan

Revised 2026-08-22. The design for everything below is
[`COMMUNITY_SCRIPT_LIVE_LOOP.md`](COMMUNITY_SCRIPT_LIVE_LOOP.md); this section is the work queue and
does not restate it. Ordering is by **what unblocks a CWS submission**, not by architectural tidiness,
and the blocker ids are those of
[`CWS_PRODUCT_READINESS_REVIEW.md`](CWS_PRODUCT_READINESS_REVIEW.md).

Every phase: RED first, minimum complete behaviour, focused suite, then the real thing running.
Cleanup only after the smoke proves the request works.

| # | Phase | Unblocks |
|---|---|---|
| 4 | Domain gate on ops | P0-3a — **done 2026-08-22** |
| 5 | Permissions and registrar | per-release host scoping; survives extension update — **done 2026-08-22** |
| 6 | Broker, script capabilities, consent | the `GM_*` equivalent; mutation safety — **broker, `storage.*`, `net.fetch` done 2026-08-22**; mediated `memory` remains |
| 7 | Agent channels | the live loop the product is for — **catalog + prerun done 2026-08-22**; packaged flow and confirm widget remain |
| 8 | Consumer UI and onboarding | P1-8 — the options page is a developer console |
| 9 | Registry publication and the Tier 2 validator | signing ownership, hosting, script-shipped flows |
| 10 | Pilots | authoring and review cost, measured |
| 11 | Migration of existing automation | prerequisite for 12 |
| 12 | CWS profile cutover and consumer auth | P0-1 remote logic, P0-2 auth, P0-4 privacy |
| 13 | Release | submission |

### Phase 4 — Domain gate on ops

**Status:** Complete on 2026-08-22.

`src/ops/domain-gate.ts` + `src/ops/domain-gate.test.ts` (25 tests), wired at the dispatcher's single
construction site in `background/service-worker.ts`.

**What shipped**

- `matchPatternMatches` — scheme, host with optional `*.`, path glob; the port never decides, matching
  the live user-script measurement. `<all_urls>`, `*://*/*`, `http://*/*`, `https://*/*` are never a
  match and are dropped when an allowlist is built.
- `domainAllowlistFor` — only releases with a **live port on that document** contribute, plus the
  product's own sites. Chrome's own `matches` enforcement is the attribution oracle, so no frame
  provenance is needed.
- `productSitesFromIndex` — the product's sites, read from the packaged index's markdown links, as
  **hosts** rather than the one page each link happens to name.
- `createDebuggerLocationReader` — one plain `Runtime.evaluate` of `location.href`. Deliberately not
  `CdpPageApi.locationHref`, which routes through the injected bundle: injecting into a page the gate
  has not approved is the one thing the check must not do.
- `createDomainGate` — fails closed on an unreadable address and on an empty allowlist; one decision
  per tab, so the check costs one read per document rather than one per op.
- `createNavigationInvalidatedDomainGate` — drops a tab's decision on a **main-frame**
  `Page.frameNavigated`; a subframe navigation buys a read and changes no answer, so it is ignored.
- `createCdpDispatcher` refuses before the op table is built, so an unapproved page is never even
  probed for the bundle.

**Live acceptance, measured on the shipping extension**

| Run | Session tab | Result |
|---|---|---|
| gate on | `https://www.amazon.com/` (indexed) | op answered the URL |
| gate on | `https://www.ebay.com/` (indexed) | op answered the URL |
| gate on | `https://axsdk.ai/ko` (**not** indexed) | op refused |
| gate **off** (wiring removed, rebuilt) | `https://axsdk.ai/ko` | op answered the URL |

The last row is the one that matters: the A/B is what proves the refusal was the gate and not the
harness. Correct behaviour, too — `axsdk.ai` is not a site this product automates.

**Mutation-checked, four ways.** Removing the dispatcher's gate branch fails 2 tests; removing the
per-document cache fails 5; failing open on an unreadable address fails 1; dropping the subframe
filter fails 1.

**Two follow-ups, recorded rather than left implicit**

1. **The refusal reaches the harness as `null`, not as a named reason.** The dispatcher answers
   `{ ok: false, error: 'domain_not_approved', detail }`; the harness's `eval` path flattens it. A
   developer sees nothing to act on. Fix where the reason is dropped, not by widening the gate.
2. **The plan's original RED said the check and the op share one `executionContextId`.** That holds
   for subframes, which `cdp/frames.ts` already evaluates against a context id, but the main-tab path
   evaluates with no context and probes for the bundle instead. So the gate is a per-document decision
   refreshed on navigation events, with a bounded residual race of one in-flight op. Closing it fully
   means moving the main path onto an isolated world — a larger change than this phase, and stated in
   `domain-gate.ts` rather than hidden.

**Rollback.** The gate is a refusal, not a rewrite; a wrong allowlist degrades to refusals, never to
silent action on an unapproved page. Removing `domainGate` from the one construction site restores the
previous behaviour exactly, which is how the A/B above was run.

### Phase 5 — Permissions and registrar

**Status:** Complete on 2026-08-22, except the `optional_host_permissions` move, which is carried into
Phase 12 with the rest of the manifest narrowing.

`src/community/permissions.ts` (7 tests), `src/community/registrar.ts` (15 tests),
`src/community/artifact-store-idb.ts` (6 tests), wired in `background/service-worker.ts`.

**What shipped**

- `originPatternsFor` — host-shaped origins derived from a release's own matches. A broad pattern is
  refused rather than narrowed, and duplicates collapse so one prompt covers one release.
- `releasableOrigins` / `releaseCommunityHosts` — removing a script never takes away a host another
  installed release still needs.
- `originGranted` — **coverage, not equality** (see the defect below).
- `desiredCommunityRegistrations` — a pure function; a release is desired only when *every* one of its
  hosts is granted, because partial permission is not partial registration.
- `reconcileCommunityRegistrations` — creates, updates in place keeping the registration id, and
  removes orphans by our id prefix only. Nothing to do sends nothing, so no world is configured for a
  release that is not being registered.
- `installCommunityReconciliation` — reconciles at worker start, on `onInstalled` install/update, and
  on any change to the installed state.
- `createIndexedDbArtifactStore` — the Phase 3 cache interface over IndexedDB, so a rebuild after a
  restart runs only bytes that were verified before. The digest is validated before the database is
  opened.

**Two defects the live run found, neither visible to the first cut of the tests**

1. **Granted origins are patterns, and I compared them by equality.** `chrome.permissions.getAll()`
   answers `http://*/*` and `https://*/*` for this extension, while a release needs
   `http://127.0.0.1/*`. Set membership said no, so **every release was unregistrable** — the user had
   granted far more than the release needed and the registrar refused. `originGranted` now asks whether
   any granted pattern *covers* the needed origin. Refusing a broad *declaration by a release* is a
   different rule and stays in the allowlist derivation.
2. **Nothing reconciled when the installed state changed.** The worker reconciled at startup and on
   install/update only, so a state write after startup — which is exactly what installing, enabling or
   removing a script is — left registrations stale until something unrelated woke the path. A
   `chrome.storage.onChanged` trigger closes it, and it is what makes the live proof deterministic.

**Live acceptance, measured on the shipping extension** (`npm run test:registrar:live`):

```text
COMMUNITY REGISTRAR SMOKE PASS
  release       fixture.read-page@1.0.0
  granted       http://*/*, https://*/*
  before state write []
  after reconcile ["axsdk-community-fixture-read-page"]  <- rebuilt by the extension
  injected      "AXSDK registrar fixture"
  after removal []
```

The registration is built by the worker's own reconciliation from trusted state plus the IndexedDB
cache — this script only writes the state — and the rebuilt registration is then proven to inject and
answer from the real DOM.

**Mutation-checked, five ways.** Skipping the `onInstalled` rebuild fails 2 tests; accepting partial
permission fails 1; including foreign registrations in orphan removal fails 1; dropping origin dedupe
fails 1; removing the store's digest check fails 1. Removing the state-change trigger fails 1, and so
does dropping its key/area filter.

**Two measured harness facts worth keeping**

1. **`chrome.runtime.reload()` leaves this unpacked profile's extension unavailable** — its options
   page never comes back, so a runtime reload cannot be a step in an automated proof. This also
   explains a stretch of "every call reinstalls the extension" churn earlier in the day.
2. **An MV3 worker idles out and its CDP target disappears with it**, so `Target.getTargets` finding no
   `service_worker` is normal. The first version of this smoke looked once, found nothing, skipped the
   restart, and then blamed the registrar for not rebuilding.

**Still open here:** the `optional_host_permissions` move (Phase 12), and a UI that performs the
install rather than a script seeding the state (Phase 8).

### Phase 6 — Broker, script capabilities, consent

**Status:** Broker, argument validation, the consent gate, `storage.*` and `net.fetch` complete on
2026-08-22. The mediated `memory` disclosure is the remaining slice, described below.

`src/community/broker.ts` (20 tests), `src/community/arguments.ts` (11),
`src/community/invoke-message.ts` (6), wired in `background/service-worker.ts`.

**What shipped**

- **Handshake binding.** A port is bound only when protocol, registration id, capability token,
  command digest, enabled and non-revoked state, and a full tab/frame/document identity all agree
  with trusted state. A mismatch disconnects. A second connection for the same release replaces the
  first. A dropped port settles everything in flight as `document_changed`.
- **`validateCommandArguments`** — a validator for the schema subset the registry accepts, refusing
  anything outside it rather than approximating it. Own-property checks only, so a `__proto__` key
  from `JSON.parse` is an unexpected argument rather than a prototype; the accepted value is a fresh
  null-prototype object; the 32 KiB ceiling is checked before any value is read.
- **`parseCommunityInvoke`** — the one message that reaches the broker, shape-closed: exactly four
  fields, an extra one refused. No artifact URL, no code, no module name, no host, no permission.
- **Effects and consent.** `read` runs; an effect the install never approved is `effect_not_approved`;
  a mutating command that declares no confirmation is `consent_unavailable` rather than run quietly;
  `external_send` and `cart_mutation` ask **every invocation**, and community consent deliberately
  does not go through `askUserToAllow`, whose `confirmRiskyActions` and word-matching early returns
  would silently skip a prompt the contract requires.
- **No replay.** A timeout answers once; a document lost mid-flight answers `document_changed`; a
  document lost while the user was deciding refuses instead of dispatching.
- `inputSchema` now travels registry → installed state, because dispatch happens long after the
  manifest was read and validating against anything else is validating against a guess.

**One defect the live run found.** The sender guard refused `sender.tab !== undefined` to keep pages
out — but **an extension page opened in a tab also carries `sender.tab`**, so it blocked the real
caller too. The discriminator is the sender URL: a content script reports the page's, an extension
page reports ours.

**Live acceptance** (`npm run test:broker:live`), every call through the extension's own broker:

```text
COMMUNITY BROKER SMOKE PASS
  registered      ["axsdk-community-fixture-read-page"]
  read_heading    {"heading":"AXSDK broker fixture"}
  read_nothing    command_undeclared
  toString        refused at the message boundary
  bad arguments   arguments_invalid: unexpected argument: nope
  stale version   version_mismatch
  unconfirmed     consent_unavailable
  unapproved      effect_not_approved
```

`toString` is refused one layer earlier than expected — it never parses as a command name — so both
layers are asserted rather than assuming the broker sees it.

**Mutation-checked, five ways.** Allowing an unconfirmed mutation, ignoring a consent refusal,
accepting an undeclared command, not settling in-flight requests on a dropped port, and allowing an
unapproved effect each turn a test red.

**Not proven live, and why.** The answered-prompt paths — dispatch on Allow, `consent_denied` on
Cancel — need the consent UI Phase 8 builds. The worker's consent window is 60s, longer than a CDP
call, so waiting for an unanswered prompt is not usable as a step; and approving through today's
activity overlay would be testing a surface that is not the community consent surface. Both paths are
unit-tested and mutation-checked meanwhile.

**`storage.*` — complete 2026-08-22.**

`src/community/script-storage.ts` (10 tests) plus 5 broker tests and an IndexedDB namespace backend.

- **One record per script holds that script's whole namespace.** That shape *is* the isolation: a
  script addresses its own record, so a cross-script read is not prevented by a check that could be
  forgotten — there is no key to ask for. It also makes the quota exact, because the namespace's
  encoded length is what the script is using.
- **Part of the broker's fixed vocabulary, not a declared command**, so a release cannot opt out of
  the namespace or the 64 KiB quota by declaring its own `storage` command. The script id comes from
  the bound connection; a `scriptId` in the request is ignored.
- A request before the handshake is ignored rather than served — there is no script to scope it to.
- A replacement is measured with the old value already gone, so swapping a large value for a small
  one is a shrink rather than a doubling.
- A namespace the backend cannot parse reads as empty and is repaired by the next write. Failing
  forever would strand a script on one bad record; falling back to another namespace is the one thing
  this must never do.
- Its own IndexedDB database rather than a second store beside the artifacts: adding a store to an
  existing database means a version bump and an upgrade path for every profile that already has one.

**A round trip cannot validate a value, so it walks it.** `JSON.stringify({ fn() {} })` is `'{}'`,
which parses and re-encodes identically — the check passes while the script's field has already been
silently dropped. Losing data between `set` and `get` is worse than refusing the write.

**Live acceptance** — the case page `localStorage` cannot serve, because the site can clear it:

```text
  storage         wrote, reloaded the page, read back {"note":"kept-across-nav","keys":["note"]}
```

The fixture release now declares `remember` and `recall`, so the signed artifact itself exercises
`AXSDK.storage`; the vector was regenerated and the cross-repository drift gate re-pinned.

**Mutation-checked, five ways.** Sharing one namespace across scripts fails 5 tests; removing the
quota, accepting JSON-unsafe values, taking the script id from the request, and serving a
pre-handshake request each fail 1.

**One process note, and it is the third time today.** The first live run of this slice hung for 15s
per call and looked like a broker defect; it was a **stale artifact** — the source had the storage
wiring and `dist` did not. A live failure immediately after a source change is a stale build until
proven otherwise.

**`net.fetch` — complete 2026-08-22.**

`src/community/net-fetch.ts` (14 tests) plus 6 broker tests, with declared hosts carried
registry → installed state and shown in the approval and the consumer summary.

- **Two conditions, and they fail differently.** A declaration is not a grant, and a grant is not a
  declaration: a release may reach a host only when it declared it *and* the user approved that
  origin. `net_host_undeclared` and `net_host_not_approved` are separate answers because they need
  separate fixes.
- **The script passes a URL; the broker decides.** A `networkHosts` in the request is ignored — the
  allowlist is the release's, reviewed and approved, not something a call can widen.
- `https` only, no port, no credentials in the URL. `*.example.com` covers the bare domain and its
  subdomains; `*`, `*.` and `*.com` are refused, so a declaration cannot widen into everything.
- **`credentials: 'omit'`, and forbidden headers refused rather than stripped.** This request leaves
  the extension, not the page, so sending the user's cookies would spend a session the script was
  never given; a script that believes it authenticated and did not is worse off than one told it
  cannot. `cookie`, `authorization`, `host`, `origin`, `referer` and friends are refusals.
- GET and POST only; a body rides only on POST; request and response bodies are both bounded at
  128 KiB.
- **A non-2xx is the server answering, not the fetch failing**, so a 404 comes back as
  `{ ok: true, status: 404 }`. A transport failure is `net_failed`, never an empty body.
- Absent from the manifest means no egress. A release that declares no host reaches none.

**Live acceptance:**

```text
  net declared    HTTP 200 from api.axsdk.ai
  net undeclared  AXSDK net refused: net_host_undeclared
```

Both from a real page, through the extension's own broker and a real cross-origin request.

**Mutation-checked, five ways.** Allowing an undeclared host fails 6 tests; allowing an unapproved
one fails 2; sending credentials, permitting a forbidden header, and taking the host list from the
request each fail 1.

**The process finding that cost the most today, and it is now understood.** Three separate live
failures looked like product defects and were all the same thing: **`Extensions.loadUnpacked` on an
already-loaded unpacked extension does not replace the running service worker.** `ensureExtension`
reports `installed: true`, the fingerprint updates, and Chrome keeps executing the previous bundle.
The decisive probe was writing state *without* the new field — the worker found the script — and then
with it, where it answered `script_not_installed`: a parser that did not know the key. The fix is a
real reload: enable developer mode on `chrome://extensions` and click `#dev-reload-button`, both
reachable only through the shadow DOM. Restarting Chrome is **not** sufficient, and neither is
`chrome.runtime.reload()`, which leaves the extension unavailable (Phase 5). Do this after every
build before trusting a live result.

**Remaining slice of this phase**

**`memory` is a mediated disclosure, not a grant.** One prompt per value, naming the key, the value
about to be handed over and the destination, offering *use this value* / *type a different one* /
*cancel*. Writes get their own prompt. Nothing is granted, so nothing can be re-invoked silently.

**Acceptance for that slice.** Live: a mediated `memory` disclosure that hands over one value and
grants nothing.

### Phase 7 — Agent channels

**Status:** Channels A and B complete on 2026-08-22, and the packaged flow that reads them is live.
The confirm widget — a model proposing an argument-taking or mutating command, and the user approving
it — is the remaining slice, described below.

**The product's purpose, proven on the shipped path.** With one release installed and enabled for a
fixture page, seeded exactly as the Phase 8 install UI will seed it:

```text
$ AXSDK_HARNESS_URL=http://127.0.0.1:57310/fixture npm run cdp -- send '이 페이지 뭐라고 쓰여 있어?'
이 페이지에는 **"AXSDK community fixture page"** 라고 쓰여 있습니다. (read_heading 스크립트 사용)

$ … npm run cdp -- send 'which community scripts can I use here?'
- **read_heading** – reads the visible H1 text from the open fixture page.
- **remember** – stores a short note in the script's own extension-backed storage (needs arguments).
- **recall** – reads back the note the script stored.
- **ping_api** – fetches the declared health endpoint.
- **probe_forbidden** – attempts an undeclared host and reports the refusal.
```

The heading is a value only the community script could supply, and the model attributed it to the
command that read it. **That also closes the join the previous slice left open**: core did carry the
block into the turn's contexts, and the reply is the evidence.

The flow is a single terminal node selecting `contexts.community`. It invokes nothing — the readings
are already in the block — and its prompt forbids the two failures that matter: claiming a command ran
when it did not, and guessing what the page says when the block is absent. `check:flows` pins that the
context is declared, that the route entry names a real node, that some node selects the context (a
declared-but-unread context is a catalog that reaches no model), and that the flow grants no
`community.*` op the platform does not publish.

**Two process notes.** The delivery smoke was deleted rather than fixed: it reimplemented the turn
with **invented wire message names** and never produced a chat, which is why `npm run cdp -- send` is
the proof instead — it is the shipped path and needed no new code. And `community:seed` now writes
what the install UI will write, so the live turn is reproducible in one command.

Delivery, added after the catalog itself: `community` is a third `BackendContextKey` in
`axsdk-core`, host-supplied because building it is asynchronous and per-page. It rides with **each
message** and is deliberately absent from the session contexts, where a catalog captured at session
open would be stale the moment the user navigated. An empty block is omitted rather than sent: an
empty key would tell the model there are scripts here and nothing to say about them, while `env` and
`sites` stay always-sent because empty is meaningful for them.

The session worker pulls it before every `AXSDK.sendMessage` over the existing `callExtension`
bridge, and the service worker answers from **the session's own tab** — the caller cannot choose
which page's catalog it gets, which is the difference between this and the options-page message.
A failed pull clears the context rather than leaving the previous page's block in place.

`npm run test:context:live` starts a session on the fixture tab, sends a turn through the shipped
path, and reads back the block for that page: catalog, readings from the live DOM, no token, no
digest. **What it does not prove, and says so in its own header:** that core carried the block into
that turn's `contexts`. Both halves are unit-tested and the join is typechecked; asserting it needs
a probe inside the offscreen worker's realm, which belongs with the slice that adds the flow reading
the context.

`src/community/catalog.ts` (23 tests), `parseCommunityContextRequest` in `invoke-message.ts`, and
`communityContextFor` in the worker behind one `axsdk.cdp.community-context` message.

- **Only what is live here**, and only what the broker would accept: enabled, not revoked, matching
  this page, and — after a live finding — only commands whose effect the install actually approved.
- **Nothing but words.** No capability token, no digest, no source URL, no artifact. A prompt is the
  least private place in the product.
- **A budget with the truncation said out loud**, because a silently shortened list reads as complete.
- **Prerun is `read`, argument-free, capped at three, in a stable order.** A failure becomes a line in
  the block rather than an absence the model would reason around — proven live, where a refused fetch
  rendered as `could not read: script_error`.

**Two defects the live block found, neither visible to the first cut of the tests**

1. **Commands the install never approved were offered.** The catalog listed `unapproved_send`
   (`external_send`, never approved), so the model could propose something the broker was always going
   to refuse as `effect_not_approved`. A release left with no offerable command now does not appear at
   all.
2. **A `read` that fetches ran as a prerun.** `ping_api` declares `read` and makes an outbound
   request, and the effect vocabulary cannot tell a page read from a network read. **A release that
   declares any network host now has none of its reads prerun** — an unrequested turn must not fetch on
   the user's behalf. Such a command is still offered; it just has to be asked for.

**Live acceptance, both directions in one run:**

```text
  catalog (release declares a network host — no prerun) —
    Community scripts installed for this page
    - Fixture Page Reader 1.0.0 (axsdk-fixtures, reviewed by axsdk-fixture-reviewer)
      - read_heading — Read the visible H1 text from the open fixture page. [read]
      …
  catalog (network hosts withdrawn — reads prerun) —
      …
    Read from this page already
    - fixture.read-page/read_heading → {"heading":"AXSDK broker fixture"}
    - fixture.read-page/recall → {"note":"kept-across-nav","keys":["note"]}
    - fixture.read-page/ping_api → could not read: script_error
```

**Mutation-checked, three ways.** Offering unapproved effects fails 2 tests; listing a release with no
offerable command fails 1; prerunning a network-declaring release fails 1. Six earlier guards
(enabled/revoked, host match, non-read prerun, required-argument prerun, the cap, the budget) are
mutation-checked too.

**Remaining slice of this phase — the confirm widget**

**The extension side is done (2026-08-22).** `src/community/widget-action.ts` (5 tests):

- `AX_widget_community_invoke` is the **one** community entry in `AX_CDP_COMMANDS`. Install, enable
  and grant are the user's, through extension UI, and are deliberately absent — a widget the model
  influenced must not be able to name them.
- `widgets.commandActions` is that exact allowlist in `buildCdpSdkConfig`, never `true`, which would
  admit every `AX_widget_*` name a widget could invent.
- `parseCommunityWidgetArgs` is a closed shape: exactly `script_id`, `version`, `command`,
  `arguments`. An artifact URL, a host, a consent flag or a capability token is a **refusal**, not a
  field to ignore.
- The service worker routes that command to the broker rather than the page tools, so installed,
  enabled, version, declared command, schema-valid arguments, approved effect and consent are all
  re-derived where they already live. The button's arguments are input, not authority.

**Mutation-checked, four ways.** Accepting extra fields, accepting any command name, dropping the
allowlist entry, and setting the gate to `true` each turn a test red.

**A mutation check that reports zero failures may mean the mutation never applied.** One `perl -0pi`
substitution here silently matched nothing, and the run read as "this test is not load-bearing" — a
result that would have led to weakening a test that was fine. A non-zero count proves the edit landed;
a **zero** does not. Verify the file changed before believing it. The same checks through `node`
`replace`, which throws on a missed anchor, caught both cases immediately.

**The renderer and its flow wiring are done (2026-08-22).** `_common/rpc/75_rpc_community.lua`
(8 tests, validated against the SDK's own `parseWidgetEnvelope` rather than a reimplementation of it),
the `community_confirm` runtime tool, and three nodes: a model `plan`, a deterministic `confirm`
contract, and a `present_confirm` terminal that relays the summary and the fenced block verbatim.

- The button carries **exactly** `script_id`, `version`, `command`, `arguments` — built field by
  field, never copied from the caller, so nothing added upstream rides along. `artifact_url`, `host`,
  `consent` and `capability_token` are pinned absent from the envelope.
- Arguments cross as a **JSON string**, because flow state carries scalars reliably and an empty Lua
  table encodes as an object the extension's parser then refuses.
- The tool grants no page, network or memory op; the compiler refuses an empty `allow`, so it names
  one it never calls.

**A defect the first live run found, and it was mine at the design level.** The renderer refused any
effect that needs no confirmation, which left an **argument-taking `read` with no path to execution at
all**: prerun skips it because arguments cannot be invented, and the renderer refused it because a
read needs no approval. The model could only describe it. The button is the user *asking for one
specific invocation*, not an approval of a mutation — an argument-taking read needs it just as much —
so every declared effect now renders, and whether a mutation additionally prompts stays the broker's,
on the click.

**Mutation-checked, four ways.** Confirming any effect, smuggling fields into the action, accepting
array arguments, and accepting any command name each turn a test red.

**The split shipped, and two gates came out of it.** `community_propose` is a separate runtime tool
that validates and hands fields to flow state and **renders nothing**; `community_confirm` is reached
only by the contract node. Two new `check:flows` assertions, both born from live failures no existing
gate caught:

- **A presentation tool is never offered to a model.** Offering the renderer in `allowedTools` is the
  shape the repo's own findings already warn about, and nothing checked it.
- **A prompt never names a tool its node does not offer.** This one cost two live runs: the node was
  repointed to `community_propose` and the prompt kept saying `community_confirm`, so the model was
  told to call something it could not see. The document compiled and every branch resolved.

**The deterministic pre-pass shipped.** Four prompt formulations had failed to make a model choose to
propose rather than answer, and the diagnosis was that `answer` was always available to it. So the
decision moved out of the model, the way the Thumbtack shortlist loop already did:

- `AX_RPC_COMMUNITY.classify` (6 tests) matches command names **from the catalog** against the user's
  sentence. A name the catalog does not list is never a proposal — otherwise an invented name becomes
  a button the broker was always going to refuse. Two names are `ambiguous` rather than guessed
  between. `remembering` is not a mention of `remember`: Lua has no word boundary, so the neighbouring
  characters are checked directly.
- The flow entry is now the `classify` contract, and the model node it routes to (`fill`) has **no
  `answer` branch** — the escape into prose is closed by the graph, not by wording. Its only job is
  reading argument values out of the sentence, which is the part a model is good at.

**Four conformance gates caught the wiring, one after another**, and each is worth knowing: a contract
node's `inputSelector` names must be *declared as the tool's parameters* (undeclared state is dropped
in silence); a `fallback` must name a **branch key of the node's own `next` map**, never a node; and a
tool may only declare state some node hands over. All 187 pass now.

**Measured: a context never reaches a runtime tool's arguments.** Two trace reads settled it, and both
overturned the guess before them.

1. The first live failure was **not** the classifier at all — the trace showed `"flow":"memory"`. The
   sentence "run the **remember** command…" collides with the memory intent by name, so the planner
   routed there and `classify` never ran. A command named after a product feature is a bad probe;
   `ping_api` is not.
2. With a non-colliding command the flow *did* route to `community_script.classify`, and it answered
   `{"next":"answer"}`. A one-run diagnostic printed what it had received:
   **`catalog=0 text=51 keys=requestText`.** `requestText` crosses. `contexts.community` is not in the
   arguments at all — not empty, absent.

So a contract node may *select* a context and a conformance gate may confirm the tool *declares* the
same name, and the runtime still does not project it. Contexts reach **prompts** — the `answer`
terminal proves that live — and not tool arguments. This is §13's family ("a field selected but not
declared is dropped in silence") one level deeper than any gate here reaches.

**CLOSED 2026-08-23 — the whole path runs, and the measurement above was right about the symptom and
wrong about the cause.** Two things were stacked, both on the runtime side, and the design that
worked around them (`COMMUNITY_SCRIPT_INVOCATION_DESIGN.md`, option D) was never needed:

1. **`contextAccess` on a `flowTools:` entry was dropped.** `flowToolAdapter` copied `execute`,
   `input`, `pagination`, `require`, `consent`, `effect`, `idempotent` and `policy` and left
   `contextAccess` behind — so no access declaration reached the adapter and the `contexts` global was
   never installed. It worked only for tools written in the adapters document, which is the surface an
   app author cannot use. Fixed in runtime `5e4022e`.
2. **A context needs BOTH declarations, and we had one.** The view is built from the *node's*
   `inputSelector`; `contextAccess` says which of those the *tool* may read. Either alone delivers
   nothing. Our request 18 asked the question with only half the shape written down.

And the global is a key of a `contexts` **table**, not a bare name — `contexts.community`, exactly as
the selector spells it.

**One SDK change was genuinely needed: the catalog did not name the script.** It rendered
`- <name> <version> (<publisher>, reviewed by <reviewer>)`, and the broker dispatches on `scriptId`.
So nothing downstream — model or deterministic node — could say *which* script it meant, and two
installs may share a display name. The entry line now carries the id in backticks. It is not a
capability token, a digest, a source URL or an artifact: it is the name of something the user
installed, which is the rule that block of comments states.

**With the catalog readable, the model stopped being asked for facts it cannot know.** `propose` used
to take `script_id`, `version` and `effect` as arguments and validate them; live, the model answered
an effect outside the vocabulary and the proposal died as `effect_invalid` — the only way that can
end. It now takes `command` and `arguments_json` and looks the rest up by command name. A second
writer of one fact is right by luck or not at all. One command name offered by two scripts is
`command_ambiguous`, never guessed between, and a command the catalog does not list is
`command_not_offered` rather than a button the broker was always going to refuse.

The parser records a command even when no script line has been seen, so a catalog-format change
degrades to a precise refusal in `propose` rather than a silently dead branch in `classify`.

**Two gates, and the second one is the runtime team's own suggestion.** A `contexts.<name>` in an
`inputSelector` must be declared in `contextAccess` and must NOT be a parameter — and the reverse:
a tool declaring access to a context no node selects gets an empty view and reads nothing. The
pre-existing "every field a contract node selects is one its tool declares" gate had to *exempt*
`contexts.*`, because the two were requiring opposite things of the same line. First run of the new
gate named both of our defects.

**Live, end to end, one session on the fixture page:**

| step | evidence |
|---|---|
| deterministic classify | `{"next":"propose","named_command":"remember"}` |
| proposal from the catalog | `script_id: fixture.read-page`, `version: 1.0.0`, effect from the line |
| arguments from the sentence | `{"note":"clicked proof"}` — the user's own words |
| the button, in a real browser | isolated-world click: `{"clicked":true,"tag":"BUTTON"}` |
| the effect | `recall` → `{"ok":true,"value":{"note":"clicked proof"}}` |
| the answer path, unchanged | "이 페이지에는 **AXSDK community fixture page** 라고 쓰여 있습니다" |

The click needed the extension's own **isolated world**: `widget.js` is injected with
`world: 'ISOLATED'`, so a page-world `evaluate` finds no button at all — the first search returned
zero on the very tab that was displaying one. Enumerating execution contexts and clicking in the one
named `AXSDK Assistant (CDP)` is what reaches it.

**It is a script now, not an afternoon: `npm run test:widget:live`.** The one proof the whole feature
rests on had no gate, and this repo's own rule is that an instrument nothing runs tells you nothing.
Getting there needed the debugger client to surface **events** — it kept only the request/reply half,
and the only place an execution context id is ever announced is `Runtime.executionContextCreated`, so
the isolated world was unreachable by construction. `on`/`off` are on the client now, with a test that
drives a real socket: an event arrives, and stops arriving once the listener is removed. A listener
that throws is logged and its siblings still run — one bad handler must not take the socket down.

**The first version of that script could not fail, and the mutation is what said so.** Removing
`element.click()` still PASSED: `recall` answered with the note the *previous* run had left, so
"the note is there afterwards" was satisfied by history. §13 records this exact trap for memory
("a measurement must read the store BEFORE the turn") and it reappeared here in a new costume. The
script now plants a random sentinel through the same broker the button reaches, confirms it took, and
requires the click to have REPLACED it. With that, removing the click fails with
`the note is still the sentinel — the button was pressed and nothing ran`.

**A claim I nearly left here, retracted before it settled: "enabling the user-scripts toggle
re-registers nothing."** It fitted the first observation — API present, stored state present,
`getScripts()` empty — and I wrote it down as a Phase 8 requirement. Re-measuring killed it:
`storedCount` was **0**. The registrar and user-scripts smokes end by removing what they registered
("after removal []") and leave the store empty, so nothing was installed and an empty registration
list was the correct answer. Registration survives a dev reload; writing the store re-registers;
there is no defect. The confound was reading one field and not the one beside it — and §13's rule is
that a false settled finding is worse than none, because nobody re-checks it.

**What IS real, and it is an instrument defect:** the user-scripts smoke fails when the profile
already has a community script installed and live — its page world holds a port that smoke did not
open — and its error named only the toggle. Twenty minutes went into settings that were already
correct. It names both causes now. And the client-versus-ordering question was itself settled by
experiment rather than by the diff: HEAD's client passed where mine failed, which looked conclusive
until the same run passed with mine on the next attempt. **One measurement is not a finding.**

**Mutation-checked, five:** trusting `args.effect` over the catalog (this one initially SURVIVED —
no test supplied a conflicting value, which is the whole property; the assertion exists now),
accepting an ambiguous command name, dropping the script id from the catalog line, removing
`contextAccess` from the classify tool, and removing the click from the live smoke.

**Acceptance met.** A proposal turn renders a confirm widget whose button reaches the broker, clicked
in a real browser, with the effect read back through the broker rather than from the tool's own flag.

**Not blocked, and not built: the direct model tool call.** `rpc.allow` is a membership check and is
not coupled to the published op list, so a `community.*` op could be implemented client-side and
granted by a flow today — measured and confirmed by the runtime team, and the publication request was
withdrawn on that basis. It stays unbuilt for a reason that is not delivery: **the confirm button is
the consent surface**, and a model calling the command directly removes it. It would save one turn on
a `read` and give away the gate on everything else. The flow grants no `community.*` op and
`check:flows` pins that.

### Phase 8 — Consumer UI and onboarding

**RED.** Onboarding names and detects **Allow User Scripts** and says it must be enabled by hand;
the install summary cannot be bypassed without host approval; a newly installed release stays
disabled; host and capability growth are highlighted on update; revocation blocks re-enable; raw
stores, raw Lua, raw flows, the recorder, API-key fields and remote toggles are **absent from the CWS
build**, not hidden in it; keyboard order, labels, status announcements and contrast meet the existing
bar.

**Acceptance.** Drive the whole thing in Chromium — install, grant, enable, ask, confirm, deny an
update with new hosts, apply a code-only update, disable, remove — confirming registrations and
permissions match the UI at every step. Visual confirmation required; assertions alone are not enough.

#### 8-1 — the user-scripts requirement, designed from measurement

**Measured first, because the detection decides the design** — and the first table was incomplete.
What matters is not only the toggle but *when the page bound the namespace*:

| toggle | page loaded | `typeof chrome.userScripts` | `getScripts()` |
|---|---|---|---|
| on | with it on | `object` | answers |
| off | with it off | **`undefined`** | — |
| off | with it **on**, then flipped | `object` | throws **`'userScripts.getScripts' is not available in this context.`** |

So the third state is not the hypothetical it was written as: it is what a user who flips the toggle
**while the page is open** actually hits, and it was the first thing the live run produced. Asking by
CALLING rather than by looking is what makes both answerable — a namespace that exists is not a
namespace that works, and registration needs the second.

Two more facts, both measured, both load-bearing for the copy:

- **Nothing fires when the user flips it.** There is no event, so the UI re-checks on demand; it may
  not wait to be told. Live: with the toggle restored, "Check again" moved the page from the refusal
  to "Community scripts can run in this browser." without a reload — which is the whole reason that
  button exists rather than an apology for it.
- **Registrations survive the toggle going off and back on** (`getScripts()` answered 1 afterwards).
  So the UI must not offer to "repair" anything after a toggle change — there is nothing to repair.

**What the slice owns.** Detection, the sentence, and one asymmetry:

1. `userScriptsReadiness(chrome.userScripts)` → `ready`, `disabled`, or `unavailable` with the
   browser's own words. Both refusals carry the by-hand path; only `unavailable` quotes Chrome.
2. The onboarding names the toggle **by Chrome's own label** and gives the path, because a user who
   is not told both cannot act. It never claims the extension can enable it — there is no API to
   request it, and a UI that implies otherwise is a promise the product cannot keep. Asserted: the
   wording contains "by hand" and none of three "we will do it" phrasings.
3. **Enabling is an activation and every gate applies; disabling is an escape and none do.** A switch
   the user cannot close is worse than one they cannot open — the way out of a script they regret must
   not depend on the browser's mood. Revocation outranks the browser: a revoked release names the
   release, not the toggle, because fixing the toggle would not help.

**Live, end to end on the dev profile:** the section renders the real installed release with its
publisher, reviewer, licence, hosts, commands and effects; **Disable** wrote `enabled: false` and the
registrar *removed* the registration (`getScripts()` → `[]`); **Enable** put both back
(`["axsdk-community-fixture-read-page"]`). The page never registers anything itself — it writes the
store transition and lets the registrar's listener reconcile, because registration is its business.

**Where it lives.** `src/community/readiness.ts` and `src/community/listing.ts` (both pure, 20 tests,
8 mutations) plus `src/options/community.ts` and its own `<section>` — separate from `main.ts` on
purpose, because 8-4 has to ship the community surface with the dev console *absent*, and a seam is
cheaper to build now than to cut later.

#### 8-2 — installing a release, and the two things that gate it

**The install is the UI's job by design.** The service worker's `fetchRelease` refuses outright
(`'install is UI-driven'`): it has no registry, no trust roots and no user. It only rebuilds
registrations from bytes that were already verified.

**Both gates default to nothing, and that is the security-relevant part.** `communityRegistry` and
`communityTrustRoots` are configuration, empty by default — **the fixture signing key lives in this
repository**, so a build that trusted it by default would accept a release signed by anyone holding a
copy. An unconfigured extension installs nothing and says so. `http` is refused except on loopback: a
signature does not make a plaintext channel private, and the index names what a user is about to
install.

**The format has one owner.** The first cut of `communityRegistrySource` invented a shape
(`[{keyId,…}]`) and refused the real fixture roots, live. `parseCommunityTrustRoots` already refuses an
empty key list, a wrong schema version and a non-Ed25519 algorithm, so the check delegates to it — a
second opinion in another file is a second format to keep in step.

**Unknown Chrome version is 0, not a guess.** The registry refuses a release whose floor is above the
number it is given, so zero refuses everything with a floor. Guessing high would install a release
into a browser that cannot run it, and the failure would surface later as a broken script instead of
here as a refusal.

**What the summary promises has to match what the store does.** `installCommunityScript` writes
`previous?.enabled ?? false`, so a fresh install lands OFF and an update to a running script keeps
running. Both directions are asserted, because saying "it will be off" about a script that keeps
executing is the worse lie and both are lies.

**Live, from a cleared store, against the real signed fixture registry:** the summary rendered name,
version, publisher, reviewer, licence, hosts, **`api.axsdk.ai`** and all five commands with their
effects — and offered **no Install button** while the user-scripts toggle was off. With it on: Install
→ `enabled: false`, `approvedNetworkHosts: ["api.axsdk.ai"]`, registration absent; Enable → registered.
Then, through the broker: `read_heading` answered, **`ping_api` → `{status: 200}`** (the host the
install approved), and `probe_forbidden` still refused with `net_host_undeclared`. Both directions of
the host grant, proven.

Modules: `src/community/proposal.ts` and `src/community/source.ts` (pure, 20 tests, 8 mutations).

#### The incident: I reverted uncommitted work, and what it cost

While diagnosing an empty context I ran `git checkout --` on `src/background/service-worker.ts`,
which was **tracked and uncommitted**. It went back to HEAD, taking the whole community wiring and the
workspace-manifest path with it. Recovery was attempted and failed on every route: never committed
(so nothing in `reflog`), never staged (18 dangling blobs scanned, none matching), no editor local
history for that file, no shadow copies, no copy on disk. `dist/service-worker.js` survived but is
bundled and mangled.

**Rewritten from the intact contracts, and the rewrite is better than what it replaced in one
specific way:** the catalog-plus-readings logic is now `src/community/context.ts` with its
dependencies injected (9 tests, 4 mutations) instead of inline in the worker where nothing could reach
it. That inline-ness is precisely why an empty context had cost four wrong probes — from outside, "the
record is unreadable" and "nothing is installed for this page" were the same empty string. They are
separate answers now, both reported, both pinned.

**Three of my own probes were the bug, not the product.** `axsdk.cdp.community-context` and
`axsdk.cdp.community-context-request` are two channels: the first takes a caller-named url, the second
takes a `groupId` and resolves the session's own tab, which is what the session worker sends. I probed
the second with a url and no groupId, read the empty answer as a product failure, and went on to probe
the offscreen realm (no `chrome.tabs`) and the options realm (wrong sender). The turn was the only
honest signal all along.

**And one gate could no longer see what it was written to see.** `test:user-scripts:live` listened for
`onUserScriptConnect` in the options page; that event goes to the primary extension context, so once
the worker owns the broker the smoke's listener gets nothing — it had passed only during the window
when the worker had no community wiring. Its connection COUNTER would now sit at zero and make every
boundary check vacuously true. It asserts through the shipped path instead: a read succeeds where the
script is injected and fails with `no_connected_document` where it is not
(`unapproved:no_connected_document removed:no_connected_document`), with the handshake token, the
undeclared command and the stale version left to the broker's own tests.

**Regression, all green after the rewrite:** extension **1085** · core 800 · `check:flows` 188 ·
`test:lua` 580 · bundle/policy/registry ok · live smokes registrar + broker + user-scripts ·
`test:widget:live` · the answer turn (*"AXSDK community fixture page", 읽은 스크립트 `read_heading`*) ·
the proposal turn with its widget · the button click replacing its sentinel.

#### 8-2b — signing dropped: install from a URL, the userscript-manager model

**Decision, 2026-08-23.** Signatures are gone from the install path. Nothing external required them —
not Chrome, not CWS policy. What policy requires is that a remote resource carry no logic for the
extension's functionality, and the recognised path for user-installed scripts is the **User Scripts
API exemption**, which is what Tampermonkey uses at 11M installs. Signing was our own bar.

**What Tampermonkey does instead**, measured from its documentation and developer threads: source
reputation (Greasy Fork and friends), a visible metadata block (`@match`, `@grant`, `@connect`), an
install prompt, and `@grant none` as the low-privilege mode. No cryptographic verification anywhere.
Its own forum records that the `@connect` prompt is *"not that easy to decide what to click for a user
who doesn't know about these security specifics"* — the model's honest shape is **the user chose the
URL, so the user carries it**.

**What the extension still checks without a key** (`src/community/from-url.ts`, 13 tests, 5
mutations):

| check | why it survives without a signature |
|---|---|
| manifest schema, closed | an unknown key is a refusal, not something ignored |
| declared digest + byte count | unsigned means we cannot prove WHO wrote it, not that we accept something other than what the document described |
| **no remote loaders in the artifact** | new here, and load-bearing |
| origin: https or loopback | a signature would have made the channel irrelevant; without one the channel is all there is |

**The loader scan had to move into the extension.** In the signed model the build-time compiler ran it
before anything was signed; an arbitrary URL has no build step. The hostile case is not a tampered
byte — it is an author who declares the digest **of** the `eval`-containing file, which every other
check then passes. Its test constructs exactly that and expects `artifact_forbidden`.

**Two checks were covering for each other.** Appending a line changes both the digest and the length,
so removing either check still failed the test. Only an equal-length edit isolates the digest; the
byte count cannot be isolated the other way, because a matching digest implies a matching length — so
it is documented as a cheap early-out rather than pretended to be an independent contract.

**A release is SELF-CONTAINED beside its manifest** — `<dir>/manifest.json` plus
`<dir>/assets/<digest>.js`. That is what makes "paste a URL" work from any directory, and it is the
layout difference from a registry with one fixed root. The fixture server serves both.

**Given up knowingly:** provenance (a compromised host serves whatever it likes, with a matching
digest) and remote revocation (no signed feed to consult — disable and remove stay local and manual).
The AI-caller concern that argued for keeping revocation is deferred to a separate mechanism.

**Deleted as dead:** `communityRegistrySource`, its tests, and the `communityRegistry` /
`communityTrustRoots` config fields — an install names a URL, so there is no configured registry to
validate and no key to parse. `chromeMajorVersion` is what remains of that module.

**Still reachable but no longer on the product path:** `fetchCommunityRelease`,
`fetchCommunityRevocations` and `parseCommunityTrustRoots`, used only by the four live smokes to build
their signed fixture registry, plus the `check:community-registry` gate. Migrating those to the URL
path is the clean cutover and needs approval before deletion.

**Live, from a cleared store:** the summary led with **`From http://…/manifest.json`** — with no
signature the URL IS the provenance, so it is the one fact a user cannot be asked to approve without
seeing — then name, version, publisher, reviewer, licence, hosts, `api.axsdk.ai` and all five
commands. Install → `enabled: false`; Enable → registered; through the broker `read_heading` answered,
`ping_api` → `{status: 200}`, `probe_forbidden` → `net_host_undeclared`; a proposal turn rendered its
widget and the click replaced the sentinel with its note.

**One consequence worth knowing, and it is the rule working.** `preflightPlan` refuses to prerun ANY
read from a release that may fetch — *"an unrequested turn must not make an outbound request on the
user's behalf"*. The URL install correctly approves `api.axsdk.ai`, so this fixture no longer answers
"what does this page say" in a single turn; its reads must be asked for. It appeared to work before
only because a stale record from an older seed had no approved hosts. A release that declares no
network host still gets the single-turn path.

**Three of my probes routed to the wrong flow before one worked**, which is a planner-collision note
rather than a defect: "remember …" reached the memory flow (`set_memory` really stored a key), and
"read_heading 명령을 실행해줘" reached the page-probe flow. Naming the script's own home — *"…from the
community script installed on this page"* — is what routes to the community flow.

### Phase 9 — Registry publication and the Tier 2 validator

**Hosting** is static, content-addressed, CDN-fronted, on its own origin. Immutable assets get a
one-year immutable cache; `index.json` a short TTL; `revocations.json` a very short one. **Sign off
the CI path**: the build is deterministic and the signature covers the bytes, so a trusted machine
signs and CI uploads already-signed files. The production key never enters CI.

**RED.** Publication refuses an unreviewed or unsigned release; the emitted tree matches the
compiler's output byte for byte; a replayed revocation feed is refused by sequence (implemented
2026-08-22 — keep the test); an unreachable feed keeps the last verified list in force and reports
stale.

**Tier 2 validator** — new work, in two places because a fragment that reaches a user must have been
checked by whoever installed it:

- registry compiler (build time, `axsdk-sites`)
- extension (install time)

It refuses any `rpc` block, `net:` block, `memory.*` reference, or tool other than `community.invoke`
over that release's own declared commands. Relaxing Tier 2 to domain-gated ops is allowed only after
Phase 4 ships and only with live evidence.

**Blocked on decisions:** signing-key custodian and reviewer ownership. Do not publish without both.

### Phase 10 — Pilots

Three, in order: a local-fixture read; one real-site read-only command with live-measured selectors;
one consented, reversible, non-purchase mutation whose outcome the site itself confirms. Each passes
source tests, registry checks, signature and tamper tests, install/reconcile tests, browser execution,
an agent end-to-end invocation, disable/remove behaviour, and the exact CWS-profile artifact scan.

Do not start Phase 11 until all three pass, or until V1 scope explicitly excludes mutations.

### Phase 11 — Migration of existing automation

One user-visible capability at a time, read-only before mutating. For each: capture the current
contract with existing tests and one real scenario, write the release and its browser test, implement,
install and invoke through the community manager, compare user-visible output and safety, switch the
caller, then run `lsp references` and delete the obsolete implementation, flow entry, schema, fixture
and documentation. No compatibility shim survives a cutover.

Order: page read → storefront readers → navigation helpers → form assistance stopping before submit →
Thumbtack quote with its never-send invariant → cart mutation with per-invocation consent → checkout
review with its no-order proof.

Keep in packaged reviewed code: deterministic ranking, identity verification, FX, memory, sitemap
data, and every policy gate. Those are not site-specific DOM automation.

### Phase 12 — CWS profile cutover and consumer auth

This is where P0-1 closes, and it closes by **deletion**, not by a policy answer.

**RED — the exact artifact fails if it contains or exposes:** Fengari or any interpreter for
downloaded code; a remote Lua/flow/JS/Wasm loader; `raw.githubusercontent.com`; `eval` or
`new Function` outside a documented dependency exception; community execution through
`chrome.debugger`, `chrome.scripting`, an offscreen worker or a sandbox page; raw editors, arbitrary
URL import, recorder export, remote-source toggles or API-key configuration; a permission no packaged
code path uses; a missing trust root; an unsigned bundled asset.

**And fails if it lacks:** `userScripts`, the optional host declarations, the minimum Chrome version,
the packaged bootstrap, the trust roots, the consumer options UI, and the privacy and permission
disclosures.

**Consumer authentication** ships here: first-run sign-in with no manual API key. A consumer product
that asks the user to paste a key is not submittable.

**Privacy disclosure** ships here too, naming page content, forms, URLs, chat, contact memory, debug
traces, `chrome.debugger`, recipients, retention, deletion and human access.

Two compile-time profiles, no ambiguous runtime switch: the CWS profile, and a developer profile that
keeps local Lua, flow injection, the recorder and raw stores as explicitly non-CWS functionality.

### Phase 13 — Release

Run the full gate sequence against the exact artifact intended for upload: clean-source and
generated-output checks; deterministic registry build and signature verification; core and extension
tests, typecheck and build; the retained Lua/flow/conformance suites; the community contract suites;
the real browser manager scenario; real agent read-only and consented scenarios; the exact-artifact
static scan; a clean-profile package-only smoke; the permission and privacy checklist; a public-safety
scan; backend revision synchronisation only with explicit approval; and the release command only with
explicit approval.

Publication materials must describe the measured artifact: what is installed, who reviews it, where
the code is visible, how updates are controlled, and how to enable **Allow User Scripts**. Do not
claim arbitrary community script support while the product accepts only registry-reviewed releases.

## 17. Verification matrix

Commands must be confirmed against the repository at implementation time. The current expected gate families are:

### `axsdk-sites`

```text
node --test "tools/community/*.test.mjs"
npm run build:rpc
npm run build:lua:check
npm run check:flows
npm run test:lua
npm run test:commerce
npm run test:scenarios
npm run test:playground
npm run dead:lua
npm run build:bundle
npm run check:bundle
```

Add explicit scripts for community registry build, verification, and exact generated-output drift. Do not hide new suites behind an unreferenced test file; the repository already has a gate against unreachable suites and the community tests must participate in it.

### `axsdk-sdk-js`

Run the package's existing focused tests, typecheck, and build commands for:

- `axsdk-core` catalog/context changes;
- `axsdk-extension-cdp` store, crypto, registry, registrar, broker, service worker, UI, and browser-session changes;
- exact extension artifact scanning.

Add a browser scenario that uses a real installed extension and local fixture origin. A mocked Chrome API is not sufficient proof of `chrome.userScripts` lifecycle or world messaging.

### Live sites

Use live sites only after the local fixture proves the mechanism. For each pilot or migrated script:

- verify the loaded registration id/version/digest;
- exercise the exact command through the agent path;
- observe the site result;
- retain no quote submission, order placement, payment, or unintended cart mutation;
- use reserved test values only.

## 18. Release and backend sequencing

The backend/app package must not be the first integration point. Develop against local packaged contracts and a sandbox app only after the extension and core tests are green.

Recommended sequence:

1. Implement fixed invocation contract locally.
2. Verify extension/core end to end with a local test adapter.
3. Build the backend/app action using the same fixed schema.
4. Push only to the sandbox app when explicitly approved.
5. Verify the sandbox package revision and exact module set.
6. Run real agent pilot scenarios.
7. Update production package only as the final release step and only with explicit approval.

Never push the community overlay to the production `browser-extension` app by accident. Existing repository safeguards remain required.

## 19. Risk register and controls

| Risk | Consequence | Control | Proof |
|---|---|---|---|
| Lua conversion changes executable bytes after review | Review bypass | Convert deterministically before review; sign and distribute the exact JavaScript bytes; ship no Lua interpreter | Deterministic build, signature, and one-byte tamper tests |
| Automatic code updates are judged insufficiently user-controlled | Rejection or trust failure | Manual update default; explicit update review | UI/browser update scenario |
| User script performs hidden DOM mutation outside broker | User harm | Registry review, exact source visibility, no autorun, countersigning, host scope, revocation | Review checklist plus pilot behavior tests |
| Registry compromise | Malicious release | Offline trust roots, signatures, immutable digests, separate reviewer, key rotation, revocation | Tamper and wrong-key tests |
| Extension downloads bytes but executes unverified content | Remote-code violation | Verify signature, URL, bytes, digest, media type before cache/registration | One-byte tamper test and exact network trace |
| Script identity spoofing through messaging | Cross-script capability use | Per-release token, isolated world, command digest, sender tab/frame/document binding | Negative handshake tests |
| Host permission creep | Excessive access | Optional exact origins, expansion confirmation, unused-host revocation | Permission UI and browser tests |
| Catalog and installed state diverge | Model invokes stale command | Broker remains authoritative; controlled session refresh | Remove/disable/update integration tests |
| Mutation is replayed after uncertain result | Duplicate external effect | No mutation retries; classified uncertainty | Disconnect/timeout mutation tests |
| Registration disappears after extension update | Scripts silently stop | Startup/update reconciliation from verified cache | Extension-update browser test |
| Revocation feed unavailable | Known bad script may remain | Signed cached revocation, explicit stale state, packaged emergency key control | Offline/revocation tests and incident procedure |
| CWS bundle retains developer executor | Policy rejection | Compile-time profiles and exact artifact scan | Release artifact gate |
| Broad migration breaks existing automation | Product regression | Per-capability cutover, real scenario, remove duplicate only after green | Migration acceptance record |
| Test fixture is more permissive than Chrome | False green | Faithful fakes plus required real-browser gate | Fixture contract tests and browser comparison |
| Telemetry captures source or user data | Privacy breach | Metadata-only event schema and prohibited-field tests | Telemetry serialization tests and artifact review |

## 20. Required decision gates

Implementation must pause at these decision boundaries if the required answer is unavailable:

1. **Signing key custodian** — blocks production registry publication (Phase 9).
2. **Review ownership and criteria** — blocks inclusion in the trusted production index (Phase 9).
3. **Registry hosting origin** — blocks publication; the recommendation is a dedicated CDN-fronted static origin, signed off the CI path.
4. **Consumer authentication** — blocks submission, not development (Phase 12).
5. **Agent catalog refresh contract** — blocks live catalog integration if core cannot refresh safely; a controlled session restart is the default fallback (Phase 7).
6. **Final mutation pilot** — blocks mutation release if a site-originated outcome cannot be proven (Phase 10).
7. **`community.catalog` / `community.invoke` platform ops** — blocks the direct model tool call only. Channels A–C ship without them (Phase 7).

None of these blocks Phase 4, 5, or 6. Lua conversion and lifecycle approval are already fixed by `community/release-policy.json`; the domain gate, the registrar and the broker need no decision that is not already made.

## 21. Completion checklist

The community-script product is complete for initial CWS release only when all statements below are true:

### Product

- [ ] The user can discover a reviewed script and inspect its publisher, source, version, hosts, commands, effects, disclosures, and review status.
- [ ] The user explicitly grants exact host access and installs/enables the script.
- [ ] The user can disable, update, and remove it.
- [ ] The model cannot perform those management actions.
- [ ] Revoked or incompatible scripts cannot run.

### Registry

- [ ] Every indexed release is immutable, reviewed, signed, and content-addressed.
- [ ] Signature, digest, URL, byte-size, compatibility, and revocation checks fail closed.
- [ ] No release loads secondary executable code.
- [ ] Builds are deterministic and public-safe.

### Runtime

- [ ] Community code runs only through `chrome.userScripts` in `USER_SCRIPT` worlds.
- [ ] Registration is limited to user-approved origins.
- [ ] Startup/update reconciliation is proven in a real browser.
- [ ] Broker identity, schemas, bounds, consent, and no-retry mutation behavior are proven.
- [ ] No purchase, order, or payment operation exists.

### Agent

- [ ] Only installed/enabled commands appear in catalog context.
- [ ] One fixed packaged invocation tool dispatches commands.
- [ ] The tool accepts no code, URL, module, flow, permission, or install input.
- [ ] Catalog changes refresh safely.
- [ ] Real read and consented pilot turns pass.

### CWS artifact

- [ ] Developer-only controls and executors are absent by construction.
- [ ] No downloaded Lua/JS/Wasm/flow program is executed outside the User Scripts API.
- [ ] Manifest permissions are minimal and measured.
- [ ] Clean-profile install and package-only startup pass.
- [ ] Listing, privacy, permissions, and support text match observed behavior.
- [ ] Exact artifact scan and all release gates are green.

## 22. Next implementation slice

Phases 0–5 are complete; Phase 6 has its broker, argument validation, consent gate, `storage.*` and
`net.fetch`; Phase 7 has its catalog, its prerun readings, and delivery of both into a real session
as a per-message `community` context. A model is now told, in words, which community commands are
live on the page it is looking at and what they already read from it.

The next slice is **channel C — the packaged flow and the confirm widget**:

1. Add a failing `check:flows` assertion that the `community_script` flow declares `contexts:`,
   that every branch target exists, and that every model node carries a stall guard naming a branch
   key of its own `next` map.
2. Add a failing assertion that its holding gate can be told no, and that the confirm node is a
   deterministic `action_contract` selecting only fields its tool declares.
3. Add a failing assertion that the widget action names exactly `AX_widget_community_invoke` and
   that `widgets.commandActions` is that exact allowlist, never `true`.
5. Implement the flow and the AX handler entry.
6. Prove it live with `npm run cdp -- send`: a natural-language question answered from a prerun
   reading in one turn, and a proposal turn rendering a confirm widget whose button reaches the
   broker. This is also where the one open link in channel A/B is closed — that core carried the
   block into the turn, asserted from inside the flow that reads it.
7. Mutation-check the gate: letting the model dispatch without the confirm node must turn a test red.

Then the mediated `memory` disclosure, which belongs with the Phase 8 consent surface: it *is* a
prompt, so building it before that surface exists would leave its live acceptance open — as the
broker's answered-consent paths already are.

**Before trusting any live result, reload the extension for real**: enable developer mode on
`chrome://extensions` and click `#dev-reload-button`. `Extensions.loadUnpacked` does not replace a
running service worker, and three separate live failures this session were that and nothing else.

Four carry-overs, none of them blockers: the op refusal reason is flattened to `null` by the
harness's `eval` path; the main-tab op path still evaluates with no execution context, which leaves
the domain gate a per-document decision rather than a per-call one; web origins are still required
rather than optional in the manifest, which Phase 12 narrows; and the answered-consent paths wait on
the Phase 8 consent UI.
