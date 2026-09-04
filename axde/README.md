# `axde` — AXSDK Dev Env

A **bun** terminal app for developing and debugging Agent Packs. It manages **Chrome profiles**, the
**local extension build** in them, and a **headed browser you can leave running and drive**; later
stages add pack lifecycle, turns and traces (`DESIGN.md`).

Bun is the runtime and TypeScript is the source, with no build step — from stage 3 on `axde` imports
the SDK's own TypeScript (pack schemas, the registry verifier, the Lua prelude) the way
`tools/packs/*.ts` already does.

## Run it

```bash
npm run axde                      # the TUI  (= bun axde/src/cli.ts)
npm run axde -- profile ls
npm run axde -- profile new packdev
npm run axde -- ext install packdev
npm run axde -- ext status packdev
npm run axde -- ext uninstall packdev
npm run axde -- launch packdev --url https://www.amazon.com/   # headed, and it STAYS UP
npm run axde -- stop packdev
npm run axde -- sources                                        # what would be delivered
npm run axde -- up packdev                                     # deliver it into the profile
npm run axde -- down packdev                                   # take it back out
npm run axde -- profile rm packdev
```

`bun axde/src/cli.ts <args>` works identically if you would rather skip npm.

Run without a terminal (piped, CI) and the TUI refuses by name and points at the commands instead
of hanging.

## The TUI is a slash-command console

The screen is a transcript plus one input line — no profile pane, no single-key shortcuts. You
type commands and read answers:

```text
/help                                  /profiles
/new <name> [--port <n>]               /rm <name> [--force]
/install <profile>                     /uninstall <profile>
/up <profile> [--check]                /down <profile>
/sources [--check]
/status <profile>                      /launch <profile> [--url <u>] [--force]
/stop <profile> [--force]              /quit
```

`Tab` completes a command name (an ambiguous prefix prints the candidates and guesses nothing),
the arrows walk history, `Esc` clears the line, `ctrl-c` quits. A line that does not start with
`/` is refused by name, and so is a command with a missing argument — the refusal quotes the
usage. While an operation runs a submit is refused and your line is KEPT.

The profile list is an ANSWER, not a pane: `/profiles` asks for it. Nothing is cached, so nothing
can go stale, and `--dist`/`--env` stay program flags read when `axde` starts so a command cannot
quietly use a different build than the header states.

