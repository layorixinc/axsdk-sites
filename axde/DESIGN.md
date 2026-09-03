# AXSDK Dev Env (`axde`) — staged design

A **bun** terminal app for developing and debugging **Agent Packs**: profiles, builds, pack
lifecycle, live turns, and traces in one place, on one screen, without hand-written CDP probes.

Why it exists, stated as measurement rather than preference: the X0–X6 work spent most of its wall
time on things a dev environment owns — a fresh profile that needs developer mode before the
Allow-User-Scripts toggle, a service worker that fails to register and says so only in
`chrome_debug.log`, a restored extension tab that is a dead document, a pack lifecycle driven by
hand-typed `chrome.runtime.sendMessage` payloads from an options page found over CDP, and traces
read by parsing `s<group>:axsdk:chat` out of `chrome.storage`. Every one of those is a repeatable
operation. `axde` is where they live.

## 1. Non-negotiables

1. **Bun is the runtime, TypeScript is the source.** `bun axde/src/cli.ts` and `bun test axde`, no
   build step. This is not a taste: from stage 3 on, `axde` must import the SDK's own TypeScript —
   the pack schemas, `fetchVerifiedPackRelease`, the Lua prelude — the way `tools/packs/*.ts`
   already does, and node cannot load those without a compile step nobody should own.
2. **Zero runtime dependencies.** This repo has none (`fengari` and `yaml` are devDependencies), and
   a TUI framework would add a bundler, a second event model, and a React reconciler to a screen
   that is a list, a menu, and a log pane. Raw ANSI + raw-mode stdin is small enough to own.
3. **Pure core, thin driver.** `reduce(state, event) → { state, effects }` and
   `render(state, size) → string[]` are pure and unit-tested with no terminal and no browser. The
   driver does stdin/stdout and executes effects. This is the same shape as `10_form_wizard.lua` and
   `44_pagination.lua`, for the same reason: the decisions are testable offline and the capability
   layer stays boring.
4. **Never reimplement the SDK's primitives.** `chromeCandidates`, `profileDir`, `chromeArgs`,
   `extensionIdFromKey`, `fingerprintBuild`, `credentialsFromEnv`, `launchChrome`, `evaluate`,
   `writeConfig` already exist in `axsdk-sdk-js/packages/axsdk-extension-cdp/scripts/`. `axde`
   imports them. Imports flow sites→SDK, never the reverse (the X6 placement rule).
5. **Every operation is also non-interactive.** The TUI is a shell over a command core that a script
   or a gate can call. A screen cannot be asserted; a command can.
6. **No secret ever reaches the screen or a log.** Credentials are seeded from `.env` and the UI
   shows only `credentials: written`. The config store is read by field, never printed whole.
7. **Destructive operations name what they will destroy** and refuse a profile `axde` did not create
   unless forced, because the shared harness profile holds the developer's credentials and chat.

### Testing: the bun runner, `node:assert` assertions

Suites are `bun:test` files that assert with `node:assert/strict`. Bun runs both, measured. The
reason is not nostalgia: the 56 core assertions each pin a measured contract (an exact effect list,
an exact refusal, an exact rendered row), and rewriting them into `expect` would have been 56
opportunities to weaken one for no gain. New assertions may use either; the sample-pack suite under
`packs/` uses `expect`, which reads better for object shapes.

## 2. Layout

```text
axde/
  DESIGN.md · README.md
  src/
    cli.ts                  # entry: subcommand or TUI
    driver.ts               # raw mode, alternate screen, resize, restore-on-exit
    core/{keys,state,render}.ts    # pure: bytes→events, reduce, render
    ops/{profiles,extension,chrome}.ts  # inventory/lifecycle, decisions, capability adapter
  packs/src/                # the sample packs axde develops against (Lua)
  *.test.ts                 # offline suites (bun test)
  packs/*.test.ts           # sample-pack suites (bun test)
```

