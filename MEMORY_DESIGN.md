# AXSDK Memory — Explicit One-Call Tools

> **Status: implemented and live-verified.** `AX_set_memory_bulk` handles saves and mixed updates;
> `AX_delete_memory` atomically deletes one or more exact GLOBAL keys.

## 1. Decision

The explicit memory flow uses four remote AX commands:

| Purpose | AX command | Input |
|---|---|---|
| Exact read or key list | `AX_get_memory` | optional `key` |
| Search | `AX_search_memory` | required `regex` |
| Save or mixed save/delete | `AX_set_memory_bulk` | required `memory` map |
| Delete only | `AX_delete_memory` | required `keys` array |

`AX_delete_memory({keys})` is the canonical delete-only path for one or many exact keys. Mixed
save/delete requests retain `AX_set_memory_bulk({memory})`. Category deletion searches candidates,
pauses in `choose_delete_keys`, and calls `AX_delete_memory` only after the user's follow-up choice.

## 2. Why the empty-string sentinel is acceptable

Empty Markdown has no useful memory content and the current renderer already omits empty values. Treat
`""` as deletion makes the bulk command a final-state map:

```json
{
  "memory": {
    "email": "thumbtack-test@example.com",
    "phone": "415-555-0100",
    "old_address": ""
  }
}
```

Meaning:

```text
email       must equal thumbtack-test@example.com
phone       must equal 415-555-0100
old_address must not exist
```

This is simpler than separate `save`, `append`, and `forget` fields and simpler than another deletion
tool. A mixed save/delete request also remains one call.

### Exact sentinel rule

Only the exact zero-length string deletes:

```text
"" → delete
```

Whitespace-only strings are not deletion sentinels:

```text
" "
"\n"
"  \n"
```

They are rejected as invalid Markdown memory rather than silently deleting or storing invisible data.
This prevents trimming or serialization differences from causing accidental deletion.

## 3. Call budget

| Request | AX calls |
|---|---:|
| Exact read | 1 × `AX_get_memory` |
| Key list | 1 × `AX_get_memory` |
| Regex search | 1 × `AX_search_memory` |
| Save one or many keys | 1 × `AX_set_memory_bulk` |
| Delete one or many exact keys | 1 × `AX_delete_memory` |
| Save and delete in the same request | 1 × `AX_set_memory_bulk` |
| Final response | 0 tool calls; terminal reads flow state |

Ambiguous deletion takes two user turns: search candidates, pause while asking which key or keys to
delete, then call `AX_delete_memory({keys})` on the resumed turn. Regex search never deletes.

## 4. Markdown storage

Each logical key owns one non-empty Markdown string:

```text
email
→ thumbtack-test@example.com

phone
→ 415-555-0100

project/alpha
→ # Project Alpha

  - Migration rehearsal comes before deployment.
```

Frequently changed facts use granular keys:

```text
email
phone
first_name
last_name
address
zip_code
```

The mutation command replaces complete values; it does not append, merge, or patch Markdown. Granular
keys avoid read-before-write for independently changing facts.

The Zustand persistence envelope remains JSON because it uses `createJSONStorage`; the values are
Markdown payloads:

```json
{
  "state": {
    "memory": {
      "g/email": "thumbtack-test@example.com",
      "g/project%2Falpha": "# Project Alpha\n\n- Migration rehearsal comes before deployment."
    }
  }
}
```

No persisted document has an empty value. Deletion removes the internal key entirely.

Remove the nested JSON object currently stored under global scope `:`. Global internal IDs use
`g/<percent-encoded-key>` and AX responses expose logical keys only. Existing site-memory APIs may use
the same Markdown codec, but site memory is not exposed to this flow.

## 5. `AX_get_memory` — unchanged

### Input

```ts
type AXGetMemoryArgs = {
  key?: string;
};
```

Exact read:

```json
{ "key": "email" }
```

```json
{
  "key": "email",
  "value": "thumbtack-test@example.com"
}
```

Missing:

```json
{
  "key": "missing",
  "value": null
}
```

List keys:

```json
{}
```

```json
{
  "keys": ["email", "phone", "project/alpha"]
}
```

The implementation resolves the logical key and returns the Markdown string directly. It does not
parse a nested JSON scope payload.

