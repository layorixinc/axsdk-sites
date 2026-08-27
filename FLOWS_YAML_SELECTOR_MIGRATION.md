# `flows.yaml` exact-selector migration

This guide migrates legacy context injection and broad state projection to the current **planner- and node-level exact-selector contract**.

In this repository, [`FLOWS.md`](./FLOWS.md) §§10–11 and this guide define the local authoring contract for site flows.

## 1. Contract change

| Legacy contract | Current contract |
|---|---|
| `planner.contexts: [sites]` | `planner.inputSelector: [contexts.sites]` |
| flow `inputSelector` | Remove it; give each node the paths it actually reads |
| flow/node `contexts` | Move to `inputSelector: [contexts.<name>]` |
| flow/node `contextSelector` | Move to `inputSelector: [contexts.<name>.<leaf>]` |
| `[global]`, `[flow]`, `[contexts]` | Enumerate only the required leaf paths |
| omitted selector exposes accumulated state | omitted or `[]` exposes no state |
| one XML block per context | selected contexts remain below `<state>.contexts` |
| implicit external publication | publish only fields named in `outputMap` |

The compiler rejects whole-scope selectors:

```text
$
global
flows
flow
active
contexts
lastIntent
```

The equivalent whole-scope JSONPath forms (`$.global`, `$.flow`, `$.contexts`, and so on) are also invalid. A leaf such as `global.cart.items`, `active.status`, or `contexts.sites` remains valid.

## 2. Scope the migration before editing

Edit authored sources only:

- Production shared/site layers: `_common/flows.yaml` and any populated `<site>/flows.yaml` overlay.
- Playground layers: `playground/_common/flows.yaml` and populated `playground/<site>/flows.yaml` overlays.

Do not edit backups, generated snapshots, or live-scenario artifacts. This repository keeps `thumbtack/flows.yaml` and `playground/example/flows.yaml` as intentionally minimal overlays; an absent `planner` inherits the app planner.

`extends: app` has two important merge rules:

1. `planner` merges field by field. If an overlay sets `planner.inputSelector`, it replaces the base planner selector and must repeat every needed path.
2. `flows.<flowId>` is replaced as a complete flow. An overlay that changes a flow must define every node, its exact selector, transitions, and terminal behavior; it cannot rely on a base node selector remaining in place.

## 3. Migrate the planner

### Before

```yaml
planner:
  allowedTools: [decide]
  inputSelector: [active, queue, conversationSummary]
  contexts: [sites]
```

### After

```yaml
planner:
  allowedTools: [decide]
  inputSelector:
    - active.status
    - active.intent
    - active.activeNode
    - queue
    - conversationSummary
    - contexts.sites
```

Select only values needed to route or continue a flow. `queue` may remain whole because it is a bounded control value. Do not expose result cards, page content, form payloads, or remote tool results merely because they exist in state.

A planner without `inputSelector` receives `{}` as selector state. The current user message and route metadata use the separate planner message contract; selecting `global`, `flow`, or conversation history is neither necessary nor permitted.

## 4. Move flow selectors to nodes

### Before

```yaml
flows:
  shopping:
    inputSelector: [requestText, candidates]
    contexts: [sites]
    nodes:
      plan:
        kind: action_unit
        inputSelector: [requestText]
        run: shopping_plan
        next: { ok: choose, error: failed }
      choose:
        kind: action_unit
        inputSelector: [candidates]
        run: shopping_choose
        next: { ok: done, error: failed }
```

### After

```yaml
flows:
  shopping:
    nodes:
      plan:
        kind: action_unit
        inputSelector:
          - requestText
          - contexts.sites
        run: shopping_plan
        next: { ok: choose, error: failed }
      choose:
        kind: action_unit
        inputSelector:
          - candidates
          - preference
        run: shopping_choose
        next: { ok: done, error: failed }
      done:
        kind: terminal
        inputSelector: []
        respond: Completed.
      failed:
        kind: terminal
        inputSelector: [__error.message]
        respond: { from: [__error.message], fallback: The request could not be completed. }
```

