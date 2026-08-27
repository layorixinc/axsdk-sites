# Stateful Lua remote-poll migration plan

## Decision

Yes: cart additions, cart updates, checkout navigation, quote progression, quote submission, and form submission can use backend `execute.poll` **when each public AX command becomes a persisted, at-most-once operation state machine**.

The controller is retried; the browser side effect is not. Each poll attempt loads the same operation record, advances a durable phase only after a compare-and-swap commit, and observes the site. It schedules an action exactly once only from the phase that owns it. Once an action may have reached the site, later poll attempts observe evidence and never click or submit it again.

This replaces the current durable continuation with explicit operation state. It does not promise impossible exactly-once delivery at an arbitrary third-party website: a browser click and a remote site's effect cannot share one transaction. The guarantee is:

- **at most one browser dispatch per operation action sequence**;
- **no automatic re-dispatch after an uncertain action**;
- **terminal verified success only from site evidence**;
- **fail closed as `indeterminate` when the outcome cannot be proved**.

This is stronger than treating a mutation as pollable merely because a flow says `idempotent: true`.

## Why function-local state is not enough

A Lua local variable disappears on every full reload. The existing `dom.get_state` / `dom.set_state` capability is useful only as a per-origin cache: it serializes values under `localStorage` with the `axsdk:lua:state:` prefix. It cannot be the authoritative ledger because it is origin-scoped, can be unavailable, and does not serialize competing tabs or a post-response action.

The operation state must instead be owned by the extension/runtime and be available to every poll attempt, including attempts after a same-origin reload, a cross-host redirect, or a new content-script context.

The SDK already has the right coordination pattern:

- `ExecStateStore` provides versioned compare-and-swap commits.
- `commitExecState` retries pure transitions on a stale sequence.
- extension shells can serialize state through a service worker and shared extension storage.
- `axcall.ts` updates the backend call before invoking `ProcessedAXHandlerResult.after`.

Reuse that pattern for an operation ledger. Do not spread raw `localStorage` reads/writes through site Lua.

## Current baseline

`FLOWS.md` documents backend `execute.poll`:

- it repeats the exact mapped input while a JsonLogic predicate is true;
- only the final non-retrying result reaches a tool's ordinary output mapping;
- polling requires `kind: remote` and `idempotent: true`;
- `intervalMs` and `maxAttempts` are bounded;
- each attempt has an independent `execute.timeoutMs` deadline.

The current AX client path is durable/defer based:

- `axcall.ts` creates a `defer` for backend calls.
- `lua/manager.ts` routes `await`, `pause`, and navigation steps through the durable runner whenever that defer exists.
- `default-capabilities.ts` implements `nav.navigate`, `nav.ensure`, navigation-hinted `dom.click`, and navigation-hinted `dom.submit_form` as durable steps.
- Amazon and generic storefront cart commands use page state plus durable replay to avoid re-clicking after a navigation.
- `AX_submit_quote` currently performs a bounded imperative loop of answer/submit clicks and waits in one call.

The poll transport must therefore carry two additions not present in the current site Lua contract:

1. a stable, internal operation identity shared by every attempt in one logical poll; and
2. a persisted operation ledger with fenced transitions and post-response action scheduling.

## Target result contract

Use the common result envelope for every migrated command.

```lua
-- Intermediate poll result. No browser mutation has run in this Lua invocation.
{
  contract = "axlua.result/v1",
  outcome = "waiting", -- navigating | waiting
  poll = { retry = true, reason = "awaiting_cart_confirmation" },
  data = {
    phase = "action_dispatched"
  },
  meta = { site = "example" }
}

-- Verified success. The site, not a click return value, supplied the proof.
{
  contract = "axlua.result/v1",
  outcome = "done",
  data = {
    product_id = "product-id",
    added = true,
    confirmation = "Added to cart"
  },
  meta = { site = "example" }
}

-- The action may have happened, but the command cannot prove it safely.
{
  contract = "axlua.result/v1",
  outcome = "indeterminate",
  error = {
    code = "operation_outcome_unverified",
    recovery = "inspect_site_then_request_a_new_explicit_operation"
  },
  data = { phase = "action_dispatched" },
  meta = { site = "example" }
}
```

Rules:

- `outcome` is the only lifecycle classification. Terminal values are `done`, `empty`, `needs_input`, `login_required`, `blocked`, `indeterminate`, `cancelled`, and `error`.
- Only intermediate results carry `poll.retry == true`; use it as the universal poll predicate.
- `data.phase` is a non-authoritative diagnostic projection of the operation ledger. The opaque operation ID, action fence, approval binding, and raw user data never appear in normal tool output.
- `error.code` is stable and machine-readable. A terminal `indeterminate` is not retried automatically.
- Migrated commands do not emit legacy top-level lifecycle fields such as `status`, `pending`, `navigated`, or tool-owned `next`.
- Use `ax.array()` for every array nested in `data`.

Standard flow predicate:

```yaml
poll:
  retryWhile: { "===": [{ var: "poll.retry" }, true] }
```

## Private operation context

### Backend responsibility

When a flow starts one stateful mutation poll, the backend creates one opaque `operationId` and persists it with the logical poll record. Every repeat, timeout retry, and client re-delivery for that logical operation carries the same private context:

```text
execution = {
  mode: "poll",
  operationId: opaque random value,
  operationKind: "mutation",
  sessionScope: opaque session binding,
  attempt: monotonic attempt number,
  deadlineAt: operation deadline,
  cancellation: cancellation signal
}
```

This context is not part of the public tool schema or mapped tool input. It must not be derived from product ID, email, address, query text, or a deterministic argument hash: two explicit user requests with identical arguments are distinct operations.

The backend must distinguish an initial operation from a continuation. If an extension receives a continuation operation with no authoritative ledger record, it returns `operation_state_lost`; it must not silently create a fresh record and risk a duplicate mutation.

For `action_unit` mutation nodes, use `llm.maxCalls: 1` during rollout unless the backend can prove that an LLM retry retains the same operation ID and approval binding. A model retry with a new logical operation is a new user-visible mutation, not a transport retry.

### Extension responsibility

Add an extension-owned `OperationStore`, scoped by `(sessionScope, operationId)`, with:

- durable storage across document reloads and host changes; use a service-worker-serialized persistent extension store, not page `localStorage`;
- versioned CAS transitions and per-operation leases/fencing tokens, following the existing `ExecStateStore` / `commitExecState` pattern;
- bounded TTL cleanup for terminal records;
- an explicit availability failure. If the store cannot durably acknowledge a transition, no action is dispatched;
- minimal data retention: action type, product/service identity, normalized non-sensitive target fingerprint, phase, timestamps, fence token, and evidence summary only. Never persist raw contact values, full address text, cookies, tokens, or form contents.

`chrome.storage.local` or IndexedDB is appropriate for the authoritative extension record when it is wrapped by a service-worker lock/CAS layer. `chrome.storage.session` and per-origin `localStorage` may cache reads, but are not sufficient as the sole source of truth for a mutation that might survive a restart.

### Lua responsibility

Expose the ledger through a common helper, conceptually `AX_BASE.operation()`, backed by a new SDK `operation` capability. Site Lua sees a synchronous state-machine facade, not storage details:

```lua
local op = B.operation() -- obtains the private operation context
local record = op:load_or_retry()
if record.retry then return record.result end

if record.phase == "ready_to_act" then
  local bad = validate_current_product(args)
  if bad then return op:finish("error", bad) end
  return op:arm_action({
    kind = "click",
    selector = add_button_selector(),
    expected = { kind = "cart_contains", product_id = product_id }
  })
end

if record.phase == "action_dispatched" then
  local evidence = cart_evidence(product_id)
  if evidence.confirmed then return op:finish("done", evidence.data) end
  if evidence.gate then return op:finish(evidence.gate.outcome, evidence.gate) end
  return op:observe_or_indeterminate("awaiting_cart_confirmation")
end
```

Storage I/O may itself return `waiting` in poll mode. The helper must hide asynchronous extension messaging behind an acknowledged CAS operation; site Lua must never treat a local write request as committed state.

## Operation ledger

A record is a forward-only state machine. Exact field names may change, but the semantics are required.

```text
OperationRecord
  version
  sessionScope + operationId
  command + site + operationKind
  binding:
    approval fingerprint
    normalized target/action fingerprint
    selected product/service identity
    flow/document version
  revision + active lease + fence token
  phase:
    new
    navigation_armed | navigation_dispatched
    ready_to_act
    action_armed | action_dispatched
    observing
    verified | blocked | failed | indeterminate | cancelled
  action sequence[]:
    sequence number, kind, fence, phase, issuedAt, expected evidence
  bounded deadlines and attempt counters
  minimal evidence summary and cached terminal envelope
```

