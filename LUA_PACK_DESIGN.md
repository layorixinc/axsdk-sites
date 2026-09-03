# Lua Pack Design — embedded Lua source in signed userScript artifacts

Status: **architecture revision, approved direction (user decision 2026-09-03)**. This document REVERSES
`USER_SCRIPT_AGENT_PACK_ARCHITECTURE.md` AD-006 and the `COMMUNITY_AGENT_PACK_DESIGN.md` §subset rule
"Do not ship Fengari plus embedded Lua inside the UserScript artifact." Per
`COMMUNITY_SCRIPT_IMPLEMENTATION_PLAN.md`, a locked decision changes only through a written revision plus
a test-plan revision before code; this file is that revision. The CWS release that shipped this
architecture's predecessor passed review (2026-09), which is what retired the caution that produced
AD-006.

## 1. Decision

Pack business logic is **authored in Lua and distributed as Lua**, embedded as a string literal inside
the signed JavaScript userScript artifact. There is **no Lua→JS compilation**. Execution is the
already-shipped **Fengari** interpreter, delivered as a *packaged* prelude into the same `USER_SCRIPT`
world, never downloaded.

```text
signed artifact (application/javascript)
  = WRAPPER_TEMPLATE( luaSource )
  = fixed preamble + JSON.stringify(luaSource) + fixed postamble

world execution order (per P3-C bootstrap machinery)
  1. bootstrap            (packaged, existing)
  2. lua prelude          (packaged: fengari + sandbox + dom bridge + register glue)
  3. pack artifact        (signed bytes; calls __AXSDK_LUA_RUN__(source, meta))
```

Why the artifact stays JavaScript: `chrome.userScripts` executes JavaScript only. A JS wrapper carrying
the Lua string is the only way Lua rides the User Scripts API. The wrapper carries **zero logic**: it is
a fixed template, so review reads the Lua and a gate proves `artifactBytes === wrap(luaSource)`
byte-exactly.

## 2. What each realm runs

| Role | Document | Lua sees |
|---|---|---|
| provider (`search_products`, …) | retailer page, `USER_SCRIPT` world | `dom` bridge over the page's real DOM (synchronous, no CDP round trips), `page`, `json`, `text`, `clock`, `register` |
| task (`prepare_search`, `rank_provider_result`, …) | task executor document (P3-C) | same prelude minus `dom` (no page to read) |

The `dom` bridge mirrors the existing op vocabulary (`dom.query_all`, `dom.get_text`, `dom.exists`,
`dom.get_attr`, …) implemented over `querySelector*`. Existing site-Lua idioms port with their names; the
~460 ms/op CDP cost drops to zero because the code runs inside the page. Navigation is NOT exposed to
pack Lua — the broker keeps its bounded-navigation ownership (provider-router, ≤2 navigations, matches/
approvedOrigins), unchanged.

## 3. Sandbox (closed environment)

The prelude builds one frozen environment per artifact execution:

- **Present:** `assert error ipairs next pairs pcall select tonumber tostring type xpcall`,
  `string.* table.* math.*`, `json.encode/decode/array`, `clock.now`, the role API above.
- **Absent, by construction:** `load loadstring dofile loadfile require collectgarbage io os debug
  coroutine`, the Fengari `js` interop library, and any reference to the real `_G`.

`load`-family absence is the load-bearing line: the interpreter may only ever run the Lua that sits
inside the signed artifact. With it, the packaged interpreter is not "an interpreter for downloaded
code" in the RED-list sense any more than `JSON.parse` is — every executable byte is reviewed and
signed. Registry static validation rejects Lua containing `load(` / `loadstring(` / `js.` tokens
before review, mirroring `FORBIDDEN_SOURCE` for JS.

## 4. Value marshaling

One converter, the SDK's real one (sequence detection + array-type marker), used in both directions at
the register glue. Known traps carried over from §13 of `AGENTS.md`, enforced in the prelude tests:

- empty Lua table encodes as `{}`; a command whose schema expects an array MUST use `json.array()` or
  return the field ABSENT — absent-over-empty at every boundary;
- every bounded string cut steps back off UTF-8 continuation bytes;
- `nil`-valued keys do not exist; providers keep "absent stays absent" (no invented shipping).

## 5. Manifest, registry, and review changes

Artifact `mediaType` stays `application/javascript`; sizes unchanged (256 KiB cap; largest current site
module ~1,100 lines fits with room). Additions:

```yaml
artifact:
  ref: sha256:<wrapped js bytes>
  authoring:
    language: lua
    wrapper: axsdk-lua-wrapper@1        # template version; template bytes are pinned in the repo
    sourceRef: sha256:<lua source bytes> # what reviewers read and sign off on
```

Validator additions (`tools/community-registry.mjs` + SDK verifier):

1. `authoring.language: lua` ⇒ recompute `wrap(luaSource)` and require byte equality with the artifact —
   a wrapper that drifted from the template is refused before review.
2. Lua static checks (§3 token list) run on the SOURCE, not the wrapper.
3. JS authoring remains accepted; both languages coexist (`acceptedAuthoringLanguages` unchanged).

## 6. Locked contracts this revision changes

| Contract | Today | Becomes |
|---|---|---|
| `USER_SCRIPT_AGENT_PACK_ARCHITECTURE.md` AD-006 | "No downloaded Lua runtime; execution never reaches Fengari" | "Lua is the primary authoring AND distribution form, embedded in signed JS; the packaged Fengari prelude executes it in the `USER_SCRIPT` world" |
| `COMMUNITY_AGENT_PACK_DESIGN.md` §Store-X subset | "Do not ship Fengari plus embedded Lua inside the UserScript artifact" | superseded by this design |
| `community/release-policy.json` `artifacts.luaPublication` | `deterministic_javascript_before_review` | `embedded_source_in_signed_wrapper` |
| `community/release-policy.json` (new fields) | — | `luaInterpreter: "packaged"`, `dynamicLuaLoad: false` |
| `tools/community-release-policy.mjs` + `.test.mjs` | pins the old strings | pins the new ones; the `download_lua_source` mutation stays red |
| `COMMUNITY_SCRIPT_IMPLEMENTATION_PLAN.md` invariant "no downloaded Lua or remote interpreter" | as written | "no dynamically loaded Lua outside signed artifact bytes; interpreter is packaged, never downloaded" |

Unchanged on purpose: `executionApi: chrome.userScripts` + `USER_SCRIPT` world, signing/digest/two-phase
approval/revocation, effects list and consent gates, `remoteInterpreter: false` (the interpreter ships in
the extension package — it already does today, 227,867 B in the approved artifact), broker mediation,
provider registry, `modelMayManageScripts: false`.

## 7. Build pipeline

- `packs/shopping/src/task.lua`, `packs/shopping/providers/amazon.lua` replace the `.js` prototypes.
- `tools/packs/wrap-lua.mjs` — the template emitter; deterministic by construction (template +
  `JSON.stringify`), pinned by a build-twice byte-compare test and a one-byte-tamper test.
- `tools/packs/first-party.ts` reads `.lua`, wraps, and signs the wrapped bytes; manifest gains the
  `authoring` block. `example.store-x` provider is rewritten in Lua as the second producer.

## 8. Test plan (revision required by the implementation plan)

1. **Wrapper**: determinism (twice, byte-equal), tamper (one byte → refused), template-drift
   (hand-edited wrapper → refused by validator).
2. **Prelude offline**: run the REAL prelude under the existing fengari harness pattern
   (`tools/lua/harness.mjs` runs the same interpreter production uses — no differential corpus needed).
   Sandbox pins: each absent global is asserted absent; `load` mutation goes red.
3. **Marshaling**: SDK-converter round-trip including empty-table/array-marker and UTF-8 cut cases.
4. **Pack behavior**: the existing 10 `test:packs` cases pass unchanged against the Lua-authored
   artifacts (rank ordering, no invented shipping, threshold free-delivery, captcha/login
   classification) — the contract is the fixture corpus, not the language.
5. **Live**: manual-QA build (P2 harness) installs the Lua-authored shopping pack, executes one provider
   search on Amazon and one rank in the task executor, MAIN world untouched,
   `chrome.userScripts.getScripts()` shape unchanged, then the structural no-Pack baseline restores.
6. **Policy**: `validateCommunityReleasePolicy` updated pins; every CWS build keeps verifying it.

## 9. Risks, stated

1. **CWS posture.** Store inquiry #3 (packaged interpreter + selected Lua in `USER_SCRIPT` world) was
   never answered in writing; the shipped-and-approved artifact already bundles Fengari with embedded
   Lua execution in the worker, and the user has accepted this risk on the strength of the passed
   review. If a future review objects, the wrapper format makes a compile-based fallback possible
   without changing manifests (swap wrapper for compiler output), which is the contingency — not the
   plan.
2. **Per-page interpreter cost.** ~228 KiB parse per provider world. Mitigation: the prelude is
   injected only into worlds that are about to execute a pack artifact (P3-C already executes against
   one acquired document, so this is the existing shape), and cost is measured in the live gate before
   R2.
