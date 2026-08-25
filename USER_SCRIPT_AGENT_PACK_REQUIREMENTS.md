# UserScript Agent Pack Product Requirements

**Status:** Proposed · Phase 0 executor/multi-asset/no-Pack baseline GREEN; policy and platform compiler BLOCKED · 2026-08-24  
**CWS launch gate:** The default Agent Pack and its first-party provider artifacts ship inside the reviewed extension artifact. REQ-REL-010 remains a later gate only for a build that fetches Pack flow or JavaScript after review.  
**Requirement language:** MUST, MUST NOT, SHOULD, SHOULD NOT, MAY follow RFC 2119.  
**Architecture:** [`USER_SCRIPT_AGENT_PACK_ARCHITECTURE.md`](USER_SCRIPT_AGENT_PACK_ARCHITECTURE.md)  
**Implementation plan:** [`USER_SCRIPT_AGENT_PACK_IMPLEMENTATION_PLAN.md`](USER_SCRIPT_AGENT_PACK_IMPLEMENTATION_PLAN.md)

## 1. Purpose

This document defines the product requirements for replacing the current AXSDK site workspace's
locally packaged flow and Lua runtime layer with user-installed, signed Agent Packs and Provider
Packs executed through `chrome.userScripts`.

The primary user scenario is:

1. The user installs **Shopping Comparison Agent Pack 1**.
2. Pack 1 provides the shopping intent, flow graph, deterministic task logic, and baseline storefront
   providers as one user-visible installation.
3. The user later installs **Store X Provider Pack 2**.
4. Pack 2 contributes Store X to Pack 1's typed `storefronts` extension point.
5. Pack 1 is not edited, updated, or reinstalled.
6. The next applicable shopping task automatically includes Store X according to the user's enabled
   provider settings.
7. Store X results pass through Pack 1's existing identity, relevance, price, shipping, FX, ranking,
   window, and safety rules.

The long-term requirement is broader: after the user explicitly installs the complete first-party
parity pack set, the existing `_common/flows.yaml`, `_common/scripts/*.lua`, `_common/rpc/*.lua`, site
flow layers, and site Lua config/runtime path can be removed without losing current user-visible
behaviour.

## 2. Scope decision

### 2.1 In scope

- signed multi-asset Agent Pack releases;
- signed Provider Pack releases;
- restricted downloadable flow fragments;
- exact reviewed JavaScript artifacts executed in `USER_SCRIPT` worlds;
- typed Agent Pack extension points;
- deterministic pack composition;
- a dedicated task-executor web document per AXSDK session;
- provider-page UserScript execution;
- controlled provider navigation and re-entry;
- current shopping, quote, memory, navigation, community-control, and terminal parity;
- explicit install, enable, update, host, capability, and mutation consent;
- clean removal of the current local site flow/Lua delivery path after full parity.

### 2.2 Clarified scope

“Remove local Lua” means removing the `axsdk-sites` workspace's production flow/Lua source path from
the CWS runtime and package graph. It does not require deleting the published `@axsdk/lua` package
from the wider SDK ecosystem. `@axsdk/lua` MAY remain for legacy SDK integrations, development, and
non-CWS consumers.

The CWS Agent Pack path MUST NOT execute downloaded Lua or bundle a Lua interpreter to execute pack
logic. Removing Fengari and the SDK's packaged default Lua tools from the final CWS artifact is a
separate extension-cleanup gate; if that gate is selected, the default form tools MUST first be
ported to packaged JavaScript with behavioural parity.

The first CWS implementation MUST embed the default Agent Pack, its flow fragment, task JavaScript,
and first-party provider artifacts in the extension artifact. Installing the extension installs that
default Pack; it MUST NOT fetch those executable assets from a registry. Dynamic Provider Pack
delivery remains in scope, but REQ-REL-010 applies before any public build enables that remote path.

### 2.3 Out of scope for the first Provider contract

- automatic purchase, order placement, or payment;
- automatic cart mutation;
- unsigned or arbitrary-URL pack import;
- model-controlled install, update, host approval, or capability expansion;
- generic YAML deep merge between independently authored packs;
- Provider Packs editing Agent Pack prompts, graph nodes, edges, or routes;
- downloaded Lua execution;
- a second implementation in the legacy `@axsdk/extension` package.

## 3. Current baseline that parity means

The current production workspace has the following measured surface:

| Surface | Current value |
|---|---:|
| `_common/flows.yaml` | 261,319 bytes |
| flows | 11 |
| routed user intents | 8 |
| flow tools | 82 |
| flow-declared modules | 26 |
| production Lua source | 39 files / 477,839 bytes / 10,759 lines |
| common scripts | 15 |
| runtime RPC modules | 14 |
| storefront config/generator Lua | 10 |

The 11 flows are:

- `shopping_multi_store_total_cost`;
- `shopping_search_one_store`;
- `shopping_single_site`;
- `checkout`;
- `request_service_quote`;
- `memory`;
- `record_memory`;
- `bluemoonsoft`;
- `community_script`;
- `unsupported_request`;
- `end_conversation`.

Shopping alone currently spans four flows, 51 nodes, 36 tools, 18 modules, two consent-gated cart
mutations, and one FX network dependency.

Functional parity therefore means more than a read-only multi-store search demo.

## 4. Product principles

### PR-001 — User authority

The user MUST be the only actor that installs, enables, disables, updates, removes, or expands the
hosts/capabilities of a pack. The model MAY explain what is available and MAY propose a command, but
MUST NOT complete a lifecycle or permission decision.

### PR-002 — Task owns graph, provider owns site adapter

An Agent Pack MUST own its task graph and policy. A Provider Pack MUST contribute only a typed
provider implementation. Provider installation MUST NOT rewrite or deep-merge the Agent Pack flow.

### PR-003 — One installed fact, one source of truth

Provider identity, version, host matches, entry URL, command bindings, effects, schemas, and display
metadata MUST come from the signed installed composition. The model, flow state, and UserScript output
MUST NOT author or override those facts.

### PR-004 — Existing safety is part of functionality

A migration that returns the same prose but weakens consent, identity revalidation, cart confirmation,
quote-submit boundaries, access classification, or order prevention is not parity.

### PR-005 — Clean cutover

Once full parity is proven, the old local production path MUST be removed. A second shipping flow/Lua
implementation MUST NOT remain as a fallback.

### PR-006 — Additive until the one clean cutover

Before the full deletion gate, installing the implementation MUST be a no-op for users who have not
enabled Pack runtime. New optional surfaces MUST NOT change existing package APIs, session payloads,
tab routing, community scripts, local flow/Lua execution, UI, or browser permissions by presence alone.

## 5. User stories

### US-001 — Install a complete task

As a user, I can install one Shopping Comparison Agent Pack and gain the task flow, task logic, and
its baseline providers through one understandable approval surface.

### US-002 — Extend a task without editing it

As a user, I can install Store X Provider Pack and have Store X appear in future Shopping Comparison
runs without changing Pack 1 bytes or graph structure.

### US-003 — Control provider inclusion

As a user, I can enable or disable Store X for Shopping Comparison independently. Explicitly named
stores remain authoritative; a generic comparison uses enabled default providers within the visible
configured bound.

### US-004 — Understand authority

As a user, I can see which task pack, provider pack, version, host, effect, fixed service/egress host,
and consent rule will be used before activation or update.

### US-005 — Preserve current capabilities

As an existing user, after explicitly installing the first-party parity pack set, I can still use
shopping, guarded cart add, checkout review, Thumbtack quote preparation, memory, BlueMoonSoft
navigation, community-script interaction, cancellation, and terminal flows with their current safety
constraints.

### US-006 — Recover safely

As a user, if an update or Provider Pack fails validation, compile, approval, exact-document
execution, or live connection, the last active composition remains usable and no mutation is
replayed.

### US-007 — Upgrade without opting in

As an existing user, I can upgrade to a build containing Pack support without enabling a Pack and see
the same tabs, routes, commands, community scripts, session payloads, and results as before.