## 6. `AX_search_memory` — regex only

### Input

```ts
type AXSearchMemoryArgs = {
  regex: string;
};
```

Schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["regex"],
  "properties": {
    "regex": {
      "type": "string",
      "minLength": 1,
      "maxLength": 200,
      "description": "Case-insensitive regex for memory keys and Markdown. Example: email|phone"
    }
  }
}
```

### Output

```ts
type AXSearchMemoryResult = {
  ok: boolean;
  keys: string[];
  markdown: string;
  truncated: boolean;
  error?: string;
};
```

Example:

```json
{
  "ok": true,
  "keys": ["project/alpha"],
  "markdown": "## Memory: project/alpha\n\n# Project Alpha\n\n- Migration rehearsal comes before deployment.",
  "truncated": false
}
```

No match:

```json
{
  "ok": true,
  "keys": [],
  "markdown": "",
  "truncated": false
}
```

AX code performs case-insensitive RE2-compatible search, groups matches by key, returns complete small
documents or bounded excerpts for large documents, formats them into one Markdown string, and enforces
fixed internal limits. The model does not receive flags, limit, scope, cursor, output mode, or revision.

Recommended internal limits are 10 matching documents, 8 KiB per document, and 32 KiB total output.
When `truncated` is true, the terminal asks for a narrower regex or exact key.

Search never mutates memory. Native JavaScript `RegExp` alone is prohibited for model-generated
patterns because catastrophic backtracking can block the extension process.

## 7. `AX_set_memory_bulk` — set final values

### Input

```ts
type AXSetMemoryBulkArgs = {
  memory: Record<string, string>;
};
```

Schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["memory"],
  "properties": {
    "memory": {
      "type": "object",
      "minProperties": 1,
      "description": "Memory key to complete Markdown. A non-empty value saves; an empty value deletes.",
      "additionalProperties": {
        "type": "string"
      }
    }
  }
}
```

Save:

```json
{
  "memory": {
    "email": "thumbtack-test@example.com",
    "phone": "415-555-0100"
  }
}
```

Delete:

```json
{
  "memory": {
    "email": "",
    "old_address": ""
  }
}
```

Mixed save/delete:

```json
{
  "memory": {
    "email": "thumbtack-test@example.com",
    "phone": "415-555-0100",
    "old_address": ""
  }
}
```

There is one input map and no secondary operation field. Object keys are inherently unique, so the
model cannot place one key in conflicting save/delete branches.

### Output

```ts
type AXSetMemoryBulkResult = {
  ok: boolean;
  saved: string[];
  removed: string[];
  not_found: string[];
  error?: string;
};
```

Success:

```json
{
  "ok": true,
  "saved": ["email", "phone"],
  "removed": [],
  "not_found": ["old_address"]
}
```

Failure:

```json
{
  "ok": false,
  "saved": [],
  "removed": [],
  "not_found": [],
  "error": "Whitespace-only memory is not allowed"
}
```

Field meanings:

- `saved`: non-empty values whose requested final state was accepted;
- `removed`: empty-string keys that existed and were deleted;
- `not_found`: empty-string keys that were already absent;
- `error`: batch failure; no changes applied.

Saving the same non-empty value again is still a successful idempotent set and appears in `saved`.

### Internal behavior

One call:

1. Reads one immutable store snapshot.
2. Validates every logical key and string value.
3. Interprets exact `""` as delete.
4. Rejects non-empty whitespace-only values.
5. Replaces non-empty Markdown values in a cloned map.
6. Removes empty-string keys from the clone.
7. Validates key count and byte limits.
8. Persists the clone once.
9. Updates the internal revision only when state changed.
10. Returns one truthful receipt.

Any validation or persistence failure applies none of the batch and returns empty receipt arrays.
Current limits of 200 keys and 256 KiB per document remain enforced.

## 8. `AX_set_memory` compatibility

Keep the current single-key API:

```ts
type AXSetMemoryArgs = {
  key: string;
  value?: string | null;
};
```

Normalize all AX set commands to the same final-state semantics:

```text
non-empty string → save/replace
exact empty string → delete
null or omitted  → delete, for existing compatibility
whitespace-only  → error
```

