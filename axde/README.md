# `axde` — AXSDK Dev Env

A **bun** terminal app for developing and debugging Agent Packs. Stage 1 manages **Chrome profiles**
and the **local extension build** in them; later stages add pack lifecycle, turns and traces
(`DESIGN.md`).

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
npm run axde -- profile rm packdev
```

`bun axde/src/cli.ts <args>` works identically if you would rather skip npm.

Run without a terminal (piped, CI) and the TUI refuses by name and points at the commands instead
of hanging.

Keys in the TUI: `j`/`k` or arrows move, `n` new profile, `d` delete (type the name to confirm),
`i` install, `u` uninstall, `r` refresh, `q` quit.

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

## Safety

`axde` marks the profiles it creates (`axde-profile.json`) and refuses to delete or install into one
it did not create — the shared harness profile holds your credentials and chat history. Pass
`--force` to `profile rm` only when you mean it.

## Tests

```bash
npm run test:axde     # bun test axde — core, ops, driver and the sample packs (71 tests, offline)
```

Suites are `bun:test` files that assert with `node:assert/strict`: bun runs both, and each core
assertion pins a measured contract that `expect` would have been an opportunity to weaken. New
assertions may use either; the sample-pack suite uses `expect`, which reads better for object shapes.

## Sample packs

`axde/packs/src/` holds the packs this environment develops against: `dev-echo` (marshaling shapes,
prelude surface, a named refusal) and `dev-probe` (reads the page it stands on). They exist so a
failure while debugging is attributable to the environment rather than to the pack under test.