## 6. Release and installation requirements

### REQ-REL-001 — Multi-asset release

An Agent Pack release MUST be a signed, content-addressed graph containing:

- one restricted flow fragment;
- one exact task JavaScript artifact;
- zero or more separate embedded-provider JavaScript artifacts;
- route, resume, hook, command, extension-point, service, schema, effect, host, fixed-service egress,
  disclosure, review, and compatibility metadata.

### REQ-REL-002 — Provider release

A Provider Pack release MUST contain:

- one or more exact provider JavaScript artifacts;
- exact site matches and entry URLs;
- typed extension-point contributions;
- declared commands, effects, input/output schemas, and confirmation requirements;
- product/result URL match rules;
- fixed service dependencies/egress disclosures, review, and compatibility metadata.

### REQ-REL-003 — Signature closure and trust roots

Release manifests, registry indexes, and revocations MUST use strict RFC 8785 canonical JSON and
detached Ed25519 signatures over domain-separated UTF-8 bytes. Trust roots and registry origins MUST
be extension-packaged; registry content MUST NOT add or replace trust roots. A trust-root change
requires an extension update. The release signature MUST cover every asset reference, byte count,
SHA-256, command contract, input/output schema, companion data-flow map, contribution, host, effect,
fixed-service dependency, disclosure, review identity, and compatibility field. A byte not covered by
that closure MUST NOT reach storage or `chrome.userScripts.execute`. Strict parsing MUST reject
duplicate keys, unknown signature algorithms, malformed canonical encodings, and untrusted/expired
keys. Signed registry indexes and revocation sets MUST carry monotonic per-registry sequence numbers;
the extension MUST persist a high-water mark and reject rollback. A `(registry, packId, version)`
tuple MUST map permanently to one release digest; a second validly signed digest is registry
equivocation and MUST be refused/quarantined. Explicit user selection of an older still-valid,
non-revoked release is a separate lifecycle action and MUST NOT lower the registry high-water mark.

### REQ-REL-004 — One user-visible installation

The embedded default Agent Pack is installed with the extension and MUST NOT require a second
installation decision. Any later dynamically delivered Agent Pack MAY contain multiple artifacts and
per-document execution worlds, but the user MUST approve and manage it as one installation. UI MUST
explain task-executor code separately from embedded provider code.

### REQ-REL-005 — JavaScript execution language

Pack executable artifacts MUST be JavaScript. Lua MAY be an authoring language only when a
deterministic pre-publication pipeline produces the exact JavaScript artifact before review and
signing. Runtime interpretation of downloaded Lua is forbidden.

### REQ-REL-006 — Version compatibility

Every release MUST declare minimum runtime version, contract versions, target Agent Pack/version
range for contributions, and schema versions. Incompatible releases MUST remain installed but inactive
with a structured reason.

### REQ-REL-007 — Explicit lifecycle approvals

Install, enable, update, host expansion, and capability expansion MUST each require user approval.
Automatic updates and automatic dependency installation are forbidden.

### REQ-REL-008 — Atomic activation

Fetch, verification, dependency resolution, composition, compile, approval verification, and state
publication MUST form one logical transaction. Pack install/enable MUST NOT execute or persistently
register downloaded JavaScript. The candidate composition remains unavailable until one authoritative
new-session-default pointer commits. After commit, new sessions pin it; already-running sessions
retain their previous pinned composition. Old compositions/artifacts remain available to live or
retained restorable sessions pinned to them and are pruned only after the last reference ends. A
pre-commit failure preserves the previous default; post-commit cleanup failure leaves the new default
active and stale unreferenced data inert/recoverable. Per-session task/provider code is injected later
with exact-target `chrome.userScripts.execute`. The current CWS extension's required all-HTTP(S) host
permission MUST NOT be added, removed, or narrowed by Pack activation.

### REQ-REL-009 — Revocation

A signed revocation MUST disable the exact release and remove its contributions from new
compositions. Every live invocation MUST reject the revoked release. Because Chrome cannot unload one
executed `USER_SCRIPT` world from a live document, the host MUST disconnect and close/recreate any
extension-created role document containing the revoked artifact before any further Pack dispatch on
that role, then re-execute only still-enabled/non-revoked pinned artifacts. Unrelated providers and
the owning Agent Pack MUST remain usable when their dependency graph is still valid.

### REQ-REL-010 — CWS remote-logic policy gate

Before a public CWS build fetches a Pack flow fragment or fetches/executes Agent/Provider Pack
JavaScript, written Chrome Web Store policy confirmation MUST cover both: (a) the remotely supplied
restricted flow logic executed by the platform, and (b) the exact signed-registry, explicit
user-install, reviewed-artifact, `chrome.userScripts.execute` model as eligible user-script
functionality. API availability, isolation, signature review, or a prior store approval MUST NOT be
treated as that confirmation. Existing policy evidence points against remotely supplied first-party
product logic. Without explicit approval of both paths, dynamic Packs MUST NOT ship through CWS and
the clean local-runtime deletion gate MUST remain blocked; first-party logic must stay
extension-packaged or use a non-CWS distribution.

Policy basis: <https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements>

### REQ-REL-011 — Lifecycle/invocation serialization

Disable, removal, revocation, role-document recycle, and extension update reconciliation MUST share a
per-connection lifecycle lock with Broker v2 dispatch. The lifecycle transition first makes the
binding dispatch-ineligible, then waits a bounded time for an in-flight read/page-write command.
If a mutation has crossed its durable dispatch frontier, interruption or missing acknowledgement
MUST resolve as `uncertain` and MUST NOT replay commit. Only after settlement/quarantine may the role
document be recycled.

## 7. Agent Pack flow requirements

### REQ-FLOW-001 — Restricted fragment

A downloadable flow fragment MAY define only namespaced flows, nodes, state, terminal instructions,
Agent Pack commands, extension-point calls, and declared versioned platform-service calls.

### REQ-FLOW-002 — Forbidden fragment authority

A fragment MUST NOT define or override global `app`, raw planner, router, defaults, contexts, arbitrary
hooks, `rpc.allow`, raw network grants, raw DOM/nav/memory/tab/debugger ops, Lua/modules, code strings,
foreign namespaces, purchase, order placement, or payment.

### REQ-FLOW-003 — Typed global contributions

An Agent Pack MAY contribute closed data for:

- route intent/entry/description/examples;
- paused-flow resume rules;
- approved typed hook slots;
- service dependencies.

The product shell MUST generate global planner/router/hook structures. Packs MUST NOT merge arbitrary
global prompt text. Route descriptions/examples MUST be bounded plain text in a fixed delimited data
rendering, reject control/template syntax, and receive signed release review for prompt injection.
Provider Packs MUST NOT contribute planner text at all.

### REQ-FLOW-004 — Namespacing

The composer MUST namespace every flow, node, tool, state key, route entry, extension point, and
command reference by pack id. Cross-pack references MUST require an explicit dependency or extension
point.

### REQ-FLOW-005 — Deterministic composition

Composition MUST be deterministic for the same installed releases/settings. Order MUST derive from an
acyclic dependency graph followed by stable pack id ordering. Last-writer-wins merge is forbidden.

### REQ-FLOW-006 — Compile before activation

The complete composition MUST pass structural validation and a platform compile-only endpoint before
activation. Validation MUST NOT create a live session or model turn.

### REQ-FLOW-007 — Session pinning

A session MUST pin `packSetDigest` and exact Agent Pack versions. Each task MUST additionally pin its
ordered `providerSetDigest` and exact provider releases. Install and update affect only sessions
created after activation; an existing session/task changes only after explicit cancel/restart.
Disable, removal, and signed revocation MUST immediately deny new invocations of the affected pinned
binding without rewriting the running graph or substituting another version; the task receives a
classified unavailable result and may continue unrelated branches or ask to restart.

### REQ-FLOW-008 — Resume semantics

The composer MUST preserve current paused-flow semantics, including exact latest-user-text forwarding,
`continue_current`, cancellation, shortlist browsing, comparison browsing, single-site gates, and
memory deletion confirmation.