`AX_set_memory` delegates to the same mutation core with one key. Existing null/omitted deletion remains
compatible; empty string becomes an additional deletion spelling. Empty Markdown documents are no
longer representable through AX memory commands.

If site-memory set commands remain, apply the same value rules so AX APIs cannot disagree about empty
content.

All other writers that share the store—including `AXSDK.setMemory` and Lua/site memory setters—must
delegate to the same mutation core or enforce the same empty/whitespace rules. Otherwise an alternate
surface could recreate invisible empty documents after migration.

## 9. Minimal flow prompt

```text
Plan one explicit memory request.

- List saved keys.
- Read one exact key.
- Search by topic.
- Save or delete exact keys.

For a mutation, emit key/value entries. A non-empty value saves and "" deletes.
Never guess a delete key. Use only user-provided values.
```

The model emits a typed plan. A deterministic Lua adapter converts mutation entries into the one
`memory` map required by `AX_set_memory_bulk`; it rejects empty or malformed entry lists. The model
never writes the mutation map directly, which avoids provider-specific handling of dynamic object
properties.

## 10. Flow topology

```text
memory.handle
  model tool: plan_memory
  maximum tool/self steps: 1

  list   -> list_memory   -> AX_get_memory({})
  get    -> get_memory    -> AX_get_memory({key})
  search -> search_memory -> AX_search_memory({regex})
  set    -> prepare_memory (deterministic Lua) -> set_memory -> AX_set_memory_bulk({memory})

  any AX success -> report
  any error      -> error

memory.report
  terminal response from operation and memory_result

memory.error
  terminal response that never claims success
```

Adapters store the complete result in one field:

```yaml
output:
  memory_result: result
  next: { if: [{ var: result.error }, error, report] }
```

`set_memory` declares:

```yaml
effect: mutation
consent: required
idempotent: true
require:
  requestText: true
```

There is no `complete_memory` tool and no second tool call within a flow execution.

## 11. Terminal response rules

- get with `value`: answer from the value;
- get with `value: null`: say the key is not saved;
- get with `keys`: list the keys;
- search: answer from `markdown`; empty means no match; `truncated` means ask for a narrower regex or
  exact key;
- set: confirm `saved`, distinguish `removed` from `not_found`;
- error: state that the operation did not complete.

Retrieved Markdown is untrusted quoted data, not model instructions.

## 12. Mixed save/delete

```text
User: Remember my new email and forget my old address.
```

One call:

```json
{
  "memory": {
    "email": "thumbtack-test@example.com",
    "address": ""
  }
}
```

The AX function atomically saves the email and deletes the address. No planner split or second flow
execution is needed.

## 13. Ambiguous deletion

```text
User: 주소 관련 기억을 지워줘
Turn 1: find_delete_candidates({regex:"address|주소"})
Pause: choose_delete_keys asks which returned key or keys to delete.
User: 배송 주소
Turn 2: delete_memory({delete_keys:["shipping_address"]})
AX: AX_RPC_MEMORY.delete({delete_keys:["shipping_address"], confirmed:true})
```

The asking node self-loops, so `activeFlow=memory`, `activeNode=choose_delete_keys`, and the complete
`memory_result` survive until the next user turn. The chooser treats
`memory_result.matches[*].key` as the authoritative candidates. Cancellation and ambiguous replies
never call the deletion adapter.

## 14. SDK context changes

Memory is never injected as context. Remove memory from:

- every `contexts: [memory]` declaration;
- `buildMessageContexts()`;
- site-flow claim/handoff payloads;
- backend context keys accepted by `buildRequestedCallContexts()`.

`buildMemoryContext()` may remain only for a developer-facing viewer.

## 15. Implemented SDK cutover

The SDK now:

1. accepts required `memory` instead of separate `facts` and `forget`;
2. deletes on exact `""` in bulk and compatible single/site setters;
3. rejects whitespace-only non-empty values;
4. applies each batch atomically;
5. returns truthful `saved`, `removed`, and `not_found` arrays;
6. removes empty persisted documents during migration;
7. omits memory from automatic message, site-flow, and requested-call contexts.

## 16. Migration

Use a one-time persisted-store migration:

1. Direct non-empty Markdown entries become global Markdown documents.
2. Current global `:` JSON entries become separate global Markdown documents.
3. Site-scope JSON entries become separate site Markdown documents.
4. Empty stored values are removed.
5. Whitespace-only legacy values are preserved under deterministic `_legacy/...` keys for manual
   review rather than interpreted as deletion.
6. Legacy freeform blobs become deterministic `_legacy/...` documents.
7. Identical collisions are deduplicated.
8. Different collisions preserve both values under `_migration_conflict/...` keys and emit a warning.
9. Validate limits and persist once.
10. On failure, leave the old payload intact.

After migration, handlers read non-empty Markdown documents only; no permanent dual-read branch
remains.

## 17. Acceptance checks

### Tool simplicity

- `AX_get_memory`: optional `key` only.
- `AX_search_memory`: required `regex` only.
- `AX_set_memory_bulk`: required `memory` map only.
- `AX_delete_memory`: required non-empty `keys` array only.
- No append, mode, tagged union, cursor, scope, revision, or universal operation object is model-facing.

### Sentinel behavior

- non-empty Markdown saves or replaces;
- exact `""` deletes;
- whitespace-only non-empty values fail the entire batch;
- deleting an existing key returns it in `removed`;
- deleting an absent key returns it in `not_found`;
- no empty document remains persisted;
- single, bulk, and site AX set commands agree on empty-string behavior.

### Call count

- exact get, list, search, save-many, delete-many, and mixed save/delete each require one AX call;
- no completion tool exists;
- no flow execution can call a second remote AX memory command in one user turn;
- only category deletion requires a search turn, a paused user choice, and a later delete turn.

### Correctness and safety

- bulk mutation is atomic and idempotent;
- search never mutates;
- regex candidates require exact user confirmation;
- missing deletes are not reported as removed;
- failed persistence cannot produce success;
- no prompt receives the full memory store.

## 18. Non-goals

This design does not add append, merge, patch, semantic search, embeddings, automatic memory capture,
automatic task recall, regex deletion, model-selected scope, raw `.md` files, hidden LLM calls inside AX
functions, or a universal `AX_memory` command.

## 19. `_common/flows.yaml` integration

This section assumes the SDK contracts above are implemented and available:

```text
AX_get_memory({key?})
AX_search_memory({regex})
AX_set_memory_bulk({memory})
AX_delete_memory({keys})
```

The flow change makes memory an explicit routed task. It removes automatic capture, full-memory
contexts, and fallback claims that a mutation already happened.

### 19.1 Required delta

In `_common/flows.yaml`:

1. Add a `memory` planner intent and router route.
2. Remove every planner statement that memory is captured automatically.
3. Explicitly route remember, forget, list, exact-read, and search requests to `memory`.
4. Remove `hooks.beforeIntent: [capture_memory]`; set `beforeIntent: []`.
5. Delete `flows.capture_memory`.
6. Delete `flows.memory_fallback`.
7. Add `flows.memory`.
8. Replace `fallbackIntent: memory_fallback` with `fallbackIntent: unsupported_request`.
9. Add `flows.unsupported_request`.
10. Delete `flowTools.remember_facts`.
11. Add `flowTools.get_memory`, `search_memory`, `find_delete_candidates`, `choose_delete_keys`,
    `set_memory`, and `delete_memory`.
12. Remove `contexts: [memory]` and `<memory>` prompt references from every ordinary task flow.

### 19.2 Planner changes

Add to the configured-intent list:

```text
- memory — an explicit request to save, delete, list, read, or search saved memory.
```

Memory routing rules:

```text
- Route to memory only when the user explicitly asks to remember/save, forget/delete, list/show,
  read, or search remembered information.
- A message that merely contains a name, email, phone, address, ZIP, preference, or product is not a
  memory request.
- Information supplied for a quote or shopping request stays in that task's requestText and is not
  automatically persisted.
- A single memory request may save and delete several exact keys; keep it as one memory intent.
- If a message contains memory plus another task, emit both intents in user order. Copy every detail
  needed by the ordinary task into that task's requestText; it must not depend on a prior memory write.
- An answer to an active flow remains continue_current and is not saved merely because it is reusable.
- If an active-flow answer also contains a separate explicit memory clause, resume the active intent
  first and queue the memory intent after it, preserving the value in both relevant requestText
  segments.
- If `activeFlow=memory` and `activeNode=choose_delete_keys`, route the latest answer with
  `continue_current`; never classify a short candidate label or cancellation as out_of_scope.
```

