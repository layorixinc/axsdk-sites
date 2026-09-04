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
  workspace/                # axde's OWN workspace: index.md, _common/{flows.yaml,scripts,rpc}, dev/
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

### Screen — **superseded by §5** (kept as the record of what stage 1 shipped)

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

## 5. Stage 2b — the TUI is a slash-command console — **DONE 2026-09-04**

Stages 1 and 2a drove the screen with single keys over a permanent profile table: `j`/`k` moved a
cursor, `i`/`u`/`l`/`s` acted on whatever row it sat on, and the table was refreshed after every
operation. That is replaced — the screen is now a TRANSCRIPT plus one input line, and every
operation is a slash command typed into it. The profile list is no longer a pane; `/profiles` asks
for it and the answer is printed like any other answer.

```text
AXSDK Dev Env   build: 7caf9283 ok

  try /help for the vocabulary; /profiles for what is on this machine.
› /profiles
  packdev              axde    chrome up :51496 pid 35472  ext 7caf9283  us on
  axsdk-extension-cdp  foreign chrome down                 ext —         us —
› /launch packdev --url https://www.amazon.com/
  launch packdev: launched on :51496 pid 35472 · extension up · user scripts on
› /instal packdev
✗ unknown command: /instal — try /help

axde › /stop packdev▏
```

**No box, and the prompt does not move.** A border around a conversation is furniture: what tells an
answer from the question above it is the marker (`›` typed, `✗` refused, two spaces for an answer),
which costs no columns and cannot be mistaken for structure. The transcript is BOTTOM-anchored in
whatever the terminal leaves after the header, one blank line, one blank line and the prompt — so
the newest answer is always the line directly above where you type, and a prompt that wandered as
output arrived would be a prompt the hands have to look for. The banner is one line, because the
header already states what the program is.

### What the target moving from the CURSOR into the COMMAND removes

The old model kept the target in the selection, and three separate mechanisms existed only to make
that safe. All three are deleted, not ported:

- **The confirm-by-retyping prompt.** `d` asked for the profile name to be typed back because the
  cursor could be on the wrong row. `/rm packdev` IS the name typed. The protection that mattered
  stays: a profile `axde` did not create still refuses without `--force`.
- **The screen-has-no-`--force` guard.** `l`/`s` had to refuse a foreign profile outright because a
  keystroke cannot carry a flag. A typed command can: `/launch other --force` reaches the same
  decision layer as the shell, so the screen and the command have one rule instead of two.
- **The cached inventory.** State held a profiles array plus a cursor, and every operation ended by
  replacing it. Nothing caches it now, so nothing can go stale and no operation owes a refresh.

### What it decides

- **A line must start with `/`.** Bare text is refused BY NAME and points at `/help`, because a
  console that silently ignores what you typed teaches nothing. `/help` is answered by the pure
  reducer — it needs no capability — from the SAME command table the parser and the completer read,
  so the vocabulary cannot drift between what is accepted, what is listed, and what completes.
- **A command with a missing argument is refused with its own usage line**, never treated as a
  no-op: `/install` alone answers ``/install needs a profile: /install <profile>``.
- **Submitting while an operation runs is refused and KEEPS the line.** Two overlapping installs
  drive one browser from two places (the stage-1 rule), but the old screen swallowed the keystroke;
  a console must not eat what you typed.
- **The arrows are history**, because with no list to move through they would otherwise be dead
  keys, and `Tab` completes a command name — a unique prefix completes, an ambiguous one prints the
  candidates, and neither guesses.
- **`Esc` clears the line.** A prompt with no way out is a trap.
- **The transcript is bounded** (200 entries) like the log it replaces, and it is plain text: the
  renderer still emits no SGR codes, so width arithmetic cannot lie.

### The two surfaces keep different spellings and ONE implementation

A prompt reads `/install packdev`; a shell reads `axde ext install packdev`. Both resolve to the same
handler — `runInstall`, `runLaunch`, `runStop`, `inventory`, `createProfile`, `deleteProfile`,
`extensionStatus` — and neither surface carries aliases within itself. The one thing that could drift
is the SET of names, so a test asserts the reducer's command table and the driver's handler table
have identical keys: a command the console offers and nothing performs is a promise the screen cannot
keep.

Program-level flags stay program-level: `--dist` and `--env` are read from argv when `axde` starts,
not per command, so `/install` cannot silently install a different build than the header states.