### REQ-FLOW-009 — Hook semantics

The memory capture `beforeIntent` behaviour MUST be represented by a typed hook slot. Hook execution
order, timeout, failure policy, and pack dependency MUST be deterministic and visible.

### REQ-FLOW-010 — Pack prompt and state isolation

Every Pack model/action node MUST receive only its own namespaced state plus explicitly declared
typed product-shell/extension-point inputs. It MUST NOT receive another Pack's prompt text, private
state, source, manifest, or unbounded result payload. Cross-Pack values may cross only a declared
closed contract, and the composer MUST reject foreign state selectors or prompt references.

## 8. Task executor requirements

### REQ-EXEC-001 — Dedicated executor

Each Pack-enabled AXSDK session MUST have one extension-created dedicated task-executor document on
an exact approved AXSDK-owned HTTPS origin that is distinct from account/app origins. The endpoint
MUST be static, carry no user/chat/account data, require no authentication cookie, register no service
worker, load no third-party script, and expose no form or navigation UI. A legacy/local session or a
session with no enabled Agent Pack MUST NOT create an executor document. Agent Pack task JavaScript
MUST execute there in a `USER_SCRIPT` world.

### REQ-EXEC-002 — Provider isolation

Task JavaScript MUST execute only on the task-executor document. Provider JavaScript MUST be injected
only into the exact approved extension-created provider work tab/frame/document selected by the
coordinator; an ordinary user-owned tab MUST NOT be reused or targeted. Adding Store X MUST NOT expand
Pack 1's page hosts or DOM authority.

### REQ-EXEC-003 — Browser validity

The executor MUST be a normal web document targeted through `chrome.userScripts.execute`, not an
extension/offscreen page or persistent match registration used as an undocumented arbitrary-code
host. Pack mode requires the Chrome 135+ exact-target execution API and a `USER_SCRIPT` world id, while
the measured current CWS source already declares `minimum_chrome_version: "138"`. Pack work MUST NOT
lower that existing compatibility floor; the final candidate preserves/discloses Chrome 138 or a
higher independently approved baseline. The exact execution model MUST be proven in real Chrome.

Chrome API basis: <https://developer.chrome.com/docs/extensions/reference/api/userScripts>

### REQ-EXEC-004 — Session lifetime

The executor MUST remain connected while provider tabs navigate. It MUST be scoped to one AXSDK
session and `packSetDigest`, and MUST be closed/released when that session ends.

### REQ-EXEC-005 — Stateless commands

Task and provider commands MUST be stateless across calls except for immutable reviewed constants and
their frozen command table. Inputs MUST contain every required value; outputs MUST publish every
downstream value. Comparison, pagination, navigation, retry, and mutation truth MUST remain in
flow/session/coordinator state or the authenticated page, not Pack globals.

### REQ-EXEC-006 — Multiple sessions

The same pack active in multiple session groups MUST resolve to the correct executor connection.
Connections MUST be addressed by pack id, version, group/session, tab, frame, and document.

### REQ-EXEC-007 — Invocation-only script lifecycle

Loading or recovery re-execution of a task/provider artifact MUST idempotently install one immutable
command table and maintain one authenticated, versioned Broker v2 connection per
world/document/digest. It MUST NOT duplicate listeners or command state. Before a broker-validated
invocation, it MUST NOT read or write page state, navigate, issue network requests, persist data,
render UI, or perform a declared effect.
Provider navigation MUST be returned as `step: "navigate"` for the coordinator; a script MUST NOT
change `location` directly. Pack network access MUST go through a fixed versioned service rather than
direct `fetch`, XHR, WebSocket, beacon, or form submission from downloaded code.

### REQ-EXEC-008 — Bootstrap authentication

Before each exact-target execution, the extension MUST create a 256-bit cryptographically random,
single-use, short-lived handshake nonce bound to the expected session/group, tab, frame, document id,
role, artifact digest, commands digest, world id, and current URL. The packaged bootstrap receives that
nonce separately from the signed artifact and opens the versioned Broker v2 port. The extension MUST
accept the connection only after the port sender and returned `InjectionResult.documentId` match the
same pending record; a port arriving first remains quarantined until the execution result matches.
The connection MUST remain dispatch-ineligible until the packaged bootstrap has accepted exactly one
frozen command table whose command names/schema digest match the signed binding. The nonce MUST be
invalidated after one match, navigation, timeout, or failure and MUST NOT be persisted, logged, or
exposed to flow/model state. Reconnection requires a fresh exact execution and nonce.

### REQ-EXEC-009 — Exact-document acquisition

Before any Pack source executes, the extension MUST run a packaged no-op with its existing
`chrome.scripting` permission against `frameIds: [0]` to obtain the current main-frame
`InjectionResult.documentId`, then revalidate the tab URL. `chrome.userScripts.execute` MUST target
that exact `documentIds: [id]` and MUST NOT combine `documentIds` with `frameIds`. Missing/mismatched
document identity MUST refuse execution; falling back to a frame-only or persistent-match injection is
forbidden. The packaged no-op is the only operation allowed to race onto a replacement document and
has no page/data side effect.

## 9. Provider and extension-point requirements

### REQ-PROV-001 — Typed contribution

A Provider Pack MUST contribute to a named Agent Pack extension point and exact contract version. A
contribution to an absent or incompatible Agent Pack MUST remain inactive.

### REQ-PROV-002 — Automatic discovery

After explicit Pack 2 install/enable and successful recomposition, Pack 1 MUST discover Store X from
the provider registry without modifying Pack 1 bytes or graph.

### REQ-PROV-003 — Inclusion policy

For Shopping Comparison:

- V1 preserves the current hard frontier of at most three providers per shopping task;
- a generic comparison uses enabled defaults directly only when at most three are selected;
- “all enabled stores” surfaces the complete enabled set, including Store X, and asks the user to
  choose at most three rather than silently truncating;
- an explicit store list searches only the named providers and asks when it names more than three;
- provider enablement and default selection remain independently configurable.
- enabling a provider that requests default inclusion beyond the frontier MUST ask which defaults to
  keep before activation commits; it MUST NOT silently evict an existing default or ignore the new one.

### REQ-PROV-004 — Canonical provider identity

The bridge MUST stamp provider id, label, pack id, release version/digest, contribution contract, and
cart support from installed metadata. It MUST resolve and enforce entry/product URL rules from the
same metadata without exposing them as provider-authored output. Provider output MUST NOT supply any
of these authority fields.

### REQ-PROV-005 — Search contract

`commerce.storefront.v1` MUST be read-only and accept one query/page/limit per call. It MUST return a
bounded canonical result with classified status, cards seen, pagination evidence, and at most six
candidates.

### REQ-PROV-006 — Search validation

The fixed validator MUST reject:

- malformed, missing, or empty candidate arrays for `status=candidates`;
- more than six candidates;
- missing product id/name/URL/price/currency;
- non-finite or non-positive prices;
- negative shipping cost;
- off-host or disallowed product URLs;
- provider-supplied rank, normalized total, identity approval, comparison id, source label, or cart
  authority;
- oversized or schema-invalid output.

Missing shipping MUST remain unknown and MUST NOT become zero.

### REQ-PROV-007 — Controlled navigation

The provider coordinator MUST accept only task pack id, extension point, provider id, command, and
validated arguments. Entry URL, version, script id, hosts, and URL rules MUST resolve from the active
composition. Every entry, navigation, landing, and product URL MUST parse as HTTPS with no credentials
or control characters, match a signed exact origin (including any non-default port), and satisfy the
signed path/query rule after URL normalization. Redirects are revalidated hop-by-hop; `javascript:`,
`data:`, `blob:`, unapproved subdomains, and origin-confusable suffix matches are refused.

### REQ-PROV-008 — Re-entrant page protocol