Root scripts: `axde` (`bun axde/src/cli.ts`) and `test:axde` (`bun test axde`, which covers the
sample packs too — `bun test <dir>` is recursive). `test:packs` stays the product packs
(`bun test tools/packs`). `tools/scenarios/runner-contract.test.mjs` walks `axde/` as a second root
and accepts a `bun test` command naming any ANCESTOR directory, so an unreachable suite here fails
the same way it does under `tools/` (the orphan-suite lesson, twice paid for) — mutation-checked by
deleting `test:axde` and watching the gate go red.

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
bun axde/src/cli.ts                       # or: npm run axde
axde profile ls | new <name> [--port <n>] | rm <name> [--force]
axde ext install <profile> [--dist <path>] | uninstall <profile> | status <profile>
```

### Measured acceptance (2026-09-03, one live journey — re-run under bun after the migration)

```text
profile new packdev             → created (port assigned, manifest written)
ext install packdev             → attached · relaunched · devMode on · allow-user-scripts on
                                  installed 7caf9283 · user scripts on · credentials: written
profile ls                      → packdev  axde  down:61077  ext attached
ext status packdev (new proc)   → installed true · stale false · userScripts true
ext install packdev (again)     → up-to-date   (no relaunch: a relaunch kills a live session)
ext uninstall packdev           → detached · uninstalled, verified absent
ext status packdev              → installed false · attachedDist —
profile rm packdev              → removed; inventory empty
profile rm axsdk-extension-cdp  → refused: axde did not create it (pass --force)
ext install axsdk-extension-cdp → refused: it manages only its own profiles
```

Offline: `npm run test:axde` — **70 tests** (56 over the reducer, the renderer at three widths, key
decoding, the profile manifest/inventory, and every extension op against a fake that refuses what
the real thing refuses and persists what it persists; 6 over the driver — alternate screen and raw
mode both restored, busy painted WHILE an operation runs, a thrown operation becoming a readable log
line, an idle poll writing no frames, and a non-TTY invocation refusing BY NAME instead of hanging
forever — measured: it used to take the alternate screen and poll an input that never arrives; and 8
for the sample packs).

### Development sample packs — `axde/packs/src/`

The packs `axde` develops AGAINST, authored as Lua like every other pack:

- `dev-echo/task.lua` — `echo` (the marshaling shapes callers get wrong: empty object vs empty list,
  Korean round-trip), `describe_surface` (which prelude APIs are actually present), `fail` (a named
  refusal). Its job is to make a debugging session's failure attributable to the ENVIRONMENT.
- `dev-probe/provider.lua` — reads the page it stands on (url parts, match count, bounded samples),
  so "the provider did not run" and "it ran and matched nothing" stop looking alike.

Both are proven to run through the real wrapper and the real prelude, and the suite pins that neither
names a click, a write, or a navigation. One finding worth keeping: the wrapper's static gate refuses
forbidden tokens even inside a COMMENT — an earlier version of `dev-echo`'s own comment listed them
and the sample stopped being publishable.

## 4. Stage 2a — a controllable headed browser — **DONE 2026-09-04**

Stage 1's browser is a TOOL: every operation launches Chrome, does one thing, and closes it
gracefully so `Preferences` reach disk. Pack development needs the opposite lifetime — a headed
browser that STAYS UP on a dev profile, with the build loaded, a debugging port open and the
user-scripts row on, so the developer can click through it and later stages can attach to it.

So this stage adds exactly two operations: `launch` starts that browser and RETURNS while it keeps
running, and `stop` ends it the way stage 1 established.

### The spawn, measured — including the part that refuted the first version of this section

(2026-09-04, Chrome 151.0.7922.34, Windows 11, bun 1.3.14.)

`launchChrome` spawned Chrome ATTACHED and stated why in its own comment: `detached: true` was tried
so an exiting launcher could leave the browser up, "and on Windows it left the shell pipeline open
instead". Four combinations through that same function — the launcher's wall time, then the port
asked again from a NEW process three seconds after it was gone:

|spawn|launcher|browser afterwards|
|---|---|---|
|attached, no `unref()`|**never returned** (killed at 12 s)|died with the killed launcher|
|attached + `child.unref()`|returned in 0 s|**died**|
|`detached: true` (+ `unref()`)|**returned in 0 s**|**survived**|
|`detached: true` + a second `unref()`|returned in 0 s|survived|

So the old note was the MISSING `unref()`: a referenced child handle holds the event loop open —
§13 records the same shape for the commerce sweep, where an attached Chrome kept an already-finished
runner alive for 40 minutes. `launchChrome` therefore grew an opt-in `detached` that does both, and
the harness keeps its attached default: a one-shot command wants a browser that cannot outlive it.

**What refuted the first draft of this section.** It claimed "both halves are required and neither
is sufficient", and the live gate then PASSED with `detached: false` — 21 of 21 checks, including
"the browser outlived the command". Measured again straight through the CLI, an attached launch
returned in 5 s and its browser survived too. Two live measurements of one mechanism disagree, so
per §13 neither is the contract, and nothing here is keyed on their agreement: `detached: true` is
kept because it is the only configuration that survived in EVERY measurement and because it states
the intent to the OS instead of relying on how a runtime reaps subprocesses. The consequence for the
gate is recorded rather than hidden — mutating `detached` alone does NOT turn it red, while making
`launch` close what it started fails it at the fourth check, which is the property it exists to
defend.

### What `launch` decides

- **Reuse, never relaunch.** The launcher probes the port first, so a second `launch` attaches to
  the running browser and answers `already-running`. That is not an optimization: a relaunch kills
  whatever session the developer is looking at (the §13 reload lesson), and the one command whose
  whole purpose is "leave it up" must not be the one that takes it down.
- **It reports, it does not repair.** Extension presence and `chrome.userScripts` are READ and
  named; when the row is off the answer says so and names `ext install` as the fix. `install` stays
  the single writer of toggles — two writers of one setting is how a setting stops meaning anything.
- **A profile `axde` did not create is refused unless forced**, and the reason is mechanical rather
  than protective: two Chromes on one profile directory are not two browsers. The second process
  hands off to the first and exits immediately (the launcher's own measurement), so launching the
  shared harness profile either joins a session `axde` does not own or waits out a port that will
  never open.
- **The record is a convenience; the PORT is the authority.** `launch` writes `running: {pid, port,
  startedAt}` into the profile manifest for the row to print and for `stop` to quote, and nothing
  reads it to decide whether a browser is up — a pid outlives its process, an answering port does
  not.
- **A start URL is applied on both paths or the flag would be a lie**: at spawn it rides
  `chromeArgs`, and on a reused browser it opens a tab.

### What `stop` decides

`Browser.close`, then the port must go quiet — a browser still answering is a FAILURE, not a
success, and saying "stopped" while it runs is the false-positive class §13 keeps finding in cart
adds. It exists so a developer never has to kill a browser: killing loses developer mode and the
Allow-User-Scripts row, because Chrome writes `Preferences` during shutdown (stage 1). A profile
whose port is already quiet answers `already-stopped` and clears a stale record.

### Screen and commands

```text
 [n]ew [d]elete [i]nstall [u]ninstall [l]aunch [s]top [r]efresh [q]uit

