# RPC Lua — ops, module shape, and flow wiring

How to actually write one. `FLOWS.md` is the schema, `AUTHORING.md` is the list of ways a correct-looking
value dies in silence; this is the working reference: what you may call, how a module is laid out, and
the smallest complete tool that runs.

Everything below is taken from code in this repo. Op names come from `tools/rpc-allow.mjs`, which is
what `npm run check:flows` audits against — if it is not in that list, granting it is a compile error.

---

## 1. The op vocabulary (23)

Ops are the ONLY way a script touches the page. They arrive as globals (`dom`, `nav`, `page`, `memory`,
`sitemap`) and each call is one round trip to the client.

### `dom` — reads

| op | call | returns |
|---|---|---|
| `dom.exists` | `dom.exists(selector)` | boolean |
| `dom.get_text` | `dom.get_text(selector)` | string / nil |
| `dom.get_attr` | `dom.get_attr(selector, name)` | string / nil |
| `dom.get_innerHTML` | `dom.get_innerHTML(selector)` | string / nil |
| `dom.get_outerHTML` | `dom.get_outerHTML(selector)` | string / nil |
| `dom.get_location_href` | `dom.get_location_href()` | string |
| `dom.query_all` | `dom.query_all(selector, fields, limit)` | list of row tables |
| `dom.read_many` | `dom.read_many(requests)` | one answer per request, **in order** |

### `dom` — writes and forms

| op | call |
|---|---|
| `dom.click` | `dom.click(selector)` |
| `dom.click_text` | `dom.click_text(selector, label, { exact = false })` |
| `dom.set_value` | `dom.set_value(selector, value)` |
| `dom.get_form_field_names` | *(no callsite in this repo — confirm the arity before use)* |
| `dom.get_form_field_value` | *(no callsite in this repo — confirm the arity before use)* |
| `dom.set_form_field_value` | *(no callsite in this repo — confirm the arity before use)* |
| `dom.submit_form` | `dom.submit_form(selector)` — calls `requestSubmit()`, so the form's real handler runs |

### `nav`, `page`

| op | call | note |
|---|---|---|
| `nav.navigate` | `nav.navigate(url)` | reports **fired / arrived only** — never where, ready, or right (`NAVIGATION.md`) |
| `nav.reload` | `nav.reload()` | |
| `page.eval` | `page.eval(expression)` | last resort; prefer a `dom` op so the audit can see it |

### `memory`, `sitemap`

| op | call | note |
|---|---|---|
| `memory.get` | `memory.get(key)` — `memory.get()` for all | |
| `memory.set_bulk` | `memory.set_bulk(entries)` | **POSITIONAL.** The params table in the implementation doc is the WIRE shape; the Lua binding takes the list. |
| `memory.search` | `memory.search(regex)` | |
| `memory.delete` | `memory.delete(key)` | |
| `sitemap.search_site` | `sitemap.search_site(regex, limit)` | the sitemap of the **site the tab is on**, not the app package's |

> Bindings are **positional**. Building the params object yourself answers `bad_params` live.

### Composed helpers — call them, do not grant them

The runtime prelude synthesises these by polling a real op. Naming them in `allow` grants nothing and
the poll underneath is then refused; grant the op they poll.

| helper | grant instead |
|---|---|
| `dom.wait_for_selector(selector, { timeout, interval })` | `dom.exists` |
| `nav.wait_for_navigation(from, { timeout, interval })` | `dom.get_location_href` |

### Host primitives — free

`rpc.now()` and `rpc.sleep(ms)` are host-side: **no round trip, no `maxCalls`**. Budget in TIME with
`rpc.now()`; pace with `rpc.sleep(ms)` rather than buying latency with a throwaway read. Guard both —
a runtime without a clock must still stop:

```lua
local function clock()
  return (type(rpc) == "table" and type(rpc.now) == "function") and rpc.now() or nil
end
```

---

## 2. Batching: `dom.read_many`

Twelve ops are batchable — the nine `dom` reads plus `memory.get`, `memory.search`,
`sitemap.search_site`. Writes deliberately are not: a batch that could hide a side effect could not
promise order or atomicity.

**Reads that describe the same instant belong in one batch.** Measured on a live quote turn: 95 frames,
`dom.exists` 37 of them — 21 seconds of a 90-second budget spent asking "is there a step?" one round
trip at a time, right next to a batch already being issued. Folding those in took `dom.get_text` from
13 calls to 4 and frames-per-step from 15.8 to 14.0.