Provider search MUST use a bounded invocation envelope with `step=done`, `step=navigate`, or
`step=blocked`. `step=done` carries the canonical search result whose own `status` is
`candidates`/`no_results`/another classified store outcome. A navigation URL MUST match signed
approved provider matches. The coordinator MAY re-invoke a read/page-write search step after document
change, but MUST NOT replay an uncertain mutation.

### REQ-PROV-009 — Classified failures

Login, CAPTCHA, access denial, no results, price unavailable, timeout, malformed output, revoked pack,
document change, and broker unavailability MUST remain distinct outcomes. CAPTCHA bypass is forbidden.

### REQ-PROV-010 — Provider removal isolation

Disabling/removing/revoking Store X MUST remove only Store X from future provider sets. Pack 1 and
other providers MUST remain functional.

### REQ-PROV-011 — Provider identity and alias collisions

Provider ids MUST be unique within an extension point after exact canonical-id validation; a duplicate
id rejects composition. Labels and aliases are display/input aids, not authority. If normalized
labels/aliases map a user's store name to more than one enabled provider, the flow MUST ask the user
which provider they mean and MUST NOT choose by install order, version, or model guess.

## 10. Shopping parity requirements

### REQ-SHOP-001 — Complete shopping flow set

Shopping Agent Pack MUST replace:

- `shopping_multi_store_total_cost`;
- `shopping_search_one_store`;
- `shopping_single_site`;
- `checkout`.

### REQ-SHOP-002 — Existing deterministic behaviour

The Pack MUST preserve query variants, brand aliases, model-code anchors, identity options/locking,
relevance screening, result normalization, pagination bounds, FX conversion, shipping honesty,
incomplete-total folding, ranking, window paging/refinement, snapshot invalidation, store outcomes,
and cancellation.

### REQ-SHOP-003 — FX

Pack 1 MUST use the fixed versioned `platform.fx.v1` service for `api.frankfurter.dev`.
Multi-currency total-cost comparison MUST fail visibly when the service is unavailable and MUST NOT
invent a conversion. Downloaded task/provider code MUST NOT fetch FX rates directly.

### REQ-SHOP-004 — Separate cart contract

Search installation MUST NOT imply cart authority. A provider that supports current cart behaviour
MUST separately contribute `commerce.cart.v1` with distinct prepare, single-commit, and read-only
confirmation commands. Only commit carries the `cart_mutation` effect; the overall invocation
requires consent bound to the exact item, quantity, comparison, invocation, and approved maximum price
in one currency. The existing numbered offer-selection turn MAY satisfy that consent without a second
prompt only when successful `prepare` returns the same identity/currency/quantity and a current price
at or below the approved maximum; any other difference invalidates it and requires new consent.

### REQ-SHOP-005 — Cart guards

Cart invocation MUST preserve current approval markers, identity/version binding, comparison binding,
quantity validation, product-page identity re-read, price re-read, exact-item confirmation, and
fail-closed behaviour. The coordinator MUST durably mark the mutation frontier before dispatching
commit exactly once. Navigation or port loss after dispatch MAY invoke only the declared read-only
confirmation command on an authenticated approved landing document; it MUST NOT invoke commit again.
A selection from a stale comparison MUST be refused.

### REQ-SHOP-006 — Checkout review

`commerce.checkout-review.v1` MAY navigate to and read an order-free checkout review. It MUST NOT
expose, invoke, or simulate place-order/payment controls.

### REQ-SHOP-007 — Read-only providers

A provider without cart contribution MUST remain visible as comparison-only. Selecting it MUST return
its approved product URL and MUST NOT call cart or checkout.

## 11. Non-shopping parity requirements

### REQ-QUOTE-001 — Quote Agent Pack

Service Quote Agent Pack MUST preserve collection of service, requirements, ZIP/address, contact,
memory recall, search, shortlist browsing, selection, confirmation, cancellation, and completion
reporting.

### REQ-QUOTE-002 — Thumbtack Provider

Thumbtack Provider Pack MUST preserve re-entrant search, canonical page detection, pro normalization,
access classification, quote modal handling, option selection, bounded waits, transient-op tolerance,
and detailed stop telemetry.

### REQ-QUOTE-003 — Never submit

The migrated quote path MUST stop at or before the existing contact/lead boundary and MUST NOT click a
final submit/send control. Absence or ambiguity MUST fail closed.

### REQ-QUOTE-004 — Typed quote-provider contract

A quote Provider Pack MUST contribute only to a versioned `service.quote.v1` extension point. It MUST
expose a read-only `search_providers` command with bounded canonical provider candidates/classified
status and a separate `drive_safe_quote` command with effect `external_send`. `drive_safe_quote` MUST
accept the exact selected provider, service, requirements, contact fields, consent binding, and
bounds; it MUST return bounded step/answer/last-step/stop telemetry. The contract MUST define no final
submit/send command.

### REQ-QUOTE-005 — Quote consent and recovery

The deterministic provider-selection confirmation MAY satisfy per-invocation consent only for the
exact selected provider/service/requirements/contact payload. Cancellation before dispatch performs
no page work. Once `drive_safe_quote` crosses its effect frontier, timeout/navigation/port loss MUST
NOT replay it; absent signed read-only confirmation, the outcome remains `uncertain` with its last
validated telemetry.

### REQ-MEM-001 — Memory Agent Pack

Memory Agent Pack MUST preserve explicit save/update/read/list/search/delete, category deletion,
consumer-facing presentation, no-match handling, cancellation, and reserved-value tests.

### REQ-MEM-002 — Fixed memory service

Current cross-turn memory semantics MUST remain a packaged typed service, not per-Provider local
storage. The service MUST support the current `get`, `search`, and bulk set/delete semantics and
consent boundaries.

### REQ-MEM-003 — Capture hook

The explicit memory clause capture hook MUST run through a typed `beforeIntent` slot. A clause without
explicit consent MUST NOT be captured. Hook failure MUST NOT stall unrelated tasks.

### REQ-MEM-004 — Memory service receipts and idempotency

`platform.memory.v1` MUST expose closed get/search/bulk-set/delete contracts. Set/delete carry
`state_write`, an explicit-consent marker, exact normalized keys/values, and a session-scoped
idempotency key. The service MUST deduplicate the same operation id and return a validated receipt
containing the fields actually written/deleted; presentation MUST use that receipt rather than
untrusted prior flow state. Reads return exact bounded values/matches and never storage internals.

### REQ-NAV-001 — Site navigation

A Site Navigation Agent Pack and BlueMoonSoft Provider/data pack MUST preserve signed sitemap search,
approved target resolution, same-document fragment handling, cross-document navigation, and honest
failure classification.

### REQ-NAV-002 — Signed target authority

Model/Pack input MUST NOT provide an arbitrary navigation URL. `platform.sitemap.v1` returns a bounded
signed target reference from the current approved site data; `platform.provider-navigation.v1`
resolves that reference or a manifest-owned provider route, validates the normalized HTTPS target,
and owns same-document fragment, cross-document arrival, redirect, and failure semantics. A consumed
fragment that names content already present may report `already_open`; it MUST NOT fabricate that the
hash remains applied.

### REQ-COMM-001 — Community control surface

The product MUST preserve user questions about installed scripts, read-only catalog/prerun answers,
command proposal, widget confirmation, cancellation, and broker result presentation. It MUST NOT let
the model install or approve a script.

### REQ-TERM-001 — Product terminals

Unsupported-request and end-conversation behaviour MUST remain available from the fixed product shell
or a first-party system pack.

### REQ-DEV-001 — Development commands

`AX_echo`, `AX_resolve_zip`, and `AX_read_page` callers MUST be removed or migrated to explicit
development tools before their Lua sources are deleted. Development commands MUST NOT be confused
with CWS task-pack capability.

## 12. Packaged service requirements

### REQ-SVC-001 — Closed services

Capability-free flow fragments MAY call only versioned packaged services declared in the Agent Pack
manifest. Initial service contracts are:

- `platform.memory.v1`;
- `platform.sitemap.v1`;
- `platform.fx.v1`;
- `platform.geocode-us-zip.v1`;
- `platform.widget-confirm.v1`;
- `platform.provider-navigation.v1`.

