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
import { extensionStatus, installExtension, uninstallExtension } from './ops/extension.ts';
import { launchHeaded, stopHeaded } from './ops/session.ts';
import { availablePort, createBrowser, fingerprintBuild, probeDebugger } from './ops/chrome.ts';
import { createProfile, deleteProfile, listProfiles, profileRootFrom } from './ops/profiles.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SITES_ROOT = resolve(here, '..', '..');
const DEFAULT_DIST = resolve(SITES_ROOT, '..', 'axsdk-sdk-js', 'packages', 'axsdk-extension-cdp', 'dist');

const USAGE = `axde — AXSDK Dev Env

  axde                                  the TUI
  axde profile ls
  axde profile new <name> [--port <n>]
  axde profile rm  <name> [--force]
  axde ext install   <profile> [--dist <path>]
  axde ext uninstall <profile>
  axde ext status    <profile>
  axde launch <profile> [--url <u>] [--force]   headed, and it STAYS UP after this returns
  axde stop   <profile> [--force]               graceful close, so the toggles survive

  --dist <path>   extension build to install (default: the sibling SDK's dist)
  --env  <path>   workspace .env to seed credentials from (default: this repo's)
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

async function runInstall(ctx, profile, log) {
  const browser = createBrowser({ root: ctx.root, log });
  const at = await target(ctx, profile);
  const result = await installExtension(browser, at);
  log(`install ${profile}: ${result.outcome} ${(result.fingerprint ?? '').slice(0, 8)} · user scripts ${result.userScripts ? 'on' : 'off'}`);
  if (result.outcome !== 'up-to-date') {
    // Seeded in its own short session, after the build is attached and therefore present on launch.
    // Values are never echoed: this is the one place a secret could reach a screen.
    const seeding = createBrowser({ root: ctx.root, log: () => {} });
    try {
      await seeding.open(at);
      log(`credentials: ${await seeding.seedCredentials(ctx.envPath)}`);
    } finally {
      await seeding.close();
    }
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

async function subcommand(args) {
  const ctx = context(args);
  const [group, action, name] = args;
  const say = (text) => console.log(text);

  if (group === 'profile' && (action === 'ls' || action === undefined)) {
    for (const row of await inventory(ctx)) {
      // Same rule as the screen: attachment is cheap to know, the fingerprint needs a browser.
      const ext = row.ext === null || row.ext === undefined
        ? (row.dist === undefined ? '—' : 'attached')
        : (row.ext.fingerprint ?? '—').slice(0, 8);
      const running = row.pid === undefined ? '' : ` pid ${row.pid}`;
      say(`${row.name}\t${row.kind}\t${row.chrome}${row.port ? `:${row.port}` : ''}${running}\text ${ext}${row.stale ? ' STALE' : ''}`);
    }
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
    await runInstall(ctx, name, say);
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
    for (const [key, value] of Object.entries(status)) say(`${key}\t${value ?? '—'}`);
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
  console.error(USAGE);
  return 1;
}

async function tui() {
  const ctx = context(process.argv.slice(2));
  if (ctx.fingerprint === undefined) {
    console.error(`No extension build at ${ctx.dist}. Build it first, or pass --dist.`);
  }
  const driver = createDriver({
    initial: initialState({ dist: ctx.dist, buildFingerprint: ctx.fingerprint }),
    perform: async (effect, push) => {
      const log = (text) => push({ type: 'log', text });
      if (effect.type === 'create-profile') {
        const created = await createProfile({ root: ctx.root, name: effect.name, port: await availablePort() });
        log(`created ${created.name} (port ${created.port})`);
      } else if (effect.type === 'delete-profile') {
        await deleteProfile({ root: ctx.root, name: effect.name });
        log(`removed ${effect.name}`);
      } else if (effect.type === 'install') {
        await runInstall(ctx, effect.profile, log);
      } else if (effect.type === 'uninstall') {
        const browser = createBrowser({ root: ctx.root, log });
        const result = await uninstallExtension(browser, await target(ctx, effect.profile));
        log(`uninstall ${effect.profile}: ${result.outcome}`);
      } else if (effect.type === 'launch') {
        await runLaunch(ctx, effect.profile, [], log);
      } else if (effect.type === 'stop') {
        await runStop(ctx, effect.profile, [], log);
      }
      push({ type: 'profiles', profiles: await inventory(ctx) });
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

export { context, inventory, runInstall, runLaunch, runStop, subcommand };
