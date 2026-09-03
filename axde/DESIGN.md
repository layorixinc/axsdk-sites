# AXSDK Dev Env (`axde`) — staged design

A terminal app for developing and debugging **Agent Packs**: profiles, builds, pack lifecycle, live
turns, and traces in one place, on one screen, without hand-written CDP probes.

Why it exists, stated as measurement rather than preference: the X0–X6 work spent most of its wall
time on things a dev environment owns — a fresh profile that needs developer mode before the
Allow-User-Scripts toggle, a service worker that fails to register and says so only in
`chrome_debug.log`, a restored extension tab that is a dead document, a pack lifecycle driven by
hand-typed `chrome.runtime.sendMessage` payloads from an options page found over CDP, and traces
read by parsing `s<group>:axsdk:chat` out of `chrome.storage`. Every one of those is a repeatable
operation. `axde` is where they live.

## 1. Non-negotiables

1. **Zero runtime dependencies.** This repo has none (`fengari` and `yaml` are devDependencies), and
   a TUI framework would add a build step, a second event model, and a React reconciler to a screen
   that is a list, a menu, and a log pane. Raw ANSI + `readline` in raw mode is small enough to own.
2. **Pure core, thin driver.** `reduce(state, event) → { state, effects }` and
   `render(state, size) → string[]` are pure and unit-tested with no terminal and no browser. The
   driver does stdin/stdout and executes effects. This is the same shape as `10_form_wizard.lua` and
   `44_pagination.lua`, for the same reason: the decisions are testable offline and the capability
   layer stays boring.
3. **Never reimplement the SDK's primitives.** `chromeCandidates`, `profileDir`, `chromeArgs`,
   `extensionIdFromKey`, `fingerprintBuild`, `credentialsFromEnv`, `launchChrome`, `evaluate`,
   `writeConfig` already exist in `axsdk-sdk-js/packages/axsdk-extension-cdp/scripts/`. `axde`
   imports them. Imports flow sites→SDK, never the reverse (the X6 placement rule).
4. **Every operation is also non-interactive.** The TUI is a shell over a command core that a script
   or a gate can call. A screen cannot be asserted; a command can.
5. **No secret ever reaches the screen or a log.** Credentials are seeded from `.env` and the UI
   shows only `credentials: written`. The config store is read by field, never printed whole.
6. **Destructive operations name what they will destroy** and refuse a profile `axde` did not create
   unless forced, because the shared harness profile holds the developer's credentials and chat.

## 2. Layout

```text
axde/
  DESIGN.md · README.md
  src/
    cli.mjs                 # entry: subcommand or TUI
    driver.mjs              # raw mode, alternate screen, resize, restore-on-exit
    core/{keys,state,render}.mjs   # pure: bytes→events, reduce, render
    ops/{profiles,extension,chrome}.mjs  # inventory/lifecycle, decisions, capability adapter
  packs/src/                # the sample packs axde develops against (Lua)
  *.test.mjs                # offline suites (node --test)
  packs/*.test.ts           # sample-pack suites (bun test)
```

Root scripts: `axde`, `test:axde` (`node --test "axde/*.test.mjs"`), and `test:packs` extended to
`bun test tools/packs axde/packs`. `tools/scenarios/runner-contract.test.mjs` walks `axde/` too, so
an unreachable suite here fails the same way it does under `tools/` (the orphan-suite lesson, twice
paid for).

## 3. Stage 1 — profiles and builds — **DONE 2026-09-03**

**Scope:** create and delete Chrome profiles; install, uninstall, and inspect the local extension
build in a chosen profile. Nothing else: no chat turn, no pack lifecycle, no trace view.

### The install mechanism, decided by measurement

The design shipped with this as an open question and answered it by probing; the answer changed the
mechanism:

| measured | consequence |
|---|---|
| CDP `Extensions.uninstall` cleanly removes a `loadUnpacked` install (targets gone, fresh options page blocked, re-install works) | it is the only working *live* removal — `chrome.management.uninstallSelf()` also removes it but destroys the caller mid-call so it can never be awaited, and the WebUI remove button did nothing |
| a `loadUnpacked` registration lives only as long as that browser session: install reported success, the browser closed, and the next `ext status` read `installed false` | installing cannot mean `loadUnpacked` |
| `--load-extension` + `--disable-features=DisableLoadExtensionCommandLineSwitch` is durable — present on every later launch, service worker registers | **install = ATTACH the build to the profile** (recorded in `axde-profile.json`); every launch passes the flag |
| a flag-loaded extension CANNOT be removed by CDP `Extensions.uninstall` — "still reachable", every time | **uninstall = detach + relaunch**: starting Chrome without the flag *is* the removal |
| developer mode + the Allow-User-Scripts row PERSIST across a graceful close, and `chrome.userScripts` is there after a restart | the toggles are set once, at install, not on every launch |
| killing the browser loses the registration AND both toggles — Chrome writes `Preferences` during shutdown | `close()` is a graceful `Browser.close` plus a settle, never a kill and never a bare release |

