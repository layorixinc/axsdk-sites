# `flows.yaml` — Full Specification

`flows.yaml` is the **config-runtime app contract**: the source of truth for intent routing, flows,
nodes, tools, contexts, and terminal behavior. The runtime compiles it (`compileConfigRuntime`) into
an IR and executes it deterministically. Prompts only handle language understanding, routing hints,
and UX wording — enforceable behavior lives here.

For the override-only authoring subset (client overlays), see
`CLIENT_FLOWS_OVERLAY_AUTHORING.md`; this document is the full schema and includes overrides.

---

## 1. Inputs & compilation

`compileConfigRuntime({ flowDocument, tools?, adapterDocument?, sitemapMarkdown? })`:

- `flowDocument` — the `flows.yaml` text (this spec).
- `tools` — remote tool schemas (`AX_*`), from the app `tools.json` / session config.
- `adapterDocument` — `adapters.yaml` text (optional; inline adapters are an alternative).
- `sitemapMarkdown` — `sitemap.md` (optional; or inline `app.sitemap`).

The IR is **recompiled every turn** from the session config, so a config swap (override) takes
effect on the next turn.

---

## 2. Top-level structure

```yaml
version: 1
app:        { ... }   # app id, entry agent, terminal renderer, completion tool
planner:    { ... }   # routing/orchestration LLM config
router:     { ... }   # mode, defaultIntent, fallbackIntent, routes, outOfScope
contexts:   { ... }   # named grounding values (markdown)
flows:      { ... }   # intent flows and their nodes  (required)
flowTools:  { ... }   # tools that nodes/planner call
actions:    { ... }   # optional top-level actions (alternative to inline node actions)
defaults:   { ... }   # global defaults: remoteToolTimeoutMs, maxSteps, mapping (§9.7), model, llm (§9.8)
hooks:      { ... }   # lifecycle hook flows run around each resolved intent: beforeIntent / afterIntent (§13.1)
```

- A top-level `adapters:` key is **not supported** — use `adapters.yaml` or inline tool adapters.
- `flows` must define at least one flow; the compile must yield at least one action.

---

## 3. `app`

```yaml
app:
  id: my-app
  entryAgent: planner
  outOfScopeResponse: 이 어시스턴트는 서비스 견적만 도와드릴 수 있어요.   # optional; seed for out-of-scope / no-route
  terminal:                       # rewrites terminal node responses (optional)
    prompt: |-
      Rewrite the terminal response in the user's language; preserve meaning.
    llm: { temperature: 0, maxOutputTokens: 512, maxRetries: 1 }
  complete:                       # completion side-effect when a flow finishes (optional)
    remote: { tool: AX_complete }
```

- `terminal` (`{ prompt?, llm? }`, optional): controls how a `kind: terminal` node's `respond` becomes the user-facing message.
  - **No `app.terminal`** → raw `respond` returned verbatim (no LLM).
  - **`app.terminal` present, `prompt` omitted** → LLM rewrite using a built-in default prompt.
  - **`app.terminal.prompt` present** → that string is the render **system** prompt.
  - The render LLM **user** message is three lines: `Latest user message: <text>` / `Base response: <node.respond>` / `Flow state JSON: <entire flow state>`. So `respond` is a **base-response directive** — literal text, or an instruction like `Use Flow state JSON's message.` — and the **whole flow state is exposed** to the render. `llm` overrides `temperature` (default 0) / `maxOutputTokens` (256) / `maxRetries` (1); the model is the session model; empty output falls back to the raw `respond`.
  - **Authoring rule**: every `respond` directive any terminal node emits MUST be matched by a rule in `prompt` (e.g. add a `…Flow state JSON's message` rule next to the `…question` rule). The reserved prompt fields `question`/`response` are **ephemeral** — the runtime resets them each step to the current action's result (see §7.7), so a stale prompt never leaks into the render; you do not need to clear them manually.
- `outOfScopeResponse` (string, optional): base seed for the reply the runtime emits when the planner returns
  `out_of_scope` (off-topic / conversation-closing message) or a route cannot be resolved (`no_route`). It is
  **LLM-rendered in the user's language** through the same renderer as `app.terminal` (system prompt + `llm` from
  `app.terminal`, or a built-in "reply in the user's language" prompt when `app.terminal` is absent) — so the reply
  is multilingual and never a hardcoded string. Unset → a neutral built-in seed (still LLM-rendered). `errorResponse`
  (§9.13) is the analogous seed for flow exceptions.
- `complete.remote.tool`: a remote tool invoked on completion (optional).

---

## 4. `planner`

The planner is the orchestration LLM: it classifies the latest message into a configured route.

```yaml
planner:
  prompt: |-
    Call decide exactly once. Classify the latest message into a configured intent.
  allowedTools: [decide]          # default ["decide"]; MUST include decide
  inputSelector: [active.status, queue, lastIntent.intent, conversationSummary, latestMessageInterpretation, contexts.sites]
  outputMap:
    conversationSummary: conversationSummary
    latestMessageInterpretation: latestMessageInterpretation
  state: { cart: { items: [] } }  # GLOBAL initial state — seeded into stepOutputs root once at session start
  model: { providerID: openrouter, modelID: openai/gpt-oss-120b }
  llm: { temperature: 0, maxOutputTokens: 2048, maxRetries: 1, timeoutMs: 30000 }
```

- `allowedTools` must include `decide`; extra planner tools must exist in `flowTools` with adapters.
- The planner **runs every turn** except when the router has exactly one `fixed` route (then it is
  skipped and that route is entered directly).
- `prompt` is **prepended** to the built-in planner framework (which lists routes + the `decide`
  contract). The framework's route classification + `defaultIntent` drive routing — a "force one
  intent" prompt line does **not** override route descriptions/examples. Control routing with
  `defaultIntent` and route `description`/`examples`.
- `inputSelector` is the planner's complete state allowlist. Select context values with paths such as
  `contexts.sites`; values come from `contexts:` defaults plus client session overrides (§6, §11).
- `state` (object) — **global initial state** seeded into the `stepOutputs` root **once** on a fresh session (or a state reset); shared across flows, read via `global.*`. Not re-seeded on later turns. See §7.6.

### 4.1 Planner clarifications and active-node prompts

The runtime keeps two assistant-prompt states with separate ownership:

- `conversation.activePrompt: { flow, node, text }` belongs to a paused flow node. A direct answer normally
  resumes that node with `action=continue_current`.
- `conversation.plannerClarification: { text }` belongs to the planner before any intent is selected. The
  runtime emits and persists the same text verbatim, then replays it as the immediately preceding assistant
  message on the next planner call. No flow, hook, action, or remote tool runs on the clarification turn.

When both exist, `plannerClarification` is newer and takes replay precedence. The planner prompt receives a
derived provenance marker so it re-evaluates the configured routes from the clarification question plus the
latest answer; it returns `continue_current` only when that answer selects the active flow, otherwise
`replace_current` or `out_of_scope`. A concrete decision clears `plannerClarification` while preserving a
valid `activePrompt`; a repeated clarification overwrites the prior question.

Planner clarification state is durable across session restart but is never copied into a paused/queued
intent. A changed client flow document clears it because the candidate routes may have changed; reapplying
the identical document preserves it. Out-of-scope/no-route completion also clears it so an obsolete question
cannot be replayed after a newer assistant response. The state intentionally stores no suggested route:
the planner derives the route from the replayed question, latest answer, configured routes, and selected
state.

---

## 5. `router`

```yaml
router:
  mode: auto                      # auto | fixed   (default auto)
  defaultIntent: shopping         # optional
  fallbackIntent: memory_fallback # optional — flow to run when no route matches (§5.1)
  routes:
    - intent: shopping            # unique route id
      entry: shopping.search      # <flowId>.<nodeId> — MUST exist
      description: Product search and purchase.
      examples: [아이팟 사줘, buy airpods]
      priority: 130               # optional (default 0); higher wins on ties
  outOfScope:                     # optional
    - category: smalltalk
      patterns: [안녕, hello]
```

- `entry` is required; `parseNodeRef` splits `flowId.nodeId` and the node must exist.
- `mode: fixed` + `defaultIntent`: the planner prefers the default unless the message clearly
  matches another route. `mode: fixed` with a single route skips the planner entirely.
- `examples`/`description` are the primary routing signal for the planner.

### 5.1 `fallbackIntent` — catch-all flow for unroutable requests

`fallbackIntent` is a **flow id** the runtime routes to when routing finds **no match** — a regex
`outOfScope` hit, planner `out_of_scope`, or no resolved intent. Instead of the generic
`app.outOfScopeResponse`, the runtime runs this flow like any intent (it need **not** be in `routes` or
the planner `decide` enum). It unifies "out of scope" with the normal flow model: a fallback is just a flow.

- Any `hooks.beforeIntent` (§13.1) runs **before** it, so recording/enrichment still happens on unroutable turns.
- Fires only on a **fresh turn** (no active/resumable flow), so an in-progress flow is never clobbered by an OOS message.
- The flow existence is compile-validated; a missing `fallbackIntent` flow is a compile error.

```yaml
router:
  fallbackIntent: memory_fallback
hooks:
  beforeIntent: [record_memory]     # records + publishes global.memory before the fallback flow
flows:
  memory_fallback:                  # a normal flow — here just a terminal (message + end)
    inputSelector: [memory]
    nodes:
      done: { kind: terminal, respond: { from: [memory], fallback: 요청을 기억해 두었습니다. } }
```
On an unroutable request: `beforeIntent` records → `memory_fallback` reads `global.memory` and replies → done. No generic OOS message.

---

## 6. `contexts` (value map)

```yaml
contexts:
  sites: |-
    - [amazon](https://www.amazon.com): shopping
    - [thumbtack](https://www.thumbtack.com): local services
  env: |-
    location: https://www.thumbtack.com/
  catalog:                          # structured value (object/array) — injected as JSON
    plans: [free, pro]
    limits: { free: 1, pro: 100 }
```

- Each entry: `name` (`^[A-Za-z][A-Za-z0-9_-]{0,63}$`) → a **markdown string** or a **structured value**
  (object / array), which is injected as pretty-printed JSON. **Empty values are allowed.**
- These are **defaults**; client session contexts (the request `contexts` field, string values only)
  override / add by name.
- Declaring a value here does not expose it. The planner or node must select a leaf such as
  `contexts.sites` in its own `inputSelector` (§10, §11).

---

## 7. `flows` and nodes

```yaml
flows:
  shopping:
    goal: Search and buy products.
    outputMap: { shopping.lastQuery: query }
    state: { searchCount: 0 }     # FLOW-LOCAL initial state — seeded on each fresh entry
    messagePolicy: { userText: segment }
    nodes:
      search: { ... }
      done:   { kind: terminal, respond: ... }
```

Flow fields: `goal?`, `state?` (object), `outputMap?`, `messagePolicy?`, `nodes` (required). Flow-level
`inputSelector`, `contexts`, and `contextSelector` are invalid; each node owns its exact inputs.

### 7.1 `action_unit` (LLM calls a tool)

```yaml
search:
  kind: action_unit
  id: shopping_search             # optional; defaults to "<flowId>.<nodeId>"
  description: Search products.
  prompt: |-
    Call search_product once with the query, then set next=done (or error).
  allowedTools: [search_product]  # REQUIRED (non-empty); names must be flowTools
  next: { done: collect, error: failed }   # REQUIRED (non-empty map)
  fallback: { invalidNext: error, exhaustedNext: error }   # optional
  model: { ... }                  # optional; default = session model
  llm: { maxCalls: 2, temperature: 0 }     # optional
  inputSelector: [requestText, contexts.sites]   # omitted / [] means no state; whole roots are invalid
  outputMap: { shopping.query: query }           # optional; omitted means publish nothing
  messagePolicy: { currentUserText: active_node_only }   # optional
  historyPolicy: { scope: session, maxTurns: 2 }         # optional
```

### 7.2 `action_contract` (deterministic tool, no LLM)

```yaml
resolve:
  kind: action_contract
  id: shopping_resolve_selection  # = a flowTool; runtime projects args from state
  next: { ok: navigate, not_found: search }
  inputSelector: [candidates, requestText]
  outputMap: { shopping.selectedProduct: selectedProduct }
  selector: { ... }               # optional grounded link/candidate selector
  state: { include: [...], exclude: [...], clear: [...] }   # optional state shaping
```

### 7.3 `terminal`

```yaml
done:
  kind: terminal
  respond: 완료되었습니다.        # string: verbatim, or app.terminal-rewritten (§6)
clarify:
  kind: terminal
  respond: { from: question, fallback: 다시 입력해 주세요. }   # object: resolved from flow state, no LLM (§9.11)
```

`respond` is **optional**. A terminal without `respond` completes the flow and produces **no user-facing text** — used by side-effect-only flows such as lifecycle hooks (§13.1).

### 7.4 Top-level `actions` (alternative)

Instead of inline `action_unit`/`action_contract` nodes, a node can be `kind: action` with
`run: <actionId>` referencing a top-level `actions:` entry. Inline nodes are the common form.

### 7.5 Asking the user and resuming (pause / resume)

To ask the user a question and continue on their reply, **do not use a `terminal`** — a terminal ends
the flow, so the next message restarts from the route entry (re-running earlier nodes and losing
accumulated state). Instead make the asking `action_unit` **self-loop**: one of its `next`
transitions points back to itself. When the model returns that transition the interpreter **pauses**
(status `paused`, `activeNode` saved); the next user turn **resumes the same node** with the new
message.