axde launch <profile> [--url <u>] [--force]      # headed, stays up after the command returns
axde stop   <profile>                            # graceful close, so the toggles survive
```

`launch` and `stop` are refused on a foreign profile from the screen, where there is no `--force`.

### The defect this stage exposed in stage 1: a READ was destructive

`launch` is the first operation that leaves something behind, and it immediately found that
`profile ls` **killed** it. The inventory reads the recorded fingerprint and the toggle state
through a browser session, and stage 1's every operation ended with a graceful `Browser.close` —
which was harmless while nothing was ever left running. Measured: `launch` → port alive → `profile
ls` reported the row `up` → **port DEAD**, and the next `launch` then found a dead port and quietly
spawned a second Chrome.

So the adapter has a third ending. `finish()` means "leave it as you found it": release when the
browser was already running, close when this process launched it. Only the READS use it — `install`
and `uninstall` must relaunch anyway, and they still close so `Preferences` reach disk.

**The journey hid it for one run.** The first version printed the second launch's outcome instead of
asserting it, so a line reading `launched … pid 43796` where `already-running` was required went
straight past. That is why the acceptance below is a runnable gate rather than a transcript.

### Measured acceptance — `npm run test:axde:live`

`axde/live/stage2a.ts`: 21 checks, ~23 s, on a throwaway profile root, through the same subcommands
a developer types.

```text
profile new + ext install    → user scripts on
launch --url                 → launched on :<port> pid <n> · extension up · user scripts on
                               command RETURNS; a NEW process finds the port and the --url tab