### Vocabulary

```text
/help                                  /profiles
/new <name> [--port <n>]               /rm <name> [--force]
/install <profile>                     /uninstall <profile>
/status <profile>                      /launch <profile> [--url <u>] [--force]
/stop <profile> [--force]              /quit
```

### Measured acceptance — the program, driven in a real terminal

A screen cannot be asserted by a unit test, so the console was driven in a PTY (2026-09-04) and
every line below is what it printed:

```text
/help              → the vocabulary, one line per command
/profiles          → "no profiles yet — /new <name> creates one"  (empty root)
/new tuidev2       → "created tuidev2 (port 65439)"
/rm tuidev2        → "removed tuidev2"   (no retype prompt: the name is in the command)
/profiles          → empty again
/instal tuidev     → "✗ unknown command: /instal — try /help"
/lau  + TAB        → the line becomes "/launch "
/s    + TAB        → "/status  /stop" printed, the line left at "/s"
UP, UP             → the two previous lines recalled, newest first
/quit              → exit 0, terminal restored
```

One thing that run corrected in the surrounding tooling rather than in `axde`: sending ESC after
the text (the harness writes `keys` after `text`) appended `/rm tuidev` to a recalled `/profiles`,
and the console refused the concatenation as an unknown command — which is the right answer to a
line nobody meant to type.

Offline: `npm run test:axde` — **100 tests**. What this stage owns is the parser and its refusals,
the transcript, history, completion, the busy refusal that KEEPS the line, the renderer at three
widths (no pane, no legend, a prompt that shows its tail), and the `COMMANDS`↔`HANDLERS` key-set
conformance. Mutation-checked: swallowing a busy submit, guessing an ambiguous completion, and
renaming one handler each turn a suite red.

`npm run test:axde:live` keeps its 21 checks; two of its assertions on the SHELL output were
retyped because `profile ls` and `ext status` now print through the same formatter the console
uses (`profileLine`, `statusLines`). That unification is the point — one answer, two surfaces —
and it was an accidental live run that caught the first attempt at it silently not applying.

## 6. Stage 2c — the workspace: local flows, Lua and modules in a profile — **DONE 2026-09-04**

**Scope:** put a working copy's flows, Lua, RPC modules, site index and sitemaps into a profile's
extension stores, take them back out again, and report exactly what would be or was written.
Nothing else: no session, no turn, no pack.

It answers the question every debugging session opens with — *is the thing I edited the thing that is
running* — which `axde` cannot answer today. A profile it sets up carries the PUBLISHED sources, so
editing a flow or a Lua file changes nothing until something delivers it, and the only tools that do
are `npm run cdp` (the SDK harness, which also opens a session and takes over the browser) and the
legacy `node tools/ax.mjs sync` (the in-page extension). Neither can be pointed at one axde profile.

### The workspace is `axde/workspace/`, and that is a decision

`axde` develops against its OWN workspace, laid out exactly like the product's but small:

```text
axde/workspace/
  README.md                 what this is, and that it is not the product's data
  index.md                  `- [dev](https://example.com/)`  → host example.com, site `dev`
  _common/
    flows.yaml              scaffold document (see the status note below)
    scripts/00_dev.lua      AX_dev_echo — proves the common Lua layer arrived
    rpc/10_dev.lua          one runtime module — proves the module store arrived
  dev/
    scripts/00_site.lua     proves a SITE layer arrives, keyed `:dev`
    sitemap.md              proves the sitemap seeding path
```

The index grammar is core's, followed exactly: a line's first http(s) link is the HOST, and the site
directory is the first non-http link's target or that first link's text — so one line declares both
(`workspace.mjs:52-78`, which restates `axsdk-core/src/sites.ts:108-136`). `example.com` is the host
on purpose: stable, no bot wall, nothing to break, and it is where `axde/packs/src/dev-probe` already
reads a page.

Why not the repo root, which is the SDK harness's own convention (`cd` into the sites repo and that
IS the workspace)? Because delivering the product workspace into a dev profile is a different job
from developing: it is a 232 KiB canonical flow document, ten site layers and 25 runtime modules,
and a pack or flow author iterating on one file does not want the whole storefront surface in the
profile they are debugging. `--workspace <path>` overrides it, so the product workspace is one flag
away (`--workspace .`), and `dist/playground` — which the sites guide warns must be synced from the
BUILD output, not the authored one — is reachable the same way.

`--workspace` is a PROGRAM flag like `--dist` and `--env`: read when `axde` starts, so a command
cannot quietly deliver a different working copy than the header states. The header gains
`ws: <name>`, the directory's own name — deliberately not the digest, which goes stale the moment a
file is saved, and a stale fact on screen is a lie. A digest is what `/sources` is for, because it is
computed when asked.

**Status of the scaffold `flows.yaml`:** the loader accepts it (it parses as an object, which is the
same rule core applies) and `/up` delivers it. Whether it COMPILES at the backend is unproven and
stays unproven until the turn console (stage 4) sends the first message — so its own header says so.
A document nobody has compiled is not evidence, and calling it one would be the "green scaffold"
failure in a new place.

### What is imported rather than rewritten

Non-negotiable 4 decides most of this stage: the mechanism already exists in
`axsdk-extension-cdp/scripts/`, and every row below was read there on 2026-09-04.

|function|what it guarantees|
|---|---|
|`loadWorkspace(dir, {storeLimits})`|reads the working copy into `{indexMd, entries, domains, flows, lua, sitemaps, modules, digest}` and REFUSES: not a directory, no `index.md`, an index naming no site, one host mapped to two sites, `axsdk.ai` mapped at all, a site directory carrying layers that `index.md` does not name, flows that are not an object, a directory under `scripts/` or `rpc/`, a slot over 256 KiB, more than 200 layers, a single module over the slot cap|
|`bundleLua`|**the merge**: one layer's `scripts/*.lua` concatenated in name order, each file wrapped in an immediately-invoked vararg function so a `local` cannot collide, with a header naming the sources in load order|
|`rpcModulesOf`|`_common/rpc/<file>.lua` → `{"_common.<file>": source}`, byte-for-byte, nothing wrapped or normalised — the runtime compiles each module as its own chunk|
|`declaredModuleNames` ∩ `scriptModuleCandidates`|a `scripts/` file is added to the module map only when a flow layer NAMES it in `execute.modules`|
|`encodeFlowLayers` / `encodeModuleLayers`|per-slot splitting (`:` / `:\|2` …) on line boundaries for flows, per-module for the map, and a refusal for the one payload no split can rescue|
|`storeEnvelopes`|the exact `chrome.storage.local` values — zustand persist envelopes, which the SDK rehydrates as an EMPTY store when the shape is wrong and reports nothing|
|`writeWorkspaceStores`|writes only what CHANGED, answers `written` or `unchanged`, and sends `axsdk.cdp.restart-host` only when it wrote — the comparison is scoped to what the workspace OWNS, because comparing against the whole live store rewrote on every call and killed the session it was about to reuse|
|`resetWorkspaceStores`|removes the workspace keys and answers which ones|
|`describeWorkspace`|root, 12-hex digest, site count, and per layer the flow/Lua/sitemap bytes plus module count and bytes|

So `axde` writes no encoder, no envelope, no digest and no merge of its own. A test pins that: the
slot arithmetic and the store shapes have been paid for once already.

### The three commands

```text
/up <profile> [--check] [--force]     this working copy INTO the profile
/down <profile> [--force]             take it back out; the profile loads published sources
/sources [--check]                    what would be written — no browser at all
```

`/up` and `/down` are the user's naming, and they carry one risk worth stating once: `/launch` and
`/stop` are the BROWSER, `/up` and `/down` are the SOURCES. The `/help` text says which, in those
words.

#### `/up <profile>` — step by step

1. **Refuse a foreign profile without `--force`.** The shared harness profile's stores are set up by
   whoever runs `npm run cdp`; overwriting them silently is not ours to do.
2. **Load the workspace** (`loadWorkspace`). Its refusals are printed RAW — each names a file and a
   rule, and a paraphrase would lose both.
3. **Refuse a stale generated file.** `_common/rpc/62_rpc_sites.lua` is generated from the site
   configs; `/up` regenerates it IN MEMORY (`readSiteConfigs` + `serializeSites` from
   `tools/build-rpc-sites.mjs`, both pure) and compares bytes. A mismatch refuses and names
   `npm run build:rpc:sites` — it does not regenerate the file, because a delivery command that
   edits your working copy is a surprise, and §13 already records what a stale generated file costs
   (a shipping fix that never reached production and a hand-edit that regeneration erased).
4. **With `--check`, run the repo's flow gate first** (`npm run check:flows`, measured 4.75 s / 245
   tests) and refuse on failure. Off by default because 4.75 s on every delivery is a tax on the
   loop, and because a gate failure is not a delivery failure — the two must not be blurred.
5. **Open the profile's browser**, adopting one that is up and launching one if not, and require the
   extension: with nothing installed there is nowhere to write, so refuse and name `/install`.
6. **Read the four source switches by field** — `remote_sites`, `storedFlowsEnabled`,
   `storedLuaEnabled`, `remoteSiteFlowsEnabled` — and refuse when one is wrong, quoting it. `install`
   already writes them through `harnessConfig(…, {local: true})` and stays their single writer; two
   writers of one setting is how a setting stops meaning anything. Storing a workspace that will not
   be read is worse than refusing to store it. Reading by field is also what keeps the API key off
   the screen: the config store is never printed whole.
7. **Write what changed** (`storeEnvelopes` → `writeWorkspaceStores`) and report `written` or
   `unchanged` exactly as the SDK answered. An `unchanged` reported as a write is the same lie as a
   cart add that never happened.
8. **Read the store back** — key set, byte counts and the module layer's names — and print it.
9. **Leave the browser as it was found** (`finish()`, the stage-2a rule): close only what this
   command started.

#### `/down <profile>` — step by step

1. Same foreign-profile refusal.
2. Open the browser and require the extension (there is nothing to remove otherwise).
3. `resetWorkspaceStores`, plus the module store — see the SDK gap below — and report the keys that
   were actually removed, in the order they are named, not the order storage answered.
4. State what the profile now loads: the published sources, which is what a user gets.
5. `finish()`.

`/down` is not a rollback to a previous workspace: nothing here keeps one. It is "no local
workspace", which is why `--off` was the first spelling considered and why the receipt says
`published sources` rather than `restored`.

#### `/sources` — step by step

No browser, no profile, no writes. It loads the workspace and prints `describeWorkspace` plus the
same staleness check `/up` performs, so it is the cheapest possible answer to "is my file in the
bundle" and to "why did `/up` refuse". With `--check` it also runs the flow gate. It is the one
command that can be run with no Chrome on the machine at all.

### When the builds and checks happen — measured, because most of them do not

|thing|when|why|
|---|---|---|
|**the Lua merge**|inside `loadWorkspace`, on every `/up` and `/sources`|`bundleLua` IS the merge, and it runs from the working copy at delivery time. `npm run build:lua` writes `dist/`, which is the PUBLISHED/self-contained path and is not read by this one — a `dist/` from yesterday cannot be delivered by accident|
|**`_common/rpc/*` modules**|read byte-for-byte at delivery|nothing to build: the map is `{name: source}` straight off disk|
|**`_common/rpc/62_rpc_sites.lua`** (generated)|CHECKED in memory on `/up` and `/sources`; regenerated only by `npm run build:rpc:sites`, which the refusal names|the file is committed and the site configs are its source; delivering it stale ships old store data with no symptom until a storefront reads wrong|
|**`check:flows`** (245 tests, 4.75 s)|opt-in `--check`, and named as NOT RUN in every receipt without it|it is a gate on the product document, not a step in a delivery, and 4.75 s per iteration is a tax. What it catches that the loader cannot: a dangling `next`, an undeclared module, a `require` that compares to `true`, the canonical document against the 512 KiB session limit|
|**`test:lua`, `build:bundle`, `check:bundle`**|never here|unit gates and the CWS package path; neither touches a dev profile|
|**flow COMPILATION**|not in this stage at all|it happens when a session opens, which is stage 4. `/up` proves delivery and says so; a receipt that implied a working turn would be the worse lie|

The receipt therefore ends with one line naming what was not checked, so a green `/up` is never
mistaken for a green gate.

### The receipt

```text
/up packdev
  workspace  axde/workspace   digest 2b95acc54f57   sites 1
  :          flows 0.4 KiB          lua 1.2 KiB      modules 1
  :dev       lua 0.3 KiB            sitemap 0.2 KiB
  generated  62_rpc_sites.lua up to date
  stores     written · host restarted
  read back  axsdk:sites 1.1 KiB · axsdk:flows 0.4 KiB · axsdk:lua 1.5 KiB · axsdk:widgets 40 B
  modules    axsdk:lua-modules 1 slot, names: _common.10_dev
  not run    check:flows (pass --check) · script ids need a session (stage 2d)
```

Four of those lines exist because of a measured trap. The **slot count**, because a layer over
256 KiB is split and a reader who does not know that cannot tell a chunked layer from a truncated
one. The **read-back**, because the only thing that proves a write landed is reading the store the
extension reads — not the answer of the call that wrote it.
**`host restarted`**, because a write that did not restart the host is a write the running session
has not read. And **`not run`**, because the most expensive failure in this repo's history is a
green instrument mistaken for a green product.

**A correction the implementation forced, before any code was written.** The first draft of this
receipt promised the SCRIPT IDS read back (`stored-lua:`, `stored-lua:dev`) as the proof the
extension had taken the layers. Measured: that answer comes from `harness.mjs`'s `lua()` helper,
which sends `axsdk.cdp.run-lua` with a `groupId` — so it needs an OPEN SESSION
(`findSession`/`startSessionOn`). This stage opens none, on purpose. So delivery is proven by the
store and CONSUMPTION is stage 2d's, where a session exists; §13's warning survives the move
intact, because script ids would have proven the durable Lua layer and said nothing about runtime
module closure anyway.

### Boundaries this stage must not blur

- **The store is the DEVELOPMENT path; production module delivery is the backend app package.** A
  flow tool whose modules come from the backend will not see these bytes — that still needs
  `npm run build:rpc` plus `node tools/rpc-package.mjs push . --app=<app> --modules-only`. The
  receipt names the module layers it wrote and claims nothing about any app.
- **`_common` layers take effect on the restarted host; a SITE flow layer may not.** Core sends a
  site's client flows once after that site becomes current, so a re-stored `<domain>/flows.yaml` can
  need a fresh session. Until stage 4 owns a `/reset`, the honest instruction is `/stop` then
  `/launch`, and the receipt says which layers changed so a developer knows whether they are in that
  case.
- **No session is opened, no message is sent, no page is navigated.** Mixing the two would make a
  delivery failure look like a flow failure, which is the trap §6.1 of the sites guide exists to
  name.

### The gap this stage exposes in the SDK, and its fix

`storeEnvelopes` emits five keys; `resetWorkspaceStores`'s `WORKSPACE_KEYS` lists **four** —
`axsdk:lua-modules` is absent (measured: `['axsdk:sites', 'axsdk:flows', 'axsdk:lua',
'axsdk:widgets']`). So a reset leaves local RPC modules in the profile, and `/down` would report
"published sources" while the module store still served this working copy's bytes. The only thing
that clears it today is unrelated: `background/workspace-assets.ts` empties legacy source caches when
the PACKAGE digest changes.

The fix belongs in the SDK rather than in a second key list here — add the key to `WORKSPACE_KEYS`,
so `npm run cdp -- reset`, the playground harness and `/down` all remove what a write created. It
needs its own SDK test and one live check, and it is the FIRST thing to do in this stage, because
`/down` cannot be honest without it.

### Planned tests, before the code

Offline, against a fake browser and temp workspaces on disk:

- the scaffold at `axde/workspace/` loads clean, and its index resolves `example.com` → `dev`;
- the receipt formatter: one line per layer with bytes, slot count and module count; `unchanged`
  reported as unchanged;
- every refusal, by name and in order: foreign without `--force`, not a workspace (raw reason
  quoted), a stale generated file (names `build:rpc:sites`), extension absent (names `/install`), a
  source switch in remote mode (names the field);
- the decision layer hands `storeEnvelopes`' output straight to the adapter — no re-encoding, no
  digest, no merge of its own;
- a one-writer pin like `console.test.ts`: `axde/src` contains no second envelope shape, no
  `encodeFlowLayers` copy and no `axsdk:` key list.

Live (`axde/live/stage2c.ts`, its own npm script, throwaway profile root):

- fresh profile → `install` → `/up` → read the store KEY SETS and byte counts back and compare them
  to what `/sources` reported, digest included;
- the module store carries the runtime module by NAME (`_common.10_dev`), which is the half of the
  delivery that a durable-layer check cannot see;
- a second `/up` answers `unchanged` and does NOT restart the host (the measured reason the
  comparison is scoped);
- `/down` removes all five keys — the assertion that fails today, and the reason the SDK fix comes
  first;
- a foreign profile is refused with exit code 1.

Mutation checks that must turn something red: dropping the switch check (a workspace stored where
nothing will read it), reporting `written` for `unchanged`, skipping the generated-file comparison,
and removing `axsdk:lua-modules` from the reset list again.


### Measured acceptance — `npm run test:axde:live`

`axde/live/stage2c.ts`: **25 checks, ~24 s**, throwaway profile root, and every store read back
through a fresh CDP connection that shares nothing with the writer — a wrong envelope shape is
rehydrated as an EMPTY store and reports nothing, which is the failure a fake cannot have.

```text
sources                 → digest + every layer, with no browser at all
up packdev              → written · host restarted; the receipt carries the same digest
                          and names the module IN the store (_common.10_dev)
read back (fresh CDP)   → all five stores; flow layer `:`; Lua layers `:` and `:dev`;
                          the common layer MERGED (one vararg function per file);
                          index source `local`; the site record carrying its sitemap
up packdev (again)      → unchanged, and the host is NOT restarted
down packdev            → all five removed, and the profile really holds none
down packdev (again)    → "nothing stored"
up packdev --workspace .→ the product workspace: 62_rpc_sites.lua up-to-date, flows reported
                          as 2 SLOTS, the store holding `:` and `:|2`, 11 site layers,
                          27 runtime modules named (including _common.62_rpc_sites)
up/down someone-elses   → refused BY NAME, exit code 1
```

Offline: **121 tests** (`npm run test:axde`). Stage 2c owns 22 of them: the scaffold loading clean
and becoming the five stores, the receipt (layers, slot counts, the key column sized to the widest
key), every refusal in order, and the one-writer pin — `axde/src` builds no store envelope,
re-implements no splitter, digest or merge, and carries no list of store keys.

Five mutation checks, each red: dropping the switch check, reporting `unchanged` as `written`,
skipping the generated-file comparison, dropping the extension-present check, and giving the
adapter its own list of store keys.

**Two defects this stage found in code that was already green.** `resetWorkspaceStores` listed
four of the five keys, so a reset left the module store behind — fixed in the SDK, mutation-checked,
and `WORKSPACE_KEYS` is now exported so the read-back cannot grow a second copy. And an import edit
in `ops/chrome.ts` had silently dropped `node:net`, `node:fs/promises` and `node:path`: every
offline test passed (they run against fakes) and the first live command died on
`createServer is not defined`.

**One promise the implementation retracted before any code was written.** The first draft of the
receipt named the SCRIPT IDS read back as proof the extension had taken the layers. Measured: that
answer comes from the harness's `lua()` helper, which sends `axsdk.cdp.run-lua` with a `groupId` —
so it needs an OPEN SESSION, and this stage opens none by design. Delivery is proven by the store;
consumption is stage 2d's.
## 7. Later stages (scope sketch, not commitments)

| stage | adds | why it is next |
|---|---|---|
| 2d | live status pane (SW alive, `scriptIds`, session id, tab groups) and a log tail with filters, over the browser stage 2a leaves up | every debugging session starts by asking "is the thing I edited the thing that is running" |
| 3 | pack lifecycle pane: registry list, refresh, stage-install with the approval DIFF shown, approve, enable/disable/replace/rollback/remove/reset | X6 drove these by hand-typed payloads; the approval diff is the one screen a reviewer needs |
| 4 | turn console: send an utterance, watch nodes/tool calls/branches stream, expand a tool's args and output | replaces `send` + parsing `:axsdk:chat`, and works around the 4,120-char trace truncation |
| 5 | pack authoring loop: wrap/verify a `.lua` artifact, run it through the packaged prelude, call `pack.catalog`/`pack.invoke`, watch the executor document | the last hand-driven surface after stage 4 |
| 6 | record and replay a session (inputs + effects) so a bug report is a file a gate can replay | a defect nobody can re-run is a defect that gets re-diagnosed |

Stages 3–5 are where non-negotiable 1 pays for itself: each imports SDK TypeScript directly.
Each stage gets its own section here, with the same "what it encodes because it was measured" and
"acceptance" pair, written before its code.

## 8. Rules this design deliberately does not bend

- No new dependency without a measurement showing the hand-written version is worse.
- No screen shows a value the user cannot act on; a refusal quotes its raw reason.
- The TUI never becomes the only way to do something — if a screen can do it, a command can too.
- `axde` owns no product behaviour. It drives the extension the way a person does, through the same
  production surfaces, so a green screen here is evidence about the product and not about `axde`.