```lua
--- One round trip for several READS. Returns nil when unavailable, meaning "read them one by one".
--- `dom.read_many` answers `{ value = … }` / `{ error = … }` per entry, in request order.
local function read_many(requests)
  local answers = optional("read_many", function() return dom.read_many(requests) end)
  if type(answers) ~= "table" then return nil end
  local out = {}
  for index = 1, #requests do
    local answer = answers[index]
    if type(answer) ~= "table" or answer.error ~= nil then return nil end
    out[index] = answer.value
  end
  return out
end

local answers = read_many({
  { op = "dom.exists",    params = { selector = Q.ACTIVE } },
  { op = "dom.get_text",  params = { selector = Q.ACTIVE } },
  { op = "dom.query_all", params = { selector = Q.OPTION_SELECTOR, fields = Q.OPTION_FIELDS, limit = 160 } },
})
```

Two rules that come with it:

- **Always keep the one-by-one path.** `read_many` is optional capability; `nil` means "fall back", not
  "the page is empty".
- **A per-step cache must be invalidated by the action that ENDS the step.** The click that advances the
  wizard clears it, or the next step reads the previous one.

---

## 3. Waiting

- Author **ONE** wait with a generous `timeout` — a ceiling, not a fixed wait. `dom.wait_for_selector`
  arms a scoped `MutationObserver` in the SDK and wakes the instant the element appears (~12ms measured);
  the deferred poll is only a backstop.
- **Never** hand-roll short-timeout retry loops in Lua. Each iteration is a fresh durable step — journal
  plus suspend/resume — and the re-drive cadence lives in the SDK driver, not in your script.
- For content readiness prefer a **scoped scalar probe** (`M.wait_settled(probe, { quiet, timeout })`,
  e.g. a deduped card count) over the whole-document fingerprint.
- Navigation freshness is `performance.timeOrigin`, not a URL compare — it catches same-URL reloads.

---

## 4. Module shape

One file per concern in `_common/rpc/`, numbered to pin load order. The skeleton every module follows:

```lua
--- What this module is, and the measurement that made it look like this.
--- (Comments here are the only place a future reader learns why the obvious version was wrong.)

AX_RPC_SITEMAP = AX_RPC_SITEMAP or {}
local S = AX_RPC_SITEMAP

-- Declare dependencies by RAISING them. This guard is the dependency list `check:flows` reads, and it
-- is the one statement that cannot drift from the code, because the code is what raises it.
local C = AX_COMMERCE
if not C then
  error("_common/scripts/50_commerce_core.lua must be loaded before 73_rpc_offers.lua")
end

-- Modules load BEFORE the runtime installs globals: shadow them LAZILY, inside the function.
local function available()
  return type(sitemap) == "table" and type(sitemap.search_site) == "function"
end

function S.search(args)
  args = type(args) == "table" and args or {}
  ...
  return { next = "go", ok = true, chunks = hits }
end
```

Rules the gates enforce:

- Globals are the only cross-file channel. Each file is its own chunk; locals and `return` are file-scoped.
- A capability may be absent. `pcall` the op and separate **"the client never registered it"**
  (`command_unresolved`) from **"we called it wrongly"** — those have opposite fixes, so carry the RAW
  reason outward.
- Retry a refusal **once** while the channel re-attaches; only a persistent refusal is a fact about the
  page.
- The script picks its own **branch** (`next`), and the tool passes it through. A constant `next` in a
  wrapper throws away work that already happened.
- Return **absent**, not empty: `#values > 0 and values or nil` (`AUTHORING.md` §2).

---

## 5. The smallest complete tool

`sitemap_search`, verbatim from `_common/flows.yaml` — a runtime Lua tool with one op, one module, one
entry:

```yaml
  sitemap_search:
    description: Search the current site's sitemap for pages matching a case-insensitive regex; returns matching lines (each with a path).
    execute:
      kind: runtime
      implementation: lua
      modules: ["_common.72_rpc_sitemap"]
      rpc:
        allow: [sitemap.search_site]
        opTimeoutMs: 4000
        deadlineMs: 30000
      entry: run
      lua: |
        function run(args)
          return AX_RPC_SITEMAP.search(args)
        end
    output:
      next: { if: [{ var: result.error }, "error", "go"] }
      sitemap_hits: result.chunks
      # The raw reason rides along. A category alone cannot separate an op the client never registered
      # from one we called wrongly.
      error: { if: [{ var: result.reason }, { var: result.reason }, { var: result.error }] }
    parameters:
      type: object
      additionalProperties: false
      required: [regex]
      properties:
        regex: { type: string, minLength: 1 }
```

Field by field:

| field | meaning |
|---|---|
| `kind: runtime` | in-engine. Production has **zero** `kind: remote`; durable is gone (`AGENTS.md` §13) |
| `modules:` | every module the entry calls **and everything those modules require** |
| `rpc.allow` | the ops, exactly. The compiler refuses `[]`, so a pure tool names one it never calls |
| `rpc.opTimeoutMs` | ceiling per op |
| `rpc.deadlineMs` | ceiling for the whole invocation — any in-script time budget must sit **under** it |
| `entry` | the global function name in `lua:` |
| `output:` | allowlist mapping script result → flow state. Unnamed fields are **dropped** |
| `parameters.properties` | allowlist projecting flow state → the script's `args`. Undeclared state is **dropped** |

And the node that runs it:

```yaml
      search:
        kind: action_contract          # deterministic: args are the node's selected flow state
        id: sitemap_search
        inputSelector: [requestText]   # every entry here MUST be a declared property above
        next:
          go: go_page
          error: error
        fallback: { invalidNext: error, exhaustedNext: error }
```

`action_contract` vs `action_unit`:

| | `action_contract` | `action_unit` |
|---|---|---|
| args come from | the node's selected flow state | the MODEL, via `allowedTools` |
| can read a snapshot | **yes**, through `inputSelector` | **no** — this is why a model-called tool answered `comparison_unreadable` |
| costs a model call | no | yes (~6–12s) |

**Latency is LLM-dominated.** Each `action_unit` is ~6–12s and node prompts inject the flow state about
three times over; a search navigation is ~7s and non-LLM work is sub-second. Fewer model nodes and
smaller prompts are the levers — not nav micro-optimisation.

---

## 6. Network egress

`rpc.allow` grants ops. It does **not** reach the network. Egress is a separate `net:` block on the same
`execute`, and without it the runtime hands the script **no `net` table at all**:

```yaml
    execute:
      kind: runtime
      implementation: lua
      net:
        allow: [api.frankfurter.dev]
        maxCalls: 2
        timeoutMs: 8000
      modules: [...]
```

Then read the response through `B.response_json(response)` — the runtime answers
`{ok, status, headers, body}` and **never** a `json` field, whatever `response = "json"` asks for
(`AUTHORING.md` §3).

---

## 7. Fan-out (agentic tasks)

A worker subflow run once per item, with the item as its input (`shopping_discover_products`, verbatim):

```yaml
    execute:
      kind: runtime
      implementation: flow.map
      flow: shopping_search_one_store
      itemsArg: discovery_sites
      resultFrom: store_result
      maxItems: 3
      concurrency: 1
      onItemError: collect          # a failing item is an outcome, not the end of the run
      task:
        keyFrom: site
        resultSchema:
          type: object
          additionalProperties: true
          required: [site]
          properties:
            site: { type: string }
            candidates: { type: [array, "null"], items: { type: object, additionalProperties: true } }
```

Two things that cost live runs here:

- The worker receives its **selected flow state**, so the item arrives as `item.site`, not as a flat
  `site`. Reading only the flat key made every store refuse with an empty site.
- `task.resultSchema` is a **validating boundary**. An empty Lua table encodes as a JSON object, so
  `candidates = {}` failed `[array, "null"]` and the store was recorded as a technical failure rather
  than "no matches" — every comparison in the session was silently single-store.

---

## 8. Op budget in practice

- Profile before optimising: `npm run measure:rpc [on|off|clear|report] --match=<tab>` gives a per-op
  histogram. Guessing which op is hot has been wrong every time it was checked.
- Budget in **TIME**, not in a round-trip count. A count is a proxy for the deadline and proxies drift;
  `check:flows` pins the in-script budget under the driving tool's `deadlineMs`.
- Two numbers in two files need a gate, or they diverge.

---

## 9. Checklist for a new tool

1. Module in `_common/rpc/NN_rpc_<name>.lua`, global `AX_RPC_<NAME>`, dependency guards raised.
2. `modules:` lists the module **and everything its guards name**.
3. `rpc.allow` lists exactly the ops called — composed helpers resolved to the op they poll.
4. `net:` if it fetches; the host must be reachable from the entry's call graph.
5. `parameters.properties` declares **every** field the node selects (nullable + non-required for
   accumulators).
6. `output:` publishes **every** field the script returns that anything downstream reads.
7. Every branch the script can answer is routed by the node.
8. Offline test in `tools/lua/` with a stub that enforces the runtime's real constraints.
9. `npm run check:flows && npm run test:lua`, then live: `ax reset` → `ax sync <site>` → `ax send`.