profile ls                   → up:<port> pid <n>, and the browser is STILL alive afterwards
ext status                   → userScripts true, and still alive afterwards
launch (again)               → already-running, no second pid, recorded pid untouched
stop                         → stopped; the port goes quiet; the record is cleared
stop (again)                 → already-stopped
ext status                   → userScripts true — the graceful stop kept both toggles
launch/stop <foreign>        → refused BY NAME, exit code 1
profile rm                   → the inventory is empty again
```

Offline: `npm run test:axde` — **89 tests** (the 70 from stage 1 plus 19: the launch/stop decisions
against a fake that records every call, the two record-writing calls carrying the profile NAME, the
non-destructive read in both directions, the launch/stop keys and their foreign-profile refusal, and
every key readable at 80 columns).

Two bugs the offline suite could not have caught, both found by the live gate on its first run: the
destructive read above, and a `stop` that reported success while leaving the record — the adapter had
no session on that path, so the profile name was `undefined` and a `.catch(() => {})` I had written
swallowed the refusal. The name travels WITH the call now, and there is no catch.

## 5. Later stages (scope sketch, not commitments)

| stage | adds | why it is next |
|---|---|---|
| 2b | live status pane (SW alive, `scriptIds`, session id, tab groups) and a log tail with filters, over the browser stage 2a leaves up | every debugging session starts by asking "is the thing I edited the thing that is running" |
| 3 | pack lifecycle pane: registry list, refresh, stage-install with the approval DIFF shown, approve, enable/disable/replace/rollback/remove/reset | X6 drove these by hand-typed payloads; the approval diff is the one screen a reviewer needs |
| 4 | turn console: send an utterance, watch nodes/tool calls/branches stream, expand a tool's args and output | replaces `send` + parsing `:axsdk:chat`, and works around the 4,120-char trace truncation |
| 5 | pack authoring loop: wrap/verify a `.lua` artifact, run it through the packaged prelude, call `pack.catalog`/`pack.invoke`, watch the executor document | the last hand-driven surface after stage 4 |
| 6 | record and replay a session (inputs + effects) so a bug report is a file a gate can replay | a defect nobody can re-run is a defect that gets re-diagnosed |

Stages 3–5 are where non-negotiable 1 pays for itself: each imports SDK TypeScript directly.
Each stage gets its own section here, with the same "what it encodes because it was measured" and
"acceptance" pair, written before its code.

## 6. Rules this design deliberately does not bend

- No new dependency without a measurement showing the hand-written version is worse.
- No screen shows a value the user cannot act on; a refusal quotes its raw reason.
- The TUI never becomes the only way to do something — if a screen can do it, a command can too.
- `axde` owns no product behaviour. It drives the extension the way a person does, through the same
  production surfaces, so a green screen here is evidence about the product and not about `axde`.
