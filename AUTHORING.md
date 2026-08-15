# Authoring RPC Lua + `flows.yaml` — the traps, and the gates that catch them

Companion to `FLOWS.md` (the schema) and `AGENTS.md` §10/§13 (selector rules, settled findings).
`FLOWS.md` tells you what is *legal*. This file tells you what is legal, compiles, passes every test,
and still does nothing — because that is what actually cost time.

**The shape of every bug in this file is the same: a value crosses a boundary, is dropped in silence,
and both sides look correct.** Nothing throws. The tests pass. The user gets a plausible wrong answer.
So the rules below are mostly about boundaries, and every one of them now has a gate in
`npm run check:flows` or `npm run test:lua`.

---

## 1. The four boundaries a value must survive

A value written by a script in turn *N* and read by a script in turn *N+1* crosses four places where
it can vanish without a word. Every one of them bit us this stretch.

```
  script result ──①──> flow state ──②──> tool arguments ──③──> script
                                                  │
  turn N ─────────────────────────④──────────────> turn N+1
```

### ① Publication — `output:` maps script result → state

`output:` is an allowlist. A field the script computes and `output:` does not name is **gone**.

Measured: the presenter answered `page` / `select` / `refine` with the payload that gives the branch
its meaning — which page, which number, which words — and the tool published only `next`. Six fields
vanished; the refiner was told to page with nothing to page with.

> **Gate** — *a branch value the presenter computes actually reaches the next node*: reads the keys the
> Lua `return`s and fails any that `output:` does not publish.

Also: `output: <field>: result` publishes the script's **envelope**, not its payload. You almost always
want `result.<field>`.

### ② Projection — `parameters.properties` maps state → tool arguments

A runtime tool receives its node's selected flow state **projected through `parameters.properties`**.
Undeclared state is **dropped**.

Measured: the presenter selected `requestText` and its schema never declared it, so the user typed
"취소" and the same listing came back instead of stopping. Selector right, schema right, nothing wrong
to look at.

Rules:

- `input:` is for **remote** tools and is a **compile error** on a runtime tool. All 22 were removed.
- Accumulators must be **nullable AND non-required**. `null` against `{type: string}` is rejected;
  `null` against `[string, "null"]` passes; absent passes.
- `required:` a key that flow state does not carry → rejected **before the script runs**.
- Nested paths are the script's job. Declare the carrier, not the leaf.

> **Gate** — *every field a contract node selects is one its tool declares*.

### ③ The tool's own arguments vs the node's state snapshot

They are **two different surfaces**. `parts[].debug.localState` can show a value while the tool
receives nil — that is not a contradiction, it is ② doing its job. Check **both** before concluding
anything about the runtime.

### ④ Turn → turn — nothing in a Lua module survives

Every turn and every navigation rebuilds the Lua context. A table parked on a module global
(`C.current_comparison`, a cache, an accumulator) is gone by the next turn; it only ever worked when
producer and consumer ran in the SAME turn.

Anything a later turn needs goes in **flow state**, as **one JSON scalar**. `session_state` stores
**strings only** and fails silently on a table (`{ok=false, error="Session state value must be a
string"}`).

And the corollary that cost three separate fixes:

> **The window the user reads is ALWAYS rendered from a RESTORE.** Anything the build computed and the
> snapshot does not carry is gone — silently, and only from the second turn onward if you test
> carelessly. Lost this way: `notes` (which store failed), `display_currency` (a Korean shopper reading
> "총 USD 10.79" beside "상품가 KRW 12,900"), and the whole branch payload.

**When you add a field to a snapshot, add it to the encoder in the same edit.**

---

## 2. Empty is not empty

**An empty Lua table encodes as a JSON object**, and every schema that types the field as an array
rejects it. This one bug wore four different costumes:

| Where | Symptom |
|---|---|
| flow state | `expected array, received object` on a tool-validated field |
| `AX_verify_product_offers` | `failures: Invalid input` on a run where every store answered |
| fan-out `task.resultSchema` | `candidates: Invalid input` → a store recorded as a **technical failure** instead of "no matches", making every comparison silently single-store |
| a nested envelope | the outer list was fixed, the inner one was not |

**An empty list must be ABSENT at every boundary that validates it, not just the first one you find.**
`#values > 0 and values or nil` at the point of return. For LLM-tool-validated state prefer a scalar
entirely (a newline-joined accumulator, split in the consumer).

---

## 3. Capabilities are two systems, not one

- `rpc.allow` grants **OPS** (`dom.*`, `nav.*`, `memory.*`, …). The compiler refuses `rpc.allow: []`, so
  pure tools name an op they never call.
- **Network egress is a separate `net:` block on the tool's `execute`.** Without it the runtime hands
  the script **no `net` table at all**, so well-written code takes its own "no fetch available" path and
  reports something bland.

Measured: the FX fetch had no `net:` block for weeks. Every offer came back
`cost_error: fx_fetch_unavailable`, so no `price_base`, so no total — a **total-cost** comparison that
never once showed a total.

> **Gate** — *a tool that fetches over the network declares the host it reaches*: walks each entry's
> call graph (through the RPC wrapper, following bare global calls) and requires only the hosts actually
> reachable. Loading a module is not evidence — `00_base` ships a geocode fetch behind `resolve_zip`
> that the store tools never call.

**A capability declared in the wrong place is indistinguishable from a missing one.** When something
refuses, get its RAW reason: `command_unresolved` means the client never registered the op, which is a
different problem from a denied one.

### `net.fetch` has two implementations under one name

| | durable | runtime (`net:` block) |
|---|---|---|
| response | `{ok, status, json}` | `{ok, status, headers, **body**}` — **never `json`** |
| settling | poll, hence `pending` checks | completes inside one invocation |

`response = "json"` does **not** make the runtime parse for you. Use `B.response_json(response)`, which
takes `json` when present and decodes `body` otherwise. Reading only `.json` turns a 200 with a perfect
payload into a silent failure.

---

## 4. Modules

- A tool's `modules:` list and its Lua are **two statements of the same fact, and only one of them runs**.
- **A dependency of a dependency is still a dependency.** Three tools loaded `73_rpc_offers` without the
  reply classifier it needs and the whole comparison died with `lua module ... error`.
- Every RPC module opens with `error("_common/scripts/X.lua must be loaded before ...")`. That guard is
  the dependency list, and it is the one statement that cannot drift — because the code raises it.
- Cross-domain helpers must live in `_common/scripts/` (`kind: 'common'`) to survive the off-domain
  site-script clear.
- Modules load **before** the runtime installs globals: shadow globals **lazily**, inside the function.

> **Gate** — *every tool declares the modules its Lua actually calls, and what those need*.

---

## 5. Generated artifacts are copies, and copies go stale

`_common/rpc/62_rpc_sites.lua` is generated from the site adapters and carries a "do not edit" header.
Its own tests serialized in memory and compared to the adapters — so a **stale file on disk passed
every one of them**, in both directions at once:

- the 11st shipping fix sat in the adapter and never reached production (the RPC path reads
  `RPC_SITES`, not the adapter): committed, gated, live-tested, **never once in effect**;
- the Amazon title fix had been hand-edited **into** the generated file, so regenerating erased it.

Rules: the adapter is the source; never edit a generated file; a committed generated artifact needs a
**staleness check**, not just a correctness check. `build:rpc` now runs `build:rpc:sites` first.

> **Gate** — *the committed module is what the generator produces right now*. Same lesson as
> `build:schema --check`.

---

## 6. Where interpretation must live

**The node that PAUSES is the only node that sees the user's new message.**