### REQ-SVC-002 — No raw-op regression

Service contracts MUST NOT expose a generic op name, selector, arbitrary URL, module name, code string,
or capability grant. The packaged service implementation owns and audits its internal op vocabulary.

### REQ-SVC-003 — Disclosure

Install/update UI MUST disclose every service dependency and network host. A new service dependency is
a capability expansion and requires approval.

## 13. Security requirements

### REQ-SEC-001 — Reviewed registry only

The CWS build MUST install only reviewed releases from signed configured registries. Arbitrary URL,
unsigned, local-file, and paste-code installation are forbidden.

### REQ-SEC-002 — UserScript-only dynamic execution

Dynamic Pack JavaScript MUST execute only through `chrome.userScripts.execute` in a named
`USER_SCRIPT` world, targeted to one verified tab and main-frame/document. Pack code MUST NOT use
persistent `userScripts.register` matches. It MUST NOT execute through extension `eval`, `Function`,
WebAssembly interpreter, service-worker import, CDP `Runtime.evaluate` as a code loader, or a
privileged sandbox bridge.

### REQ-SEC-003 — Host minimization

Task code MUST be executed only on the exact task-executor origin. Provider code MUST be executed only
after the coordinator verifies an approved provider URL and exact target document. Host expansion
requires explicit approval.

### REQ-SEC-004 — Input/output validation

The broker MUST validate command input immediately before dispatch and output immediately after
receipt, against signed installed schemas. Unknown keys MUST be refused rather than dropped.

### REQ-SEC-005 — Document-scoped identity

A live UserScript connection MUST match installed pack id, artifact/script id, version, commands
digest, world id, session/group, tab, frame, document id, execution result, and current approved URL.

### REQ-SEC-006 — Effect vocabulary and consent

V1 command effects are closed to `read`, `page_write`, `state_write`, `external_send`, and
`cart_mutation`; every command MUST declare exactly one. `read` MAY request coordinator-controlled
approved navigation needed for a read but MUST NOT mutate site/state data. `page_write` MAY change
local page controls but MUST NOT send user data or mutate a cart. `state_write` is limited to declared
packaged state services and requires explicit user intent in the active turn. `external_send` and
`cart_mutation` MUST ask per invocation with the exact proposed action. A command that omits required
confirmation MUST be refused. Consent denial MUST perform no side effect.

### REQ-SEC-007 — Forbidden effects

Purchase, order placement, and payment MUST remain absent from the effect vocabulary, pack contracts,
provider contributions, UI actions, and fixed services.

### REQ-SEC-008 — No effect replay

Timeout, navigation, port loss, or unknown acknowledgement after an `external_send` or
`cart_mutation` dispatch MUST NOT replay that effectful command. A separately declared read-only cart
confirmation command MAY resolve a cart outcome only from exact site evidence on an authenticated
approved document; otherwise the result MUST remain `uncertain`/refused. An external send with no
signed read-only confirmation contract remains `uncertain`.

### REQ-SEC-009 — Secret safety

Registry artifacts, logs, traces, diagnostics, pack contexts, and user-visible errors MUST NOT include
API keys, auth tokens, cookies, credentials, private endpoints, or raw configuration stores.

### REQ-SEC-010 — Model context minimization

Model context MAY contain bounded human-readable pack/provider labels, commands, effects, required
argument names, and compact results. It MUST NOT contain signatures, capability tokens, source code,
artifact URLs, full manifests, or large candidate payloads.

### REQ-SEC-011 — Reviewed-code trust boundary

A `USER_SCRIPT` world isolates Pack code from extension APIs and other script worlds; it is not a
capability sandbox for the page on which the script runs. Reviewed downloaded JavaScript can directly
observe or mutate the exact approved target page if malicious. Multiple Agent Pack worlds on the
shared static executor also share its DOM even though their JavaScript globals differ; every task
artifact command MUST declare `read`, perform no DOM/page operation, and pass release-review/static
tests for that invariant. Provider artifacts may touch only their exact provider document. The
script-topology gate MUST bar this extension's enabled community v1 registrations from that role
document; it cannot attest against the provider page itself or scripts installed by another
extension. “Trusted provider result” means signed reviewed code, exact approved URL, and validated
schema—not a pristine third-party DOM. Agent Pack V1 is a signed configured-registry trust model, not
isolation for mutually malicious Pack publishers. The host MUST use exact-target
`chrome.userScripts.execute`, bootstrap MUST satisfy REQ-EXEC-007/008, and
review MUST reject undeclared direct navigation, network, storage, UI, DOM (for task artifacts), or
effects.
Broker validation constrains what the platform/model can request; it MUST NOT be described as
technically preventing arbitrary behaviour inside an already trusted artifact.

### REQ-SEC-012 — Pack world policy

Every Pack world MUST use a Pack-owned digest-qualified id and an explicit User Scripts world
configuration with messaging enabled and a closed CSP that omits `unsafe-eval` and
`wasm-unsafe-eval`, sets `connect-src 'none'`, and sets `object-src 'none'`. Pack cleanup MUST reset
only exact Pack world ids. CSP is defense in depth for world-origin APIs; it MUST NOT replace signed
review because a script can still mutate its approved page DOM and trigger page behaviour.

### REQ-SEC-013 — Declared data flow

Every command and fixed service schema MUST have a signed companion data-flow map that classifies
every leaf JSON Pointer as public product data, user content, personal data, or secret/forbidden and
declares whether it may reach page DOM, extension state, the AXSDK backend/model, or fixed-service
egress. The map MUST NOT alter the existing JSON Schema dialect sent to the platform. Install/update
UI and CWS privacy disclosures MUST reflect the signed declaration. The broker MUST refuse uncovered
fields, undeclared personal fields, and every secret/forbidden field. Personal data MAY cross only for
the active user-requested contract with its required consent and MUST NOT enter lifecycle logs,
diagnostics, catalog metadata, or registry storage.

## 14. Lifecycle and state requirements

### REQ-STATE-001 — Installed state

Installed state MUST preserve exact manifest fields needed for later authorization: pack/release id,
version, digests, contracts, commands, effects, schemas, data-flow maps, hosts, fixed-service
dependencies/egress disclosures, contributions, review, enabled/revoked state, and approvals.

### REQ-STATE-002 — Composition state

Active composition MUST contain canonical route contributions, resume rules, hooks, Agent Pack command
bindings, provider registry, service dependencies, exact versions, `packSetDigest`, and a
`providerRegistryDigest` over every active contribution/setting.

### REQ-STATE-003 — Result provenance

Every task/provider result entering flow state MUST carry bounded provenance sufficient to identify
Agent Pack, Provider Pack, command, exact release version/digest, and provider id. It MUST NOT trust
provenance fields returned by the script.

### REQ-STATE-004 — Comparison state

Each task's `providerSetDigest` MUST hash its ordered selected provider ids, exact release digests,
contracts, and task version. Comparison ids MUST bind that digest and the identity version. A previous
listing number MUST fail after any change to listed offers, selected provider order/set, provider
release, contract, or task version.

### REQ-STATE-005 — Storage separation

Pack artifacts MUST live in content-addressed IndexedDB storage. Lifecycle metadata MAY live in
extension storage. Flow truth remains in flow/session state. V1 task/provider commands MUST remain
stateless and MUST NOT write page-origin local/session storage or IndexedDB; no Pack script-private
store is introduced. Source text MUST NOT be copied into legacy flow/Lua stores.

### REQ-STATE-006 — Restart recovery

Service-worker restart, browser restart, and extension update MUST reconstruct the new-session
default composition, live/restorable pinned compositions, task executor, provider settings, and
exact role-document execution state from verified persisted metadata/assets. Missing Pack
connections MUST be re-executed only on a freshly verified exact role document. A persisted mutation
frontier with no validated terminal result MUST recover as `uncertain` and MUST NOT dispatch commit
again.

## 15. UX requirements