The binding is checked on every attempt. A different site, product identity, quantity, expected price/currency, explicit confirmation, or quote target yields `operation_binding_mismatch`; it never joins an existing operation.

Terminal records cache their final envelope. Duplicate delivery after verified success returns that cached result without reading, clicking, or submitting again.

## At-most-once action protocol

A browser click cannot be transactionally coupled to a third-party website. The protocol must therefore prefer a false `indeterminate` over a duplicate click.

For every physical action -- navigation, add button, quantity update, delete, protection-plan decline, quote Next, quote Submit, checkout button, or form submit -- use the following sequence.

1. **Observe first.** If the desired external state is already proven, commit `verified` and return success without scheduling an action.
2. **Preflight.** Detect login/captcha/blocked pages, validate product/service identity, price, quantity, variant, and user approval before arming an action.
3. **Arm.** CAS-commit `ready_to_act -> action_armed` with a new fence token and expected evidence. Return a retryable result that registers one post-response callback.
4. **Deliver the result.** `axcall.ts` must complete `api.updateCall(...)` before the callback can run. A failed backend completion update runs no action.
5. **Fence and dispatch.** In the callback, reload/CAS the record from `action_armed(fence)` to `action_dispatched(fence)` and await the persistence acknowledgement **before** the click/submit/navigation. A stale callback whose fence no longer matches cannot act.
6. **Observe only.** Every later attempt in `action_dispatched` reads site evidence. It may schedule a separate, explicitly recorded navigation needed for observation, but it cannot re-arm or repeat the original mutation.
7. **Finish conservatively.** Strong evidence commits `verified`. A login/captcha/validation gate commits a terminal classified outcome. Expired observation time, lost state, or ambiguous site state commits `indeterminate`.

A callback that cannot establish its fence or cannot persist `action_dispatched` does nothing. A record in `action_dispatched` remains non-clickable even if the browser crashed between the checkpoint and the site action; that is the intentional at-most-once tradeoff.

For a multi-action operation, each side effect gets its own sequence and fence. Example: Amazon add-to-cart is not one untracked block; it can be `navigate_to_product`, `click_add`, `decline_protection`, and `navigate_to_cart_for_verification`.
Document navigation may be re-armed only as a new, separately fenced navigation sequence after the old document proves that no navigation began within its bounded fired window. That exception never applies to an add/update/submit action.

## Poll-aware action transport

The read/navigation plan's post-response primitives remain necessary, but stateful mutations use ledger-aware variants:

- `operation.arm_navigation_after_response(...)`
- `operation.arm_click_after_response(...)`
- `operation.arm_submit_after_response(...)`

They validate the DOM synchronously, register only one callback for the winning fence, and do not claim `fired` or `arrived` before dispatch.

In poll mode, the old durable primitives -- `nav.navigate`, `nav.ensure`, `nav.wait_for_navigation`, navigation-hinted `dom.click`, and navigation-hinted `dom.submit_form` -- must fail explicitly. They must never silently create a durable replay or immediately navigate before the poll result is stored.

Plain `dom.set_value` may be repeated only when its target is part of the preflight binding and repeating the same value cannot create an external mutation. Site code must not hide a click inside `dom.fill` during a stateful poll; split it into recorded state, one-tick readiness checks, and a separately armed action.

## Re-entrant command pattern

Every stateful poll command has this shape:

```text
load operation record
  -> cached terminal?                         return cached terminal result
  -> target/page gate?                        finish blocked/error; no action
  -> needed document missing?                 arm one navigation; return navigating/retry
  -> desired state already proven?            finish done
  -> preflight not ready?                     return waiting/retry
  -> ready, no action issued?                 arm one action; return waiting/retry
  -> action dispatched?                       observe only; return waiting/retry or terminal
```

No branch is allowed to infer success from `dom.click(...) == true`, a URL change, a missing button, or a changed cart count alone. Each command defines durable, product/service-specific evidence before it becomes pollable.

## Command migration map

