# Extension playground design

## Decision

Add a dedicated, headed-Chrome CLI playground for testing extension flows and Lua tools without touching the daily live-harness profile or its stored runtime.

The playground is a folder-local source workspace and a separate Chrome runtime:

```text
playground folder
  index.md + _common + per-site YAML/Lua sources
          |
          v
playground CLI (reuses tools/harness/cdp.mjs)
          |
          v
isolated headed Chrome profile + AXSDK extension stores
          |
          v
https://axsdk.ai/ test surface + interactive REPL
```

The default invocation enters a managed REPL. Before showing its prompt, the CLI starts or attaches only to a dedicated profile, reads the workspace's `index.md`, `_common`, and per-site sources, writes a canonical local sites-index document plus the Lua/flow layer maps to extension storage, sets the `remote_sites: false` master policy, reloads the extension, opens `https://axsdk.ai/`, verifies the loaded index and layers, then waits for commands such as `.reload`, `.send`, `.run`, and `.call`.

The V1 implementation now provides the `playground/` fixture workspace and managed CLI described below; remaining forward-looking sections are design constraints, not unimplemented runtime behavior.

## Goals

1. Run a **headed** Chrome instance with a persistent, playground-only profile.
2. Make the playground executable from its own folder.
3. Load the workspace `index.md`, `_common`, and each site layer's `flows.yaml` and ordered Lua source files into extension storage.
4. Run the extension against `https://axsdk.ai/` by default.
5. Exercise both direct `AX_*` Lua commands and the real flow engine from one interactive CLI.
6. Make source refresh deterministic: edit files -> `.reload` -> extension runs exactly those files after a cold reload.
7. Reuse the proven CDP/AXSDK plumbing in `tools/harness/cdp.mjs`; do not fork the live harness.
8. Prevent accidental writes to the daily `ax` profile, port, stores, or remote-source settings.

## Non-goals

1. Replace `tools/ax.mjs`; `ax` remains the production-site daily driver.
2. Build a browser UI, web server, mock site, or a second extension.
3. Automatically submit orders, quotes, forms, or other irreversible actions.
4. Treat `axsdk.ai` as a production site definition or edit the remote sites index to make it one.
5. Add a generic arbitrary-code shell. The REPL accepts only declared playground commands and `AX_*` calls.
6. Support arbitrary synthetic site-layer behavior on an unknown host without a separate SDK test-host adapter.

## Facts that shape the design

### Existing harness

`tools/ax.mjs` already supplies the needed live primitives through `tools/harness/cdp.mjs`:

- Chrome lifecycle: `ensureChrome`, `launchChrome`, and CDP target selection.
- AXSDK Assistant context discovery and Lua execution: `run`, `call`, `listCommands`, `status`.
- extension reload: `reloadExtension` navigates through the extension options page, invokes `chrome.runtime.reload()`, reattaches, and waits for the runtime.
- flow driving: `sendMessage` and `readChat` re-find the AXSDK context across navigations.
- store injection: current `syncStore` writes `axsdk:lua`, `axsdk:flows`, and `axsdk:extension:config` for the shared live profile; it intentionally retains the normal remote sites-index policy.

The playground must reuse these primitives, but must not call `syncStore` directly: `syncStore` builds the whole repository and writes all published site layers into the shared live profile.

### `remote_sites` is the local-index master policy

The sibling SDK/extension now provides `remote_sites`, defaulting to `true`. It replaces the proposed playground-specific stored-index flag: the playground requires an extension build with this policy and selects local mode by writing `remote_sites: false` in its dedicated profile.

- With `remote_sites: true`, the extension storage adapter returns `null` for `axsdk:sites` and ignores writes/removes to that key. The regular runtime can load its configured remote index in memory, but it cannot overwrite or delete a user-saved local index.
- With `remote_sites: false`, the adapter rehydrates `axsdk:sites` normally. Core accepts it as a local index only when `source === "local"`, `indexUrl === ""`, and `indexMd` is a string; otherwise it clears the in-memory index and reports that no local index is configured.
- Local mode prevents remote sites-index and site-definition loading, including sitemap and site knowledge resources. It also makes the effective remote client-flow, Lua, and widget settings false even if their individual persisted toggles remain true. Stored flows remain enabled for the playground.
- A matching local hostname creates an empty local site definition lazily, without a network request. The extension watches only the local-index fingerprint (`source`, `indexUrl`, `indexMd`, `loadedAt`), so later site-cache updates do not cause a rehydration loop.

The Extension Options Local sites index editor writes the same canonical document and enforces a UTF-8 256 KiB limit. The playground writes the same shape directly through CDP; it does not automate the Options UI.

### Why `axsdk.ai` executes only the common layer

