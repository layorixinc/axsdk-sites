# `flows.yaml` — authoring review and improvement proposals

A review of the two flow documents as they stand after the durable→RPC migration, from the position of
someone who has to edit them. Companion to `FLOWS.md` (schema), `AUTHORING.md` (the boundaries a value
dies at) and `RPC_LUA_REFERENCE.md` (what a script may call).

Every number below was measured against the committed documents, not estimated. Nothing here is a
refactor for its own sake: each item names the cost it imposes on the next edit, and several name a live
failure this session that the shape made possible.

---

## 1. What is there now

Two workspaces, one schema, **two delivery paths**:

| | production | playground |
|---|---|---|
| document | `_common/flows.yaml` + site overlays | `playground/_common/flows.yaml` |
| size | 196.2 KiB · 4,317 lines | 24.2 KiB · 773 lines |
| flows | 9 | 7 |
| nodes | 86 | 27 |
| flowTools | 70 | 11 |
| `action_unit` (model) | **14** | 1 |
| `action_contract` | 50 | 10 |
| `terminal` | 22 (21 with text, avg 262 chars) | 16 |
| planner prompt | 10,549 chars | none — the router dispatches directly |
| node prompts | 23,068 chars (max 3,995) | 728 chars |
| module delivery | by NAME, app package (25 `luaModules`) | INLINED per tool, 221.3 KiB of a 256 KiB ceiling |

`kind: remote` is **0** in both. 58% of production nodes are deterministic, and the comparison loop lost
its last model node this session after an `action_unit` there re-sent the previous turn's message and put
an offer in a real cart.

Three node kinds carry everything:

- **`action_contract`** — arguments are the node's selected flow state, projected through
  `parameters.properties`. No model call.
- **`action_unit`** — arguments come from the MODEL via `allowedTools`. ~6–12s each.
- **`terminal`** — wording only.

**33 of 70 production tools are three-line delegations** to a module entry.

---

## 2. Findings

### A. 14 model blocks that say what `defaults` already says

`defaults.model` exists. Fourteen node-level `model:` blocks are **byte-identical to it**, and **zero**
differ:

```
per-node model blocks identical to defaults.model: 14 | differing: 0
```

Same shape elsewhere: `fallback: { invalidNext: error, exhaustedNext: error }` appears **32 times** out of
56 fallback lines.

**Cost.** ~150 lines of YAML that carry no decision, in the file where finding the node you want is
already the hard part. Worse, a reader cannot tell whether a repeated block is deliberate — that is
exactly the question `differing: 0` answers, and no reader runs that query.

**Proposal.** Delete the 14 blocks. Add a `defaults.fallback` for the error pair, keeping explicit
fallbacks only where they differ (the stall guards on model nodes genuinely do).

**Effort** small · **Risk** very low — a gate can assert `differing: 0` stays true.

### B. Three parallel lists per tool, kept in sync by hand

An author writing one tool maintains three declarations that must agree:

| list | what it controls |
|---|---|
| `inputSelector` | which state the node hands over |
| `parameters.properties` | which of that survives projection |
| `output` | which script results reach state |

Production has **296 selector entries across 86 nodes** (max 14 on one node).

**Cost — measured, three live failures this session:**

- `requestText` selected but never declared → the user typed "취소" and the window came back.
- Six branch fields returned by the script and never published → the refiner was told to page with
  nothing to page with.
- A node converted to `action_contract` whose `output` still read `tool.args.next` → every comparison
  routed to lost.

All three are silent: the selector looks right, the schema looks right, nothing throws. Gates now catch
each direction, but the gates exist because the format asks for the same fact three times. Two tools
still declare more than their node selects (`browse_offers` +2, `add_selected_offer` +1) — harmless
today, and precisely the drift that becomes a defect later.

**Proposal.** Derive rather than repeat: default `inputSelector` to the tool's declared properties, and
have the build print a diff for the deliberate exceptions. Failing that, generate the two lists from one
source in the build.

**Effort** medium · **Risk** medium — changes an authoring contract; do it behind the existing gates.

### C. A runtime tool cannot be shared across flows

One inline action backs exactly one node, and an id may not repeat across flows. So one behaviour needs
one thin entry per flow:

```
enter_shopping_site · enter_checkout_site · enter_bluemoonsoft   → all AX_RPC_NAV.open_site
```

The playground port produced three more for one search entry, for the same reason.

**Cost.** Copies to keep in step, and under inline delivery the module set is charged per tool — this is
what took the playground document to 615.7 KiB before the search entries were consolidated.

**Proposal.** Two parts. Short term: **generate** the thin entries from one declaration so nobody writes
them. Long term: ask the runtime for a shareable runtime action, the way `run:` already works for the
remote kind. That is one request document, and the shape it needs already exists.

