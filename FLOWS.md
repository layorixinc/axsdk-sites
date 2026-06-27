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
router:     { ... }   # mode, defaultIntent, routes, outOfScope
contexts:   { ... }   # named grounding values (markdown)
flows:      { ... }   # intent flows and their nodes  (required)
flowTools:  { ... }   # tools that nodes/planner call
actions:    { ... }   # optional top-level actions (alternative to inline node actions)
defaults:   { ... }   # global defaults: remoteToolTimeoutMs (and model/maxSteps/params)
```

- A top-level `adapters:` key is **not supported** — use `adapters.yaml` or inline tool adapters.
- `flows` must define at least one flow; the compile must yield at least one action.

---

## 3. `app`

```yaml
app:
  id: my-app
  entryAgent: planner
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
- `complete.remote.tool`: a remote tool invoked on completion (optional).

---

## 4. `planner`

The planner is the orchestration LLM: it classifies the latest message into a configured route.

```yaml
planner:
  prompt: |-
    Call decide exactly once. Classify the latest message into a configured intent.
  allowedTools: [decide]          # default ["decide"]; MUST include decide
  inputSelector: [active, queue, conversationSummary, latestMessageInterpretation]
  outputMap:
    conversationSummary: conversationSummary
    latestMessageInterpretation: latestMessageInterpretation
  contexts: [sites]               # names injected into the planner system prompt
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
- `contexts` values come from `contexts:` defaults + client session contexts (see §7, §11).
- `state` (object) — **global initial state** seeded into the `stepOutputs` root **once** on a fresh session (or a state reset); shared across flows, read via `global.*`. Not re-seeded on later turns. See §7.6.

---

## 5. `router`

```yaml
router:
  mode: auto                      # auto | fixed   (default auto)
  defaultIntent: shopping         # optional
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

---

## 6. `contexts` (value map)

```yaml
contexts:
  sites: |-
    - [amazon](https://www.amazon.com): shopping
    - [thumbtack](https://www.thumbtack.com): local services
  env: |-
    location: https://www.thumbtack.com/
```

- Each entry: `name` (`^[A-Za-z][A-Za-z0-9_-]{0,63}$`) → markdown string. **Empty values are allowed.**
- These are **defaults**; client session contexts (the request `contexts` field) override/add by name.
- Declaring a value here does not inject it — injection requires referencing the name in
  `planner.contexts` or a flow/node `contexts:` list (see §11).

---

## 7. `flows` and nodes

```yaml
flows:
  shopping:
    goal: Search and buy products.
    contexts: [sites]             # injected into this flow's action-node prompts
    inputSelector: [requestText]  # state projected into the flow
    outputMap: { shopping.lastQuery: query }
    state: { searchCount: 0 }     # FLOW-LOCAL initial state — seeded on each fresh entry
    messagePolicy: { userText: segment }
    nodes:
      search: { ... }
      done:   { kind: terminal, respond: ... }
```

Flow fields: `goal?`, `state?` (object), `contexts: [name]`, `inputSelector?`, `outputMap?`, `messagePolicy?`, `nodes` (required).

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
  inputSelector: [requestText]    # optional
  outputMap: { shopping.query: query }     # optional
  contexts: [sites]               # optional (adds to flow contexts)
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
  respond: 완료되었습니다.        # REQUIRED; app.terminal LLM may rewrite from flow state