The extension content script runs on all HTTP(S) pages, including `https://axsdk.ai/`. However, `axsdk.ai` is not a site in this repository's `index.md`. On an unknown host, `refresh_current_site()` clears the active site-layer scripts.

The playground persists the canonical local-index document and every workspace layer:

```text
axsdk:sites                 = `source:"local"`, `indexUrl:""`, raw index.md, and initial `sites:{}`
axsdk:lua[":"]              = _common Lua bundle
axsdk:flows[":"]            = _common flows.yaml
axsdk:lua[":<domain>"]      = that site's Lua bundle
axsdk:flows[":<domain>"]    = that site's flows.yaml, when present
axsdk:widgets               = canonical empty map in V1; the workspace has no widget source contract
```

At `axsdk.ai`, the global `_common` Lua and flow layer is active; all site layers remain persisted and digest-verified but inactive. After `.open` navigates to a host that the stored local `index.md` resolves as `<domain>`, the SDK applies `stored-lua:<domain>` after `stored-lua:` and merges the stored site flow overlay after the stored common flow layer.

The first version does not write a `":axsdk.ai"` or synthetic `":playground"` site key. The source workspace mirrors real site layers, while site activation remains governed by the SDK's normal current-site resolution.

## Filesystem contract

The workspace root mirrors this repository's existing layer convention. It has one explicit `_common/` directory and one immediate top-level directory per site; it does **not** add a `sites/` wrapper.

`--root` may point either to a dedicated `playground/` workspace or to this repository root; both use the same `_common/` plus immediate-site layout, so existing site layers never need a `sites/` wrapper or an export/copy step.

```text
playground/
  index.md                   # required local sites index; drives host → domain resolution
  _common/
    flows.yaml               # required stored common client-flow document
    scripts/                 # optional common Lua layer, lexical file order
      00_base.lua
      10_tools.lua
  amazon/
    flows.yaml               # optional stored Amazon flow overlay
    scripts/                 # optional Amazon-only Lua layer
      00_common.lua
      10_product.lua
  thumbtack/
    flows.yaml               # optional stored Thumbtack flow overlay
    scripts/                 # optional Thumbtack-only Lua layer
  fixtures/                  # optional test-only data; never auto-loaded into the extension
  .gitignore                 # no profile, logs, cookies, or runtime state here
```

### `index.md`

- Required at the workspace root and stored as the canonical local sites index: `source: "local"`, `indexUrl: ""`, raw `indexMd`, empty common remote artifacts, and initial `sites: {}`.
- Its UTF-8 encoding must not exceed 256 KiB; preflight rejects an oversized document before Chrome or extension storage is touched.
- Parsed before Chrome is touched by a strict playground parser with table-driven parity fixtures for the current core line semantics. The parser derives a hostname from the first HTTP(S) Markdown link and the domain from the first non-HTTP(S) link (or the site-link text), then validates the resulting domain/path before storage.
- Every discovered site layer must have a matching domain entry. Index entries without a workspace overlay are valid and resolve as common-only sites.
- Duplicate hostname entries that resolve to different domains, malformed domain/path values, and a layer absent from the index are rejected rather than silently falling back to the remote index. Multiple hostnames may intentionally map to one domain.
- Static source state never pre-materializes site stubs. On the first navigation to a matched hostname, core lazily creates an empty local site cache; that cache is runtime state, not an input to the source digest.
- `axsdk.ai` is rejected as a local-index hostname in version 1 so home remains the unknown-host common-layer test surface.

### Layer discovery and storage keys

- `_common/` is required and maps to the global store key `":"`.
- Every direct, non-hidden top-level directory other than `_common`, `fixtures`, `dist`, `tools`, and `node_modules` is a site layer only when it contains `flows.yaml` or immediate `scripts/*.lua`.
- A site's directory basename is its SDK domain/store suffix: `amazon/` maps to `":amazon"`, `thumbtack/` maps to `":thumbtack"`.
- The loader rejects nested `scripts/**`, non-UTF-8 source, and ambiguous directory/file paths. It never scans recursively for a second convention.
- A site directory may supply Lua, flows, or both. Missing optional site files do not create an empty overlay key.
- Root-level `flows.yaml` or `scripts/` are rejected; the previous single-global source shape is not silently reinterpreted as `_common`.

### Flow YAML

- `_common/flows.yaml` is required and stored verbatim under `axsdk:flows[":"]`.
- Each present `<site>/flows.yaml` is parsed locally for YAML syntax and stored verbatim under `axsdk:flows[":<domain>"]`.
- The CLI does not rewrite interpolation, merge source files, or invent output schemas. The extension/runtime remains authoritative for flow compilation and runtime layer merging.

### Lua scripts