| Command family | Stateful poll phases | Success evidence | Notes |
|---|---|---|---|
| `AX_open_site`, searches, views | Existing schedule -> detect -> probe -> read pattern | Target page classification plus read result | Read-only pilot remains the first rollout phase. |
| `AX_add_to_cart` (Amazon) | product navigation -> identity/price/quantity preflight -> `click_add` -> optional `decline_protection` -> observe confirmation/cart | Matching product identifier in cart or a site-specific confirmation tied to the product | Preserve current price/currency checks. Record `before_count` only as diagnostics, never as sole proof. |
| `AX_add_store_product_to_cart` / generic storefront add | adapter/site preparation -> product navigation -> identity/price/options/quantity preflight -> `click_add` -> cart verification navigation if needed | `cart_contains(site, product_id)` or site-specific product confirmation | `C.ensure_adapter` becomes a recorded navigation phase instead of hidden durable work inside the mutation. |
| `AX_update_cart` | cart navigation -> read scoped row -> `set_quantity` or `delete` action -> observe row | Requested quantity exactly matches, or the row is absent for delete | A second update/delete click is forbidden after `action_dispatched`. |
| `AX_update_product` | product navigation -> idempotent field/variant preparation -> action transition if site requires an Apply control -> observe selected variants/product identity | Requested variant fingerprint and product identity match | Each non-idempotent Apply action is separately fenced. |
| `AX_checkout` | cart navigation -> checkout preflight -> `open_checkout` action -> observe checkout page | Checkout readiness only; never an order placement signal | Preserve the existing no-order boundary. |
| `AX_update_search` | results identity -> select-filter action -> observe selected filter/results identity | Selected option and results surface match | Only migrate after exact selected-filter evidence exists. |
| `AX_open_quote` / `AX_answer_quote` | profile preparation -> dialog-open action -> per-question answer/Next action sequence -> observe active-step fingerprint | Expected dialog/step fingerprint changes | The overlay remains an SPA; polling controls the sequence, not document arrival. |
| `AX_submit_quote` | explicit confirmation binding -> final form preflight -> `submit_quote` action -> observe receipt/terminal response | Positive submission receipt or unambiguous site completion state | Never infer success just because the submit button disappeared. Standard live tests do not actually submit a quote. |

A site command is not migrated until its success and gate selectors are specific enough to support this table. If the site cannot provide strong evidence, retain the command's durable implementation or return a terminal unsupported/indeterminate result; do not invent a success condition.

## Flow contract extension

Current `execute.poll` only describes generic idempotent retries. Add an explicit mutation mode before authoring stateful mutation polling:

```yaml
flowTools:
  shopping_add_to_cart:
    execute:
      kind: remote
      tool: AX_add_to_cart
      timeoutMs: 5000
      poll:
        retryWhile: { "===": [{ var: "poll.retry" }, true] }
        intervalMs: 750
        maxAttempts: 24
        operation:
          kind: mutation
          guarantee: at_most_once
          state: extension
          observation: required
    input:
      product_id: tool.args.product_id
      quantity: tool.args.quantity
      expected_unit_price: tool.args.expected_unit_price
      expected_currency: tool.args.expected_currency
    output:
      next:
        if:
          - { "===": [{ var: result.outcome }, "done"] }
          - done
          - error
      cart_status: result.outcome
      cart_error: result.error.code
      cart_confirmation: result.data.confirmation
    effect: mutation
    consent: required
    idempotent: true
    require: { product_id: true }
```

`poll.operation` is a proposed backend/schema extension. The current `FLOWS.md` contract does not define it, so deploy runtime validation and operation-context support before adding it to site flows.

Its semantics are mandatory:

- `idempotent: true` means re-invoking the controller with the same private `operationId` cannot dispatch an already armed/dispatched action again.
- `effect: mutation`, `consent: required`, and non-empty `require` remain mandatory.
- The backend injects the operation context; authors cannot map or spoof it through tool arguments.
- The backend persists operation identity across poll attempts and timeout retries, and abort propagates a cancellation signal to the extension.
- A stateful mutation poll cannot combine with pagination.
- The poll's maximum attempts and total operation deadline must fit its parent flow/task budget. Account for the documented per-attempt timeout retry.

Do not use a generic `execute.poll` block on a mutation before this mode is supported. The generic validator cannot tell whether a tool's internal click is actually fenced.

## Concrete flow migration

1. Convert `open_site`, `shopping_open_mapped_store`, `shopping_open_selected_store`, `shopping_search_product`, `shopping_search_one_store`, and `search_service` using the read/navigation poll path first.
2. Delete `shopping_search_one_store`'s `search_after_navigation` and `search_after_navigation_retry` only when its search tool returns the common envelope through polling.
3. Add stateful poll support to `shopping_add_to_cart` and `shopping_add_selected_store_offer` only after their operation ledgers and evidence tests exist.
4. Replace the selected-offer cart retry chain with one poll-driven stateful mutation node only after it owns every former navigation/action phase. Do not remove its current branches earlier.
5. Convert `update_cart`, `update_product`, and checkout one command family at a time.
6. Convert quote answer/submit flows only after step fingerprints and positive submission evidence are tested. The final submission remains gated by explicit `confirm: true` and the existing flow consent rules.