`messagePolicy: { currentUserText: active_node_only }` hands an `action_unit` the text of the turn *it*
was active for. Move the pause to a deterministic node upstream and the model gate downstream keeps
answering the previous turn's message.

Measured, twice: the user typed **"취소"** and the offer was **added to a real cart**, because the gate
re-sent the previous turn's "3번". The Thumbtack shortlist had already hit this exact failure and
answered it the same way — **no model node in the loop at all**.

So:

- A loop that holds the user is deterministic end to end: render → pause → read the reply
  (`AX_CANDIDATE_BROWSER.classify_reply` is shared: numbers select, 다음/이전 page, 취소 cancels,
  anything else is a refinement, nothing at all keeps the window up).
- **A model-called tool cannot be handed flow state.** `allowedTools` means the MODEL supplies the
  arguments, so a tool that needs the snapshot must be an `action_contract` reading it via
  `inputSelector`.
- Converting a model node to a contract is **not** just `kind:`. Its `output:` may still read
  `tool.args.next` (the model's argument — a contract has no model, so the branch comes back
  `undefined`), and its `required:` list is model-shaped. Output mapping, required list and property
  types all follow the node kind.
- Saying **no** must work at every gate that can hold the user, and cancel must be reachable from each.
- **`requestText` is NOT refreshed on a resumed turn** unless the planner copies the reply into
  `state.requestText`. The planner rule lists the nodes it applies to **by name** — move the pause,
  update the list.
- A planner rule needs a **decidable test**, not a longer list of examples, and it must forbid the
  failure that actually happens. Ours listed "미확인 포함" by name and still got
  "어떤 제품을 비교하고 싶으신가요?", because nothing forbade *clarifying* — which discards the listing
  exactly as replacing it would.

> **Gates** — *no model node stands between the comparison and the cart* (reachability, not just
> absence); *the planner names every node that can hold the user*; *nothing in the comparison loop can
> narrate work it did not do*.

---

## 7. Branches

- A command picks its own branch and the adapter **passes it through**. A constant `next` in a wrapper
  throws away work that already happened.
- `invalidNext` is **silent until it discards the whole turn**. Every branch a tool can answer must be
  routed by its node.
- Every model node needs a stall guard (`fallback.maxStalledSteps` + `stalledNext`); one live turn spent
  176s repeating a pair of nodes and said nothing.
- A refusal is **not** the loss of the work: the previous listing must STAND, and the reason must be
  rendered **in the window**. The model relays the window verbatim, so a reason it would have to add in
  its own words is a reason that sometimes never arrives.

---

## 8. Selectors

Everything in `AGENTS.md` §10 still holds. Added this stretch:

- **A selector is only ever validated against the live page.** `.c-card-item__delivery` existed nowhere
  on 11st's card; the real cell is `dd.c-card-item__price-delivery` with an `sr-only` label glued to the
  value, so the text reads `배송비무료` with no separator. A selector matching nothing reads as *"this
  store says nothing about shipping"* — every 11st row reached the comparison with an unknown total and
  was folded out of the window it was searched for.
- Measure before concluding: of 6 cards on that page exactly **one** states shipping at all. The other
  five genuinely say nothing, and guessing zero there would make the store look like the cheapest on
  screen. **Absent is a real answer; record the measurement in a comment next to the selector.**
- The logged-in dev profile can render a **different layout** than an anonymous browser. Measure on the
  profile the extension actually uses.
- A CSS list matches in **document order** — Amazon cards carry two `h2` (brand first), so `"h2, h2 a"`
  took the brand and every branded row came back named "Logitech".

---

## 9. One rule, one implementation

There USED to be two shipping parsers: `S.parse_shipping` in the durable `60_storefront.lua` and a
private one in `61_rpc_storefront.lua`. **Production ran the RPC one.** A fix for `배송비무료` landed in
the other copy; every test passed and the live path stayed broken. A pin test held the two answers
together until one of them could be deleted.