Flags: `--dist <path>` picks the build to attach (default: the sibling SDK's
`packages/axsdk-extension-cdp/dist`), `--env <path>` picks the workspace `.env` credentials are
seeded from (default: this repo's), `--port <n>` fixes a profile's debugging port.
`AXSDK_PROFILE_ROOT` overrides where profiles live (default `%LOCALAPPDATA%/AXSDKChromeProfiles`) —
point it at a temp directory to experiment without touching your own profiles.

## What "install" means here

The build is **attached** to the profile and loaded by Chrome at launch (`--load-extension`), because
that is the only form that survives a restart — a CDP `loadUnpacked` registration dies with its
browser session. Installing therefore attaches, relaunches, turns on developer mode and the
Allow-User-Scripts row (both persist), and records the build's fingerprint. Uninstalling detaches and
relaunches: a flag-loaded extension cannot be removed live. Every measurement behind those sentences
is in `DESIGN.md` §3.

Two consequences worth knowing:

- `axde` closes Chrome **gracefully** after each operation, because killing it loses the extension
  registration and both toggles (Chrome writes `Preferences` during shutdown).
- Re-installing the same build answers `up-to-date` and does **not** relaunch: a relaunch would kill
  whatever session you are looking at.

## What "launch" means here

A launched browser **outlives the command**: it is spawned detached, so `axde launch packdev`
returns and leaves a real headed Chrome on that profile with its debugging port open, the build
loaded and the user-scripts row on — the browser you then click through, and the one later stages
attach to. Launching again ADOPTS it (`already-running`) rather than relaunching, because a
relaunch kills whatever session you are looking at.

It **reports** rather than repairs: a browser that came up without the extension or without user
scripts says so and names `axde ext install` as the fix, so one command stays the only writer of
those toggles.

`axde stop` closes it gracefully, which is the only way the two toggles survive — never kill it.
A `stop` whose port keeps answering is reported as a failure, not as a stop.

## What "up" and "down" mean here

A workspace is flows, Lua, runtime modules, a site index and sitemaps. `/up <profile>` writes
this working copy into that profile's extension stores; `/down <profile>` removes it, and the
profile goes back to the published sources. `/sources` says what would be written and touches no
browser at all — the cheapest answer to "is my file in the bundle".

The default working copy is **`axde/workspace/`** — axde's own, small, laid out exactly like the
product's (see its README). The product workspace is one flag away: `axde --workspace .`.

What `/up` refuses, and why: a profile axde did not create (`--force` if you mean it), a
workspace the loader will not accept (its raw reason names the file and the rule), a stale
`_common/rpc/62_rpc_sites.lua` (it names `npm run build:rpc:sites` and never regenerates your
working copy for you), a profile with no extension (the stores live in its origin), and a profile
whose source switches are in remote mode — storing a workspace nothing will read is worse than
refusing to store it.

The merge is not a build step: the SDK loader concatenates each layer at delivery time, so
`npm run build:lua` (which writes `dist/` for the published path) is never on this path and a
stale `dist/` cannot be delivered by accident. The flow gate is opt-in — `--check` runs
`check:flows` (4.75 s, 245 tests) and refuses on failure; without it, the receipt names it as not
run, because a green delivery is not a green gate.

**An axde profile REPLACES the baseline embedded in the build.** The artifact carries a packaged
workspace — flows, Lua and runtime modules — and a product profile merges the persisted layers on
top of it. That is wrong for a dev environment: measured, a 75 B workspace flow layer travelled
inside a 139,101 B document because a 136 KiB product document sat underneath, and that baseline
was five days older than the workspace. So `ext install` writes replace mode, `/up` reports it
(`baseline package:: replaced`), and `ext install --merge` opts back into the product-like
layering, where the receipt names the baseline and its date instead.

Replace mode covers three different mechanisms, because they are three: flow layers deep-merge,
runtime modules union by name, and the durable Lua bundles BOTH run (packaged first). With the
switch off, none of the packaged three is used at all.

One boundary: nothing here opens a session. A client flow document is compiled when one opens, so
`/up` proves the bytes are in the stores, not that a turn will work.

## Safety

`axde` marks the profiles it creates (`axde-profile.json`) and refuses to delete or install into one
it did not create — the shared harness profile holds your credentials and chat history. Pass
`--force` to `profile rm` only when you mean it.

`launch` and `stop` refuse a foreign profile for a mechanical reason too: two Chromes on one
profile directory are not two browsers, so a launch there either joins a session `axde` does not
own or waits out a port that never opens.

## Tests

```bash
npm run test:axde        # bun test axde — core, ops, driver, workspace, packs (125 tests, offline)
npm run test:axde:live   # three real-browser gates: headed browser (21), workspace (25), replace (11)
```

The live gate drives the same subcommands on a throwaway profile root and asserts the 21 facts no
offline test can reach — including the one it caught on its first run: a read must not take down a
browser `launch` deliberately left running.

Suites are `bun:test` files that assert with `node:assert/strict`: bun runs both, and each core
assertion pins a measured contract that `expect` would have been an opportunity to weaken. New
assertions may use either; the sample-pack suite uses `expect`, which reads better for object shapes.

## Sample packs

`axde/packs/src/` holds the packs this environment develops against: `dev-echo` (marshaling shapes,
prelude surface, a named refusal) and `dev-probe` (reads the page it stands on). They exist so a
failure while debugging is attributable to the environment rather than to the pack under test.