Keep `defaults.mapping: legacy` unchanged.

## Implementation phases

### Phase 0 - operation transport and store

1. Extend backend poll calls with a persistent private `operationId`, operation kind, cancellation, and continuation/initial marker.
2. Add the `poll.operation` schema/compiler rule. Reject mutation polling when client operation support is unavailable.
3. Implement the extension `OperationStore` using acknowledged CAS, leases, fence tokens, and TTL cleanup. Reuse the `ExecStateStore` design rather than page storage.
4. Extend Lua command dispatch so a poll-mode command can register one fenced after-response callback without changing ordinary Lua return serialization.
5. Ensure a poll-mode attempt does not create a durable defer/replay journal.

Exit criterion: a synthetic mutation has a stable operation ID across attempts, persists `action_armed` and `action_dispatched`, and cannot invoke the synthetic click twice under duplicate calls or stale callbacks.

### Phase 1 - read/navigation pilot

1. Keep the existing read/navigation migration sequence: `AX_open_site`, one generic storefront search, then Amazon/eBay searches and reads.
2. Validate post-response navigation, gate classification, and one-tick readiness probes before coupling them to mutations.

Exit criterion: page navigation works without durable continuation and no old-page DOM is read after a schedule result.

### Phase 2 - Amazon cart operation pilot

1. Convert `AX_add_to_cart` to the ledger pattern with product identity/price preflight, one fenced add action, and product-specific confirmation evidence.
2. Convert `AX_update_cart` using scoped cart-row evidence for update/delete.
3. Exercise failure points before and after every checkpoint with a deterministic DOM fixture.
4. Keep checkout and quote submission out of live mutation validation.

Exit criterion: every duplicate poll call returns controller state only; the add/update DOM action count remains one and terminal output reflects observed cart state.

### Phase 3 - generic storefront and selected-offer cart

1. Move `C.ensure_adapter`, product navigation, add, optional protection handling, and cart verification into explicit generic operation phases.
2. Convert `AX_add_store_product_to_cart` and then replace its flow-level navigation retry chain.
3. Preserve identity, price, currency, quantity, approval, and comparison bindings in the operation binding.

### Phase 4 - quote and form operations

1. Model each quote Next/Submit as a separate action sequence bound to the active-step fingerprint.
2. Add the final submit operation only with explicit confirmation and a positive receipt detector.
3. ~~Convert Bluemoonsoft submit~~ — **withdrawn 2026-08-26**: the site was removed from the product.

### Phase 5 - remove migrated durable branches

After a command's stateful poll implementation passes its crash, duplicate, and live-safe tests, remove its old durable navigation/replay path and its flow retry branches in the same change. Keep the generic durable engine for commands not yet migrated; do not leave a per-command runtime fallback that guesses whether stateful poll support exists.

## Safety and recovery rules

1. **No automatic retry after mutation dispatch.** `action_dispatched` means observe only. A proven no-op document navigation may use a new fenced navigation sequence; an add, update, delete, quote step, checkout action, or submit click never may.
2. **State loss fails closed.** A continuation with missing/corrupt state returns `operation_state_lost` / `indeterminate`; it does not reconstruct an action from arguments.
3. **Cancellation is fenced.** A cancellation before dispatch prevents the callback from acting. Cancellation after dispatch observes the result but does not undo an external effect.
4. **Gate pages are terminal.** Login, captcha, consent, validation errors, blocked pages, wrong product, stale price, wrong variant, and mismatched quote step are classified without rearming the action.
5. **Fresh approval is required for a new operation.** A user who wants another attempt receives a new operation ID and a new explicit approval path. That new operation first observes current state, so an already-completed cart/quote action can still resolve safely as done.
6. **No sensitive ledger contents.** The operation record contains no form values, contact data, full address, cookies, headers, or credentials. Debug logs use operation phase/fence and redacted identity summaries only.
7. **No success from weak evidence.** A click return, modal disappearance, URL change, or cart-count delta alone is insufficient. Missing strong evidence becomes `indeterminate`.
8. **No bulk parallel mutation until proven.** `flow.map` must not fan out stateful mutation operations until per-operation leases, budgets, and cancellation are verified under contention.