Every `action`, `action_unit`, `action_contract`, `decision`, and `terminal` node must own an exact `inputSelector`. Write `[]` explicitly when the node reads no state. Accumulated flow state remains available to later nodes, but it is invisible until that node selects it.

Use the node type to derive the selector:

- `action_unit`: fields needed for model reasoning and tool arguments.
- `action_contract`: fields read by the adapter input projection or deterministic runtime implementation.
- `decision`: fields used by branch conditions.
- `terminal`: every source named by `respond.from` or terminal-renderer instructions.

## 5. Context selection

Move context selection into the same exact-selector list.

```yaml
# Legacy
contexts: [catalog]
contextSelector: [catalog.pricing]

# Current
inputSelector:
  - contexts.catalog
  - contexts.catalog.pricing
```

A context projection preserves the root:

```json
{
  "contexts": {
    "catalog": {
      "pricing": {
        "plan": "pro",
        "price": 20
      }
    }
  }
}
```

Missing paths are omitted. Empty strings, objects, and arrays remain valid selected values. Contexts remain canonical in `session.config.contexts`; selection does not copy them into accumulated flow state. Record a deterministic action result separately when a later node must validate or transform it.

## 6. Keep user messages separate from state

Current user text arrives through the runtime message channel. Do not select broad state or history merely to receive it.

Use `messagePolicy.currentUserText: active_node_only` for a node that should receive the current user text only when it is entered directly or resumed from a pause, not after an automatic transition in the same turn:

```yaml
confirm_checkout:
  kind: action_unit
  inputSelector: [site, cart, checkoutQuestionAsked, followup]
  messagePolicy:
    currentUserText: active_node_only
```

Use `messagePolicy.userText: original` only when a flow genuinely requires the original full user message instead of the default `segment`.

## 7. Treat `outputMap` as a publication allowlist

`inputSelector` controls reads. `outputMap` controls publication outside the current flow.

```yaml
resolve_product:
  kind: action_contract
  inputSelector: [productId, candidates]
  run: shopping_resolve_product
  outputMap:
    shopping.selectedProduct: selectedProduct
  next: { ok: done, error: failed }
```

Action results still update flow-local state through the node `state.include`, `state.exclude`, and `state.clear` contract. Only explicitly mapped fields are published to global `stepOutputs`; no `outputMap` means no external publication. `next` is routing-only and is never preserved as state.

An action may replace an entire named context only through an explicit context destination, for example:

```yaml
outputMap:
  contexts.page: updatedPage
```

A failed tool call or invalid transition rolls back staged context writes.

## 8. Common migration failures

| Symptom | Cause | Fix |
|---|---|---|
| `cannot select an entire state scope` | whole root selected | replace with required leaf paths |
| `flow.inputSelector is no longer supported` | flow projection remains | move paths to individual nodes |
| `contexts is no longer supported` | retired planner/flow/node context list remains | select `contexts.<name>` directly |
| `contextSelector is no longer supported` | retired context selector remains | select `contexts.<name>.<leaf>` directly |
| terminal output is empty | terminal selector omits its response source | add every `respond.from` path |
| an overlay loses base behavior | partial `flows.<id>` override | define the complete flow in the overlay |
| automatic follow-up treats the initial request as approval | current text carried into an automatic node | use `active_node_only` where appropriate |

## 9. Validation

Run repository validation after every migration:

```sh
npm run check:flows
npm run test:playground
```

Then sync stored sources and run read-only extension scenarios:

```sh
node tools/ax.mjs sync amazon
node tools/playground.mjs sync --root=playground --no-launch
```

Inspect more than the terminal response. In the live trace or structured debug artifact, verify:

1. accumulated global state remains intact;
2. each node's selected state contains only its declared paths;
3. model requests expose only the selected state and eligible tools;
4. current-user-text policy is respected across automatic transitions;
5. adapter arguments match the action-contract selector; and
6. terminal state includes only fields used by its response.

A representative safe scenario is a read-only multi-store search, for both the production overlay and Playground. Do not use cart, checkout, form-submit, or quote-submit scenarios merely to validate selectors.
