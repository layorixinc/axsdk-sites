#!/usr/bin/env bun
/**
 * `axde` — the entry point. One command core, two faces: a TUI (default) and subcommands.
 *
 * The subcommands exist because a screen cannot be asserted and a command can: every gate, script
 * and bug report uses the same code path the screen uses.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createDriver } from './driver.ts';
import { initialState } from './core/state.ts';
import { profileLine, statusLines } from './core/render.ts';
import { extensionStatus, installExtension, uninstallExtension } from './ops/extension.ts';
import { launchHeaded, stopHeaded } from './ops/session.ts';
import {
  downWorkspace, inspectWorkspace, readPackagedBaseline, receipt, upWorkspace,
} from './ops/workspace.ts';
import { availablePort, createBrowser, fingerprintBuild, probeDebugger } from './ops/chrome.ts';
import { createProfile, deleteProfile, listProfiles, profileRootFrom } from './ops/profiles.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SITES_ROOT = resolve(here, '..', '..');
const DEFAULT_DIST = resolve(SITES_ROOT, '..', 'axsdk-sdk-js', 'packages', 'axsdk-extension-cdp', 'dist');
// axde develops against its OWN workspace: small, and not the product's data. `--workspace .`
// points at the repository root when that is what a session is about.
const DEFAULT_WORKSPACE = resolve(here, '..', 'workspace');

const USAGE = `axde — AXSDK Dev Env

  axde                                  the TUI — a slash-command console (/help inside)
  axde profile ls
  axde profile new <name> [--port <n>]
  axde profile rm  <name> [--force]
  axde ext install   <profile> [--dist <path>] [--merge]
  axde ext uninstall <profile>
  axde ext status    <profile>
  axde launch <profile> [--url <u>] [--force]   headed, and it STAYS UP after this returns
  axde stop   <profile> [--force]               graceful close, so the toggles survive
  axde up     <profile> [--check] [--force]     this working copy INTO the profile
  axde down   <profile> [--force]               take it back out; published sources return
  axde sources [--check]                        what would be written — no browser

  --dist <path>   extension build to install (default: the sibling SDK's dist)
  --env  <path>   workspace .env to seed credentials from (default: this repo's)
  --workspace <path>  the working copy /up delivers (default: axde/workspace)
`;

function flag(args, name) {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? undefined : args[at + 1];
}

function context(args) {
  const dist = flag(args, 'dist') ?? DEFAULT_DIST;
  return {
    root: profileRootFrom(process.env),
    dist,
    envPath: flag(args, 'env') ?? join(SITES_ROOT, '.env'),
    workspace: resolve(flag(args, 'workspace') ?? DEFAULT_WORKSPACE),
    fingerprint: fingerprintBuild(dist),
  };
}

/**
 * The inventory. Attachment comes from the profile manifest and costs nothing; the recorded
 * fingerprint and the toggle state live in the browser, so they are read ONLY for a profile whose
 * browser is already up — `close()` shuts Chrome down gracefully, so that is usually nobody. A row
 * nobody read stays unknown rather than being given a default.
 */
async function inventory({ root, dist, fingerprint }) {
  const rows = await listProfiles({ root, probe: async (port) => Boolean(await probeDebugger(port)) });
  return Promise.all(rows.map(async (row) => {
    if (row.chrome !== 'up' || row.kind !== 'axde') return row;
    const browser = createBrowser({ root });
    try {
      const status = await extensionStatus(browser, { profile: row.name, port: row.port, dist, fingerprint });
      return {
        ...row,
        ext: status.installed ? { id: status.extensionId, fingerprint: status.fingerprint } : null,
        userScripts: status.userScripts,
        stale: status.stale,
      };
    } catch {
      // A profile that cannot be read stays exactly as unknown as it was; a default here would be a
      // claim about a browser nobody reached.
      return row;
    }
  }));
}

async function target(ctx, profile) {
  const rows = await listProfiles({ root: ctx.root, probe: async () => false });
  const row = rows.find((one) => one.name === profile);
  if (row === undefined) throw new Error(`no such profile: ${profile}`);
  return {
    profile,
    kind: row.kind,
    port: row.port ?? await availablePort(),
    dist: ctx.dist,
    fingerprint: ctx.fingerprint,
  };
}

async function runInstall(ctx, profile, log, { packaged = false } = {}) {
  const browser = createBrowser({ root: ctx.root, log });
  const at = await target(ctx, profile);
  const result = await installExtension(browser, at);
  log(`install ${profile}: ${result.outcome} ${(result.fingerprint ?? '').slice(0, 8)} · user scripts ${result.userScripts ? 'on' : 'off'}`
    + ` · sources ${packaged ? 'package + workspace' : 'workspace only'}`);
  // ALWAYS, not only when the build changed. `install` is the single writer of this profile's
  // config (§5), and the source MODE is part of it — measured 2026-09-04, the live gate caught
  // `ext install --merge` doing nothing at all on an already-current profile, because the seeding
  // step it writes through was skipped for `up-to-date`. One short session is the price of a writer
  // that actually writes.
  //
  // Values are never echoed: this is the one place a secret could reach a screen.
  const seeding = createBrowser({ root: ctx.root, log: () => {} });
  try {
    await seeding.open(at);
    log(`credentials: ${await seeding.seedCredentials(ctx.envPath, { packaged })}`);
  } finally {
    await seeding.close();
  }
  return result;
}