## Verification plan

### SDK and backend tests

Add focused tests for:

1. stable `operationId` across normal poll attempts, timeout retries, backend redelivery, and client reload;
2. backend/schema rejection of a mutation poll without `poll.operation` support;
3. extension CAS conflicts, lease expiry, stale callback fences, and cross-tab duplicate delivery;
4. response-before-action ordering: `api.updateCall` must resolve before navigation/click/submit;
5. no action after failed result delivery, cancellation, unavailable operation storage, or lost fence;
6. persistence acknowledgement before every physical action;
7. state-loss behavior: continuation is terminal/indeterminate, never a new click;
8. legacy durable primitives rejecting poll mode rather than firing early;
9. cached terminal results returning without another site action.

### Crash matrix

For each stateful mutation fixture, stop execution at each boundary and resume the same operation:

```text
new -> navigation_armed
navigation_armed -> navigation callback
navigation_dispatched -> destination load
action_armed -> result delivery
action_armed -> callback fence commit
action_dispatched -> physical site action
action_dispatched -> confirmation observation
verified -> duplicate backend delivery
```

Expected invariant: no branch produces a second physical add/update/submit click. Any ambiguous post-dispatch branch returns `indeterminate` rather than retrying the action.

### Lua and flow tests

Update deterministic Lua fixtures to assert operation phases, action counts, terminal evidence, and exact reuse of input plus private operation identity. Update:

- `tools/test_representative_commerce_sites.mjs` for generic storefront add state transitions;
- `tools/test_multi_store_total_cost.mjs` for selected-offer cart stateful polling;
- Amazon offline fixtures for add/update/cart observation phases;
- Thumbtack fixtures for answer-step and submit fence behavior;
- `tools/flow-conformance.test.mjs` for the new mutation poll schema and removal of only replaced retry nodes.

Run after each applicable change:

```text
npm run build:lua:check
npm run check:flows
npm run test:commerce
```

### Live verification

`ax run` and `ax call` are useful for page-state smoke checks but do not prove backend polling or operation identity. Use a stored flow plus the real backend poll path, inspect `remote_poll` diagnostics, and verify the operation record's phase transitions.

- Begin with `AX_open_site` and read-only search flows.
- Use deterministic offline/mocked DOM fixtures for duplicate and crash cases.
- A live cart mutation requires intentional explicit dev consent and a reserved test item.
- Standard validation never submits a real quote, form, checkout order, or personal contact data.
- Verify final site evidence and flow state, not merely the browser URL or a click return value.

## Documentation and deployment

Update, in the same implementation phase:

- `FLOWS.md`: define `poll.operation`, stable operation identity, at-most-once semantics, cancellation, and state-loss behavior.
- `NAVIGATION.md`: distinguish durable navigation from ledger-aware post-response scheduling; neither scheduling nor a state record is page readiness.
- `DEVTOOLS.md`: add operation-state inspection, redacted diagnostics, and backend poll test instructions.
- `SCHEMA.md`: update command descriptions to state the observable terminal lifecycle; do not add output schemas there.
- Lua/flow tests: remove legacy `pending`/`status` assertions only after the corresponding command is migrated.

Deploy in this order:

1. backend poll operation schema and stable operation context;
2. extension OperationStore and fenced after-response primitives;
3. common Lua operation helper;
4. matching site Lua plus flow tool changes;
5. removal of old durable code for proved command families.

Do not ship a new stateful mutation flow to clients that cannot acknowledge operation state. If rollback is needed, restore the matching Lua and flow document together; preserve the additive operation transport until no active operation can reference it.

## Decision gates before coding

1. Confirm that the backend can persist and resend one opaque operation identity for the entire poll lifecycle, including timeout/retry/redelivery.
2. Confirm the operation record can be stored with acknowledged CAS across tabs, host changes, reloads, and extension restarts.
3. Confirm how a failed completion update is distinguished from an armed callback so a later attempt can safely fence/re-arm without a duplicate action.
4. Define strong, site-specific success evidence before migrating each mutation command.
5. Confirm poll-attempt accounting against `flow.map` budgets and the parent deadline; include the documented per-attempt timeout retry.
6. Do not migrate a command with an irreversible action until its state-loss and post-dispatch ambiguity behavior has a tested, fail-closed result.