```yaml
plan_quote_step:
  kind: action_unit
  prompt: |-
    Inspect the active quote step. If a field is visible, answer it from the latest user message
    and set next=answer_quote. If you need the user, set next=ask and question=<the question to ask>.
  allowedTools: [plan_quote_step]
  next:
    answer_quote: answer_quote
    ask: plan_quote_step          # ← self-loop: pause and wait for the user's reply
    error: error
```

- The paused node's **`question`** field is shown to the user. The runtime reads `question`, then
  `response` — **not** `message`. So the asking tool must output `question` (passthrough: list it in
  `parameters`); a `message`-only field is **not** surfaced on pause.
- **The planner must resume.** On the user's reply it must call `decide` with
  `action=continue_current` (not `replace_current`), so the runtime resumes the paused node. A planner
  prompt that always forces a fresh intent / `replace_current` discards the in-progress flow and
  restarts it. See §4 and §14.
- **Remote (navigating) nodes** should route their "needs user input" transition to the asking
  planner node (not self-loop), to avoid re-running the remote/navigation on resume.
- **Do NOT use a self-loop for internal multi-tool iteration.** A single "driver" node that calls one
  tool per execution and re-enters itself (`next: { continue: <self> }`) to call the next tool will
  **pause after every tool call** (self-loop = wait-for-user), not iterate. To run several tool calls
  in one turn, use **sequential nodes** — each step is its own node whose `next` points to the *next*
  node (`resolve_zip → search_service → select_pro → …`). Reserve self-loop strictly for genuine user
  questions. (Note `maxSteps` defaults to **24** for the config runtime — configurable via
  `defaults.maxSteps`, clamped to ≤ 256 (§9.4) — so per-turn node chains must stay bounded; natural
  user pauses keep them short.)


### 7.6 Initial state (`planner.state` / `flows.<id>.state`)

Seed starting state declaratively (both must be **objects**; arrays/scalars are a compile error):

- **`planner.state`** → **global** seed into the `stepOutputs` root, applied **once** on a fresh session (or a
  `set` reset). Shared across flows (read via `global.*`); not re-seeded on later turns.
- **`flows.<id>.state`** → **flow-local** seed into `stepOutputs[<id>]`, applied on **fresh entry**
  (`replace_current` / new), **not** on `continue_current` resume (accumulated state is preserved).

Precedence for flow-local (low → high): `flows.<id>.state` → accumulated state → `inputSelector` projection →
planned-intent state (same key, later wins). Do not put secrets here — state can be surfaced via `x-axsdk-debug`
part snapshots. Verify via the `<state>` block or the matching `step-start.debug.globalState` / `localState` / `selectedState` (the node-projected pre-action state). The correlated `tool.debug.end` contains post-action state.

### 7.7 Reserved prompt fields (`question` / `response`) are ephemeral

`question` and `response` are runtime-reserved prompt outputs — the runtime pauses a self-loop when an
action result carries either (see §7.5). They are **not accumulated state**: after each action step the
runtime resets them in flow-local state to **exactly that step's result** (present if the action re-emitted
one, deleted otherwise), so an answered/superseded `question` never lingers into later steps or a terminal
render. The reset is single-sourced with the pause check, so authors never declare `state.clear`/`exclude`
for them. The answering step still sees the pending `question` (reset happens *after* the action runs), and
a `question` set in the same step that transitions to a terminal survives for that terminal's render.
`state.include`/`exclude` still govern whether a re-emitted prompt actually persists.

---

## 8. Node required fields & defaults

| Field | Required? | Default / runtime behavior |
|---|---|---|
| `next` (action nodes) | **Yes** — non-empty map | none; missing → `… .next must be an object` / `… must define at least one transition` |
| `allowedTools` (`action_unit`) | **Yes** — array | none; missing → `… .allowedTools must be an array`. Entries are tool-name strings or `{ tool, when }` for **state-conditional eligibility** (§9.5.1). `[]` compiles but always fails at runtime (no tool to produce `next`) |
| `fallback` | No | On invalid output / exhausted budget: declared `invalidNext`/`exhaustedNext` (if in `next`) → else `"error"` if `next` has an `error` key → else the **first** `next` key → else hard error. **Declare an `error` transition.** Also `maxStalledSteps` + `stalledNext` for the no-progress guard (§9.5.2) |
| `model` / `llm` | No | session model; `llm.maxCalls` default `max(1, turns) + 1` (1 retry on validation failure; single-turn ⇒ **2**). See §9.6 |
| `maxSelfSteps` (action nodes) | No | When set, the node's **self-loop** iterations count against this per-node budget instead of the global `maxSteps`; positive int, floored, clamped **≤ 256**. Allowed on `action_unit` **and** `action_contract`. See §9.5 |
| `toolChoice` (`action_unit`) | No | `required`/forced (default) — the LLM must call a tool. `auto` lets a step return **plain text** (streamed to the user as a message) and **continue** without failing, so a node can narrate mid-loop: `message → tool → message …` (§9.5.3). Pair with eligibility (§9.5.1) to keep tool selection correct |
| `respond` (`terminal`) | **Yes** | string → verbatim / `app.terminal` rewrite; `{ from, fallback }` object → resolved from flow state, no LLM (§9.11) |

> A node with **only `prompt`** does not compile.

---

## 9. `flowTools`

Tools that `action_unit` `allowedTools`, `action_contract` `id`, and `planner.allowedTools` reference.

```yaml
flowTools:
  decide:                         # planner tool (required when planner uses it)
    description: Select configured intent flows.
    parameters: { type: object, properties: { action: { type: string } }, required: [action], additionalProperties: true }

  respond:                        # passthrough capture (answer-from-context nodes)
    description: Return the answer to the user.
    execute: { kind: runtime, implementation: passthrough }
    output: tool.args
    parameters:
      type: object
      additionalProperties: false
      required: [next, message]
      properties:
        next: { type: string, enum: [done] }
        message: { type: string }

  search_product:                 # remote tool — `next` MUST come from `output`, not `parameters`
    description: Search products.
    execute: { kind: remote, tool: AX_search_product, timeoutMs: 20000 }   # optional per-tool remote timeout (ms)
    input: { query: tool.args.query }      # project model args → the remote tool's args
    output:                                  # the remote result has no `next` — derive it here
      next: { if: [{ var: result.error }, "error", "done"] }
      candidates: result.candidates
    parameters:
      type: object
      required: [query]                      # no `next` here for remote tools
      properties:
        query: { type: string }
```

flowTool fields:

- `description`, `parameters` (alias `schema`) — the LLM-facing arg schema.
- `output` — output projection. `tool.args` echoes the model args (passthrough). For remote tools,
  derive `next` and map result fields here (JsonLogic over `result`, e.g. `{ if: [{ var: result.error }, "error", "ok"] }`).
- `execute` — the adapter: `{ kind: runtime, implementation: passthrough | sitemap.search | state.transform | lua | lua.compile | lua.dynamic | mock | delay | flow | flow.map }` (§9.2–§9.17) or
  `{ kind: remote, tool: AX_* }`. Shorthand: `execute: passthrough`/`runtime` requires `output: tool.args`.
- `input` (alias `adapterInput`) — input projection for remote tools.
- `pagination` — pagination config.
- `execute.timeoutMs` (remote only) — per-tool remote-call timeout in **ms** (positive integer, clamped ≤ 120000). Overrides the document default; see §9.1.
- `execute.poll` (remote only) — bounded declarative polling of the same remote tool/input (§9.1.1).
- **Mutation side-effects**: `effect: mutation` requires `consent: required`, a non-empty `require`,
  and `idempotent: true` (see §12).

> **Where `next` comes from (`action_unit`).** The transition is **`result.next ?? args.next`** (§9.10): the
> tool result's `next` if present (result-driven), otherwise the LLM's runtime-injected `next` argument. So:
>
> - **pure tools** (`mock` / `lua` / remote) return only domain data — the runtime injects the `next` param and
>   the LLM's `args.next` routes; no `next` anywhere in the tool.
> - **result-driven** tools (e.g. a remote whose outcome decides the branch) may set `result.next` in `output`
>   (a literal or JsonLogic over `result`) to **override** the LLM's choice.
> - `action_contract` reads `next` from the result only (`output.next` / §6.6 branch), never from args.

Runtime implementations: **client-submitted** documents may use `passthrough` / `sitemap.search` / `mock` /
`flow` / `flow.map` and the sandboxed `lua` / `lua.compile` / `lua.dynamic`, or `kind: remote` (§14.4);
the internal `state.transform` (§9) and `delay` (§9.3) stay **app**-only.
Remote (`kind: remote`) requires the referenced `AX_*` tool to exist in the
compiled `tools` set.

### 9.1 Remote tool timeout

Remote tool calls have a configurable timeout (previously hardcoded 5000ms). On timeout the call fails
at `tool_execute` (`message: "timeout"`) and the node falls back via `fallback.invalidNext` — so a slow
remote tool must be given enough time or it routes to `error`.

Resolution order (first defined wins):

1. **per-tool** — flowTool / adapter `execute.timeoutMs` (ms).
2. **document default** — top-level `defaults.remoteToolTimeoutMs` (ms).
3. **runtime fallback** — `5000` (env `AXSDK_REMOTE_TOOL_TIMEOUT_MS` overrides this constant).

```yaml
defaults:
  remoteToolTimeoutMs: 15000        # applies to every remote flowTool unless overridden
flowTools:
  search_service:
    execute: { kind: remote, tool: AX_search_service, timeoutMs: 25000 }   # this tool overrides the default
```

- Both knobs are positive integers in ms, validated and clamped to ≤ 120000; invalid values are ignored
  (fall through to the next level).
- Retries: a timed-out remote call is retried once (`maxAttempts=2`), so total wall-clock ≈
  `2 × resolved timeout`.
- For `extends: app` overlays, both `defaults` and per-tool `execute.timeoutMs` are merged into the
  effective document (§14.2).

### 9.1.1 Declarative remote polling

A remote adapter may repeat the same idempotent tool call until a JsonLogic condition over the normalized
remote result becomes false. Polling is an adapter concern: the planner and action-unit model make one
tool decision, and only the final non-retrying result reaches the adapter's normal `output` projection.

```yaml
flowTools:
  read_job_status:
    description: Read the current job status.
    execute:
      kind: remote
      tool: AX_read_job_status
      timeoutMs: 5000               # timeout for each remote invocation, not the whole polling loop
      poll:
        retryWhile: { "===": [{ var: pending }, true] }
        intervalMs: 500             # optional; default 500
        maxAttempts: 60             # optional; default 60
    input:
      job_id: ${tool.args.job_id}
    output:
      next: done
      status: ${result.status}
    idempotent: true
    parameters:
      type: object
      required: [job_id]
      properties:
        job_id: { type: string }
```

- `retryWhile` is required and must be a non-empty JsonLogic object. It is evaluated against each
  normalized remote result at the root scope; for example, `{ var: pending }` reads `result.pending`.
- `intervalMs` is a fixed delay between attempts: integer `1..30000`, default `500`.
- `maxAttempts` bounds total remote invocations: integer `2..256`, default `60`.
- Polling requires `kind: remote` and `idempotent: true`. It cannot be combined with `pagination`.
- Every retry reuses the exact mapped `input`. A non-retrying result returns immediately; if the condition
  remains true on the final attempt, the adapter throws `remote poll exhausted` and normal node recovery applies.
- Abort cancels both an in-flight remote invocation and the inter-attempt sleep. `execute.timeoutMs` applies
  independently to each remote invocation; it is not a total polling deadline.
- Runtime debug logs emit one `remote_poll` entry per attempt with `tool`, `attempt`, `maxAttempts`,
  `status` (`retrying`, `completed`, or `exhausted`), and `elapsedMs`.
- The same contract and validation apply to app `flows.yaml`, integrated session `clientFlowDocument`,
  inline flowTool adapters, and standalone client adapter maps. Omitted defaults are materialized only by
  the runtime adapter normalizer.


### 9.2 Lua adapter (`implementation: lua`)

For deterministic logic the `state.transform` DSL cannot express (array `pop`/remove, marking an item
done, multi-step computation), an **app/trusted** adapter may run a sandboxed Lua 5.3 function. The
script receives the tool `args` as the globals `args` and `input`, and its returned table becomes the
tool result (merged into flow state like any tool; only `next` is consumed for routing).

```yaml
flowTools:
  todo_op:
    description: Apply a deterministic op to the todolist.
    execute:
      kind: runtime
      implementation: lua
      lua: |
        -- args.todolist / args.op / args.target_id come from projected flow state
        local out = {}
        if args.op == "pop" then
          local l = args.todolist or {}; table.remove(l); out.todolist = l
        elseif args.op == "remove" then
          local kept = {}
          for _, it in ipairs(args.todolist or {}) do
            if it.id ~= args.target_id then kept[#kept + 1] = it end
          end
          out.todolist = kept
        elseif args.op == "done" then
          for _, it in ipairs(args.todolist or {}) do
            if it.id == args.target_id then it.done = true end
          end
          out.todolist = args.todolist
        end
        out.next = "updated"
        return out
      maxInstructions: 2000000   # optional; clamped to <= 50_000_000 (default 2_000_000)
      entry: ""                  # optional; if set, the chunk defines it and runtime calls entry(args)
    parameters:                  # schema properties select which state fields project into args (action_contract)
      type: object
      additionalProperties: true
      properties:
        todolist:  { type: array }
        op:        { type: string }
        target_id: { type: [string, "null"] }
```

Use it from an **`action_contract`** node: `actionArgs`/`projectSchemaArgs` project the declared state
fields (`todolist`, `op`, `target_id`) into `args` with **no LLM**; the new `todolist` returned merges
back into flow state. A preceding `action_unit` (LLM) only sets the small target (`op`/`target_id`).