```

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
part snapshots. Verify via the `<state>` block or the debug `begin.globalState` / `begin.localState` / `begin.selectedState` (the node-projected state the action actually sees).

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
| `allowedTools` (`action_unit`) | **Yes** — array | none; missing → `… .allowedTools must be an array`. `[]` compiles but always fails at runtime (no tool to produce `next`) |
| `fallback` | No | On invalid output / exhausted budget: declared `invalidNext`/`exhaustedNext` (if in `next`) → else `"error"` if `next` has an `error` key → else the **first** `next` key → else hard error. **Declare an `error` transition.** |
| `model` / `llm` | No | session model; `llm.maxCalls` default `max(1, turns)` = 1 |
| `maxSelfSteps` (`action_contract` nodes) | No | When set, the node's **self-loop** iterations count against this per-node budget instead of the global `maxSteps`; positive int, floored, clamped **≤ 256**. **`action_contract` only** (compile error elsewhere). See §9.5 |
| `respond` (`terminal`) | **Yes** | — |

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
- `execute` — the adapter: `{ kind: runtime, implementation: passthrough | sitemap.search | state.transform | lua }` or
  `{ kind: remote, tool: AX_* }`. Shorthand: `execute: passthrough`/`runtime` requires `output: tool.args`.
- `input` (alias `adapterInput`) — input projection for remote tools.
- `pagination` — pagination config.
- `execute.timeoutMs` (remote only) — per-tool remote-call timeout in **ms** (positive integer, clamped ≤ 120000). Overrides the document default; see §9.1.
- **Mutation side-effects**: `effect: mutation` requires `consent: required`, a non-empty `require`,
  and `idempotent: true` (see §12).

> **Where `next` comes from (critical).** An action node validates `next` against the node's `next`
> keys using the **final tool result**, not the model's args.
>
> - **passthrough** tools (`output: tool.args`): the result *is* the model args, so put `next` in
>   `parameters` and the model chooses it.
> - **remote** tools: the result is the remote response (which has no `next`), so **derive `next` in
>   `output`** (a fixed value like `"ok"`, or JsonLogic over `result`) and do **not** put `next` in
>   `parameters`. Omitting `output.next` on a remote tool makes every call fail with
>   `final tool result next must be one of: …` and fall back to `error`.

Runtime implementations: **client-submitted** documents may use `passthrough` / `sitemap.search` and
the sandboxed `lua` (§9.2); the internal `state.transform` (§9) and `delay` (§9.3) stay **app**-only.
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
        kind: action_contract        # only allowed on action_contract nodes
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
- **`action_contract` only** (deterministic, no LLM) — compile error on `action_unit`/`action` nodes, so
  the global `maxSteps` stays the **sole bound on per-turn LLM iterations** (cost).
- Positive integer, floored, clamped ≤ 256. Per-turn and per-visit (a fresh budget on every entry), like
  `maxSteps`.

Net effect: a deterministic N-step contract behaves like **one** flow-step against the global budget —
`maxSteps` bounds flow-level breadth (e.g. number of items processed) while `maxSelfSteps` bounds contract
depth.

---

## 10. Selectors — `inputSelector` / `outputMap`

- **`inputSelector: [path, ...]`** — projects state into the planner/flow/node scope. Paths may use
  scoped roots; unrooted paths resolve against the default scope. Recognized roots:
  `global`, `flows`, `flow`, `active`, `queue`, `status`, `activeFlow`, `activeNode`,
  `conversationSummary`, `latestMessageInterpretation`, `contexts`. JSONPath (`$. … [*]`) is supported.
  (Note: action-node input scope does **not** include `contexts` data — contexts are injected as XML
  blocks via `contexts:` lists, not via `inputSelector`.)
- **`outputMap: { destination: source }`** — copies `source` (a selector over the action result/state)
  to `destination` (a **dot path**, not JSONPath), e.g. `shopping.lastQuery: query`.

---

## 11. Contexts injection (lenient)

- `planner.contexts: [name]` → injected into the planner system prompt as `<name>…</name>`.
- flow-level or node-level `contexts: [name]` → injected into that action node's prompt.
- **Values**: `contexts:` defaults + client session contexts.
- **Missing/empty declared context → rendered as an empty block `<name></name>` (not an error)**, and
  a warning is logged (`context "<name>" not provided; rendering empty block`). Provide a default or
  send the value when grounding matters.

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
3. `action_unit`: builds the system prompt (node prompt + injected contexts + selected state), the LLM
   calls one `allowedTools` tool, the tool result's `next` selects `node.next[next]`.
4. `action_contract`: projects args from state, runs the tool once, uses the result `next`.
5. `terminal`: renders `respond` (rewritten by `app.terminal` if configured) and completes.
6. State flows via `inputSelector` (in) and `outputMap` (out); `next` not in the map → hard error.
7. **Pause/resume**: if a node's chosen `next` points to itself, the flow **pauses** (status
   `paused`, `activeNode` saved) and surfaces the node's `question`/`response` to the user. The next
   user turn resumes that node — **only if the planner returns `action=continue_current`** (a
   `replace_current` restarts the route from its entry). See §7.5.

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
| `router.mode`, `router.defaultIntent` | — | overlay value wins if present |
| `flows` | flow id | same id → overlay replaces the whole flow; new → added; others kept |
| `flowTools` | tool name | overlay replaces / adds by name |
| `contexts` | name | overlay replaces / adds by name |
| `planner` | field | field-wise overlay (`prompt`/`allowedTools`/`inputSelector`/`outputMap`/`model`/`llm`/`contexts`); omitted fields kept from base |
| `defaults` | field | field-wise overlay (`remoteToolTimeoutMs`, `maxSteps`); omitted fields kept from base. `maxSteps` is clamped to ≤ 256 for client and app documents alike (§9.4) |
| `app` | field | field-wise overlay (e.g. `terminal`, `complete`); omitted fields kept from base. **`app.id` is forced to the base** — the overlay cannot change the app identity (any `app.id` it includes is ignored) |

- Deletion is not expressible (add/replace only); flows/routes replace as a unit.
- The **base** is the document the session started with (stored on the session); overrides merge onto
  it, so they are independent (non-compounding).

### 14.3 Timing

- Session creation: the merged/replaced document is the session's initial config.
- Message override: applied at that turn before the planner; the running flow is pended; persists.
- Tool-result override: stored and applied at the **next** turn boundary; the running flow is pended.

### 14.4 Security gate

Client-sent documents are validated before use: client adapters may only use runtime implementations
`passthrough` / `sitemap.search` / `lua` (sandboxed, §9.2) or `kind: remote`; `model.apiKey`, `local`
execution, and other runtime implementations (e.g. `state.transform`) are rejected; size/shape are
bounded; `app.id` (if present) must match the session app.

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
    contexts: [memory]
    nodes:
      request_service_quote:
        kind: action_unit
        inputSelector: [requestText]
        prompt: |-
          Answer the user question with provided contexts.
          Call respond exactly once: next=done, message=<your reply in the user's language>.
        allowedTools: [respond]
        next: { done: done }
        outputMap: { request_service_quote.message: message }
      done:
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
| `final tool result next must be one of: …` *(runtime → fallback `error`)* | a **remote** tool returned a result with no valid `next`; derive `next` in the flowTool `output` (§9) |
| `flow exceeded max steps` *(runtime)* | a turn ran more than `maxSteps` node executions (default 24, raise via `defaults.maxSteps` ≤ 256, §9.4) — usually a self-loop with no exit |
| `node exceeded self-loop budget: <flow>.<node>` *(runtime)* | an `action_contract` node with `maxSelfSteps` (§9.5) self-looped past its per-node budget |
| `flows.<f>.nodes.<n>.maxSelfSteps is only allowed on action_contract nodes` | `maxSelfSteps` set on an `action_unit`/`action` node (§9.5) |

Compile errors throw at turn setup — **before** any LLM call — so a broken document leaves an empty
debug log and no response. Missing **contexts** are no longer errors (rendered empty, §11). The last
row is a **runtime** validation (after the tool call), not a compile error — it routes via `fallback`.

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