- `_common/scripts/*.lua` and each `<site>/scripts/*.lua` are optional. An absent `scripts/` directory is valid for flow-only layers.
- Files participate only from their immediate `scripts/` directory and are sorted lexically. Numeric prefixes remain the explicit load-order mechanism.
- The CLI creates one in-memory bundle per layer. Each source file is wrapped in the same vararg-function form used by `tools/merge-lua.mjs`, preserving file-local Lua `local` values and top-level `return` behavior while allowing globals to cross files.
- The `_common` bundle is stored at `":"`; every site bundle is stored at its own `":<domain>"` key. Site bundles remain site-only: the CLI never prepends `_common`, because the runtime applies the common layer before the active site layer.
- The CLI does not write a generated `dist/` artifact for the playground by default. A future `bundle` diagnostic command may print or save an explicitly requested generated source.

### Home selection

V1 does not read a workspace manifest. The default home is `https://axsdk.ai/`; use the CLI
`--home=URL` flag to override it. Profile paths, API keys, extension configuration, credentials,
arbitrary source includes, site aliases, and remote-source toggles are never workspace inputs.
`sync` owns source selection: it forces `remote_sites: false` and stored flows on; individual
remote-layer toggles are not authoritative while the master policy is false.

## Process and profile isolation

### Defaults

| Setting | Playground default | Live-harness default | Reason |
|---|---|---|---|
| CDP port | `9235` | `9224` | Never attach to the daily Chrome accidentally. |
| Profile | `%LOCALAPPDATA%/AXSDKPlaygroundChromeProfile` | `%LOCALAPPDATA%/AXSDKSitesChromeDevProfile` | Isolate extension stores, login state, and test history. |
| Home | `https://axsdk.ai/` | site-specific | Stable test surface. |
| Browser mode | headed | headed | Human can inspect/login/debug the real extension. |
| Extension build | current `AXSDK_EXTENSION_PATH` default | same | Test the local unpacked extension build. |
| Sites index | persisted workspace `index.md` | remote GitHub index | Host/domain resolution follows the test workspace. |

`launchChrome` already launches headed Chrome because it supplies no headless flag. The playground uses the same required CDP flags as the live harness, including `--remote-allow-origins=*`, and must never use `--enable-unsafe-extension-debugging`.

### Ownership guard

Before any store write, the CLI checks all of the following:

1. Its resolved port is not the live-harness port unless `--allow-shared-profile` is explicitly supplied.
2. Its resolved profile is not the live-harness profile unless `--allow-shared-profile` is explicitly supplied.
3. A running Chrome endpoint either has a matching playground ownership stamp or is a newly created empty dedicated profile.
4. The expected extension context and extension ID are present.

The playground writes an explicit ownership/provenance record:

```text
chrome.storage.local["axsdk:playground"] = {
  version: 1,
  sourceDigest: <sha256 of canonical index + empty-widget policy + ordered layer manifest>,
  indexDigest: <sha256 of raw index.md>,
  widgetsDigest: <sha256 of canonical empty widgets envelope>,
  indexDomains: <count>,
  layers: {
    ":": { flowsDigest: <sha256>, luaDigest: <sha256> },
    ":amazon": { flowsDigest: <sha256>|null, luaDigest: <sha256>|null },
    ...
  },
  home: "https://axsdk.ai/",
  writtenAt: <timestamp>
}
```

A profile with a nonmatching stamp is refused by default. `--adopt` is an explicit, noisy one-time override for a dedicated profile. It is not a shortcut around the live-profile guard.

The browser process is detached, like `ax chrome`; `.quit` detaches from it rather than closing it. `.stop` is an explicit command and is allowed only for a profile verified by the playground stamp.

## CLI contract

The default command is the managed `repl`, with the workspace root resolved from the current directory:

```text
cd playground
node ../tools/playground.mjs
```

The explicit equivalent is:

```text
cd playground
node ../tools/playground.mjs repl
```

Without `--no-sync`, `repl` performs the full bootstrap before it prints a prompt: validate local `index.md`, `_common`, and all site layers; launch/attach safe Chrome; replace the canonical local-index, Lua, flow, and empty widget maps; cold-reload the extension; open home; verify the common layer and local index; then wait for commands. There is no separate `start` command.

For a new development profile, run `setup` first. It creates the dedicated profile directory without
clearing an existing profile, launches **headed** Chrome without `--load-extension`, opens
`chrome://extensions`, and waits for the user to install the unpacked extension, configure it, and
enable Debug logging. It does not read, print, or write credentials or extension configuration.

Implementation layout:

```text
tools/playground.mjs             # CLI entry and argument parsing
tools/playground/sources.mjs     # index parser/local document, layer discovery, YAML/Lua bundles, digests
tools/playground/store.mjs       # stored-runtime write/read/verification
tools/playground/runtime.mjs     # re-entrant local site-activation checks
tools/playground/setup.mjs       # non-destructive profile initialization and manual setup wait
tools/playground/repl.mjs        # interactive command parser/dispatcher
tools/playground/*.test.mjs      # deterministic parser/store/setup/runtime/REPL coverage
playground/                      # user-authored source root; created only by implementation/init
```

`tools/playground.mjs` imports `tools/harness/cdp.mjs`. It must not copy WebSocket, Chrome, extension-context, or flow-polling logic.

### Top-level commands

| Command | Behavior |
|---|---|
| `repl` | **Default.** Validate the local index and all source layers, launch/attach safe Chrome, synchronize stores, reload extension, open home, verify, and enter the REPL. With `--no-sync`, attach only to an already stamped runtime and do not write stores. |
| `sync` | One-shot local-index plus all-layer source-to-store synchronization, extension reload, and home navigation; no REPL. |
| `status` | Print profile/port/home, provenance digest, local-index digest/domain count, empty-widget policy digest, every stored layer key/digest, active site domain, active URL, and command-source classification. |
| `reset` | With `--yes`, delete the dedicated profile's `axsdk:sites`, `axsdk:lua`, `axsdk:flows`, `axsdk:widgets`, `axsdk:playground`, and `axsdk:extension:config` records; reload the extension and return home. |
| `init` | Create the minimal layered workspace skeleton only if the target directory is empty or explicitly selected. |
| `setup` | Create the dedicated profile directory without deleting existing contents; launch headed Chrome without loading the extension, open `chrome://extensions` plus home, and wait for manual unpacked-extension installation/configuration and Debug logging. It never writes extension settings. |

Shared flags:

```text
--root=PATH                 Layered source workspace; default current working directory
--port=9235                 Dedicated CDP port
--profile=PATH              Dedicated Chrome user-data-dir
--chrome=PATH               Chrome executable
--extension=PATH            Unpacked extension build
--extension-id=ID           Expected extension ID
--home=URL                  Override default home
--timeout=MS                Direct command or flow wait deadline
--no-launch                 Refuse rather than launch Chrome
--no-sync                   With default/explicit repl, attach/open/verify saved state only
--adopt                     Explicitly stamp an otherwise safe, existing profile
--allow-shared-profile      Explicit dangerous override; never implied
--yes                       Confirm noninteractive `reset` or `stop`; no effect otherwise
```

### REPL commands

The REPL never retains a page WebSocket across `.reload`. Each command acquires a fresh session through the shared harness and closes it afterward. This makes an extension reload or full document navigation nonfatal.

| REPL command | Behavior |
|---|---|
| `.help` | Print exact syntax, current layer rules, and safety notes. |
| `.reload` / `.sync` | Re-read `index.md`, `_common`, and every site layer; replace the canonical local-index, Lua, flow, and empty widget maps; reload extension; open home; and verify. This is the normal edit-test loop. |
| `.ext-reload` | Reload the extension and reopen home using the existing stored sources; no disk read/write. |
| `.page-reload` | Reload only the active page; does not refresh extension stores. |
| `.home` | Navigate the active tab to configured home, where only the common layer is active. |
| `.open <url>` | Navigate to an explicit HTTP(S) URL. At a host resolved by stored local `index.md`, wait for current-site detection and report `stored-lua:<domain>` when the workspace supplies that Lua layer; otherwise report common-only activation. |
| `.send <text>` | Exercise the real flow engine through `sendMessage`; print text and tool parts. |
| `.run <AX_command> [json]` | Durable direct Lua command via shared `run`. |
| `.call <AX_command> [json]` | Single-turn Lua call via shared `call`. |
| `.page` | Print current URL, active domain, and a bounded situational read. |
| `.ls` | Print Lua commands, their script-source classification, and the active common/site layer IDs. |
| `.status` | Print extension/runtime/store/provenance diagnostics. |
| `.sources` | Print the parsed local index entries plus the common layer and every discovered site layer, lexical file order, byte sizes, store keys, and digests without touching Chrome. |
| `.clear` | Explicitly confirmed alias for top-level `reset`. |
| `.quit` / `.exit` | Detach from Chrome and end the CLI. |
| `.stop` | Explicitly close only a verified playground Chrome process. |

`.reload` is intentionally stronger than a page refresh. It must execute the entire persisted-store cold-start sequence, because same script IDs can otherwise remain sticky in the runtime. Navigating with `.open` is intentionally weaker: it leaves stores unchanged and lets normal SDK site detection activate the matching saved site layer.

## Source-to-store protocol

### 1. Preflight before browser mutation

The CLI completes all local work before it starts Chrome or mutates extension storage:

1. Resolve and validate the layered source root.
2. Require and parse root `index.md` into canonical hostname/domain entries with core-parser parity, and reject a UTF-8 document larger than 256 KiB before Chrome is touched.
3. Require and parse `_common/flows.yaml` as YAML.
4. Discover `_common/scripts/*.lua` and each direct site layer; parse every present `<site>/flows.yaml`.
5. Require each discovered site-layer domain to appear in the parsed local index.
6. Build one wrapped Lua bundle per layer, keeping `_common` and site source files independent and in lexical order.
7. Produce canonical sorted `lua` and `flows` maps keyed by `":"` and `":<domain>"`, one canonical local sites-index document with `sites: {}`, and an empty V1 widgets map.
8. Compute the raw-index digest, per-layer YAML/Lua digests, and one canonical aggregate source digest.
9. Refuse malformed, duplicate, missing, ambiguous, nested, or non-UTF-8 source before starting Chrome or modifying storage.

### 2. Safe browser attachment

1. Resolve playground-specific options before calling `resolveOptions`; never inherit `ax`'s port/profile defaults silently.
2. Ensure Chrome is running or launch the dedicated headed profile.
3. Attach through `attachActive`, allowing a blank tab on first launch.
4. Verify the AXSDK Assistant context can be found.
5. Inspect the ownership stamp and refuse untrusted/shared profiles unless the user provided the explicit guard override.

### 3. Write exactly the discovered index and layer maps

The CLI reads existing extension config, then makes one `chrome.storage.local.set(...)` call after all preflight succeeds. It writes:

```text
axsdk:sites = JSON.stringify({
  state: {
    index: {
      source: "local",
      indexUrl: "",
      indexMd: <raw index.md>,
      loadedAt: <timestamp>,
      commonFlowsYaml: "",
      commonScripts: [],
      commonWidgets: []
    },
    sites: {}
  },
  version: 0
})

axsdk:flows = JSON.stringify({
  state: {
    flows: {
      ":": <raw _common/flows.yaml>,
      ":amazon": <raw amazon/flows.yaml>,
      ":thumbtack": <raw thumbtack/flows.yaml>,
      ...
    }
  },
  version: 0
})

axsdk:lua = JSON.stringify({
  state: {
    lua: {
      ":": <wrapped _common Lua bundle>,
      ":amazon": <wrapped Amazon-only Lua bundle>,
      ":thumbtack": <wrapped Thumbtack-only Lua bundle>,
      ...
    }
  },
  version: 0
})

axsdk:widgets = JSON.stringify({
  state: { widgets: {} },
  version: 0
})

axsdk:extension:config = {
  ...existingConfig,
  remote_sites: false,
  storedFlowsEnabled: true
}

axsdk:playground = <provenance stamp>
```

This is the same canonical local-index shape used by the Extension Options editor. `sites: {}` is intentional: no source loader fabricates site definitions. After a later `.open` reaches an indexed host, core caches that host's empty local definition and applies the stored `":"` and `":<domain>"` layers without a remote fetch.

The source workspace has no widget directory in version 1. Writing an empty `axsdk:widgets` envelope prevents an old dedicated-profile template from becoming an undeclared input after `remote_sites: false` makes stored widgets eligible. A future widget source contract must add widgets to layer discovery, the source digest, and the verifier.

The writer preserves unrelated extension configuration. It need not overwrite `remoteLuaEnabled`, `remoteSiteFlowsEnabled`, or `remoteWidgetsEnabled`: `remote_sites: false` derives effective `remote_lua: false`, `remote_widgets: false`, and `clientFlows.remoteSites: false` at runtime. It does not invoke `buildLua` or write `dist/`; workspace sources are authoritative.

If the storage write fails, the CLI does not reload the extension and reports the current runtime as unchanged.

### 4. Cold reload and activation destination

After the storage write resolves:

1. Invoke the existing `reloadExtension` helper.
2. Pass the configured home URL explicitly so the helper returns to `https://axsdk.ai/` rather than a production site default.
3. Wait for the AXSDK Lua runtime in the fresh content-script context.
4. Navigate/open the configured home if the extension reload selected another target.

At home, the local index deliberately has no `axsdk.ai` entry, so the runtime applies only the stored common layer. The canonical `sites` map remains empty until a later `.open` reaches a hostname defined in local `index.md`; core then creates the local cache on demand. The CLI must not use `loadLocal` for this path: in-memory overrides disappear on navigation and would not exercise the persisted source pipeline being tested.

### 5. Verification gate

A successful `.reload` prints a compact receipt only after all checks pass:

```text
playground ready
  home: https://axsdk.ai/
  index: local=<digest>, <N> domains, remoteSites=false
  common: flows=<digest>, lua=<digest>, N Lua files
  sites source: canonical empty cache; flows=<count>, lua=<count>, widgets=empty
  source mode: remoteLua=false, remoteFlows=false, remoteWidgets=false, storedFlows=true
  active: common-only on axsdk.ai
  commands: stored=<N>, remote=0, local=0
```

The verifier reads the fresh runtime and checks:

1. `AXSDK.config.remote_sites === false`, `AXSDK.config.remote_lua === false`, and `AXSDK.config.remote_widgets === false`.
2. `clientFlows` resolves to `{ remoteSites: false, stored: true }`.
3. `AXSDK.getSitesStore().getState().index.indexMd` hashes to local `index.md`, and its index has `source === "local"` and `indexUrl === ""`.
4. The written `axsdk:sites` envelope is canonical with `sites: {}` immediately after sync. A later local site cache is permitted only after a matching navigation and is excluded from source-map/digest equality.
5. The Lua and flow store key sets exactly equal the discovered layer maps, every stored value hashes to its recorded layer digest, and `axsdk:widgets` is the canonical empty V1 map.
6. `axsdk:playground` has the same aggregate digest, index digest, domain count, and per-layer manifest.
7. On home, `listCommands()` reports common playground commands as `stored-lua:` and no remote or in-memory-local source is active. The active page has the configured home origin after navigation; a same-origin canonical or locale redirect is valid (the current `https://axsdk.ai/` destination resolves to `/en`).

When `.open` lands on a hostname in local `index.md` with a discovered overlay, the activation verifier requires the local index to resolve the expected domain, the runtime-created site definition to have only local empty metadata, and the active site command source to be `stored-lua:<domain>`. If the layer has only flows, it verifies the stored flow key and reports that no site Lua is expected. A local-index site with no workspace overlay is a valid common-only result. If no Lua files exist in `_common`, the common-command source condition is skipped; flow-only/default-tool playgrounds remain valid.

## Persisted index, layer semantics, and host activation

### Persisted map

```text
index.md                    -> axsdk:sites.state.index, with `source:"local"` and `indexUrl:""`
sync-time axsdk:sites        -> `state.sites: {}`
matching indexed host         -> lazy local runtime cache at `axsdk:sites.state.sites[domain]`
_common/flows.yaml          -> axsdk:flows[":"]
_common/scripts/*.lua       -> axsdk:lua[":"]
<site>/flows.yaml           -> axsdk:flows[":<site>"]
<site>/scripts/*.lua        -> axsdk:lua[":<site>"]
V1 workspace widgets        -> axsdk:widgets.state.widgets `{}`
```

The common and site Lua bundles are intentionally distinct. The stored local index resolves the page hostname to a domain; core creates only the empty local cache for that domain, then applies the stored common bundle first and only that domain's stored site bundle. An active site command may therefore intentionally override a common command using the same command name.

### Host behavior in `remote_sites: false` local mode

| Destination | Local-index result | Active Lua | Client-flow layer |
|---|---|---|---|
| `https://axsdk.ai/` or an unlisted host | no domain | `stored-lua:` common layer only | stored common `":"` flow document |
| Host mapped to `amazon` | lazily created `amazon` local definition | `stored-lua:` then `stored-lua:amazon` | stored common `":"` plus stored `":amazon"` overlay |
| Host mapped to another loaded `<domain>` | lazily created `<domain>` local definition | `stored-lua:` then `stored-lua:<domain>` | stored common `":"` plus stored `":<domain>"` overlay |
| Indexed host with no workspace overlay | lazy local definition only | `stored-lua:` common layer only | stored common flow document only |

No remote sites-index, site definition, sitemap, site knowledge, remote flow, remote Lua, or remote widget fetch participates in this path. This is the isolated playground's persisted source model; `remote_sites: true` preserves the local index in storage while retaining the normal remote runtime behavior used by existing `ax`.

### Later: explicit SDK test-host adapter

If a test genuinely requires a synthetic site layer on `axsdk.ai` -- for example `axsdk:lua[":playground"]`, a synthetic site flow overlay, `currentSite`, or site memory scope -- add a first-class test-only SDK configuration rather than adding `axsdk.ai` to the local index:

```text
playgroundHost: "https://axsdk.ai/"
playgroundDomain: "playground"
```

The SDK adapter would map only that configured host to the synthetic domain and apply stored `":playground"` Lua/flow entries. It must be disabled by default, never change normal remote or local-index resolution, and be covered by SDK tests. It is not required to load and exercise local `index.md`, `_common`, plus real site layers.

## Safety model