The durable stack is gone (2026-08-15): `60_storefront.lua` is deleted, `<site>/scripts/*` are
config-only declarations read by `tools/build-rpc-sites.mjs`, and the rule has ONE statement —
`61_rpc_storefront.lua`, whose site data is the generated `62_rpc_sites.lua`. The cases the pin was
guarding live on in `tools/lua/rpc-storefront.test.mjs` ("the shipping parser holds every case the
two-parser pin was holding").

Before fixing behaviour, ask **which copy production runs** — and if the answer is ever "there are two
copies", that is the regression this section records. A storefront rule belongs in the RPC layer, and a
site-specific fact belongs in the site's config declaration, where the generator carries it whole.

---

## 10. Tests

- **A fixture that stands in for a capability MUST enforce the runtime's constraints.** The zip fixture
  returned `{ok, json}` — a shape the runtime never produces — so it asserted on its own assumption and
  hid the `body`-only reality for as long as it existed.
- **A fixture that asserts on its own input is worse than none.** If the fake was told to return the
  value you assert, you tested the fake. Assert on what the code *does* — e.g. that the emitted script
  re-reads the store **after** mutating it.
- **A check that cannot fail is not a check.** When a gate passes the moment you write it, prove it can
  fail (run it against a synthetic bad input in the same test).
- **A gate that names a structure breaks when the structure improves.** The live discovery gate required
  `findTool(compare, 'choose_offer')` — a node deleted for a safety bug — while the behaviour it meant
  to protect was fine. Assert the behaviour, and prefer the stronger observable (the pause itself) over
  the presence of a node.
- Test the boundary you were burned at: projection, publication, snapshot, empty-list, module list,
  net host, generated-file staleness. Each one above is a one-line assertion and each one caught a real
  defect the same day it was written.
- Offline (`tools/lua/*.test.mjs`) is for site-agnostic, capability-free modules. Anything touching
  `dom`/`nav`/`net` needs the live harness — but the *encoding* bugs above are all reproducible
  offline, and the offline FX test reproduces the live failure string exactly.

---

## 11. Live testing without breaking something real

- **Clear the paused gate first: `node tools/ax.mjs reset`.** A shopping session paused on a comparison
  window reads the next bare number as a **SELECTION**, and a selection is the approval turn that
  mutates a real cart. Three unintended cart adds came from skipping this.
- A session id is **server-issued** (`ses_…`). Do not mint one; close the session and let the SDK open a
  real one. Minting `ax-<base36>` made every following send return EMPTY — one 928-second timeout
  against a session the backend had never heard of.
- After `reload-ext`, or after attaching a second CDP client, the first `ax send` may come back empty.
  Warm up with a throwaway send; if sends wedge, `reload-ext` again.
- Iterate with reduced scope (one item, one store) and confirm full scope once at the end. A full live
  multi-step flow run costs minutes and the latency is LLM-dominated.
- Isolate tool time with `ax run AX_*` before blaming navigation: measured, tools are stable ~13s while
  the same full flow swung 17 → 49 → 79s, and the entire swing was provider routing.
- `ax run` / `ax call` nest the result under **`.value`**. Reading the envelope's top level yields
  `undefined` and mimics an empty result — a real diagnosis trap that once cost a whole investigation.

---

## 12. Before you say it works

1. Which copy does production run? (§9)
2. Is the generated artifact regenerated? (§5)
3. Does the field survive publication, projection, and the snapshot? (§1)
4. Is every empty list absent? (§2)
5. Does the tool declare its modules, and their dependencies? (§4)
6. Does it declare the hosts it fetches? (§3)
7. Did you see it work **live**, on the profile the extension uses, after `ax reset`? (§11)

`npm run check:flows` · `npm run test:lua` · `npm run test:commerce` · `npm run build:schema --check` ·
`npm run dead:lua` · `npm run test:commerce:live:all` · `npm run test:commerce:live:discovery`