async function runLaunch(ctx, profile, args, log) {
  const browser = createBrowser({ root: ctx.root, log });
  const at = await target(ctx, profile);
  const result = await launchHeaded(browser, {
    ...at, url: flag(args, 'url'), force: args.includes('--force'),
  });
  log(`launch ${profile}: ${result.outcome} on :${result.port}`
    + `${result.pid === undefined ? '' : ` pid ${result.pid}`}`
    + ` · extension ${result.extension} · user scripts ${result.userScripts ? 'on' : 'off'}`);
  // A browser that came up without user scripts is not the controllable browser that was asked for,
  // and the answer names the one command that fixes it rather than repairing it from here.
  if (result.fix) log(result.fix);
  return result;
}

async function runStop(ctx, profile, args, log) {
  const browser = createBrowser({ root: ctx.root, log });
  const at = await target(ctx, profile);
  const result = await stopHeaded(browser, { ...at, force: args.includes('--force') });
  log(`stop ${profile}: ${result.outcome}`);
  return result;
}

/**
 * What the console performs, keyed by the command name the reducer emits. `/help` and `/quit` are
 * deliberately absent: the reducer answers the first and the driver owns the second, and a handler
 * for either would be a second implementation of something already answered. `console.test.ts` pins
 * this table against `COMMANDS`, because a name the console offers with nothing behind it is a
 * promise the screen cannot keep.
 */
const HANDLERS = {
  profiles: async (ctx, _args, say) => {
    const rows = await inventory(ctx);
    if (rows.length === 0) { say('no profiles yet — /new <name> creates one'); return; }
    for (const row of rows) say(profileLine(row));
  },
  new: async (ctx, { positional: [name], flags }, say) => {
    const port = Number(flags.port ?? await availablePort());
    const created = await createProfile({ root: ctx.root, name, port });
    say(`created ${created.name} (port ${created.port})`);
  },
  rm: async (ctx, { positional: [name], flags }, say) => {
    const removed = await deleteProfile({ root: ctx.root, name, force: flags.force === true });
    say(`removed ${removed.name}`);
  },
  install: async (ctx, { positional: [name], flags }, say) => {
    await runInstall(ctx, name, say, { packaged: flags.merge === true });
  },
  uninstall: async (ctx, { positional: [name] }, say) => {
    const browser = createBrowser({ root: ctx.root, log: say });
    const result = await uninstallExtension(browser, await target(ctx, name));
    say(`uninstall ${name}: ${result.outcome}`);
  },
  status: async (ctx, { positional: [name] }, say) => {
    const browser = createBrowser({ root: ctx.root, log: () => {} });
    for (const line of statusLines(await extensionStatus(browser, await target(ctx, name)))) say(line);
  },
  launch: async (ctx, { positional: [name], flags }, say) => {
    await runLaunch(ctx, name, flagsToArgv(flags), say);
  },
  stop: async (ctx, { positional: [name], flags }, say) => {
    await runStop(ctx, name, flagsToArgv(flags), say);
  },
  up: async (ctx, { positional: [name], flags }, say) => {
    await runUp(ctx, name, { check: flags.check === true, force: flags.force === true }, say);
  },
  down: async (ctx, { positional: [name], flags }, say) => {
    const browser = createBrowser({ root: ctx.root, log: say });
    const at = await target(ctx, name);
    const result = await downWorkspace(browser, { ...at, force: flags.force === true });
    say(result.removed.length === 0
      ? `down ${name}: nothing stored — the profile already loads published sources`
      : `down ${name}: removed ${result.removed.join(" ")} — published sources return`);
  },
  sources: async (ctx, { flags }, say) => {
    const inspected = await inspectWorkspace(ctx.workspace);
    const checked = flags.check === true ? await runFlowGate(say) : "skipped";
    for (const line of receipt({
      inspected, wrote: "not written (no profile named)", restarted: false,
      readBack: { bytes: {}, moduleNames: [] }, checked,
    })) say(line);
  },
};

/** The shared handlers read a shell argv; a console has parsed flags. One shape, converted once. */
function flagsToArgv(flags) {
  return Object.entries(flags).flatMap(([flag, value]) => (value === true ? [`--${flag}`] : [`--${flag}`, value]));
}

/**
 * The repo's flow gate, run only when asked. Measured 4.75 s / 245 tests, which is why it is opt-in:
 * a gate failure is not a delivery failure, and blurring the two is how a delivery gets blamed for a
 * dangling `next`. What it catches that the loader cannot: an undeclared module, a `require` that
 * compares to `true`, a branch target that does not exist, the canonical document against the
 * backend's 512 KiB session limit.
 */