1. **Dedicated profile by default.** The CLI rejects the daily live profile/port without a dangerous explicit flag.
2. **Stamped ownership.** No profile is silently adopted or overwritten.
3. **Remote source isolation.** `remote_sites: false` is the master policy: effective remote site flows, Lua, widgets, index, and site-definition resources are off together. The canonical local index, stored Lua, stored flows, and empty V1 widget map are synchronized as one source transaction.
4. **No secrets in workspace.** Profile/login state stays outside the repository. The CLI does not read, print, copy, or persist cookies, tokens, headers, passwords, or `.env` contents.
5. **No automatic mutations.** Startup, reload, and REPL refresh commands never call `AX_add_to_cart`, `AX_checkout`, `AX_submit_quote`, or form-submit commands. Direct calls remain intentional user input.
6. **Explicit destructive actions.** Top-level `reset`/`stop` require `--yes`; REPL `.clear`/`.reset`/`.stop` require a typed confirmation. `--adopt` and `--allow-shared-profile` are explicit dangerous flags.
7. **No command injection.** REPL dispatches a fixed command grammar; arguments to `.run` / `.call` are JSON, not shell text.
8. **No stale context reuse.** Reattach per REPL operation after reloads/navigations.
9. **No persistent terminal logs by default.** Flow replies/tool output can contain user-provided text, so diagnostics print to the terminal only unless a later redacted logging design is approved.

## Test strategy

### Pure Node playground tests

Extract source and command parsing into pure modules and cover:

1. required root `index.md` and `_common/flows.yaml`; core-line-parser parity for HTTP(S) hostname links, domain-link/title fallback, and hostname aliases; conflicting duplicates; rejected `axsdk.ai`; UTF-8 256 KiB enforcement; and rejection when a discovered site layer is absent from the index;
2. optional common/site Lua, optional site flow overlays, reserved-directory exclusion, direct-only site discovery, path containment, UTF-8 errors, lexical ordering, per-file Lua wrapping, and the invariant that site bundles never prepend `_common`;
3. generation of the canonical `source: "local"` / `indexUrl: ""` sites document with `sites: {}`, an empty V1 widgets envelope, plus `":"` and `":<domain>"` Lua/flow maps; omission of absent optional artifacts; and rejection of nested/ambiguous paths;
4. stable source/index/layer/aggregate digest validation, generated lazy-site-cache acceptance, and YAML syntax rejection before any CDP/store action;
5. default `repl` command parsing, closed-input handling, `--no-sync`, JSON argument validation, confirmation requirements, and no shell execution;
6. non-destructive profile initialization plus manual extension-setup retry/cancellation behavior;
7. ownership-guard decisions for live/default/dedicated/adopted profiles.

### SDK/extension local-index policy tests

The delivered sibling SDK policy is a hard prerequisite for the playground and must retain focused coverage:

1. `remote_sites: true` remains the default, exposes no persisted `axsdk:sites` payload to the core runtime, and makes writes/removes to that key no-ops so remote runtime state cannot overwrite a saved local index;
2. `remote_sites: false` rehydrates only the canonical local document (`source: "local"`, empty `indexUrl`, string `indexMd`); a missing, remote, or malformed persisted index reports the local-index error rather than using a remote fallback;
3. current-site refresh against a valid local index resolves hostname/domain mapping, lazily creates the empty local definition without any sites-resource request, and applies stored `":"` plus `":<domain>"` Lua/flow layers;
4. the master policy forces effective remote client flows, Lua, and widgets off even when the individual persisted remote toggles are true, while saved flows remain selectable;
5. index change detection reacts only to `source`, `indexUrl`, `indexMd`, and `loadedAt`; a `sites[domain]` cache update does not cause a rehydration/render loop;
6. the Options helpers read/write/delete only the canonical local document and reject index Markdown over 256 KiB;
7. normal remote extension configuration and the existing `ax` harness retain their current remote behavior.

### Mocked CDP/store tests

Use a fake `callInAxContext`/storage adapter to assert:

1. generated `axsdk:sites`, `axsdk:flows`, `axsdk:lua`, and `axsdk:widgets` envelopes contain exactly the canonical local index with `sites: {}`, the discovered common/site keys, and the empty V1 widget map;
2. a subsequent sync removes a stale prior `":<domain>"` layer, lazy local site cache, and stored widget template instead of leaking any into the next test;
3. `remote_sites: false` and stored flows are forced while unrelated extension config remains; individual remote-layer toggles may be preserved because the master policy makes them ineffective;
4. the provenance stamp records the same index, per-layer, widget-policy, and aggregate digests that verification expects;
5. extension reload happens only after a successful all-store write, and a failed write leaves the current runtime untouched;
6. home verification accepts only common-layer activation, while local-index site verification requires the matching lazy local definition and `stored-lua:<domain>` source or a declared flow-only layer;
7. `.reload` obtains a fresh session after extension reload.