Execution model and limits:
- **Sandbox**: only `base`/`table`/`string`/`math` are opened; `os`, `io`, `package`, `require`,
  `load`/`loadstring`, `dofile`/`loadfile`, `debug`, `collectgarbage`, `print`, and `math.random`/
  `randomseed` are removed. No filesystem, network, process, or wall-clock access → **deterministic**.
- **Bounded execution**: a fixed instruction-count hook aborts after `maxInstructions` (default
  2,000,000). fengari is synchronous, so this hook — not a wall-clock timeout — is the loop bound; an
  infinite loop raises an error instead of hanging.
- **Data**: `args` is deep-copied into native Lua tables (no live JS objects are exposed); the return
  is deep-copied back. JS `null` → Lua `nil` (absent in tables). Functions/userdata in the output are
  dropped. Output depth/size are capped. A **fully-empty** Lua table reads back as JSON `{}` (Lua cannot
  tell an empty array from an empty map) — wrap it with the injected helper **`array(t)`** to force a JSON
  array (`array({})` → `[]`); `array()` marks any table (empty, non-empty, or nested) as an array.
- **Compile check**: the script is syntax-checked at compile time (`…execute.lua: invalid lua script`).
  Size is capped at 64 KB.
- **Trust**: `lua` is **allowed in client (`clientFlows`) documents** too — its sandbox (no I/O, stripped
  stdlib, instruction-bounded, deep-copy isolation) is the security boundary. The client gate (§14.4)
  requires `execute.lua` to be present; the synchronous instruction cap (≤ 10,000,000) bounds event-loop
  blocking. `state.transform` remains app-only.


### 9.3 Delay (`implementation: delay`) and the `__self__` self-loop

A `delay` tool **waits** a bounded time, then returns — for pacing, or "wait briefly, then let the
assistant continue." It is a wall-clock **side-effect**, **app-authored only**.

```yaml
flowTools:
  delay:
    description: Pause briefly, then continue.
    execute:
      kind: runtime
      implementation: delay
      delayMs: 3000        # fixed wait (optional); or the caller passes args.delayMs / args.ms
      next: ""             # optional transition key; omitted -> "__self__" (self-loop)
    parameters:
      type: object
      properties:
        delayMs: { type: number }
        next: { type: string }
```
- **Duration**: `args.delayMs ?? args.ms ?? execute.delayMs ?? 0`, clamped to **≤ 30,000 ms**. Returns `{ waited_ms, next }`.
- **Abort**: respects the session/turn abort signal — a cancelled turn stops the wait immediately.
- **In-turn only**: the wait holds the open turn (request/SSE) → **short** waits only. Long waits need a durable scheduler (separate feature).
- **`next`**: `args.next ?? execute.next ?? "__self__"`.

**`__self__` reserved self-next** (generic): any action result whose `next` is `"__self__"` **re-enters the
current node** (self-loop) without a `node.next` entry, bounded by `maxSteps`. Because self-loop re-runs the node:
- on an **`action_unit`** node → the **LLM is re-invoked** each iteration;
- on an **`action_contract`** node → only the deterministic tool re-runs (no LLM).

So "LLM calls `delay` → wait → LLM called again to continue" = a self-loop **`action_unit`**: the LLM calls
`delay` (no `next` → `__self__` → self-loop), the node re-enters and the LLM runs again for the follow-up
(returning a real `next` to exit). A standalone `delay`-only `action_contract` that always self-loops spins
to `maxSteps` and errors — so use `execute.next` to advance for one-shot pacing, and reserve self-loop for
nodes that exit on a condition (or the LLM choosing a non-self `next`).

### 9.4 Step limit (`defaults.maxSteps`)

Each turn the interpreter runs at most `maxSteps` node executions (self-loops, promptless chains, and
multi-node flows all count). Exceeding it throws `flow exceeded max steps` at runtime.

Resolution: top-level `defaults.maxSteps` ?? **24** (runtime default). Positive integer, floored, and
**clamped to ≤ 256** (the hard cap). Invalid values (≤ 0, non-numeric) are ignored → falls back to 24.

```yaml
defaults:
  maxSteps: 64        # raise the per-turn step budget for long promptless chains / self-loops
```
- **clientFlows-overridable** (§14) via an **`extends: app` overlay**: `defaults.maxSteps` merges
  field-wise onto the app base and is **clamped to ≤ 256 for client and app documents alike** — a client
  cannot raise the budget beyond 256. (A full-replace client document's `defaults` is consumed as
  agent/session config, not the config-runtime step limit — same as `remoteToolTimeoutMs`; use an overlay.)
- Raise it for legitimate long chains (e.g. `delay` self-loops, multi-step deterministic flows); keep it
  low to bound runaway loops and LLM cost.
- **Deterministic self-loops can be exempted** from this global budget per node via `maxSelfSteps` (§9.5),
  so a multi-step `action_contract` does not consume the per-turn budget that bounds the rest of the flow.


### 9.5 Per-node self-loop budget (`maxSelfSteps`)

A deterministic multi-step `action_contract` that self-loops (e.g. an "answer" contract filling a form
across N steps) would otherwise consume N of the global `maxSteps` (§9.4), constraining how much else the
flow can do in one turn. Set **`maxSelfSteps` on the node** to give its self-loop its own budget:

```yaml
flows:
  quote:
    nodes:
      answer:
        kind: action_contract        # allowed on action_contract AND action_unit nodes
        maxSelfSteps: 16             # self-loop iterations here count against THIS budget, not maxSteps
        id: answer
        next: { again: answer, done: review }   # `again` -> self
        tools:
          answer:
            schema: { type: object, properties: { next: { type: string } }, additionalProperties: true }
      review: { kind: terminal, respond: Done. }
```
- When a node with `maxSelfSteps` **self-loops** (`next` resolves to itself / `__self__`), the iteration
  counts against a **per-node** counter (≤ `maxSelfSteps`, hard cap **256**, reset each time the node is
  entered) and does **not** consume the global `maxSteps`. Advancing to a *different* node always consumes
  the global budget. Exceeding the per-node budget throws `node exceeded self-loop budget: <flow>.<node>`.
- **Allowed on `action_contract` and `action_unit`** nodes. On an `action_contract` the global `maxSteps`
  stays the sole bound on per-turn **LLM** iterations; on an `action_unit` (agentic self-loop) it gives the
  loop its own budget — pair it with `fallback.stalledNext` (§9.5.2) for a graceful exit instead of the
  `node exceeded self-loop budget` throw.
- Positive integer, floored, clamped ≤ 256. Per-turn and per-visit (a fresh budget on every entry), like
  `maxSteps`.

Net effect: a deterministic N-step contract behaves like **one** flow-step against the global budget —
`maxSteps` bounds flow-level breadth (e.g. number of items processed) while `maxSelfSteps` bounds contract
depth.

### 9.5.1 State-conditional tool eligibility (`allowedTools[].when`)

An `action_unit` `allowedTools` entry may be a bare tool name **or** an object `{ tool, when }`, where `when`
is a comparison string or JsonLogic object (same language as a §6.6 decision `when`) evaluated against the
**current flow state** each self-loop iteration. Only tools whose predicate holds (or that have no `when`)
are offered to the LLM that step.

```yaml
        allowedTools:
          - { tool: read,     when: { "==": [ { var: fileContent }, "" ] } }
          - { tool: webfetch, when: { and: [ { "!=": [ { var: fileContent }, "" ] }, { "==": [ { var: docsInfo }, "" ] } ] } }
          - { tool: diff,     when: { "==": [ { var: diffResult }, "" ] } }
          - finish                       # no `when` -> always eligible
```

- **Forcing.** When the predicates narrow the offered set to **exactly one** tool, the runtime forces that
  tool (`toolChoice`), so the model cannot pick a wrong-but-valid tool — the single biggest lever for driving
  a weak model through a deterministic pipeline while keeping the node agentic when several tools are eligible.
- **Fail-closed on zero eligibility.** If a state leaves **zero** tools eligible, the runtime does **not** fall
  back to offering the full `allowedTools` set. The action resolves **deterministically before any LLM or tool
  call** to `fallback.invalidNext` (→ `error` if unset, then the first declared `next`; §8), recording a
  `stage: config` validation error (`action <id> turn <id> has no eligible tools`). Zero eligible tools is thus a
  side-effect-free, no-model-call exit — never an unconstrained "offer everything" step.
- Predicates read the projected flow state (the same state the node sees via `inputSelector`). `next` is still
  chosen per §9.10 (`result.next ?? args.next`); eligibility gates **tool selection**, not the transition.

**The `fields` shorthand.** Presence pipelines ("which fields are filled in yet?") are verbose in raw
JsonLogic (`{ "!": [{ missing: [...] }] }` per field). `when` therefore accepts one compile-time macro: an
object whose **only** top-level key is `fields`, holding one or more of four clauses, each a non-empty array
of dotted state paths:

- `allPresent: [...]` — **every** path is present.
- `anyPresent: [...]` — **at least one** path is present.
- `allMissing: [...]` — **every** path is missing.
- `anyMissing: [...]` — **at least one** path is missing.

Several clauses in one block are **ANDed** in the fixed order `allPresent, anyPresent, allMissing, anyMissing`
(independent of YAML key order, so IR snapshots stay deterministic); a single-clause block emits that clause
alone. One `action_unit` can then drive a deterministic staged pipeline — one forced tool per stage — with no
hand-written `!`/`!!` presence tree:

```yaml
        allowedTools:
          - tool: collect_service
            when: { fields: { anyMissing: [service_query, user_requirements] } }
          - tool: collect_location
            when:
              fields:
                allPresent: [service_query, user_requirements]
                allMissing: [zip_code, address]
          - tool: resolve_zip
            when:
              fields: { allPresent: [address], anyMissing: [zip_code] }
          - tool: collect_contact
            when:
              fields:
                allPresent: [zip_code]
                anyMissing: [last_name, first_name, email, phone]
          - tool: finish_quote
            when:
              fields: { allPresent: [service_query, user_requirements, zip_code, last_name, first_name, email, phone] }
```

- **Presence follows `missing`, not truthiness.** A path that is **absent / `undefined` / `null` / `""`** is
  *missing*; **`false`, `0`, `[]`, `{}`**, whitespace-only strings, and every other non-empty value are
  *present*. This intentionally differs from `!!{ var }` (which treats `0` / `false` / `[]` as falsy) — keep raw
  `when` comparisons for value-dependent booleans and numerics; use `fields` only for population/completeness.
- **Dotted `var` paths only.** Numeric segments are fine (`items.0.id`); JSONPath / bracket / wildcard forms
  (`$.x`, `items[0]`, `items[*]`, `..`) are **compile errors** that echo the offending path, as are empty,
  duplicate, or surrounding-whitespace entries. Paths resolve against the **same projected flow state** as raw
  eligibility rules and are re-evaluated each self-loop iteration — the macro never bypasses `inputSelector`.
- **Pure compile-time sugar.** It desugars to stock `missing` / `!` / `!!` / `and` / `or` before the eligibility
  IR is emitted — **no new operator, evaluator, or IR field** — so forcing, fail-closed-on-zero, and transition
  selection (above) are unchanged. Every emitted clause is **boolean-wrapped**: a bare top-level `missing` (which
  yields an array, not a boolean) is never produced, so a result can never be misread by length.
- **`allowedTools`-only, and `fields` stands alone.** The macro is recognized **only** as an
  `allowedTools[].when` wrapper; the same `{ fields: … }` in a decision / §6.6 branch `when` is rejected
  (`fields macro is only supported in allowedTools[].when; use raw JsonLogic here`). Within a `when`, `fields`
  **cannot** share the object with other JsonLogic keys — to mix presence with other predicates, drop to **raw
  JsonLogic** (the escape hatch above), which remains byte-for-byte compatible.
- **Deployment-safe (runtime first).** Desugaring happens in the runtime compiler; the backend structurally
  merges and preserves the authoring object (including `extends: app` overlays) until then. A runtime that predates
  the macro does **not** silently unguard the tool: it passes `{ fields: … }` through as JsonLogic, where the
  unknown `fields` operator **throws** rather than returning `true` — fail-closed, never an accidental "offer
  everything". Deploy the compiler-aware runtime before authoring `fields` rules.

A standalone controller document is available at
[`examples/collect-eligible-controller.yaml`](examples/collect-eligible-controller.yaml).

#### Complete example: field-driven profile collection

The document below is self-contained. Each successful tool call writes fields back into flow state through
`$spread`; the next self-loop therefore sees a different eligible tool. `marketing_opt_in: false` still counts
as present, so an explicit opt-out advances to `finish_profile` rather than reopening consent collection.