### REQ-UX-001 — Install summary

Install UI MUST show:

- task routes and purpose;
- task-executor execution;
- embedded providers;
- external contributions;
- exact hosts;
- commands/effects;
- network hosts and fixed services;
- confirmation requirements;
- disclosures, reviewer, publisher, and version.

### REQ-UX-002 — Contribution wording

Store X installation MUST state that it adds Store X to Shopping Comparison, that the Store X adapter
runs on the Store X host, and that new generic comparisons in sessions created after activation
include it by default when enabled. It MUST state that already-running sessions remain pinned until
restart, and that Pack 1 remains on the task executor and does not gain Store X DOM access.

### REQ-UX-003 — Update diff

Update UI MUST distinguish code, flow, prompt/route, command/schema, host, effect, network, service,
and extension-point changes. Host/capability expansion MUST be highlighted separately.

### REQ-UX-004 — Bound visibility

If enabled providers exceed the Agent Pack bound, the user MUST see a provider-selection question.
The system MUST NOT silently search a subset while presenting it as complete.

### REQ-UX-005 — Failure language

User-visible failures MUST name the affected provider and actionable classification. Internal wire
codes MAY appear in diagnostics but SHOULD be translated in the comparison window.

### REQ-UX-006 — Migration

Because pack install/enable requires user approval, the product MUST provide a one-time migration UI
for existing functionality. It MUST NOT claim identical out-of-box behaviour before the user approves
the parity pack set.

### REQ-UX-007 — User Scripts availability

Before enable/activation, the extension MUST feature-detect exact-target
`chrome.userScripts.execute`/`documentIds` support and the user's Chrome “Allow User Scripts” setting.
If unavailable or disabled, the release remains installed but inactive, the previous composition
remains usable, and the UI provides actionable browser/update/enablement instructions. The extension
MUST NOT claim success, partially execute code, or attempt to change that browser setting on the
user's behalf.

## 16. Non-functional requirements

### REQ-NFR-001 — Determinism

Canonical manifest, composition, provider registry, and digest output MUST be byte-deterministic for
the same inputs.

### REQ-NFR-002 — Bounded data

Command input/output, catalog text, model context, candidate count, navigation steps, pages, calls,
wall time, artifact sizes, retained composition versions, active Pack worlds, and restore pins MUST
have enforced bounds. Truncation/eviction MUST be explicit and MUST never evict a live pin.

### REQ-NFR-003 — No extra model calls for plumbing

Pack lookup, provider discovery, composition, schema validation, task command invocation, and provider
dispatch MUST be deterministic platform/client work and MUST NOT add model calls.

### REQ-NFR-004 — Composition outside the turn

Install/update composition and compile MUST happen before activation, not during a user message.

### REQ-NFR-005 — Isolation

A failed or removed provider MUST not invalidate unrelated provider results. A malformed pack MUST not
prevent the last valid composition from starting.

### REQ-NFR-006 — Observability

Diagnostics MUST record lifecycle stage, composition digest, pack/provider ids and versions, command,
target role, timing, structured failure, and consent outcome without logging arguments/results that
contain user data or secrets.

### REQ-NFR-007 — Accessibility

Pack lifecycle, permission, update-diff, provider-selection, and consent UI MUST be keyboard accessible
and expose semantic labels.

### REQ-NFR-008 — Invocation serialization

Broker v2 MUST permit at most one in-flight command per Pack connection/document and MUST bound any
queue. Parallelism MAY occur across distinct session or provider documents, never by overlapping
effects on one document. One bounded service-worker script-topology lock MUST serialize community v1
registration reconciliation with Pack role-document acquisition/re-entry. If both topology and
per-connection locks are required, topology is acquired first; Broker dispatch MUST NOT upgrade a held
connection lock. Every path releases locks on refusal/failure. A timeout or lost acknowledgement MUST
quarantine that connection until the command settles or its role document is replaced. Mutation
recovery MAY perform only the REQ-SHOP-005 read-only confirmation; it MUST report uncertain when exact
confirmation is absent and MUST never replay commit.

## 17. AXSDK package requirements

### REQ-PKG-001 — Shared pack contracts

A new browser-independent `@axsdk/packs` package MUST own manifest schemas, canonicalization, digest
logic, restricted-flow validation, extension-point contracts, deterministic composition, compatibility
diagnostics, and serializable protocol types. It MUST NOT own Chrome APIs, network fetch, key storage,
or UI.

### REQ-PKG-002 — `@axsdk/core`

`@axsdk/core` MUST accept a dedicated validated `packFlows` layer and composition provenance only for
a Pack-mode session. It MUST NOT treat independent pack fragments as generic `mergeWith` layers.
Pack mode MUST send `packFlows` and omit current `clientFlows`/`clientLuaModules` and local Lua
execution without clearing their persisted stores. With no Pack host/composition, existing
`AXSDK.init`, client-flow/Lua resolution, stores, events, and outbound session/message field sets MUST
remain unchanged.

### REQ-PKG-003 — `@axsdk/extension-cdp`

The shipping extension MUST own registry fetch/trust, installation, permission UI, artifact storage,
exact-document UserScript execution/world lifecycle, task executor, provider coordinator,
document-scoped broker, consent, revocation, recovery, and `packFlows` delivery to core.

### REQ-PKG-004 — `@axsdk/lua`

`@axsdk/lua` MUST NOT execute Agent Pack code. Its published standalone runtime and the existing
`@axsdk/core/lua` compatibility surface MUST remain supported. The CWS Pack path MUST have no runtime
dependency on pack-delivered Lua or Lua modules; removing Fengari from the CWS bundle MUST use an
extension-specific build boundary rather than deleting Lua support from generic `@axsdk/core`.

### REQ-PKG-005 — `@axsdk/react`

`@axsdk/react` SHOULD expose browser-agnostic pack lifecycle/update/consent components or state models
only through a separate `@axsdk/react/packs` export. The existing root export and CSS MUST NOT import
or initialize Pack UI. Chrome permission calls remain extension-owned.

### REQ-PKG-006 — `@axsdk/browser`

`@axsdk/browser` MUST remain a generic embed and MUST NOT imply Chrome UserScript support, create Pack
tabs, or add Pack code to its default bundle. A future host MAY implement the same `@axsdk/packs`
contracts through an explicit PackHost adapter.

### REQ-PKG-007 — `@axsdk/voice`

`@axsdk/voice` requires no pack-specific execution changes or new dependency. Finalized transcripts
MUST continue through the existing `@axsdk/core` message/event path; a Pack-mode session's pinned
composition then decides routing.

### REQ-PKG-008 — Legacy extension

`@axsdk/extension` MUST NOT receive a second Agent Pack implementation. New CWS work targets
`@axsdk/extension-cdp`; legacy runners are ported or retired before being used as shipping evidence.

### REQ-PKG-009 — AXSDK platform

The AXSDK platform flow runtime MUST support compile-only validation, restricted task/provider/service
action implementations, composition provenance, and structured client-op routing. It MUST NOT manage
browser pack installation or permissions.

### REQ-PKG-010 — `axsdk-sites`

`axsdk-sites` MUST become the first-party pack source/registry publisher and parity fixture repository.
After clean cutover, its CWS package build MUST no longer publish local common/site flow, Lua, or Lua
module runtime layers.

## 18. Backward compatibility and side-effect requirements

### REQ-COMPAT-001 — Zero-install no-op

When no Pack is installed, Pack support MUST NOT create executor/provider tabs, UserScript
executions or worlds, Pack model context, network requests, permission prompts, persistent Pack
records, or Pack wire fields. Installing a Pack disabled MAY persist only its verified lifecycle
state/assets; until enabled it MUST cause no execution/session side effect. Before the clean cutover,
the current C3 workspace, local flow/Lua/module path, toolbar start, session console, recorder,
options, and community-script path MUST otherwise behave as before. After clean cutover, no enabled
Pack means only the minimal product shell and Pack Manager are available; legacy local sources MUST
NOT be restored as fallback.

