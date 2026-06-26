# AGENTS.md

## Project Purpose

This repository stores site-specific `llms.txt` sitemap data used by the AXSDK Chrome extension. The repository is intended to be public on GitHub, so every file added here must be safe to publish.

## Core Rules

- Treat all repository contents as public data.
- Never commit secrets, private tokens, cookies, internal URLs, customer data, unpublished credentials, or personally identifiable information.
- Keep entries factual and source-based. Do not invent URLs, metadata, or site capabilities.
- Prefer small, reviewable changes. Avoid unrelated formatting churn.
- Preserve existing file naming and directory conventions once they are established.

## Data Guidelines

- Store only data needed by the AXSDK extension to discover or use site-specific `llms.txt` resources.
- Prefer canonical, stable URLs over redirected, tracking, localized, or session-specific URLs.
- Remove query parameters unless they are required for the resource to work.
- Do not add generated timestamps unless the project later defines them as part of a schema.
- If a site has no reliable `llms.txt` source, do not create a placeholder that implies support.

## Project Structure

Use the existing root-level site directory convention. Do not introduce a `sites/` wrapper unless the repository schema is explicitly changed.

```text
index.md
<site>/
  sitemap.md              # route aliases and site navigation, when available
  knowledge/
    index.yaml
    <group>/
      info.json
      knowledge.md
  scripts/
    *.lua                 # AXSDK helpers, when needed
```

Use lowercase hostnames or established site slugs for directory names. Avoid protocol prefixes such as `https://` in paths. Empty directories with only `.gitkeep` are not supported site data; do not list them as supported unless real source-backed data is added.

Keep `index.md` synchronized with populated site entries.

## Lua Script Selectors

AXSDK Lua scripts drive pages through the injected `dom` capability, which resolves only standard CSS selectors (`querySelector` / `querySelectorAll`). Author selectors for stability across deploys and A/B variants, never for the current build's generated markup:

- Never target obfuscated or build-generated class names — CSS-module / styled-component hashes such as `._2Wt7kayvRID5rLVjUZGxyx`, `.css-1a2b3c`, or `[class*="_3iW9"]`. They change on every deploy and differ across A/B variants.
- Prefer stable, meaningful identifiers: `data-test` / `data-testid` attributes, `id` / `name` made of real words, `aria-label`, `role`, semantic elements (`main`, `aside`, `section`, `nav`, `form`), and design-system utility classes whose names are real words.
- When no stable identifier exists, locate the element by document structure and position relative to a semantic anchor: parent/child/sibling combinators, `:has()`, `:not()`, `:nth-*`, `:first-child`, `:last-child`.
- The `dom` capability cannot match by visible text. When an element is distinguishable only by its label, read candidates with `dom.query_all(selector, { text = true })`, confirm the meaningful label in Lua, then click the verified selector.
- Keep shared selectors as named `M.*` constants in `<site>/scripts/00_common.lua` so they are reviewed and updated in one place.
- Reading list/result cards: the same label is often rendered more than once (responsive duplicates) and may be followed by rating/status badge text (e.g. `Top Pro`, `Very good`, `Exceptional`, `Great`). Before using a card value, collapse the largest immediately-repeated prefix and strip known trailing badges; never assume a single clean render.

## Lua State & Serialization

- An empty Lua table serializes to a JSON **object**, not an array. A flow-state field that a tool schema validates as `array` then fails with `expected array, received object`, and the array-type marker is not reliably honored on every output path. For any state an LLM tool schema validates, prefer a scalar — e.g. a newline-joined string accumulator — and split it in the consumer if a list is needed.
- Scripts shared across domains must live in `_common/scripts/*.lua` registered with `kind: 'common'`; these survive the site-script clear that runs on off-domain navigation, whereas `<site>/scripts/*.lua` do not. Put cross-domain helpers (navigation, ZIP resolution) there.

## Testing Flow Changes

`_common/flows.yaml` (and `<site>/flows.yaml`) are fetched from GitHub at runtime, but `raw.githubusercontent.com` is cache-sticky — editing an existing `flows.yaml`, pushing, and reloading does **not** reliably load the new version. So **test flow changes from the flow store with remote flows OFF — never against the remote copy, and without pushing**:

- **Turn remote flows OFF** so the store is authoritative: `AXSDK.config.clientFlows = { remoteSites: false, stored: true }` (or the Options flow-source toggle). This is required — if remote stays on, the remote copy is re-fetched/deep-merged on navigation and silently overrides your injected flows (e.g. a stale value clobbers your edit), so the test runs the wrong flow.
- **Inject the LOCAL `flows.yaml` into the store** as the only layer: `AXSDK.getFlowsStore().getState().setFlows(":", "<yaml>")` (key `:` = common flows; `:<domain>` = a site's flows). Equivalent: persist `chrome.storage.local["axsdk:flows"]` = `JSON.stringify({ state: { flows: { ":": "<yaml>" } }, version: 0 })`, or use the Options Flows editor.
- **Drive the real flow engine** and read the chat store: `AXSDK.sendMessage(text)`, then poll `AXSDK.getChatStore().getState()` (assistant message lives in the last message's `parts[]`: tool parts carry `state.output`, the terminal reply is a `type:"text"` part — messages have no `role` field). **No git push, no redeploy — iterate by re-injecting**; push only to ship the verified version.
- Scope: this overrides **flows only**. Site **Lua scripts** (the tools `flowTools` call via `execute: { kind: remote, tool: AX_* }`) still load from GitHub and survive navigation by re-fetch, so a Lua edit needs either `AXSDK.lua.load(...)` (what the `<site>/scripts/test_*.mjs` harnesses do, reloading per navigation) or a push + extension reload to take effect inside the flow.

## Testing Lua Logic Locally

- Validate deterministic Lua (serialization, parsing, text normalization, dedupe) OFFLINE with a `fengari` unit test before any live run. Mirror the SDK's real Lua-to-JS converter (sequence detection plus the array-type marker) — a custom reader that ignores the marker gives false confidence. `fengari` needs `lualib.luaL_openlibs(L)` for `tostring` and the string library.
- A full live multi-step flow run costs minutes (navigation plus per-step model calls). Iterate with reduced scope (one item / lowest count) and confirm full scope once at the end, instead of paying the full cost on every fix.

## Validation Before Finishing

Before reporting work as complete:

- Re-read every file you changed.
- Confirm public-safety: no secrets, private endpoints, or personal data.
- Confirm URL accuracy against the source when adding or updating site data.
- Run any validation, formatting, or tests that exist in the repository. If none exist, say so in the final response.

## Style

- Use plain UTF-8 text and Markdown where applicable.
- Keep documentation concise and operational.
- Prefer English for repository-wide technical guidance unless a narrower file already uses another language.