Replace the current out-of-scope statement with:

```text
- out_of_scope — the message matches no configured intent. Explicit memory requests are never
  out_of_scope; route them to memory.
```

Add planner examples:

```text
"내 이메일 test@example.com을 기억해"
→ replace_current
→ intents=[{intent:memory, segments:["내 이메일 test@example.com을 기억해"], state:{requestText:"내 이메일 test@example.com을 기억해"}}]

"이메일을 잊어줘"
→ replace_current
→ intents=[{intent:memory, segments:["이메일을 잊어줘"], state:{requestText:"이메일을 잊어줘"}}]

"기억한 내용 보여줘"
→ replace_current
→ intents=[{intent:memory, segments:["기억한 내용 보여줘"], state:{requestText:"기억한 내용 보여줘"}}]

"이메일 test@example.com을 기억하고 예전 주소는 잊어줘"
→ one memory intent; set_memory can save and delete in one map

"test@example.com으로 청소 견적 받아줘"
→ request_service_quote only; use the email for this quote and do not save it

"이메일 test@example.com을 기억하고 청소 견적도 받아줘"
→ memory plus request_service_quote in the stated order
→ the quote requestText also contains the email if the quote needs it
```

Add `memory` to the `decide` tool's intent enum:

```yaml
intent:
  type: string
  enum:
    - request_service_quote
    - shopping_single_site
    - bluemoonsoft
    - end_conversation
    - checkout
    - memory
```

No memory subtype, operation enum, scope, key list, or tool argument belongs in the planner schema.
The planner selects only the route and preserves `requestText`.

### 19.3 Router and hooks

Target router additions:

```yaml
router:
  mode: fixed
  defaultIntent: request_service_quote
  fallbackIntent: unsupported_request
  routes:
    # existing routes remain
    - intent: memory
      entry: memory.handle
      description: Save, delete, list, read, or search explicitly requested memory.
      examples:
        - 내 이메일을 기억해
        - 이메일을 잊어줘
        - 기억한 내용 보여줘
        - 내가 기억하라고 한 주소가 뭐야
```

Disable the automatic hook explicitly:

```yaml
hooks:
  beforeIntent: []
```

An explicit empty list is preferred to omitting `hooks`: overlays preserve omitted base fields, while
the list replaces the inherited hook field.

### 19.4 `memory` flow

```text
memory.handle
  list        -> list_memory -> AX_RPC_MEMORY.get({})
  get         -> get_memory -> AX_RPC_MEMORY.get({key})
  search      -> search_memory -> AX_RPC_MEMORY.search({regex})
  delete      -> delete_memory -> AX_RPC_MEMORY.delete({delete_keys, confirmed})
  set         -> prepare_memory -> set_memory -> AX_RPC_MEMORY.set_bulk({memory, confirmed})
  find_delete -> find_delete_candidates -> choose_delete_keys
                                              ask -> self-loop / pause
                                              delete -> delete_memory
                                              cancelled -> terminal
```

All adapters are `kind: runtime` tools loading `_common.70_rpc_memory`; `rpc.allow` grants the exact
local `memory.*` op. Exact one/many delete requests call `delete_memory` directly. Category deletion
searches candidates on the first user turn, then pauses in `choose_delete_keys`; the resumed turn copies
the user's chosen exact key or keys into `delete_keys`. `prepare_memory` remains only for save and mixed
save/delete requests sent to `set_memory`.

### 19.5 Flow-tool adapters

`find_delete_candidates` publishes the op payload at `memory_result` and branches on
`result.memory_result.matches.0`. Each match is `{key, excerpt, truncated}`. `choose_delete_keys` reads
only `memory_result.matches[*].key`; it is a passthrough action-unit tool whose `ask` transition
self-loops and pauses the flow. `delete_memory` projects only the selected keys plus the confirmation:

```yaml
delete_memory:
  execute:
    kind: runtime
    implementation: lua
    modules: [ "_common.70_rpc_memory" ]
    rpc: { allow: [ memory.set_bulk ] }
  effect: mutation
  consent: required
  idempotent: true
  require: { confirmed: true }
```