async function runFlowGate(log) {
  log('check:flows …');
  const child = Bun.spawn(['npm', 'run', 'check:flows'], { cwd: SITES_ROOT, stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  const summary = `${out}${err}`.split(/\r?\n/)
    .filter((line) => /^.\s?(pass|fail) \d+/.test(line)).join(' ').trim();
  if (code !== 0) throw new Error(`check:flows failed — ${summary || 'see npm run check:flows'}`);
  log(`check:flows ${summary || 'pass'}`);
  return 'pass';
}

async function runUp(ctx, profile, { check = false, force = false }, log) {
  const inspected = await inspectWorkspace(ctx.workspace);
  const checked = check ? await runFlowGate(log) : 'skipped';
  const browser = createBrowser({ root: ctx.root, log: () => {} });
  const result = await upWorkspace(browser, { ...(await target(ctx, profile)), force, inspected });
  const baseline = readPackagedBaseline(ctx.dist);
  for (const line of receipt({ inspected, ...result, baseline, checked })) log(line);
  return result;
}

async function subcommand(args) {
  const ctx = context(args);
  const [group, action, name] = args;
  const say = (text) => console.log(text);

  if (group === 'profile' && (action === 'ls' || action === undefined)) {
    // One formatter for both surfaces: these are the exact lines the console prints into its
    // transcript, so a row cannot read one way on a screen and another way in a script.
    for (const row of await inventory(ctx)) say(profileLine(row));
    return 0;
  }
  if (group === 'profile' && action === 'new') {
    const port = Number(flag(args, 'port') ?? await availablePort());
    const created = await createProfile({ root: ctx.root, name, port });
    say(`created ${created.name} (port ${created.port}) at ${created.directory}`);
    return 0;
  }
  if (group === 'profile' && action === 'rm') {
    const removed = await deleteProfile({ root: ctx.root, name, force: args.includes('--force') });
    say(`removed ${removed.name}`);
    return 0;
  }
  if (group === 'ext' && action === 'install') {
    await runInstall(ctx, name, say, { packaged: args.includes('--merge') });
    return 0;
  }
  if (group === 'ext' && action === 'uninstall') {
    const browser = createBrowser({ root: ctx.root, log: say });
    const result = await uninstallExtension(browser, await target(ctx, name));
    say(`uninstall ${name}: ${result.outcome}`);
    return 0;
  }
  if (group === 'ext' && action === 'status') {
    const browser = createBrowser({ root: ctx.root, log: () => {} });
    const status = await extensionStatus(browser, await target(ctx, name));
    for (const line of statusLines(status)) say(line);
    return 0;
  }
  if (group === 'launch') {
    await runLaunch(ctx, action, args, say);
    return 0;
  }
  if (group === 'stop') {
    await runStop(ctx, action, args, say);
    return 0;
  }
  if (group === 'up') {
    await runUp(ctx, action, { check: args.includes('--check'), force: args.includes('--force') }, say);
    return 0;
  }
  if (group === 'down') {
    await HANDLERS.down(ctx, { positional: [action], flags: { force: args.includes('--force') } }, say);
    return 0;
  }
  if (group === 'sources') {
    await HANDLERS.sources(ctx, { positional: [], flags: { check: args.includes('--check') } }, say);
    return 0;
  }
  console.error(USAGE);
  return 1;
}

async function tui() {
  const ctx = context(process.argv.slice(2));
  if (ctx.fingerprint === undefined) {
    console.error(`No extension build at ${ctx.dist}. Build it first, or pass --dist.`);
  }
  const driver = createDriver({
    initial: initialState({
      dist: ctx.dist,
      buildFingerprint: ctx.fingerprint,
      workspace: ctx.workspace.split(/[\\/]/).filter(Boolean).pop(),
    }),
    perform: async (effect, push) => {
      const say = (text) => push({ type: 'output', text });
      const handler = HANDLERS[effect.name];
      // Unreachable while `console.test.ts` is green — and it says so rather than doing nothing,
      // because a console that silently ignores an accepted command teaches nothing.
      if (handler === undefined) { push({ type: 'error', text: `nothing performs /${effect.name}` }); return; }
      await handler(ctx, effect, say);
    },
  });
  await driver.run();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const help = args.includes('--help') || args.includes('-h');
  if (help) { console.log(USAGE); process.exitCode = 0; }
  else if (args.length > 0 && !args[0].startsWith('--')) {
    subcommand(args).then((code) => { process.exitCode = code; }, (error) => {
      console.error(`axde: ${error?.message ?? error}`);
      process.exitCode = 1;
    });
  } else {
    tui().catch((error) => {
      console.error(`axde: ${error?.message ?? error}`);
      process.exitCode = 1;
    });
  }
}

export { HANDLERS, context, inventory, runInstall, runLaunch, runStop, subcommand };