### REQ-COMPAT-002 — Session runtime-mode isolation

Every new session MUST pin exactly one runtime mode: `legacy-local` or `packs`. A session MUST NOT
merge, race, or fall through between the local flow/Lua graph and a Pack graph. Before the full
cutover, Pack live proofs MUST use an explicitly selected isolated profile/app/session; production
continues in `legacy-local` mode by default.

### REQ-COMPAT-003 — Core API compatibility

Existing `AXSDK.init` configuration fields, exported names/signatures, store semantics, event names,
session creation, message sending, durable calls, client flows, Lua modules, and site refresh MUST
remain source- and behaviour-compatible when Pack input is absent. Pack configuration MUST be
optional, installed before first init, and immutable for the pinned session.

### REQ-COMPAT-004 — Wire capability negotiation

Core MUST omit Pack composition/provenance fields and Pack action names unless the host selected Pack
mode and the platform advertised the matching protocol version. Pack capability negotiation through
the existing pre-session app-info call MUST succeed before any executor/provider tab, Pack
`USER_SCRIPT` execution/world, Pack session field, or Pack action is created. Old clients MUST remain
accepted by the upgraded platform; old platforms MUST receive the existing request field set from
non-Pack clients. Unknown-version Pack frames MUST fail before a page or mutation is reached.

### REQ-COMPAT-005 — Pure shared package

Importing `@axsdk/packs` or any of its subpaths MUST perform no I/O, global mutation, timer/listener
registration, environment probing, storage access, or Chrome access. It MUST publish ESM, CommonJS,
and type declarations compatible with the current SDK release process.

### REQ-COMPAT-006 — Root bundle isolation

`@axsdk/react/packs` MUST be a separate entry and style surface. Default `@axsdk/react`,
`@axsdk/browser`, `@axsdk/voice`, and `@axsdk/extension` builds MUST NOT import Pack UI, composer,
registry, Chrome host, or task/provider artifacts. Bundle-size and module-graph regressions MUST be
measured rather than assumed tree-shaken.

### REQ-COMPAT-007 — Lua consumer compatibility

Pack migration MUST NOT remove `@axsdk/lua`, `@axsdk/core/lua`, default Lua configuration, stored Lua,
client Lua modules, or durable Lua behaviour from published generic SDK packages. CWS-only dependency
removal is permitted only after its extension-specific callers are replaced and its own artifact gate
passes.

### REQ-COMPAT-008 — Storage and garbage-collection isolation

Pack lifecycle metadata and artifacts MUST use versioned keys/databases distinct from
`axsdk:community-scripts`, `axsdk-community-artifacts`, `axsdk-community-storage`, legacy SDK stores,
and session chat/trace keys. Pack garbage collection MUST enumerate only Pack-owned assets.
“Reset shared SDK state” MUST use an explicit SDK-store allowlist and MUST NOT erase Pack or existing
community-script installations.

### REQ-COMPAT-009 — UserScript namespace isolation

Pack world ids, port names, bootstrap protocol, and message types MUST have dedicated versioned
namespaces. Pack world cleanup MUST reset only Pack-owned world ids after their last document/session
reference ends. Broker v1 and Broker v2 MUST ignore foreign ports/messages without disconnecting or
consuming them, and configuring/resetting a Pack world MUST NOT mutate an existing community world.

### REQ-COMPAT-010 — Existing community-script compatibility

The existing community single-script install/list/enable/disable, catalog/prerun, argument validator,
private storage, network broker, widget confirmation, and result presentation MUST retain their v1
state/schema/limits and behaviour on ordinary approved pages. Agent Pack registry trust and output
validation MUST be implemented beside that path, not by tightening or migrating v1 records in place.

Pack code MUST NOT share an extension-created executor/provider role document with an enabled
community v1 registration that may match its URL. Before role-tab creation, provider navigation,
recovery, or exact execution, the service worker MUST inspect the complete registered v1
match/exclude configuration under the same script-topology lock used for community reconciliation.
Any possible match, unsupported pattern, or inconclusive inspection MUST refuse Pack role acquisition
as `community_script_conflict` before Pack code executes; the UI names the conflicting v1 script and
asks the user to disable it. Pack code MUST NOT disable, remove, rewrite, or consume that script's
port/state. If an explicit v1 enable/update would newly collide with a live Pack role document, the
extension MUST settle/quarantine that role under REQ-REL-011 and retire it before registering the v1
script. The community action completes; later Pack work remains classified-unavailable until the
conflict is removed.

### REQ-COMPAT-011 — Tab-role compatibility

Executor/provider roles MUST be additive optional metadata on `AgentSessions`. Existing snapshots
without roles MUST parse unchanged. The current first-member `primaryTabIdOf` result, page-location
source, opaque client ids, manual group membership, and ordinary untargeted CDP dispatch MUST remain
unchanged. Infrastructure tabs MUST be created inactive, appended without promotion, and never steal
focus. If an infrastructure tab leaves its session group, changes role URL unexpectedly, or is
replaced, its connection MUST be invalidated; an ordinary user tab MUST NOT inherit the role. Recovery
may create a new inactive extension-owned role tab only while a user-owned session tab remains live.

### REQ-COMPAT-012 — Session end and restore compatibility

Pack-created infrastructure tabs MUST NOT keep a session alive after all user-owned tabs leave.
Ending a Pack session MUST close only extension-created infrastructure tabs, never user tabs.
Restore fingerprints MUST exclude executor/provider infrastructure URLs, and any new Pack-scoped
session keys MUST move atomically with the existing chat/trace keys.

### REQ-COMPAT-013 — Permission and DNR compatibility

Pack approval is a product-level exact-host/effect decision layered inside the extension's existing
required `http://*/*` and `https://*/*` permissions. Pack lifecycle MUST NOT request/remove those
Chrome origins, alter existing content-script matches, or replace the backend's fixed dynamic DNR
rule. Fixed-service egress MUST be validated at its closed service adapter.

### REQ-COMPAT-014 — Startup failure containment

Pack manifest/store/composer/executor/world failures MUST be caught outside the existing packaged
workspace installer, toolbar/session startup, community broker/reconciler, settings, and console
paths. A Pack subsystem failure in `legacy-local` mode MUST leave current behaviour available. A
pinned Pack-mode session MUST fail explicitly rather than silently fall back to local execution.

### REQ-COMPAT-015 — Build and harness continuity

Existing `build`, `build:cws`, harness, package-workspace, community UserScript, and local/live scenario
commands MUST keep their current contracts until the final cutover. Pack development MUST add separate
preview/build inputs first; it MUST NOT repurpose the current C3 artifact or clear legacy source stores
while production still selects `legacy-local`.

### REQ-COMPAT-016 — Compatibility regression gate

Before any Pack-capable CWS release, tests MUST prove:

- current package root exports and existing public type signatures remain available;
- core with no Pack input emits the existing session/message field set and runs current flow/Lua;
- browser, voice, React root, Lua, and legacy extension builds/tests remain green;
- extension startup with no Packs creates no extra tab/UserScript execution/world/storage write;
- an enabled matching community v1 script blocks Pack role-document acquisition before execution,
  remains installed/functional itself, and permits Pack work after the user disables the conflict;
- shared-state reset, Pack garbage collection, enable/disable, and revocation preserve unrelated
  community/SDK state;
- old session snapshots restore with the same primary tab and conversation;
- Pack infrastructure does not change focus, group end, restore matching, or untargeted CDP routing.

### REQ-COMPAT-017 — Page/RPC operation isolation

Pack task/provider invocation MUST use a distinct namespaced client-action route. It MUST NOT add
Pack commands to or change the semantics of the current `createRpcOpTable`, `LOCAL_OPS`, CDP
dispatcher, `AX_OVER_CDP`, page bundle, default form tools, Lua command registry, or untargeted page
operation path. A fixed service MAY reuse an existing implementation only behind its versioned closed
service adapter and existing tests.

### REQ-COMPAT-018 — Package dependency isolation