```yaml
version: 1
app:
  id: field-eligibility-example
defaults:
  mapping: interpolation
router:
  mode: fixed
  defaultIntent: profile_update
  routes:
    - intent: profile_update
      entry: profile_update.collect
      priority: 100
flowTools:
  collect_identity:
    description: Collect the user's name and email.
    execute: passthrough
    output:
      $spread: ${tool.args}
      next: continue
    parameters:
      type: object
      additionalProperties: false
      properties:
        name: { type: string }
        email: { type: string }
  collect_consent:
    description: Collect the user's explicit marketing preference.
    execute: passthrough
    output:
      $spread: ${tool.args}
      next: continue
    parameters:
      type: object
      additionalProperties: false
      required: [marketing_opt_in]
      properties:
        marketing_opt_in: { type: boolean }
  finish_profile:
    description: Finish after every required profile field is present.
    execute: passthrough
    output:
      next: done
      completion: Profile collection complete.
    parameters:
      type: object
      additionalProperties: false
      properties: {}
flows:
  profile_update:
    goal: Collect a name, email, and explicit marketing preference.
    nodes:
      collect:
        kind: action_unit
        prompt: Read the latest userMessages value, call the one eligible tool, and never invent profile values.
        inputSelector: [userMessages, name, email, marketing_opt_in, completion]
        state:
          include: [name, email, marketing_opt_in, completion]
        allowedTools:
          - tool: collect_identity
            when:
              fields:
                anyMissing: [name, email]
          - tool: collect_consent
            when:
              fields:
                allPresent: [name, email]
                anyMissing: [marketing_opt_in]
          - tool: finish_profile
            when:
              fields:
                allPresent: [name, email, marketing_opt_in]
        maxSelfSteps: 3
        fallback:
          invalidNext: error
          exhaustedNext: error
        next:
          continue: collect
          done: done
          error: error
      done:
        kind: terminal
        respond:
          from: [completion]
          fallback: Profile collection complete.
      error:
        kind: terminal
        respond: Profile collection failed.
```

Expected eligibility progression:

| Flow state before the step | Eligible tool |
|---|---|
| `{}` | `collect_identity` |
| `{ name: "Ada", email: "ada@example.com" }` | `collect_consent` |
| `{ name: "Ada", email: "ada@example.com", marketing_opt_in: false }` | `finish_profile` |

#### Example: value-dependent conditions stay in raw JsonLogic

`fields` answers only whether values are populated. If eligibility also depends on a particular boolean,
number, or enum value, author the complete condition as raw JsonLogic:

```yaml
        allowedTools:
          - tool: charge
            when:
              and:
                - "!": [{ missing: [payment_method] }]
                - "==": [{ var: consent_granted }, true]
                - ">": [{ var: total }, 0]
```

Do not rewrite `consent_granted == true` as `fields.allPresent`: both `true` and `false` are present values, but
only `true` satisfies the business predicate above.

### 9.5.2 No-progress guard (`fallback.maxStalledSteps` / `stalledNext`)

A self-loop that keeps producing the **same flow state** (a stuck model, or a tool that never advances) would
otherwise burn `maxSteps` / `maxSelfSteps` and then throw. Set `fallback.maxStalledSteps` to detect it and
route out **gracefully**:

```yaml
        next: { continue: run, done: reply, timeout: bail }
        fallback:
          maxStalledSteps: 3            # N consecutive self-loops with no flow-state change
          stalledNext: timeout          # transition to take when the guard trips (must be in `next`)
```

- After `maxStalledSteps` consecutive self-loop iterations whose merged flow state is byte-identical to the
  prior iteration, the node transitions via `fallback.stalledNext` (falling back to `exhaustedNext` if unset).
  Progress (any state change) resets the counter.
- `stalledNext` must be a declared `next` key (compile-checked). If neither `stalledNext` nor `exhaustedNext`
  is set, the guard throws `node made no progress: <flow>.<node>` instead of routing.

### 9.5.3 Talking to the user mid-loop (`toolChoice: auto`)

By default an `action_unit` step is **forced** to call a tool (`toolChoice: required`, or a single eligible tool
→ forced), so the model produces no user-visible text. Set node **`toolChoice: auto`** to let a step return
**plain text** instead of a tool call: the runtime streams that text to the user as a live message and the
self-loop **continues** (the text is fed back as an `assistant` message so the model does not repeat it) rather
than failing the step. So one node can `narrate → act → narrate → act …` **without pausing** — distinct from the
`question`/`response` pause (§7.5), which **waits** for a reply.

```yaml
      run:
        kind: action_unit
        toolChoice: auto              # a step may be plain-text narration or a tool call
        allowedTools:                 # pair with eligibility so the tool, when called, is the right one
          - { tool: read,  when: { "==": [ { var: file }, "" ] } }
          - { tool: finish, when: { "!=": [ { var: file }, "" ] } }
        next: { continue: run, done: reply }
```

- Any step's text is emitted **before** its tool runs (order = message-then-tool). Narration counts against
  `llm.maxCalls` / `maxSelfSteps`, so those bound how much a node may talk before it must act or exit.
- **Pair with eligibility (§9.5.1).** `auto` removes the tool-forcing that keeps a weak model on track, so on its
  own it can over-narrate / mis-pick tools; eligibility narrows each step to the correct tool while `auto` still
  allows the narration text.
- Whether the model emits text with `auto` is model-dependent (the loop still terminates via a tool → terminal).

### 9.6 Tool-call failure & retry (`llm.maxCalls`)

Handling of a failed flow tool call depends on the node kind.

**`action_unit`** (the LLM picks/calls the tool). Each LLM attempt is validated in stages: `model` (no /
disallowed tool call), `tool_args` (args fail the tool JSON schema), `tool_execute` (tool threw / remote
timeout), `tool_result` & `next` (output shape). **Every stage retries uniformly:**
- **All failures → bounded retry.** The runtime appends the exact validation error as a system message and
  **re-prompts the LLM** ("do not repeat the invalid arguments; call the tool again — corrected args, or a
  different tool that makes progress"). This covers `model`, `tool_args`, **`tool_execute`** (the LLM
  *observes* the tool error and can switch tool/args — in-loop error recovery), and the final
  `tool_result` / `next` stages. The budget is `llm.maxCalls` (total LLM calls for the action, shared across
  turns). **Default = `max(1, turns) + 1`** → a single-turn action gets **2** calls = **1 retry**. On
  exhaustion → `fallback.invalidNext` (→ `error`, §8).
- **Mutation safety without extra config.** Retrying a `tool_execute`/`next` failure re-prompts the LLM, which
  may re-invoke a side-effecting tool. This is safe because `effect: mutation` tools are **required
  idempotent** (§12) — repeating an idempotent mutation yields the same end state. To force fail-closed for a
  specific action (no retry), set **`llm.maxCalls: 1`**. (For remote mutations, full safety across a
  succeeded-but-errored network case also relies on backend idempotency-key dedup — hardening §3.)

**`action_contract`** (deterministic, no LLM). Args are projected from state and validated against the tool
schema; a schema failure throws and the node resolves to **`next: error`** with **no retry** (re-running the
same deterministic projection fails identically). Fix the schema/projection, or route `error` to recovery.

**Tuning `llm.maxCalls`** (per action, or inline under the node):

```yaml
actions:
  collect_fields:
    kind: action_unit
    llm: { maxCalls: 3 }      # 1 initial + 2 feedback re-prompts (single-turn)
    # ...
  strict_once:
    kind: action_unit
    llm: { maxCalls: 1 }      # no retry — first invalid call routes straight to fallback `error`
    # ...
```
- `maxCalls` is the **total** LLM-call budget for the action; a multi-turn action needs ≥ `turns`, retries
  consume the remainder. `maxCalls < turns` → immediate `exhausted` → fallback.
- Before raising retries, check the **schema ↔ prompt** match: if the prompt tells the LLM to emit `null`
  for unknown fields but the schema forbids `null`, every retry re-fails — make those fields
  `type: [string, "null"]`. Retries fix *formatting slips*, not *contract mismatches*.

### 9.7 Value mapping (`output` / `input`) & `defaults.mapping`

`output` (tool result → step result) and `input` (LLM args → remote args) map values via templates. The
**`defaults.mapping`** mode controls how a **string** value is read:

| value | `legacy` (default) | `interpolation` |
|---|---|---|
| `continue` | literal (no dot, not a scope key) | literal |
| `result.next` | **path** (dotted → traversed) | **literal** `"result.next"` |
| `.article-body` | path miss → **`undefined`** (silent) | literal `.article-body` |
| `${result.next}` | literal `"${result.next}"` | **path** → typed value |
| `"id ${args.id}"` | literal | embedded → `"id 7"` |
| `$$` | literal `$$` | literal `$` (escape) |

- **`legacy`** — a bare string is a path when it contains `.` or matches a scope key, else a literal. This
  is context-dependent and fails **silently** to `undefined` on a dotted miss (the dotted-literal foot-gun).
- **`interpolation`** (recommended for new docs) — **a string is always a literal; references use
  `${path}`.** A whole-string `${path}` returns the **typed** value (array/object/number preserved); an
  embedded `${path}` is stringified into the surrounding text; `$$` escapes a literal `$`. No dot-heuristic,
  no scope-key collision, no silent literal/path confusion. `{ op: … }` (JsonLogic `if`/`in`/`==`/`map`/…)
  still **computes** in either mode (references inside logic use `{ var }`).

```yaml
defaults:
  mapping: interpolation        # legacy | interpolation (default legacy). Invalid value → compile error.
flowTools:
  pick:
    execute: { kind: runtime, implementation: passthrough }
    output:
      next: continue                 # literal
      selector: ".read-more"         # literal (dots safe)
      item: "${result.items.0}"      # typed reference (the object, not a string)
      label: "row ${result.id}"      # embedded interpolation
```
- **Scope**: applies to `output` / `input` value templates. `inputSelector` / `outputMap` (§10) are
  **pure path lists** (always references) and are unaffected. `state.transform` keeps its own
  `{ literal: … }` / `{ path: … }` markers.
- **Migration**: existing docs stay on `legacy` (no change). Opt new docs into `interpolation` for
  safe-by-default literals; mixing a legacy bare path (`result.next`) under `interpolation` makes it a
  **literal**, so convert those to `${result.next}`.

### 9.8 Model & LLM defaults (`defaults.model` / `defaults.llm`)

Action nodes need not repeat `model`/`llm`. Resolution is **base→override, field-wise**:

- **model**: `node.model` → `defaults.model` → **`session.model`** (the app/session default). A node that
  omits `model` already inherits the session model — so per-node model blocks that only repeat the app
  default are redundant and can be dropped.
- **llm**: `node.llm.<field>` → `defaults.llm.<field>` → runtime constant (e.g. `maxCalls` =
  `max(1, turns) + 1`, `temperature` = 0).

`defaults.model` / `defaults.llm` are **folded into every action at compile time**, with the node winning
field-by-field (`{ ...defaults.model, ...node.model }`).

```yaml
defaults:
  model: { providerID: openrouter, modelID: openai/gpt-oss-120b,
           providerOptions: { openrouter: { reasoning: { effort: low } } } }
  llm:   { temperature: 0, maxOutputTokens: 1024 }       # shared by all action nodes
flows:
  quote:
    nodes:
      collect:
        kind: action_unit
        llm: { maxCalls: 4 }          # overrides only maxCalls; temperature/maxOutputTokens inherited
        # model omitted -> inherits defaults.model
        # ...
```
- **Shallow merge**: a node `model` that sets `providerOptions` replaces the default's `providerOptions`
  wholesale (override `modelID` alone to keep the default provider options).
- **clientFlows**: `defaults` is overlay-merged only on the **`extends: app`** path; a full-replace client
  document's `defaults` is consumed as agent/session config (same caveat as §9.4 `maxSteps`).

### 9.9 flowTool authoring shorthands

Cut the per-tool ceremony:

- **String `execute`** — `execute: passthrough` (or `runtime`) expands to
  `{ kind: runtime, implementation: passthrough }`; `execute: sitemap.search` likewise. Use the object form
  for `remote` (needs `tool:`), `lua`, `state.transform`, `delay` (they need extra fields).
- **Echo all args** — a `passthrough` tool with **no `output`** returns its args verbatim (no need to list
  every field).
- **`$spread`** — in an `output`/`input` record, the `$spread` key merges a resolved record first, then
  sibling keys add/override it: echo args **and** add literals in one place.

```yaml
flowTools:
  pick:
    execute: passthrough                  # 1-line shorthand
    output:
      $spread: ${tool.args}               # echo every arg (interpolation; legacy: tool.args)
      next: continue                      # then add/override
      navigated: true
    parameters: { type: object, properties: { url: { type: string } } }
  note:
    execute: passthrough                  # no `output:` -> echoes all args verbatim
    parameters: { type: object, properties: { text: { type: string } } }
```
- `$spread` works in both mapping modes; sibling keys win over the spread.

### 9.10 `next` is a runtime-injected LLM control argument (`action_unit`)