**Effort** small (generate) / external (runtime) · **Risk** low.

### D. Lua inside YAML

Production carries **314 lines of inline Lua**, of which **37 are `function run(args)` wrappers** that do
nothing but forward:

```yaml
      entry: run
      lua: |
        function run(args)
          return AX_RPC_OFFERS.present(args)
        end
```

**Cost.** No syntax highlighting, no linting, no unit test, and a YAML indentation error in a Lua block
reads as a schema error. The wrapper is pure ceremony — the module entry is already named right there.

**Proposal.** Let `entry:` name a module function directly (`entry: AX_RPC_OFFERS.present`) and have the
builder synthesise the wrapper. Removes ~110 lines and one whole class of edit.

**Effort** small (builder) · **Risk** low — the emitted document is unchanged.

### E. 4,317 lines in one file

Nine flows, seventy tools, one document.

**Cost.** This session that file was edited by line number, and one regex edit landed on the wrong tool
because two tools had the same block shape. Merge conflicts on it are unpleasant for the same reason.

**Proposal.** Split to `_common/flows/<flow>.yaml` + `_common/flowTools/<group>.yaml` and merge in the
build. No schema change, and the emitted document is byte-identical — which is itself the acceptance
test.

**Effort** medium · **Risk** low, given a byte-identical output check.

### F. Two delivery paths with different limits, and duplicated Lua

Production sends modules by name; the playground inlines them. Consequences:

- The playground alone meets a **64 KiB per-tool** ceiling. It had been **failing to compile** —
  `execute.lua exceeds 65536 bytes` — before this session's port, and nothing local checked it. The
  builder now strips comments and refuses what the runtime will reject.
- `61_rpc_storefront.lua` (38.3 KiB) and the generated site table (27.0 KiB) exist **twice, byte for
  byte**, once per workspace. A mirroring test keeps them equal; nothing makes them one.

**Cost.** 65 KiB of Lua maintained in duplicate, and a class of failure only one workspace can see.

**Proposal.** Have the playground build read the production `_common/rpc` modules directly instead of
keeping copies. Keep the mirroring test until the copies are gone, then delete it with them.

**Effort** medium · **Risk** medium — the playground is a live profile; verify with `playground sync`
plus one driven turn.

### G. Prompt weight is the latency budget

10,549 characters of planner prompt, 23,068 across node prompts, 14 model nodes. Node prompts inject the
flow state about three times over (global, local, selected). Measured elsewhere in this repo: tools are
stable ~13s while the same full flow swung 17 → 49 → 79s, and the entire swing was model turns.

**Cost.** Every model node is seconds and a chance to answer wrong. The comparison loop proved the
alternative: it now has **no model node at all** — render, pause, read the reply deterministically — and
it stopped both the latency and a cancel-becomes-purchase bug in one change.

**Proposal.** Audit the remaining 14 `action_unit` nodes for the same pattern: any node inside a loop
that holds the user is a candidate, because such a node re-reads a message it cannot see change.

**Effort** per node · **Risk** medium — each is a behaviour change and needs a live turn.

---

## 3. Order of work

| # | item | frees | risk |
|---|---|---|---|
| 1 | Delete the 14 redundant `model:` blocks; add `defaults.fallback` | ~150 lines | very low |
| 2 | `entry:` names a module function; drop the 37 wrappers | ~110 lines of YAML-embedded Lua | low |
| 3 | Split the document per flow, byte-identical output | edit safety | low |
| 4 | Generate the thin per-flow entries | copies that drift | low |
| 5 | One copy of the RPC modules, shared by both workspaces | 65 KiB duplicate | medium |
| 6 | Derive `inputSelector` from declared properties | the three-list class of bug | medium |
| 7 | Audit the remaining model nodes in holding loops | latency + a known bug class | medium |

1–4 are mechanical and independently shippable. 5–7 change contracts and each wants a live turn.

---

## 4. Deliberately not proposed

- **Merging the redundant playground demo flows.** Two of them search Amazon; consolidating is a product
  decision about what the fixture demonstrates, not a cleanup.
- **Trimming the generated site table.** `build-rpc-sites` copies each adapter config whole on purpose —
  "nothing is selected, so a key the adapter declares cannot be missing from the reader". Selecting
  fields to save bytes would reintroduce exactly the drift the generator removed.
- **Replacing the planner prompt with rules.** Its follow-up rules are load-bearing and were each written
  after a live failure; they belong in a prompt because they interpret language.
- ~~**Deleting `60_storefront.lua`.**~~ Refused here while the stored-Lua site layer still read it — two
  callers, not two copies. That layer is gone (2026-08-15) and `60_storefront.lua` went with it:
  production RPC flows read `61_rpc_storefront`, and its site data is the generated `62_rpc_sites`
  built from the config-only `<site>/scripts/*` declarations.