This also RETIRES an X6 note: "`--load-extension` produced no service worker" was measured while the
external pack config was broken (`missing schemaVersion`). With that fixed, the flag path is clean.

### Screen

```text
 AXSDK Dev Env — profiles                                  build: 9f3c2a1e ok
 ┌ profiles ────────────────────────────────────────────────────────────────────────┐
 │ > packdev        axde   chrome up :39701  ext 9f3c2a1e  us on                    │
 │   x6-scratch     axde   chrome down       ext attached                           │
 │   axsdk-extension-cdp   foreign  chrome down       ext —                         │
 └──────────────────────────────────────────────────────────────────────────────────┘
 [n] new  [d] delete  [i] install  [u] uninstall  [r] refresh  [q] quit
```

Attachment is readable from the manifest and costs nothing; the recorded fingerprint and the toggle
state live in the browser, so they are read only for a profile whose browser is already up. A row
nobody read says `attached`, never a fabricated fingerprint — unknown stays unknown.

### Commands (the same core the TUI calls)

```text
axde                                  the TUI
axde profile ls | new <name> [--port <n>] | rm <name> [--force]
axde ext install <profile> [--dist <path>] | uninstall <profile> | status <profile>
```

### Measured acceptance (2026-09-03, one live journey)

```text
profile new packdev             → created (port assigned, manifest written)
ext install packdev             → attached · relaunched · devMode on · allow-user-scripts on
                                  installed 7caf9283 · user scripts on · credentials: written
profile ls                      → packdev  axde  down:57354  ext attached
ext status packdev (new proc)   → installed true · stale false · userScripts true
ext install packdev (again)     → up-to-date   (no relaunch: a relaunch kills a live session)
ext uninstall packdev           → detached · uninstalled, verified absent
ext status packdev              → installed false · attachedDist —
profile rm packdev              → removed; inventory empty
profile rm axsdk-extension-cdp  → refused: axde did not create it (pass --force)
ext install axsdk-extension-cdp → refused: it manages only its own profiles
```

Offline: `npm run test:axde` — 56 tests over the reducer, the renderer at three widths, key decoding,
the profile manifest/inventory, and every extension op against a fake that refuses what the real
thing refuses and persists what it persists.

### Development sample packs — `axde/packs/src/`

The packs `axde` develops AGAINST, authored as Lua like every other pack:

- `dev-echo/task.lua` — `echo` (the marshaling shapes callers get wrong: empty object vs empty list,
  Korean round-trip), `describe_surface` (which prelude APIs are actually present), `fail` (a named
  refusal). Its job is to make a debugging session's failure attributable to the ENVIRONMENT.
- `dev-probe/provider.lua` — reads the page it stands on (url parts, match count, bounded samples),
  so "the provider did not run" and "it ran and matched nothing" stop looking alike.

Both are proven to run through the real wrapper and the real prelude (`npm run test:packs`), and the
suite pins that neither names a click, a write, or a navigation. One finding worth keeping: the
wrapper's static gate refuses forbidden tokens even inside a COMMENT — an earlier version of
`dev-echo`'s own comment listed them and the sample stopped being publishable.

## 4. Later stages (scope sketch, not commitments)

| stage | adds | why it is next |
|---|---|---|
| 2 | launch/attach mode (a browser deliberately left up), live status pane (SW alive, `scriptIds`, session id, tab groups), log tail with filters | every debugging session starts by asking "is the thing I edited the thing that is running" |
| 3 | pack lifecycle pane: registry list, refresh, stage-install with the approval DIFF shown, approve, enable/disable/replace/rollback/remove/reset | X6 drove these by hand-typed payloads; the approval diff is the one screen a reviewer needs |
| 4 | turn console: send an utterance, watch nodes/tool calls/branches stream, expand a tool's args and output | replaces `send` + parsing `:axsdk:chat`, and works around the 4,120-char trace truncation |
| 5 | pack authoring loop: wrap/verify a `.lua` artifact, run it through the packaged prelude, call `pack.catalog`/`pack.invoke`, watch the executor document | the last hand-driven surface after stage 4 |
| 6 | record and replay a session (inputs + effects) so a bug report is a file a gate can replay | a defect nobody can re-run is a defect that gets re-diagnosed |

Each stage gets its own section here, with the same "what it encodes because it was measured" and
"acceptance" pair, written before its code.

## 5. Rules this design deliberately does not bend

- No new dependency without a measurement showing the hand-written version is worse.
- No screen shows a value the user cannot act on; a refusal quotes its raw reason.
- The TUI never becomes the only way to do something — if a screen can do it, a command can too.
- `axde` owns no product behaviour. It drives the extension the way a person does, through the same
  production surfaces, so a green screen here is evidence about the product and not about `axde`.