The compiler **injects a `next` parameter** (`type: string`, `enum` = the node's `next` keys) into **every**
`action_unit` flowTool schema — whether or not the tool declares one. The LLM picks the transition in the
tool-call **args**, and **tools return only domain data** (no `next` in their impl or authored schema) → a tool
is reusable across flows and mapping modes.

- **Transition source.** `next = result.next ?? args.next`: the tool result's `next` wins **if present**
  (result-driven, backward-compatible), otherwise the LLM's `next` argument. A pure tool omits `next` from its
  result, so `args.next` drives the loop.
- **One place, per node.** The enum is the full `node.next` key set, set on a **per-action clone** (a flowTool
  shared by nodes with different `next` maps gets the right enum at each); a hand-written enum is **overridden**
  by the derived one. Drift guard: an enum value not in `node.next` is a compile error.
- **`action_unit` only.** `action_contract` next is deterministic (`output.next` / §6.6 branch); its tool schema
  is left untouched.
- **Result-driven routing without touching the tool:** return `result.next`, or use a §6.6 `next:{when,then,else}`
  branch on an `action_contract` node.

```yaml
flowTools:
  diff:                         # pure: no `next` in impl or schema — the runtime injects it, the LLM fills args.next
    execute: { kind: runtime, implementation: lua, lua: 'return { diffResult = tostring(input.left).." vs "..input.right }' }
    parameters: { type: object, properties: { left: { type: string }, right: { type: string } } }
```

---

### 9.11 Data terminal (object `respond`)

A `terminal` node's `respond` may be a **string** (existing behavior — verbatim, or rewritten by `app.terminal`, §6) **or an object** the interpreter resolves **deterministically from flow state, with no LLM call and bypassing `app.terminal`**:

```yaml
clarify:
  kind: terminal
  respond: { from: question, fallback: 쇼핑할 상품명을 알려주세요. }
done:
  kind: terminal
  respond: { from: [html, message], fallback: 완료했습니다. }   # first non-empty string wins, else fallback
```

- **`from`**: a dot path into the flow state, or an array of paths tried in order. The **first** path resolving to a **non-empty string** is returned verbatim; otherwise `fallback`.
- **`fallback`**: required, non-empty literal string.
- **No LLM, no `app.terminal` rewrite.** The named field is emitted exactly, so a stale state field can never leak — the failure mode of a free-form `app.terminal` directive over the whole-state dump (§6, §13). Use it for terminals that surface a field an earlier action already produced (e.g. a clarification `question`).
- **Strings are unchanged.** Only the object form is data; a plain string still goes through the `app.terminal` LLM (when configured) for language adaptation — keep fixed status messages as strings.

---

### 9.12 Mock adapter (`implementation: mock`)

For self-contained example/test flows (no backend), a flowTool can **return canned data verbatim** — no remote call, no LLM, no `resolvePath` (so dotted strings are safe, unlike `passthrough` + `output`):

```yaml
flowTools:
  demo_extract:
    execute:
      kind: runtime
      implementation: mock
      returns: { next: continue, html: "<html>…</html>" }   # emitted as-is (deep clone)
  demo_search:
    execute:
      kind: runtime
      implementation: mock
      returns: { next: continue, results: [ { url: /help, selector: .article-body } ] }
      returnsByArgs:                       # optional arg-driven branching
        - match: { query: 없음 }           # exact deep-equal subset of args
          returns: { next: continue, results: [] }
    parameters: { type: object, properties: { query: { type: string } } }
```

- **`returns`**: pure data, emitted as-is (`structuredClone`) — a fresh clone each call, no path resolution.
- **`returnsByArgs`**: the first entry whose `match` is an exact **deep-equal subset** of the call args wins; otherwise `returns`. Exact match only — substring/conditional output still needs `passthrough` + JsonLogic.
- **Compile error** if neither `returns` nor `returnsByArgs` is present.
- **Allowed in `clientFlows`** (canned data only, no side effects).
- Echoing an arg (`${tool.args.x}`) is **not** a mock (mock ignores args except for `match`) — use `passthrough`.

---

### 9.13 Flow exception model (auto-unwind + `__error`)

Errors are **exceptions**: any node failure produces a structured `__error` and unwinds to the nearest handler, so per-node `fallback` / `next.error` wiring is **optional**.

- **`__error`** (reserved flow-state field) `{ stage, message, node, flow }` — `stage ∈ config|budget|model|tool_args|tool_execute|tool_result|next|timeout`. Before an action result is merged, the prior `__error` is cleared; a successful action handler therefore recovers, while a decision- or terminal-only handler preserves the failure.
- **Resolution** on a node failure / unresolved transition: `node.next.error` (if declared) → `flow.onError: <nodeId>` → **built-in default** (completes with `app.errorResponse`, else a neutral message). A node that returns *no next and no error* is still a hard error.
- **Handler = any node.** Point `flow.onError` at a data terminal (§9.11) that surfaces the real cause:
```yaml
flows:
  checkout:
    onError: on_error            # any node id in this flow
    nodes:
      on_error: { kind: terminal, respond: { from: [__error.message], fallback: 요청을 처리하지 못했습니다. } }
      # per-node fallback / next.error no longer required
app:
  id: myapp
  errorResponse: 요청을 처리하지 못했습니다.   # built-in default when no onError/next.error
```
- **Backward compatible**: declared `next.error` / `fallback` still resolve first; only previously-crashing unresolved transitions now unwind gracefully.
- **Subflow boundaries.** When a flow runs as a subagent (`execute: flow`) or as a `flow.map` item, its terminal
  outcome is **typed** (§9.17): reaching a terminal while still carrying an unrecovered `__error`, or a direct hard
  failure, becomes a `failed` outcome — surfaced as `{ __return: "error", __error }` for `execute: flow` (route it
  through the caller's `next.error`) or a `failed` item for `flow.map`. A successful downstream action handler
  clears the prior `__error` before merging its result and yields a normal `completed` outcome; a decision- or
  terminal-only handler leaves it unrecovered. Terminal node **names** stay domain-neutral: outcome status never
  comes from a terminal called `failed`/`error`.

### 9.14 Deterministic branch — `next: { when, then, else }` and `kind: decision`

A node may **branch deterministically** instead of listing a transition map — no tool / schema just for
routing, no LLM. Two forms:

- **`kind: decision`** — no action; branch on **flow state**:
```yaml
gate:
  kind: decision
  next: { when: "plan == pro", then: pro_flow, else: free_flow }
```
- **`action_contract` branch** — run the tool, then branch on the **tool result merged over flow state**
  (`result.*` and state paths both resolve); the tool need not return `next`:
```yaml
pick:
  kind: action_contract
  id: score
  next: { when: "result.count > 0", then: found, else: empty }
```

- **`when`** — a **comparison string** `"<path> <op> <literal>"` (op `== != > >= < <=`, or `in` for
  `<path> in <path>`) compiled to JsonLogic at compile time; **or** a raw **JsonLogic object** for anything
  more complex. Literals are JSON (`20`, `true`, `"pro"`); an unquoted word is a string.
- **`then` / `else`** — node ids in the same flow (compile-validated). `else` is **required** and may be a
  nested branch (elif): `else: { when: …, then: …, else: … }`.
- **Not on `action_unit`** — there the LLM owns `next` (§6.3 derives its enum); a branch is a compile error.
- A branch consumes one `maxSteps` step; a failed `action_contract` still **unwinds** (§9.13) instead of
  branching. `next` as a `{ key: nodeId }` map is unchanged — the branch object is an additive opt-in.

### 9.15 Dynamic Lua — LLM-generated scripts (`lua.compile` / `lua.dynamic`)

Unlike §9.2 (author-written `execute.lua`), these run a **model-authored** Lua script passed as a **tool
argument**, in the same hardened sandbox. Two tools:

- **`implementation: lua.compile`** — compile-checks the script arg (default `script`, override with
  `argScript`) and returns `{ ok: true, script }` or `{ ok: false, error }` as **data (never throws)**, so the
  LLM can fix syntax before running.
- **`implementation: lua.dynamic`** — runs the script arg over data and returns its table. The script comes
  from `argScript` (default `script`); the Lua global **`input`** is the `argInput` arg if set, else **the
  remaining args** (every arg except the script field). The tool therefore **never enumerates data fields** —
  the node's `inputSelector` (or the LLM) supplies whatever the script needs.

```yaml
# opaque envelope (an action_unit LLM fills `data`):
run_lua:
  execute: { kind: runtime, implementation: lua.dynamic, argScript: script, argInput: data }
  parameters: { type: object, properties: { script: { type: string }, data: { type: object } }, required: [script] }
# fully generic (an action_contract node's inputSelector supplies data; input = args minus script):
run_lua_generic:
  execute: { kind: runtime, implementation: lua.dynamic }
  parameters: { type: object }
```

- **Script prototype**: read global `input` (a table), **return a table**; only `base` / `table` / `string` /
  `math` (the §9.2 sandbox: no I/O, network, clock, random; 64 KB script; instruction / depth / output caps).
  Setting `execute.lua` on a `lua.dynamic` / `lua.compile` tool is a **compile error** (the script comes from
  args, not the document).
- **Off-runtime (client or another service):** `execute: { kind: remote, tool: AX_run_lua }` with an `input:`
  forwarding `{ script, data }` — the fulfiller runs the same sandbox and completes the call (no new runtime
  kind; reuses the remote-tool path).
- **clientFlows-overridable:** `lua.compile` / `lua.dynamic` are in the client-adapter allowlist (§14.4) —
  the same hardened sandbox as static `lua` (§9.2) — so `clientFlows` documents may override with them.
  `execute.lua` must **not** be set on these tools (the script comes from the args, not the document).
- **`outputSchema`** (optional JSON Schema on `lua.dynamic`) — validates the returned table; a mismatch is a
  runtime error (below). Off by default; use it to hard-guarantee a **deterministic** run's shape.
- **`recoverErrors: true`** (default false) — a runtime error (Lua error, instruction cap, `outputSchema`
  mismatch) returns a sentinel `{ ok: false, error }` **instead of throwing**, so the node can self-loop
  (the LLM revises, §9.3) or branch (§9.14) on `result.ok`.
- **Errors**: by default a `lua.dynamic` **runtime** error throws → unwinds (§9.13) (syntax errors are caught
  earlier by `lua.compile`); with `recoverErrors: true` they become the `{ ok: false, error }` sentinel above.
  Dynamic scripts are **not** compile-cached (model output is high-cardinality).

### 9.16 Authoring shorthands — `uses:`, inline `tool:`, `templates:` / `extends:`

These cut flowTool ceremony. They work in **app** documents and in **`clientFlows`** documents alike. In
client documents they are resolved (desugared) **before** the client-adapter allowlist runs (§14.4), so every
`execute` a synthesized/merged flowTool introduces is still gated — a `clientFlows` `tool:` / `extends:` that
resolves to a non-allowlisted `execute` (e.g. `kind: local`, `implementation: shell`) is rejected exactly as
an explicit adapter would be. On the **`extends: app` overlay** path, template references must be
self-contained in the overlay (the overlay is allowlist-validated on its own).

- **`uses: <flowTool>`** (on an `action_contract` node) — invoke the named flowTool, decoupled from the node
  `id`. `id: <name>` (identity == flowTool name) still works; `uses` is for when they differ or for clarity.
```yaml
pick: { kind: action_contract, id: pick, uses: score, next: { ok: done } }
```
- **Inline `tool:`** (on an `action_unit` / `action_contract` node) — the node's **single** tool, inline; the
  compiler synthesizes a flowTool `<flow>__<node>` and binds it (no `flowTools` entry, no `allowedTools`).
  Mutually exclusive with `id` / `uses` / `tools` / `allowedTools`.
```yaml
classify:
  kind: action_contract
  tool:
    execute: { kind: runtime, implementation: lua.dynamic }
    parameters: { type: object, properties: { script: { type: string } }, required: [script] }
  next: { done: reply }
```
- **`templates:` + `extends:`** — a top-level `templates:` map of reusable partial blocks; `extends: <name>`
  on a flowTool or node **deep-merges** the template (local keys win; chains allowed; cycles rejected). Not
  bound/executed unless referenced. Precedence (widest → narrowest): `defaults` (§9.8) → `extends` template →
  local fields.
```yaml
templates:
  lua_tool:
    execute: { kind: runtime, implementation: lua.dynamic, argScript: script }
    parameters: { type: object, properties: { script: { type: string } }, required: [script] }
flowTools:
  transform: { extends: lua_tool, outputSchema: { type: object } }   # inherit execute+parameters, add a field
  aggregate: { extends: lua_tool }
```

### 9.17 Bounded subflow map (`implementation: flow.map`)

`flow.map` runs the **same subflow over each item of a bounded collection** and returns results in input order.
It is available in both app-owned and `clientFlows` documents and in V1 is **sequential** (`concurrency` fixed
at 1). The map never waits for user input mid-call; task mode surfaces an input request as structured
`needs_input` data (§9.17.1). Full design and rationale: `AGENTIC_FANOUT_MAP_DESIGN.md`.

The map is **source-agnostic** and **effect-agnostic**: a target may reach read, navigation, or mutation adapters.
`flow.map` grants no side-effect privilege. Every mutation adapter still independently requires
`effect: mutation`, `consent: required`, a non-empty `require`, and `idempotent: true`; those checks run for each
execution. A V1 map is not a transaction: it provides no rollback, exactly-once, automatic deduplication, or
restart-skip guarantee, and a failure can follow already-committed effects.

**Adapter fields** (`execute`): `flow` (target flow — required), `itemsArg` (top-level array arg key — required),
`resultFrom` (path read from each completed subflow state — required), `entry?`, `maxItems?` (default 8, cap 32),
`concurrency?` (must be 1 in V1), `onItemError?` (`fail` default / `collect`), `task?` (opt-in **task map**,
§9.17.1 — `{ keyFrom, resultSchema, budget }`; **absent → the legacy V1 behavior described in this section**).

**Binding & transitions.** A `flow.map` adapter must bind to exactly one **`action_contract`** node. The caller
declares `next.done` and `next.empty`; `onItemError: collect` additionally requires `next.partial`. Task mode
(§9.17.1) requires `onItemError: collect` — and therefore `next.partial` — so per-item failures never throw.

**Per-item input / result.** Each subflow starts with fixed state `{ item, index, context }` — plus `key` in
task mode (§9.17.1) — where `context` = the validated args minus `itemsArg`. The tool result is
`{ next, results }`, always in input order. Each `results[i]` is `{ index, status: "completed", value }` in the
base form, or in task mode one of `{ index, key, status: "completed", value, terminal }`,
`{ index, key, status: "needs_input", prompt }`, or `{ index, key, status: "failed", error }`. Aggregation:
every item `completed` → `next: done`; empty input → `next: empty`, `results: []`; otherwise (any item not
`completed`, or fewer results than items) → `next: partial`.

`next: done` means every worker completed; it does not mean the workers found a domain result. A completed item may
carry `value.next: empty`, so the app-owned fan-in must derive domain success/empty from the returned values.

**Base (legacy, no `task:`) form.** The example below uses the three required fields only; keys, per-item
budgets, `resultSchema`, and `needs_input` are opt-in via `execute.task` (§9.17.1).

```yaml
defaults:
  mapping: interpolation

flowTools:
  probe_sites:                    # the flow.map caller tool
    description: Run probe_one for each site and collect findings.
    execute:
      kind: runtime
      implementation: flow.map
      flow: probe_one
      itemsArg: sites
      resultFrom: finding
      onItemError: fail           # default; 'collect' additionally needs next.partial
    parameters:
      type: object
      properties:
        sites: { type: array, items: { type: object } }
        query: { type: string }
      required: [sites]           # itemsArg MUST be a required array property
    output:
      next: ${result.next}
      findings: ${result.results}

  probe_one_site:                 # the per-item worker
    description: Produce one finding.
    execute: { kind: runtime, implementation: passthrough }
    output:
      next: done
      finding:
        site: ${tool.args.item}
        query: ${tool.args.context.query}
    parameters:
      type: object
      properties:
        item: { type: object }
        index: { type: number }
        context: { type: object }
      required: [item, index, context]

flows:
  gather:
    nodes:
      run:
        kind: action_contract
        uses: probe_sites
        inputSelector: [sites, query]
        next: { done: report, empty: none }   # 'partial' too, under collect
      report: { kind: terminal, respond: Done. }
      none:   { kind: terminal, respond: Nothing to probe. }

  probe_one:                      # mapped subflow — one node, no self-loop
    nodes:
      probe:
        kind: action_contract
        uses: probe_one_site
        inputSelector: [item, index, context]
        next: { done: done }
      done: { kind: terminal }
```

### 9.17.1 Task mode (`execute.task`)

Adding `execute.task` turns the base map into a **keyed task map**: results are correlated by a caller-chosen
key, each completed value is schema-validated, each item runs under its own budget, and a mapped subflow that
pauses becomes a structured `needs_input` result instead of a failure. When `task` is **absent**, everything in
§9.17 above is the unchanged **legacy V1** behavior. **Source parity:** the opt-in and every check below apply
identically whether the `flow.map` adapter is declared inline on a flowTool `execute`, as an inline node adapter,
or in `adapters.yaml` (§12), and in both app-owned and `clientFlows` documents.

The `task` block has three required members: `keyFrom`, `resultSchema`, and a `budget` with **all four** fields.

- **Keys (`keyFrom`).** `keyFrom` names a property that must be declared on the **item schema**
  (`parameters.properties.<itemsArg>.items`, itself a required JSON-Schema object) **and** listed in that item
  schema's `required`. For every item the property must resolve to a **unique** non-empty string or finite
  number; a missing, empty, non-string/non-finite-number, or duplicate value fails. The resolved key is always a
  **string** — a finite number is normalized with `String(value)` (so `7` and `"7"` collide as duplicates) — and
  that string is threaded into each subflow's state (`{ item, index, key, context }`) and stamped verbatim on
  every `results[i].key` entry, the `map_step` event, and the debug record.
- **Result validation (`resultSchema`).** `resultSchema` must be a JSON-Schema object. The value read from
  `resultFrom` on a **completed** subflow is validated against it; on success the item is
  `{ index, key, status: "completed", value, terminal }` (carrying the terminal node id and the validated
  value), on failure `{ …, status: "failed", error: { stage: "tool_result", code: "result_schema", … } }`.
- **Per-item budget (`budget`).** All four fields are **required integers** (adapter-normalizer validated):
  `maxNodes` 1–1024, `maxModelCalls` 0–256, `maxRemoteCalls` 0–512, `timeoutMs` 1–120000. Each item runs under
  its own **child budget** carrying those caps. A consume checks the child's local cap, recursively charges the
  parent lineage, then decrements the child; a local-cap failure never charges the aggregate. There is no
  reconciliation or equal-share. The child deadline is `min(aggregate deadline, now + timeoutMs)`.
- **`needs_input`.** A pause inside a mapped task subflow yields `{ …, status: "needs_input", prompt }` (the
  pause prompt), rather than the base form's `paused_not_supported` failure.
- **Partial & control failures.** Because task mode requires `onItemError: collect`, per-item failures never
  throw: the item is recorded as a structured `failed` (or `needs_input`) entry and the loop continues. A
  timeout, budget-exhaustion, or 256 KiB result-cap **control failure** also does not throw — accepted results
  are preserved, the failing item is recorded, the loop stops, and the tool returns `next: partial`. An
  **external abort** still throws in both modes. `next: done` only when every item is `completed`.

```yaml
flowTools:
  enrich_products:                # task-map caller
    description: Enrich each product and collect per-SKU results.
    execute:
      kind: runtime
      implementation: flow.map
      flow: enrich_one
      itemsArg: products
      resultFrom: enriched
      onItemError: collect        # required in task mode
      task:
        keyFrom: sku              # a required property of each item (see items schema)
        resultSchema:             # each completed `enriched` value is validated against this
          type: object
          properties: { sku: { type: string }, price: { type: number } }
          required: [sku, price]
        budget:                   # all four required; ranges in §19
          maxNodes: 64
          maxModelCalls: 8
          maxRemoteCalls: 16
          timeoutMs: 30000
    parameters:
      type: object
      properties:
        products:
          type: array
          items:                  # task mode requires an object item schema...
            type: object
            properties: { sku: { type: string } }
            required: [sku]       # ...that declares keyFrom and lists it as required
      required: [products]
    output:
      next: ${result.next}
      results: ${result.results}

flows:
  enrich:
    nodes:
      run:
        kind: action_contract
        uses: enrich_products
        inputSelector: [products]
        next: { done: report, empty: none, partial: review }   # task ⇒ partial required
      report: { kind: terminal, respond: All items enriched. }
      review: { kind: terminal, respond: Some items need input or failed. }
      none:   { kind: terminal, respond: Nothing to enrich. }

  enrich_one:                     # mapped task subflow; agentic self-loop under the gate
    nodes:
      work:
        kind: action_unit         # (2) a self-loop requires action_unit
        maxSelfSteps: 8           # (4) required, and <= task.budget.maxNodes  (7)
        # toolChoice omitted -> forced/required, i.e. NOT auto  (3)
        allowedTools: [lookup, finish]   # `finish` writes state.enriched (schema-valid)
        fallback:
          maxStalledSteps: 3      # (5) required
          stalledNext: bail       # (6) required; maps to a different node
        next: { again: work, done: ready, bail: incomplete }
      ready:      { kind: terminal }
      incomplete: { kind: terminal }
```

**Self-loop gate.** A legacy target rejects every self-loop; a task target permits exactly **one** kind — an
`action_unit` self-loop — and only when **all** of the following hold (compiler-checked, in order):

1. the enclosing map is in task mode (`execute.task` present);
2. the self-looping node's action is `kind: action_unit` (an `action_contract` self-loop is rejected);
3. `action.toolChoice` is **not** `auto` (tool-call-only / forced — the node `prompt` text does not count as
   interactivity);
4. the node sets `maxSelfSteps`;
5. `fallback.maxStalledSteps` is set;
6. `fallback.stalledNext` is set and `next[stalledNext]` resolves to a **different** node (an exit);
7. `task.budget.maxNodes >= node maxSelfSteps`.

Decision-node and branch (`when`/`then`/`else`) self-loops are rejected unconditionally, even in task mode. A
runtime backstop mirrors the gate: a mapped context may not self-loop without `maxSelfSteps`, and any pause still
surfaces as `needs_input`.

**Compiler policy.** Raw `flow.map` values are validated **before** normalization (a non-`runtime` `kind`, a
non-integer or out-of-range `maxItems`, a non-integer `concurrency`, or an `onItemError` other than
`fail`/`collect` is rejected, not coerced; a present `task` is validated per §9.17.1). `itemsArg` must be a
**required, `array`-typed** property of the caller schema. From the target's entry the compiler walks every
reachable node — through `next` maps, branches, nested `execute: flow` / `flow.map`, and each visited flow's
`onError` handler. It permits read, navigation, and mutation effects and rejects missing nested flows/entry
nodes. **Self-loops:** a **legacy** target (no `task`) rejects every explicit self-loop; a **task** target
permits an `action_unit` self-loop only under the §9.17.1 gate, while `action_contract` and decision/branch
self-loops stay rejected in either mode. Reachable mutation adapters still face the universal
consent/require/idempotency checks.

**Runtime.** Items run one at a time; before each item the external abort signal is checked and **always throws**
when aborted (both modes). The **aggregate per-map budget** (node 1024 / model 256 / remote 512 / 120 s deadline
— §19) bounds the whole run and every nested subflow. In the **base form** all items share that one aggregate
budget directly. In **task mode** each item additionally runs under its own **child budget** (the four
`task.budget` caps). A consume checks the child, recursively charges the aggregate and any ancestor, then
decrements the child; a local-cap failure leaves ancestors untouched. There is no reconciliation or equal-share,
and the child deadline is `min(aggregate deadline, now + timeoutMs)`. The deadline is checked before each item,
before every mapped non-terminal node, at model/remote spend sites, and after each item completes. Mapped subflows
run with narration suppressed and emit one `map_step`
event per item under one `mapRunId`. A subflow that **pauses** becomes an item `needs_input` (carrying the
`prompt`) in task mode, but in the base form fails that item (`stage: tool_execute`, `code:
paused_not_supported`); one that completes still carrying a reserved `__error` (§9.13) fails with that structured
error (its stale `resultFrom` value is never read); a missing `resultFrom` fails (`stage: tool_result`, `code:
missing_result`). In the **base form**, `fail` throws on the first non-completed item (sequential, so no later
item starts). In **task mode**, a timeout, budget-exhaustion, or 256 KiB result-cap control failure does **not**
throw: every accepted result is preserved, the failing item is recorded as a structured `failed` entry, the loop
stops, and the tool returns `next: partial`. Before accepting a non-final result, the runtime reserves the larger
of the exact deadline and result-limit failure envelopes for the following key. If that bounded entry cannot fit
for a key, the map fails before any worker runs. The recorded control failure retains its full details and is
never compacted or silently omitted. `flow.map` never truncates completed values.

---

## 10. Selectors — `inputSelector` / `outputMap`

- **`inputSelector: [path, ...]`** is the complete state allowlist for a planner or node. Omitted
  planner selectors and omitted / empty node selectors expose no state. Unrooted planner paths read
  the global `stepOutputs` root; unrooted node paths read the active flow state.
- Explicit roots are `global`, `flows`, `flow`, `active`, `queue`, `lastIntent`, `status`,
  `activeFlow`, `activeNode`, `conversationSummary`, `latestMessageInterpretation`, and `contexts`.
  JSONPath (`$. … [*]`) is supported. Whole-scope selectors such as `global`, `flow`, `contexts`,
  `active`, `lastIntent`, or `$` are compile errors; select the exact leaf paths instead.
- The current user message is a separate message channel governed by `messagePolicy`; it does not
  require selecting the whole flow state.
- **`outputMap: { destination: source }`** copies only named outputs from post-action flow state.
  Omission means publish nothing. A destination is a dot path, not JSONPath, for example
  `shopping.lastQuery: query`.

---

## 11. Context selection (lenient)

- Select a whole named context with `contexts.<name>` in planner or node `inputSelector`.
- A selected context remains under the `contexts` root in selected state and is rendered in the
  action's `<state>` block. It is not copied into accumulated flow state.
- **Values**: `contexts:` defaults plus client session context overrides.
- A missing selected context is omitted rather than treated as a compile/runtime error. Empty context
  values remain valid.
- `planner.contexts`, flow/node `contexts`, and flow/node `contextSelector` are invalid. `inputSelector`
  is the single context-selection mechanism.

### 11.1 Breaking selector migration

전체 절차, before/after 예제, live artifact 검증은
[`FLOWS_YAML_SELECTOR_MIGRATION.md`](./FLOWS_YAML_SELECTOR_MIGRATION.md)를 따른다.

1. Move `planner.contexts: [x]` to `planner.inputSelector: [contexts.x]`.
2. Delete flow-level `inputSelector`, `contexts`, and `contextSelector`.
3. Give every flow node an exact `inputSelector`; use `[]` when the node needs no state.
4. Replace node `contexts: [x]` / `contextSelector: [x.y]` with
   `inputSelector: [contexts.x]` / `inputSelector: [contexts.x.y]`.
5. Split broad roots (`flow`, `global`, `contexts`, `active`, `lastIntent`, `$`) into leaf paths.
6. Keep only deliberate publication in node/flow `outputMap`; omission publishes nothing.

---

## 12. Adapters

Adapters bridge flowTools to runtime/remote execution. Three sources, merged at compile:

1. **Inline flowTool `execute`** (§9) — recommended for self-contained docs.
2. **Inline node tool adapters** — `flows.<f>.nodes.<n>.tools.<tool>.adapter` (object, or
   `passthrough`/`runtime` shorthand with `output: tool.args`).
3. **`adapters.yaml`** (`adapterDocument`) — separate adapter map.

Adapter shape (per tool):

```yaml
adapters:
  quote.submit:
    execute: { kind: remote, tool: AX_submit_quote }
    input: { confirm: true }
    effect: mutation            # side effect
    consent: required           # required for mutation
    idempotent: true            # required for mutation
    require: { selectedProduct: true }   # required (non-empty) for mutation
```

- `execute.kind: remote` must reference an existing remote tool.
- Mutation adapters MUST set `consent: required`, `idempotent: true`, and a non-empty `require`.
- `execute.timeoutMs` (remote) — per-tool remote-call timeout in ms (§9.1).

---

## 13. Execution model

1. Planner runs (unless fixed single-route) → picks a route (`decide`).
2. Runtime enters the route's `entry` node.
3. `action_unit`: builds the system prompt from the node prompt and exact node-selected state; the LLM
   calls one `allowedTools` tool, and the transition (`result.next` if present, else the LLM's `args.next`, §9.10)
   selects `node.next[next]`.
4. `action_contract`: projects args from state, runs the tool once, uses the result `next`.
5. `terminal`: renders `respond` (rewritten by `app.terminal` if configured) and completes.
6. State flows via `inputSelector` (in) and `outputMap` (out); `next` not in the map → hard error.
7. **Pause/resume**: if a node's chosen `next` points to itself, the flow **pauses** (status
   `paused`, `activeNode` saved) and surfaces the node's `question`/`response` to the user. The next
   user turn resumes that node — **only if the planner returns `action=continue_current`** (a
   `replace_current` restarts the route from its entry). See §7.5.

### 13.1 Lifecycle hooks (`hooks.beforeIntent` / `hooks.afterIntent`)

Top-level `hooks` run an ordered list of **flows** around the turn's resolved intent — after the planner
resolves a route and **before** the target flow's entry node (`beforeIntent`), and after the turn's flow(s)
complete (`afterIntent`). A hook is just a flow id; hook flows are ordinary flows (§7).

```yaml
hooks:
  beforeIntent: [record_memory]   # run before the target flow (e.g. judge + record to memory)
  afterIntent: [audit_log]        # run after the turn's flow(s) complete
```

- **When**: `beforeIntent` runs once per turn once a target flow will run (skipped on `clarify` /
  `out_of_scope` / no-route). `afterIntent` runs once after the turn's intent chain **completes** (not on pause).
- **State**: each hook runs as a flow with the turn's **global state** (`stepOutputs`) available via `inputSelector`;
  its own flow-local state is isolated. A hook publishes back to global with `outputMap` — so a hook can **recall**
  data and feed the target flow, which reads it with `inputSelector` (hook `outputMap: { memory: recalled }` →
  target `inputSelector: [memory]`). The runtime injects `targetIntent` and the user message (`userMessages`) into
  the hook flow.
- **Non-interactive & non-blocking**: a hook must not pause — if a hook node self-loops with a `question`, the pause
  is ignored (logged) and control proceeds. A hook error never blocks the target flow (fire-and-continue).
- **No user output**: hook terminals render with output suppressed; use a `respond`-less terminal (§7.3).
- **Deterministic, not planner-driven**: hooks always run for every applicable turn (no LLM routing decision). Keep
  hook side effects (memory writes, audit) in the hook's own tools/adapters; the runtime stays domain-agnostic.
- A hook flow id must exist in `flows` (compile-validated); it is not required to have a `router` route.

---

## 14. Overrides — `clientFlows`

A client can send a flow document at runtime as **`clientFlows`** (a YAML string), accepted at:

- Session creation — `POST /axsdk/v2/sessions`, field `clientFlows` (aliases `clientFlowDocument`/`flowDocument`).
- Message — `POST /axsdk/v2/sessions/message`, field `clientFlows`.
- Tool-call result — `PUT /axsdk/v2/calls/:callID`, field `clientFlows`.
- (Internal runtime API `prompt`/`prompt_async` accept `clientFlows` as an already-normalized object.)

### 14.1 Replace vs overlay

- **No `extends`** → the document **fully replaces** the app flows (must be self-contained).
- **`extends: app`** (top-level) → the document is an **overlay merged onto the session's base flow
  document**.

### 14.2 Merge model (`extends: app`)

| Section | Merge key | Behavior |
|---|---|---|
| `router.routes` | `intent` | same intent → overlay replaces; new → appended; others kept |
| `router.mode`, `router.defaultIntent`, `router.fallbackIntent` | — | overlay value wins if present |
| `flows` | flow id | same id → overlay replaces the whole flow; new → added; others kept |
| `flowTools` | tool name | overlay replaces / adds by name |
| `contexts` | name | overlay replaces / adds by name |
| `planner` | field | field-wise overlay (`prompt`/`allowedTools`/`inputSelector`/`outputMap`/`model`/`llm`); omitted fields kept from base |
| `defaults` | field | field-wise overlay (`remoteToolTimeoutMs`, `maxSteps`, `mapping`, `model`, `llm`); omitted fields kept from base. `maxSteps` ≤ 256 (§9.4); `mapping` (§9.7) and `model`/`llm` (§9.8) apply to both |
| `hooks` | field | field-wise overlay (`beforeIntent` / `afterIntent` arrays); the overlay's list replaces that field, the other kept from base |
| `app` | field | field-wise overlay (e.g. `terminal`, `complete`); omitted fields kept from base. **`app.id` is forced to the base** — the overlay cannot change the app identity (any `app.id` it includes is ignored) |

- Deletion is not expressible (add/replace only); flows/routes replace as a unit.
- The **base** is the document the session started with (stored on the session); overrides merge onto
  it, so they are independent (non-compounding).

### 14.3 Timing

- Session creation: the merged/replaced document is the session's initial config.
- Message override: applied at that turn before the planner; the running flow is pended; persists.
- Tool-result override: stored and applied at the **next** turn boundary; the running flow is pended.
- For message and tool-result overrides, the backend persists the **normalized effective** flow, adapters, and
  remote-tool snapshot before dispatch. Call authorization therefore sees client-introduced remote tools only
  after the client security gate; `baseFlowDocument` is not changed.

### 14.4 Security gate

Client-sent documents are validated before use: client adapters may use the runtime implementations
`passthrough` / `sitemap.search` / `lua` / `lua.compile` / `lua.dynamic` (sandboxed, §9.2 / §9.15) /
`mock` (§9.12) / `flow` (§7) / `flow.map` (§9.17), or `kind: remote`; `model.apiKey`, `local` execution, and
other runtime implementations (including `state.transform` and `delay`) are rejected; `execute.lua` is rejected
on `lua.compile` / `lua.dynamic` (their script comes from args); size/shape are bounded; `app.id` (if present)
must match the session app. The client gate requires non-empty `flow`, `itemsArg`, and `resultFrom` fields for
`flow.map`; the merged effective document then passes the same full runtime compiler validation as an app
document.

Authoring shorthands (§9.16) are resolved **before** this gate runs: an inline node `tool:` is hoisted to a
synthesized flowTool and `extends:` / `templates:` are deep-merged, so the resulting `execute` faces the same
allowlist. A `clientFlows` shorthand that resolves to a rejected `execute` is refused just like an explicit
adapter would be.

---

## 15. Examples

### A. Minimal "answer from context" flow

```yaml
extends: app
router:
  routes:
    - intent: request_service_quote
      entry: request_service_quote.request_service_quote
      description: Request quotes for a local service.
      examples: [열쇠공 견적줘, 청소 견적]
flows:
  request_service_quote:
    nodes:
      request_service_quote:
        kind: action_unit
        inputSelector: [requestText, contexts.memory]
        prompt: |-
          Answer the user question with provided contexts.
          Call respond exactly once: next=done, message=<your reply in the user's language>.
        allowedTools: [respond]
        next: { done: done }
        outputMap: { request_service_quote.message: message }
      done:
        inputSelector: [message]
        kind: terminal
        respond: Use Flow state JSON's message.
flowTools:
  respond:
    execute: { kind: runtime, implementation: passthrough }
    output: tool.args
    parameters:
      type: object
      additionalProperties: false
      required: [next, message]
      properties:
        next: { type: string, enum: [done] }
        message: { type: string }
```

### B. Remote single action

```yaml
extends: app
router:
  routes:
    - intent: find_service
      entry: find_service.search
      description: Find local service pros.
      examples: [청소 업체 찾아줘, house cleaning near me]
flows:
  find_service:
    nodes:
      search:
        kind: action_unit
        prompt: |-
          Call search_service once with the user's query and a zip_code (or address).
        allowedTools: [search_service]
        next: { done: done, error: failed }
        fallback: { invalidNext: error, exhaustedNext: error }
      done:   { kind: terminal, respond: Use Flow state JSON's results. }
      failed: { kind: terminal, respond: 검색에 실패했습니다. }
flowTools:
  search_service:
    description: Search Thumbtack services.
    execute: { kind: remote, tool: AX_search_service }
    input: { query: tool.args.query, zip_code: tool.args.zip_code, address: tool.args.address }
    output:                                  # remote result has no `next` — derive it
      next: { if: [{ var: result.error }, "error", "done"] }
      results: result
    parameters:
      type: object
      additionalProperties: true
      required: [query]                      # no `next` for remote tools
      properties:
        query: { type: string }
        zip_code: { type: string }
        address: { type: string }
```

`AX_search_service` must exist in the app base `tools` or be declared in a top-level `tools:` block.

### C. Planner overlay (force routing default)

```yaml
extends: app
planner:
  prompt: |-
    Classify the latest message. Prefer request_service_quote for service-quote/estimate requests.
router:
  mode: fixed
  defaultIntent: request_service_quote     # overlay overrides the base default
  routes:
    - intent: request_service_quote
      entry: request_service_quote.request_service_quote
      description: Request quotes for a local service (locksmith, cleaning, handyman).
      examples: [열쇠공 견적줘, 청소 견적, handyman estimate]
```

The overlay's `planner` fields and `router.defaultIntent` override the base; base routes still
compete via their descriptions, so make `examples`/`description` distinct.

### D. Standalone (full replace) — self-contained app

A document without `extends` must define `app`, `router`, `flows`, `flowTools` (and any `decide`
adapter) itself; it replaces the app flows entirely.

### E. Lua state manipulation (deterministic cart ops)

A flow keeps a `cart` array in state. An `action_unit` (LLM) interprets the user and sets only a small
target (`op`/`item_id`/`qty`); an `action_contract` then runs a **lua** tool that reads the cart from
state, mutates it, recomputes `item_count`, and returns the changed state (merged back via the tool
result). This works in **`clientFlows`** documents too (lua is sandboxed; §9.2, §14.4).

```yaml
extends: app
flowTools:
  cart_decide:                 # LLM picks the operation (small output)
    description: Decide the cart operation from the user's message.
    execute: { kind: runtime, implementation: passthrough }
    output: tool.args
    parameters:
      type: object
      properties:
        op:      { type: string, enum: [add, remove, set_qty, clear] }
        item_id: { type: [string, "null"] }
        qty:     { type: [number, "null"] }
        next:    { type: string, enum: [apply] }
      required: [op, next]
  cart_op:                     # deterministic lua mutation of the cart array
    description: Apply the chosen op to the cart and recompute item_count.
    execute:
      kind: runtime
      implementation: lua
      lua: |
        local cart = args.cart or {}
        local op = args.op
        if op == "add" then
          local found = false
          for _, it in ipairs(cart) do
            if it.id == args.item_id then it.qty = (it.qty or 0) + (args.qty or 1); found = true end
          end
          if not found then cart[#cart + 1] = { id = args.item_id, qty = args.qty or 1 } end
        elseif op == "remove" then
          local kept = {}
          for _, it in ipairs(cart) do if it.id ~= args.item_id then kept[#kept + 1] = it end end
          cart = kept
        elseif op == "set_qty" then
          for _, it in ipairs(cart) do if it.id == args.item_id then it.qty = args.qty end end
        elseif op == "clear" then
          cart = {}
        end
        local count = 0
        for _, it in ipairs(cart) do count = count + (it.qty or 0) end
        return { cart = array(cart), item_count = count, next = "done" }   -- array() keeps an empty cart as []
    parameters:
      type: object
      additionalProperties: true
      properties:
        cart:    { type: array }      # projected from flow state (action_contract)
        op:      { type: string }
        item_id: { type: [string, "null"] }
        qty:     { type: [number, "null"] }
flows:
  cart:
    state: { cart: [], item_count: 0 }   # seeded on entry; accumulated across continue turns
    nodes:
      interpret:
        kind: action_unit
        allowedTools: [cart_decide]
        next: { apply: apply }
      apply:
        id: cart_op
        kind: action_contract            # projects cart/op/item_id/qty from state -> lua -> result merges into state
        next: { done: respond }
      respond:
        kind: terminal
        respond: Cart updated.
```

Verified op sequence (run through the runtime; deterministic — same input always yields the same state):

```
add apple x2          -> cart=[{apple,2}]              item_count=2
add banana x3         -> cart=[{apple,2},{banana,3}]   item_count=5
add apple x1 (merge)  -> cart=[{apple,3},{banana,3}]   item_count=6
set banana qty=1      -> cart=[{apple,3},{banana,1}]   item_count=4
remove apple          -> cart=[{banana,1}]             item_count=1
clear                 -> cart=[]                       item_count=0
```

> Empty-array note: an unmarked fully-empty Lua table reads back as JSON `{}` (Lua cannot distinguish an
> empty array from an empty map). Wrap array fields with the injected **`array(t)`** helper — as in
> `array(cart)` above — so an empty array stays `[]`. Either way it round-trips correctly into lua next turn.

### F. Wait, then continue (LLM → delay → LLM follow-up)

A self-loop `action_unit`: the LLM calls `delay` (which self-loops), the node re-enters, and the LLM runs
again to do the follow-up. The wait happens between the two LLM calls, in one turn (short waits).

```yaml
extends: app
flowTools:
  delay:
    description: Pause briefly and stay on this step (then the assistant continues).
    execute: { kind: runtime, implementation: delay }   # no `next` param -> always __self__ (self-loop)
    parameters:
      type: object
      properties: { delayMs: { type: number } }         # LLM sets how long; cannot set next
  do_followup:
    description: Do the follow-up work after the wait.
    execute: { kind: remote, tool: AX_followup }
    output: { next: { literal: done } }                 # remote result has no next -> derive it
    parameters: { type: object, properties: { note: { type: string } } }
flows:
  wait_then_act:
    nodes:
      step:
        kind: action_unit                # action_unit -> self-loop re-invokes the LLM
        allowedTools: [delay, do_followup]
        next: { done: result }           # exit; `__self__` is implicit (no entry needed)
      result: { kind: terminal, respond: Done. }
```

One turn: LLM #1 calls `delay(delayMs)` → waits → result `next: __self__` → re-enter `step` → **LLM #2** calls
`do_followup` → `next: done` → `result`. `delay` omits `next` from its schema, so the LLM can only wait
(self-loop) with it and must call `do_followup` to proceed. Bounded by `maxSteps`.

### G. One node, many tools — LLM decides the next tool from each result

A self-loop `action_unit` exposing several tools. The LLM calls **one tool per step**, reads its result from
the accumulated Flow state, and decides the next tool until it reaches the goal — or finishes with an error.
Each non-terminal tool forces `next: continue` (self-loop, re-invokes the LLM); a `finish` tool forces
`next: done`. Branching lives in the LLM's tool choice, not in fixed transitions.

```yaml
flows:
  fetch_article:
    nodes:
      agent:
        kind: action_unit
        allowedTools: [search, navigate, click, extract, finish]
        prompt: |-
          Call ONE tool per step; read its result from the Flow state JSON and pick the next tool:
          - results not in state -> search(query)
          - results == [] -> finish(status=error, message=...)
          - results non-empty & navigated unset -> navigate(url=results[0].url)
          - navigated & clicked unset -> click(selector=results[0].selector)
          - clicked & html unset -> extract()
          - html set -> finish(status=ok)
        next: { continue: agent, done: complete }   # continue -> self; done -> terminal
        tools:
          search:   { output: { next: continue, results: result.results }, schema: { type: object, properties: { query: { type: string } }, required: [query] } }
          navigate: { output: { next: continue, navigated: result.ok },     schema: { type: object, properties: { url: { type: string } },   required: [url] } }
          click:    { output: { next: continue, clicked: result.ok },       schema: { type: object, properties: { selector: { type: string } }, required: [selector] } }
          extract:  { output: { next: continue, html: result.html },        schema: { type: object, properties: {} } }
          finish:   { output: { next: done, message: tool.args.message },   schema: { type: object, properties: { status: { type: string, enum: [ok, error] }, message: { type: string } } } }
      complete: { kind: terminal, respond: Done. }
```
- **Result-driven**: `output: { next: continue }` is a **literal** (`resolvePath` returns the string when it
  is not a state/result key), so search/navigate/click/extract always self-loop; only `finish` reaches `done`.
  The LLM's *tool choice* (and its args, e.g. `navigate(url=results[0].url)`) is what branches.
- State accumulates across self-loops (`results` → `navigated` → `clicked` → `html`); the LLM sees it each step.
- Bounded by the global `maxSteps`, or give the node its own budget with `maxSelfSteps` (now allowed on
  `action_unit`, §9.5) plus a `fallback.stalledNext` no-progress guard (§9.5.2). For a weak model, gate tools
  with `allowedTools[].when` (§9.5.1) so exactly one tool is forced each step.
- Covered end-to-end by `packages/runtime/test/agent-loop.test.ts` (found → full chain; empty → `finish(error)`).

---

## 16. Common errors

| Message | Cause |
|---|---|
| `flowDocument must not be empty` | empty document |
| `router.routes[N].entry must be a non-empty string` | route missing `entry` |
| `flows.<f>.nodes.<n>.next must be an object` | action node missing `next` |
| `flows.<f>.nodes.<n>.next must define at least one transition` | empty `next` |
| `flows.<f>.nodes.<n>.allowedTools must be an array` | `action_unit` missing `allowedTools` |
| `planner.allowedTools must include decide` | planner tools omit `decide` |
| `planner.allowedTools.decide requires adapter mappings` | `decide` flowTool/adapter missing |
| `adapters.tools.<t>.execute.tool references missing remote tool: AX_…` | remote tool not in `tools` |
| `flows.yaml top-level adapters is not supported …` | a top-level `adapters:` key |
| `client adapter <n>.execute.implementation is not allowed` | client overlay used a non-allowlisted implementation |
| `final tool result next must be one of: …` *(runtime → fallback `error`)* | neither the tool `result.next` nor the LLM's `args.next` was a valid `node.next` key (§9.10) — for a result-driven tool derive `next` in `output`; otherwise the LLM omitted/mis-picked the injected `next` arg |
| `flow exceeded max steps` *(runtime)* | a turn ran more than `maxSteps` node executions (default 24, raise via `defaults.maxSteps` ≤ 256, §9.4) — usually a self-loop with no exit |
| `node exceeded self-loop budget: <flow>.<node>` *(runtime)* | an action node with `maxSelfSteps` (§9.5) self-looped past its per-node budget |
| `node made no progress: <flow>.<node>` *(runtime)* | the no-progress guard tripped with no `stalledNext`/`exhaustedNext` to route to (§9.5.2) |
| `actions.<a>.fallback references undeclared next: <v>` | `fallback.invalidNext`/`exhaustedNext`/`stalledNext` is not a declared `next` key |
| `flows.<f>.nodes.<n>.maxSelfSteps is only allowed on action nodes` | `maxSelfSteps` set on a `terminal`/`decision` node (§9.5) |
| `<path>[i] must be a tool name string or a { tool, when } object` | malformed `allowedTools` eligibility entry (§9.5.1) |
| `actions.<a>.tools.<t>.schema.properties.next.enum references a next not declared in node.next: <v>` | a hand-written `action_unit` tool `next` enum drifted from `node.next` (§9.10) |

Compile errors throw at turn setup — **before** any LLM call — so a broken document leaves an empty
debug log and no response. A missing selected context is simply absent (§11). The last row is a
**runtime** validation (after the tool call), not a compile error — it routes via `fallback`.

**Observability — per-step trace.** Each `action_unit` step appends a compact `{ type: "action_step", flow,
node, callID, tool, eligibleTools, next, status, stage, llmCalls }` entry to the runtime debug log (exposed via
`GET /session/:id/state`). It gives a single-place view of the loop: the chosen vs eligible tool (§9.5.1), the
transition, retries (`llmCalls > 1`, §9.6), and where a step failed (`status`/`stage`). Repeated same-`node`
entries with unchanged state surface a stall (guarded by `fallback.maxStalledSteps`, §9.5.2).
The same log also records **flow/node change recovery**: `{ type: "resume_discarded", flow, node, reason:
"flow_missing" | "node_missing" }` when a carried-over runtime state is dropped because its flow/node no longer
exists in the current document (→ the planner re-routes), and `{ type: "stale_resume_node", flow, requestedNode,
resumedAt }` when a resumed node is absent so the interpreter falls back to the flow entry. Use these to diagnose
a client that ships flows removing the node a session was paused on.

---

## 17. Validate before shipping

Compile the document (merge onto the app base first if it is an `extends` overlay) and confirm the
routes/flows:

```sh
bun -e '
const { compileConfigRuntime } = await import("../axsdk-agentv3/packages/runtime/src/index.ts");
const yaml = (await import("js-yaml")).default;
// standalone:
const ir = compileConfigRuntime({ flowDocument: await Bun.file("flows.yaml").text() });
console.log("routes:", ir.routes.map(r => r.intent).join(","));
console.log("flows:", Object.keys(ir.flows).join(","));
'
```

For an `extends: app` overlay, merge onto the app base before compiling (see
`CLIENT_FLOWS_OVERLAY_AUTHORING.md` §11 for the merge+compile snippet).

---

## 18. Data & state flow (mental model)

One rule set for **where each mechanism reads and writes**. "Global" = the `stepOutputs` root
(`global.*` / `flows.*`); "flow state" = the active flow's slice (read as `flow.*` / `active.*`);
"node scope" = the state the LLM / contract actually sees.

| Mechanism | Reads | Writes | When |
|---|---|---|---|
| `planner.state` | — | global root | once, on a fresh config-runtime state or planner `set` reset (§4, §7.6) |
| planner `inputSelector` | global/session/context scope | planner scope | before the planner runs |
| flow `state` | — | flow state | each fresh flow entry (§7) |
| node `inputSelector` | flow/session/context scope | node scope (what the action sees) | before the node runs |
| selected `contexts.<name>` | `contexts` map | planner/node selected state only | before planner/node execution (§11) |
| tool `output` | tool result | the action's returned object | after the tool call (§9.7) |
| `state.include` / `exclude` | action result | flow state (filtered) | after the action (`statePatch`) |
| `state.clear` | — | unsets flow-state paths | after the merge |
| node `outputMap` | flow state | global | after the node |
| flow `outputMap` | flow state | global | after every node **and** at the terminal |
| reserved `question` / `response` | action result | prompt (pause), then cleared | each node |
| reserved `__error` | node failure | flow state, then unwinds (§9.13) | cleared per node, set on failure |
| reserved `next` | action result | routing only — stripped from state | each node |

**What is in state at node N** (interpreter order):

1. **Session start/reset** — `planner.state` is seeded into the global root on a fresh config-runtime state or planner `set` reset.
2. **Route entry** — flow state = flow `state` (fresh entry) + any reused prior flow state + the
   planner's `intent.state`.
3. **Per node**, in order: node `inputSelector` projects exact flow/session/context leaves into node
   scope → action runs → clear `question` / `response` / `__error` → merge `statePatch` (result minus
   `next`, filtered by `include` / `exclude`) into flow state → `state.clear` → node then flow
   `outputMap` copy named flow-state outputs to global.
4. **Terminal** — flow `outputMap` applied; `respond` resolved (string = LLM / verbatim; object = read
   from flow state, §9.11).

A stale `question` / `response` "leaking" into a later terminal means it was written to flow state and
never cleared — prefer the reserved fields (auto-cleared each node) or `state.clear`.

---

## 19. Budgets (reference)

Every bound the runtime enforces, with the loop it guards.

| Budget | Scope | Default | Cap | Config |
|---|---|---|---|---|
| `maxSteps` | node executions per turn | 24 | 256 | `defaults.maxSteps` (§9.4) |
| `maxSelfSteps` | one action node's self-loops | unset (self-loops count toward `maxSteps`) | 256 | node `maxSelfSteps` (§9.5) |
| action_unit LLM calls | one action node | `max(1, turns) + 1` (one validation retry) | — | `llm.maxCalls` (§9.6) |
| remote attempts | one remote tool call | 2 (retries **timeout only** — under review) | — | — (§9.1, hardening §3) |
| remote timeout | one remote tool call | see §9.1 | 120000 ms | `defaults.remoteToolTimeoutMs` (§9.1) |
| Lua instructions | one Lua run | 2,000,000 | 10,000,000 | `execute.maxInstructions` (§9.2) |
| Lua script size | compile | — | 64 KB | — (§9.2) |
| delay | one delay tool | — | bounded | `execute.delayMs` (§9.3) |
| subflow depth | any nested subflow (`execute: flow` or `flow.map`) | — | 4 | `SUBFLOW_MAX_DEPTH` (§9.17) |
| flow.map `maxItems` | one flow.map call | 8 | 32 | `execute.maxItems` (§9.17) |
| flow.map result bytes | one flow.map call | — | 256 KiB | — (§9.17) |
| flow.map aggregate node budget | one flow.map run (shared) | 1024 | 1024 | — (§9.17) |
| flow.map aggregate model-call budget | one flow.map run (shared) | 256 | 256 | — (§9.17) |
| flow.map aggregate remote-call budget | one flow.map run (shared) | 512 | 512 | — (§9.17) |
| flow.map aggregate deadline | one flow.map run (shared) | 120000 ms | 120000 ms | — (§9.17) |
| task map per-item nodes | one task-map item (child of aggregate) | required, 1–1024 | 1024 | `task.budget.maxNodes` (§9.17.1) |
| task map per-item model calls | one task-map item (child of aggregate) | required, 0–256 | 256 | `task.budget.maxModelCalls` (§9.17.1) |
| task map per-item remote calls | one task-map item (child of aggregate) | required, 0–512 | 512 | `task.budget.maxRemoteCalls` (§9.17.1) |
| task map per-item timeout | one task-map item (child of aggregate) | required, 1–120000 ms | 120000 ms | `task.budget.timeoutMs` (§9.17.1) |

**Self-loop budgets:** `maxSelfSteps` (§9.5) is allowed on **both** `action_unit` and `action_contract`; when
set, the node's self-loops count against that per-node budget instead of the global `maxSteps`. An `action_unit`
without `maxSelfSteps` still counts each self-loop toward `maxSteps`. Prefer a graceful exit via
`fallback.stalledNext` (§9.5.2) over hitting either hard cap (`flow exceeded max steps` /
`node exceeded self-loop budget`).

**Subflow vs map budgets:** a plain `execute: flow` subagent runs under an **unbounded** aggregate budget (only
the subflow depth cap and the per-turn `maxSteps` apply). `flow.map` is the exception: its whole item loop runs
under one **bounded aggregate** `ExecutionBudget` (the aggregate node / model / remote / deadline rows above). In
the base form every mapped subflow — and anything nested inside it — shares that aggregate directly. In **task
mode** (§9.17.1) each item additionally gets its own **child** `ExecutionBudget` (the four `task.budget` caps). A
consume checks the child, recursively charges its ancestors, then decrements the child; a local-cap failure leaves
the aggregate untouched. Each item has explicit local caps and its own `min(aggregate, now + timeoutMs)` deadline.
This is per-item
budgeting, not concurrency — items still run one at a time (§9.17).