### Headed extension smoke test

With a dedicated test profile and a layered fixture workspace:

1. provide a minimal local `index.md`, `_common` ping command/flow, and a mapped site's ping command/flow; invoke `node ../tools/playground.mjs` with no subcommand and confirm that it synchronizes then enters the REPL;
2. verify `axsdk:sites` has `source: "local"`, `indexUrl: ""`, the local index digest, and initial `sites: {}`; verify `remote_sites` is false and no remote sites resource is requested;
3. verify `_common` `AX_playground_common_ping` is sourced from `stored-lua:` on `axsdk.ai`;
4. use `.open` on a non-mutating canonical URL mapped by the local index, wait for current-site detection, verify the runtime lazily created only the empty local definition, and verify the site ping command comes from `stored-lua:<domain>`;
5. force a document navigation and an extension reload, then prove the same local index still resolves the domain, preserves the local-index fingerprint, and applies the stored site layer without remote resources;
6. edit `index.md`, one common artifact, and one site artifact; invoke `.reload`; prove index/layer digests and live command values all change without stale state;
7. invoke `.home` and verify that the active page returns to the configured `axsdk.ai` origin with only the common Lua layer active.

A real `.send` flow test is optional in this smoke suite because it depends on a configured backend/session. When configured, run it once at `axsdk.ai` for common flows and once on a local-index-mapped site for common-plus-site flow merging. Direct Lua testing remains independent of model/backend availability.

## Implementation sequence

1. Require the sibling SDK/extension build that implements the `remote_sites` master policy; before depending on it, prove through the focused tests that `remote_sites: false` rehydrates canonical local indices and blocks all remote site resources.
2. Add a pure playground index parser with parity fixtures for the current core semantics. Keep it isolated behind a small module so a future public core parser export can replace it without changing source discovery.
3. Add pure playground index/source/manifest/bundle modules and their tests.
4. Extract a generic stored runtime writer/verifier from `syncStore` into `tools/harness/cdp.mjs` or a focused harness sibling. It must write/verify canonical sites, Lua, flows, empty V1 widgets, and the `remote_sites` config without changing `syncStore` behavior.
5. Implement dedicated playground option resolution, ownership stamp guard, canonical local-index/layer digests, and V1 widget clearing.
6. Implement the one-shot `sync` path for `index.md`, `_common`, plus every discovered site layer.
7. Implement default managed `repl` and its fresh-session command loop.
8. Add local-index active-domain verification to `.open`, `.ls`, `.page`, and `.status`, distinguishing source state from lazy site cache.
9. Add `sources`, `reset`, and guarded `stop`.
10. Add fixture-based headed index/common/site smoke coverage.
11. Update `DEVTOOLS.md` with the playground lifecycle only after the implementation passes its smoke test.

## Acceptance criteria

The playground is complete when all of the following are demonstrably true:

1. `cd playground && node ../tools/playground.mjs` opens a headed, dedicated-profile Chrome on `https://axsdk.ai/`, synchronizes the workspace by default, and enters a REPL.
2. The source loader requires and parses root `index.md`, `_common/flows.yaml`, `_common/scripts/*.lua`, and every eligible immediate site directory's `flows.yaml`/`scripts/*.lua` in deterministic lexical order.
3. The CLI rejects malformed/conflicting index entries, an index over 256 KiB, `axsdk.ai` as a local-index host, and any discovered site layer missing from the local index.
4. `axsdk:sites` persists the exact local index text in the canonical `source: "local"` / empty-`indexUrl` envelope with initial `sites: {}` across document navigation and extension reload while `remote_sites: false`; no remote sites resource fetch occurs.
5. Store state contains the canonical empty static sites/widgets maps, `":"` common entries, and discovered `":<domain>"` site entries; a later sync removes stale maps and caches, while a post-navigation lazy site cache is not treated as source state.
6. On `axsdk.ai`, common commands show `stored-lua:` as their source, remote Lua/widget/flow sources are absent, and common stored flows are active.
7. After `.open` reaches a hostname mapped by local `index.md`, its Lua commands show `stored-lua:<domain>`, its stored flow overlay is available with the common layer, and the matching empty local definition was created without remote site resources.
8. Editing `index.md`, common YAML/Lua, or site YAML/Lua, then entering `.reload`, results in a cold extension reload with matching index, per-layer, widget-policy, and aggregate digests.
9. `.run`, `.call`, `.send`, `.page`, `.status`, `.open`, `.ext-reload`, and `.reload` survive document/extension reloads without stale-CDP failures.
10. The CLI refuses the live profile/port and non-playground-stamped profile by default.
11. No playground operation writes to the normal `ax` profile, pushes source files, or requires secrets in the source workspace.