Adding Pack support MUST NOT add a runtime dependency on `@axsdk/packs` to `@axsdk/core`,
`@axsdk/react`, `@axsdk/browser`, `@axsdk/voice`, `@axsdk/lua`, or `@axsdk/extension`.
`@axsdk/core` MUST own only its narrow optional Pack-mode host/wire types;
`@axsdk/react/packs` MUST use local view-model types and callback inputs. Only
`@axsdk/extension-cdp`, authoring/build tools, tests, and platform composition tooling MAY take a
runtime dependency on the pure package. Existing package dependency graphs and default bundle graphs
MUST otherwise remain unchanged.

### REQ-COMPAT-019 — Chrome-version cutover

Pack execution technically requires Chrome 135+ because `chrome.userScripts.execute`,
`InjectionResult.documentId`, and named `USER_SCRIPT` worlds are load-bearing isolation primitives.
The current CWS source already requires Chrome 138. Transitional releases feature-detect Pack APIs
and leave Pack mode inactive on an incompatible runtime; the final empty-local-source CWS candidate
MUST preserve `minimum_chrome_version: "138"` or a higher separately approved value, disclose it, and
MUST NOT ship a persistent-registration fallback.

## 19. Migration requirements

### REQ-MIG-001 — No early deletion

No current local flow/Lua source may be removed while any current route, resume rule, hook, tool
contract, dev command caller, provider config, or exact-artifact scenario lacks a pack/service owner.

### REQ-MIG-002 — Ordered migration

Migration MUST proceed in this order:

1. shared contracts and restricted composer;
2. multi-asset installer/store and task executor;
3. broker v2 and fixed action path;
4. read-only shopping Pack 1 + Store X fixture;
5. current storefront search providers;
6. cart and checkout-review contracts;
7. single-site shopping;
8. quote and Thumbtack;
9. memory and hook;
10. sitemap/navigation and BlueMoonSoft;
11. community control/terminals/dev tools;
12. full exact-artifact parity;
13. clean deletion of local runtime sources.

### REQ-MIG-003 — One source during cutover

Production MUST select one whole runtime mode at session creation. Before full parity, Pack-mode live
proofs run in an isolated app/profile/session while production remains `legacy-local`; the two graphs
MUST NOT be composed or used as fallback for one another. After the deletion gate, new production
sessions switch atomically to `packs` mode.

### REQ-MIG-004 — Source builder cutover

The final workspace/package builder MUST have no dependency on `_common/flows.yaml`,
`_common/scripts`, `_common/rpc`, site flow layers, or site scripts for CWS runtime behaviour. An
empty-local-source regression MUST prove this.

### REQ-MIG-005 — Fresh-profile evidence

The final proof MUST use a fresh CWS candidate profile with no stored flow/Lua/module overrides. Trace
ownership MUST show signed Agent Pack flow assets and `USER_SCRIPT` artifacts, with no packaged/stored
workspace Lua or runtime Lua modules.

### REQ-MIG-006 — Final-update legacy-session handling

A CWS update cannot wait for every user's legacy session to finish. The final empty-local-source
candidate MUST therefore recognize persisted/restorable `legacy-local` session records without
loading old sources. On first recovery it MUST retain the conversation/primary-tab record, terminate
the incompatible flow with a translated `runtime_migrated` outcome, mark any unresolved effect
frontier `uncertain`, and require an explicit user restart into `packs` mode. It MUST NOT reinterpret
old flow state under a Pack graph, replay a deferred/effectful call, fetch deleted local sources, or
persist the old runtime as fallback. Pre-cutover releases MUST warn about this one-time boundary and
offer restart before the final update.

## 20. Acceptance scenarios

### AC-001 — Pack 1 baseline

```text
Install + enable Shopping Agent Pack 1
→ shopping routes become available
→ baseline providers are visible
→ broad discovery and exact-model comparison work
→ source provenance names Pack 1 and exact provider releases
```

### AC-002 — Store X extension

```text
Install + enable Store X Provider Pack 2
→ user approves Store X host/capability
→ if three defaults already exist, user includes Store X in the visible at-most-three default set
→ Pack 1 bytes and graph remain unchanged
→ `packSetDigest` and `providerRegistryDigest` change
→ next generic task in a newly started session has a `providerSetDigest` containing Store X's exact release
→ next generic comparison includes Store X
→ Store X output passes Pack 1 normalization/screening/identity/FX/ranking
→ one window contains baseline + Store X results
```

### AC-003 — Explicit scope

```text
With Store X enabled, ask for Amazon and eBay only
→ Store X is not searched
→ window states exactly the requested provider scope
```

### AC-004 — Removal isolation

```text
Disable/remove/revoke Store X
→ new comparison omits Store X
→ Pack 1 and baseline providers still work
→ no stale world/port/provider result remains
```

### AC-005 — Guarded cart

```text
Select an offer from the current comparison
→ exact identity/comparison/cart approvals are required
→ model and price are re-read
→ user approves one cart mutation
→ exact item is confirmed by the site
→ checkout/order/payment is not invoked
```

### AC-006 — Quote safety

```text
Run the current quote journey
→ service/requirements/location/contact persist
→ shortlist selection works
→ wizard advances only safe steps
→ stops before lead/final submit
→ no pro is contacted without the required confirmation
```

### AC-007 — Memory parity

```text
Save/update/read/list/search/delete reserved data
→ consent and consumer replies match current contracts
→ capture hook records only explicit clauses
→ quote recall sees the saved contact
```

### AC-008 — Full local-source deletion

```text
Build exact CWS candidate from a workspace with local flow/Lua runtime sources absent
→ package build passes
→ all current route/scenario gates pass
→ trace shows signed pack flow + USER_SCRIPT ownership
→ no local/packaged/stored Lua module executes
```

### AC-009 — Upgrade without Packs

```text
Upgrade to a pre-cutover Pack-capable build from a profile with current local sources and community scripts
→ enable no Agent Pack
→ no executor/provider tab, Pack UserScript execution/world, Pack storage write, or Pack wire field appears
→ current local routes, Lua/modules, community catalog/invocation, toolbar, and options still work
→ existing session restore keeps the same primary page and conversation
```

### AC-010 — v1 community collision isolation

```text
Enable one existing community v1 script whose match covers a Pack provider or task-executor URL
→ the community script still runs on its ordinary approved page
→ Pack role acquisition refuses community_script_conflict before creating/navigating the role tab or executing Pack code
→ the community registration, broker, storage, and result path remain unchanged
→ disable the conflicting community script and retry
→ Pack exact-target execution succeeds through its separate v2 port/world/state
→ enabling the v1 script again retires any affected Pack role before registration and never replays a mutation
```

## 21. Full deletion gate

The current local flow/Lua path MAY be removed only when:

- all eight current routed intents, default fallback, resume rules, and memory hook are represented;
- all 26 current flow-declared modules have pack/service replacements;
- development command callers are removed or replaced;
- all ten storefront configs are represented by signed provider artifacts/data;
- commerce all-sites, discovery, cart, checkout review, Thumbtack, memory, BlueMoonSoft, community
  control, cancellation, and no-order/no-submit exact-artifact scenarios pass;
- task-executor lifetime is proven in real Chrome;
- written REQ-REL-010 CWS policy approval covers both downloaded flow logic and Pack JavaScript;
- the final candidate preserves/discloses the current Chrome 138 minimum and contains no registration fallback;
- a fresh profile contains no workspace flow/Lua/module source layers;
- a real pre-cutover profile upgrade proves legacy session/chat retention, `runtime_migrated`,
  uncertain-frontier handling, explicit restart, and zero old-source fallback;
- registry, permissions, activation, rollback, revocation, and provider-isolation mutation tests pass;
- the package builder's empty-local-source regression passes;
- the zero-install, package API/build, community collision isolation, storage/reset/GC, tab-role,
  restore, no-focus, no-extra-wire-field, and platform-version compatibility gates pass;

Until then, any claim of full parity or authorization to delete the local sources is false.