3. **Review readability.** Reviewers read Lua; the sandbox vocabulary (§3) is the whole reachable API,
   which is what keeps review tractable.

## 10. Delivery order

1. Doc + policy + gate revisions (this file; the table in §6) — first, per the plan's own rule.
2. Prelude + wrapper + offline suites (§8.1–8.3).
3. `packs/shopping` rewritten in Lua; `test:packs` green unchanged (§8.4).
4. SDK verifier + broker acceptance of `authoring.language: lua`; live manual-QA proof (§8.5).

## 11. Delivery status (2026-09-03, updated same day)

Steps 1–4 are DONE and green except the platform-blocked live proof:

- Policy/gates: `community/release-policy.json` now pins `luaPublication:
  embedded_source_in_signed_wrapper`, `luaInterpreter: packaged`, `dynamicLuaLoad: false`;
  `tools/community-release-policy.{mjs,test.mjs}` updated (mutations for `download_lua_source`,
  `downloaded` interpreter, and dynamic load stay red). AD-006, the pack-design subset rule, and the
  implementation-plan invariants are rewritten to this design.
- Wrapper: canonical implementation is `@axsdk/packs` `src/lua-wrapper.ts`;
  `tools/packs/wrap-lua.mjs` mirrors it for Node consumers here, and a mirror test pins the two
  byte-for-byte (same artifacts, same refusals). Deterministic template, byte-tamper and hand-edit
  drift refusals, forbidden-token static checks, multibyte round trip.
- Prelude: canonical implementation is the EXTENSION's
  `axsdk-extension-cdp/src/packs/lua-prelude.ts`, built as the self-contained packaged bundle
  `dist/pack-lua-prelude.js` (fengari IIFE, 233 KiB, loaded lazily per session that runs a Lua pack).
  This repository's contract suite (`tools/packs/lua-prelude.test.ts`) imports and pins THAT module —
  the shipped prelude is what the offline tests execute; the temporary `.mjs` copy is deleted.
- Injection: `injector.ts` executes `[bootstrap, packaged prelude, artifact]` in the same
  `USER_SCRIPT` world whenever the artifact is a Lua wrapper; a Lua artifact with no loadable prelude
  refuses `prelude_unavailable` BEFORE anything executes; a plain JS artifact never loads it.
- Verifier: `fetchVerifiedPackRelease` recomputes the wrapper for every asset carrying `authoring` —
  a drifted wrapper whose declared digest is its own (the exact review-bypass shape) refuses
  `asset_authoring_mismatch`, as does a `sourceRef` that is not the digest of the embedded Lua.
- Packs: `packs/shopping/src/task.lua`, `packs/shopping/providers/amazon.lua`,
  `packs/store-x/src/provider.lua` replace the deleted `.js` prototypes; the pre-existing behavior
  suite passes unchanged against the wrapped Lua artifacts, and a drift gate pins
  `artifact === wrap(source)` plus `authoring.sourceRef === sha256(luaSource)`. The port fixed a
  latent bug: `task.js` joined comparison lines with a LITERAL `\n` two-byte sequence.
- Schema: `AssetRefV2Schema` accepts the optional closed `authoring` block, refused on
  non-JavaScript assets; the community single-script registry refuses a Lua wrapper BY NAME
  (`lua_wrapper_not_supported_here`).
- Built-bundle smoke: the real `dist/pack-lua-prelude.js` bytes, executed in a `process`-less realm
  the way the world runs them, installed `__AXSDK_LUA_RUN__` and ran a wrapped artifact end to end
  (marshaling, `json.array`, `url.with_params`, Korean round trip). The first smoke attempt also
  proved the static gate: a probe source naming `load`/`os` was refused by `wrapLuaSource` itself.

§8.5 live proof: **CLOSED 2026-09-03** by the X3 executor gate
(`test:packs:executor:live`, PACK EXECUTOR LIVE PASS): the Lua-authored `layorix.shopping` task,
fetched and digest-verified from the live unsigned registry by the extension's own verifier, executed
on the published `pack-executor.html` document through `chrome.userScripts.execute` with the built
`dist/pack-lua-prelude.js` — `prepare_search` answered correctly, an empty query refused
`query_required`, the page MAIN world stayed untouched, and `chrome.userScripts.getScripts()` was
unchanged. The platform Pack protocol remains the blocker only for PRODUCT-SESSION routing (X5/X6),
not for Lua pack execution itself.