The module receives `{delete_keys, confirmed}` and returns the standard removal/not-found receipt.
`set_memory` is the separate bulk adapter for `{memory, confirmed}`.

### 19.6 Remove memory from ordinary flows

Delete `contexts: [memory]` from:

```text
request_service_quote
shopping_single_site
checkout
bluemoonsoft
```

Update quote collection:

```text
Before:
Fill the request fields from the user message and memory...
Extract from requestText and <memory>.
A field is missing only if absent from message, memory, and state.

After:
Fill the request fields from the user message and current flow state...
Extract from requestText and the projected state fields.
A field is missing only if absent from requestText and state.
```

The quote flow still requires all contact fields and must ask for missing values. A contact value used
for the current quote is not persisted unless the user separately routed an explicit memory request.

Update shopping collection:

```text
Before:
Extract products from requestText and <memory>.

After:
Extract products from requestText and the current shop_plan only.
```

Saved memory never creates a product, quantity, checkout, navigation, or quote action implicitly.

`checkout` and `bluemoonsoft` do not currently use `<memory>` in their node prompts; remove only their
unused flow-level memory contexts.

### 19.7 Unsupported fallback

Replace `memory_fallback` with:

```yaml
flows:
  unsupported_request:
    nodes:
      reply:
        kind: terminal
        respond: |-
          Reply briefly in the user's language. This request is unsupported. State that you can help
          with service quotes, shopping, checkout review, BlueMoonSoft navigation, and explicit memory
          requests. Never claim anything was saved or deleted.
```

The fallback does not receive memory and never infers that a hook already performed a mutation.

### 19.8 Expected per-turn behavior

| User message | Planner route | Memory AX call | Ordinary task effect |
|---|---|---|---|
| `내 이메일 test@example.com을 기억해` | memory | set `{email: value}` | none |
| `이메일을 잊어줘` | memory | delete `{keys:[email]}` | none |
| `기억한 key 보여줘` | memory | get without key | none |
| `내 이메일이 뭐야?` | memory | get `{key: email}` | none |
| `프로젝트 알파 관련 기억 찾아줘` | memory | search regex | none |
| `email 저장하고 address 삭제해` | memory | one mixed set map | none |
| `test@example.com으로 청소 견적` | request_service_quote | none | email used only in quote |
| `아이폰 사줘` | shopping_single_site | none | requestText only |
| `주소 관련 기억 지워줘` | memory | search candidates, pause | no deletion until follow-up |
| `배송 주소` while paused | continue memory | delete `{keys:[shipping_address]}` | exact selected key only |
| unsupported request | fallback | none | no false memory claim |

### 19.9 Verification plan

Before shipping the flow change:

1. Run the flow compiler/build check.
2. Verify planner routing for explicit save, delete, exact read, list, regex search, non-memory PII,
   mixed memory/task, active-flow answer, and unsupported requests.
3. Verify every completed memory turn invokes at most one remote AX memory command.
4. Verify mixed save/delete uses one `AX_set_memory_bulk` call.
5. Verify category deletion searches, pauses, resumes, and calls `AX_delete_memory` with selected keys.
6. Verify cancellation and ambiguous replies do not call `AX_delete_memory`.
7. Inject SDK errors from get, search, set, and delete; confirm no terminal success claim.
8. Verify `request_service_quote`, `shopping_single_site`, `checkout`, and `bluemoonsoft` prompts contain no memory
   context or `<memory>` block.
9. Verify a quote still collects current-turn contact details and asks for missing fields.
10. Verify shopping still builds products from current request and `shop_plan`.
11. Verify no full memory appears in planner, action-unit, terminal, or site-flow prompt payloads.

Implementation-time repository synchronization:

- update `_common/flows.yaml`;
- update `SCHEMA.md` for the final AX memory command schemas;
- run `npm run build:lua:check`;
- use `node tools/ax.mjs sync <site>` and a focused `ax send` flow run to prove stored flows and the
  updated SDK tools execute together;
- use only reserved test values such as `thumbtack-test@example.com`, `415-555-0100`, and `94101`.

### 19.10 Flow non-goals

This flow integration does not add automatic capture, task-time recall, profile autofill, memory-driven
shopping, memory-driven navigation, regex deletion, semantic search, or a prompt context containing the
whole memory store.
