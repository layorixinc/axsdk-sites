/**
 * X6 live gate (`EXTERNAL_PACK_TASK_PLAN.md`): the published `layorix.service-quotes@1.0.0` travels
 * the PRODUCTION lifecycle against the LIVE unsigned registry — stage-install (two-phase approval),
 * enable, then disable/remove/reset back to a deep-equal baseline — on an EXTERNAL build of the
 * extension (live registry + executor document defines), on a dedicated throwaway profile.
 *
 * Judged by BRANCH AND FIELD, never prose. Hard assertions: the lifecycle outcomes and the restored
 * baseline. One stage is a MEASUREMENT, not an assertion: whether a pack-mode chat session opens
 * against today's backend (AGENTS.md §13: the platform advertises no Pack protocol) — either
 * outcome is recorded evidence, and the teardown runs regardless.
 *
 * Plan deviation, recorded: the plan placed this gate in the SDK; it lives HERE because chat turns
 * belong to this repo's harness and imports flow sites→SDK, never the reverse (the artifact smoke's
 * precedent).
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const SITES_ROOT = resolve(here, '..', '..');
const SDK_PACKAGE = resolve(SITES_ROOT, '..', 'axsdk-sdk-js', 'packages', 'axsdk-extension-cdp');
const EXTERNAL_CONFIG = resolve(here, 'pack-external.config.json');
const REGISTRY_URL = 'https://layorixinc.github.io/axsdk-sites/packs/registry/';
const EXECUTOR_URL = 'https://layorixinc.github.io/axsdk-sites/pack-executor.html';
const PACK_ID = 'layorix.service-quotes';
const PACK_VERSION = '1.0.0';

const checks = [];
function check(name, ok, evidence = '') {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${evidence ? ` — ${String(evidence).slice(0, 160)}` : ''}`);
}
function note(name, evidence) {
  console.log(`NOTE ${name} — ${String(evidence).slice(0, 240)}`);
}

function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

function runExternalBuild() {
  return new Promise((resolveBuild, reject) => {
    const child = spawn('bun', ['run', 'build'], {
      cwd: SDK_PACKAGE,
      env: {
        ...process.env,
        AXSDK_PACK_EXTERNAL: '1',
        AXSDK_PACK_EXTERNAL_CONFIG: EXTERNAL_CONFIG,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let tail = '';
    const keep = (chunk) => { tail = (tail + String(chunk)).slice(-2000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('exit', (code) => {
      if (code === 0) resolveBuild();
      else reject(new Error(`external build exited ${code}: ${tail.slice(-500)}`));
    });
  });
}

/** Sends one production Pack lifecycle message from the REAL options page (sender-gated). */
async function packMessage(evaluate, cdp, optionsSession, message) {
  const reply = await evaluate(cdp, optionsSession,
    `chrome.runtime.sendMessage(${JSON.stringify(message)}).then((value) => JSON.stringify(value ?? null))`);
  return JSON.parse(reply);
}

/**
 * The stable baseline (the phase-2 contract, minus tab ids: this gate's own harness opens tabs, so
 * tabs are asserted separately by the executor probe). Three identical consecutive reads.
 */
const BASELINE_EXPRESSION = `(async () => {
  const registrations = (await chrome.userScripts.getScripts()).map((entry) => entry.id).sort();
  const stored = await chrome.storage.local.get(null);
  const packKeys = Object.keys(stored).filter((key) => key.startsWith('packs:') || key.includes('pack-')).sort();
  const list = await chrome.runtime.sendMessage({ type: 'packs:list' });
  return JSON.stringify({
    registrations,
    packKeys,
    installed: Object.keys(list?.releases ?? {}).length,
    active: list?.activePackSetDigest ?? null,
  });
})()`;

async function readStableBaseline(evaluate, cdp, optionsSession, label) {
  let previous;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const current = await evaluate(cdp, optionsSession, BASELINE_EXPRESSION);
    if (previous !== undefined && current === previous) return current;
    previous = current;
    await new Promise((delay) => setTimeout(delay, 500));
  }
  throw new Error(`${label}: baseline never stabilised`);
}

async function main() {
  const { openCdpSession } = await import('../harness/cdp-session.mjs');
  const { ensureExtension, evaluate, launchChrome, waitFor } = await import(
    `file://${SDK_PACKAGE.replaceAll('\\', '/')}/scripts/browser-session.mjs`);
  const { HARNESS_PROFILE } = await import(
    `file://${SDK_PACKAGE.replaceAll('\\', '/')}/scripts/harness-config.mjs`);

  console.log('stage: external build');
  await runExternalBuild();

  const temp = await mkdtemp(join(tmpdir(), 'axsdk-pack-external-'));
  process.env.AXSDK_PROFILE_ROOT = join(temp, 'profiles');
  const port = await availablePort();
  const dist = join(SDK_PACKAGE, 'dist');

  let session;
  let launched;
  let optionsSession;
  try {
    console.log('stage: launch dedicated profile');
    launched = await launchChrome({ profileName: HARNESS_PROFILE, profileRoot: process.env.AXSDK_PROFILE_ROOT, port });
    let extension = await ensureExtension(launched.cdp, dist);
    optionsSession = extension.options.sessionId;

    console.log('stage: allow user scripts');
    // Measured 2026-09-03 on a FRESH profile: developer mode must be ON first (without it the
    // per-extension toggle silently does nothing), and once devMode + the row are on the
    // `chrome.userScripts` namespace appears IMMEDIATELY — no reload, no restart. A restart is
    // actively harmful here: `Extensions.loadUnpacked` re-install RESETS the row to off.
    if (!(await evaluate(launched.cdp, optionsSession, "typeof chrome.userScripts !== 'undefined'"))) {
      const page = await launched.cdp.send('Target.createTarget', {
        url: `chrome://extensions/?id=${extension.extensionId}`,
      });
      const webUi = await launched.cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
      await waitFor(async () => evaluate(launched.cdp, webUi.sessionId, `(() => {
        const find = (node, depth, selector) => {
          if (!node || depth > 14) return undefined;
          const hit = node.querySelector?.(selector);
          if (hit) return hit;
          for (const el of node.querySelectorAll('*')) {
            if (el.shadowRoot) {
              const nested = find(el.shadowRoot, depth + 1, selector);
              if (nested) return nested;
            }
          }
          return undefined;
        };
        const devMode = find(document, 0, 'cr-toggle#devMode');
        if (devMode && !devMode.checked) { devMode.click(); return undefined; }
        const row = find(document, 0, 'extensions-toggle-row#allow-user-scripts');
        if (!row) return undefined;
        if (!row.checked) { row.shadowRoot.querySelector('#crToggle').click(); return undefined; }
        return true;
      })()`), 'Allow User Scripts toggle on', 30_000);
      await launched.cdp.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
      await waitFor(async () => (await evaluate(launched.cdp, optionsSession,
        "typeof chrome.userScripts !== 'undefined'")) === true || undefined,
      'chrome.userScripts to appear', 15_000);
    }

    console.log('stage: baseline before');
    // `packs:reset` WRITES an empty lifecycle state rather than deleting the key, so a profile that
    // has been reset differs BY ONE KEY from one never touched. Resetting first makes both baselines
    // the same representation and keeps the comparison byte-strict.
    await packMessage(evaluate, launched.cdp, optionsSession, { type: 'packs:reset' });
    const baselineBefore = await readStableBaseline(evaluate, launched.cdp, optionsSession, 'before');
    const registriesView = await packMessage(evaluate, launched.cdp, optionsSession, { type: 'packs:list' });
    check('external build carries the live registry',
      JSON.stringify(registriesView?.state?.registries ?? []).includes('layorix-packs'),
      JSON.stringify(registriesView?.state?.registries ?? []).slice(0, 120));

    console.log('stage: open harness session (no composition)');
    session = await openCdpSession({ workspace: SITES_ROOT, port, reuse: false, extensionDir: dist });
    await session.reset();
    const empty = await session.send('팩 카탈로그 보여줘', { timeoutMs: 120000 });
    check('empty catalog answers honestly before any install',
      /설치된 에이전트 팩이 없|no packs/i.test(String(empty.text)), String(empty.text).slice(0, 80));

    console.log('stage: production install from the live registry');
    const staged = await packMessage(evaluate, launched.cdp, optionsSession, {
      type: 'packs:stage-install', registryUrl: REGISTRY_URL, packId: PACK_ID, version: PACK_VERSION,
    });
    check('stage-install previews from the live registry', staged?.ok === true
      && /^sha256:[0-9a-f]{64}$/.test(String(staged?.approvalDigest)),
      staged?.ok === true ? staged.approvalDigest : JSON.stringify(staged).slice(0, 200));
    if (staged?.ok !== true) throw new Error('stage-install refused; cannot continue');

    const approved = await packMessage(evaluate, launched.cdp, optionsSession, {
      type: 'packs:approve-install', approvalDigest: staged.approvalDigest, approval: staged.approval,
    });
    check('two-phase approval installs the exact staged release', approved?.ok === true,
      JSON.stringify(approved).slice(0, 200));

    const afterInstall = await packMessage(evaluate, launched.cdp, optionsSession, { type: 'packs:list' });
    const releaseRows = afterInstall?.state?.releases ?? [];
    const releaseDigest = (Array.isArray(releaseRows)
      ? releaseRows.find((row) => JSON.stringify(row).includes(PACK_ID))?.releaseDigest
      : Object.keys(releaseRows).find((digestKey) => JSON.stringify(releaseRows[digestKey]).includes(PACK_ID)));
    check('installed release is listed with our pack id', typeof releaseDigest === 'string', releaseDigest);

    const enabled = await packMessage(evaluate, launched.cdp, optionsSession, {
      type: 'packs:enable', releaseDigest,
    });
    check('enable activates a composition', enabled?.ok === true, JSON.stringify(enabled).slice(0, 200));
    const activeView = await packMessage(evaluate, launched.cdp, optionsSession, { type: 'packs:list' });
    check('active pack-set digest is present after enable',
      typeof activeView?.state?.activePackSetDigest === 'string', activeView?.state?.activePackSetDigest);

    console.log('stage: MEASUREMENT — pack-mode session against today\'s backend');
    let packModeOutcome;
    try {
      await session.reset();
      const turn = await session.send('팩 카탈로그 보여줘', { timeoutMs: 120000 });
      packModeOutcome = `opened; reply: ${String(turn.text).slice(0, 160)} | tools: ${(turn.toolCalls ?? []).map((call) => call.name).join('>')}`;
    } catch (error) {
      packModeOutcome = `refused/timed out: ${String(error.message).slice(0, 220)}`;
    }
    note('pack-mode session measurement', packModeOutcome);

    const executorTabs = await evaluate(launched.cdp, optionsSession,
      `chrome.tabs.query({}).then((tabs) => JSON.stringify(tabs.map((tab) => tab.url).filter((url) => url === ${JSON.stringify(EXECUTOR_URL)})))`);
    note('executor tabs after activation', executorTabs);

    const registrationsNow = await evaluate(launched.cdp, optionsSession,
      '(async () => JSON.stringify((await chrome.userScripts.getScripts()).map((entry) => entry.id).sort()))()');
    check('no persistent userScripts registration appeared',
      registrationsNow === JSON.stringify(JSON.parse(baselineBefore).registrations),
      registrationsNow);

    console.log('stage: end live sessions (product-shaped: close the agent tab group)');
    // A refused/timed-out pack-mode session still CLAIMS the client-side pin at worker init, and the
    // manager refuses disable/remove/reset while any live session pins the composition. Closing the
    // session's tab group is how a USER ends a session, and it releases the pin.
    const closedGroups = await evaluate(launched.cdp, optionsSession, `(async () => {
      const groups = await chrome.tabGroups.query({});
      for (const group of groups) {
        const tabs = await chrome.tabs.query({ groupId: group.id });
        await chrome.tabs.remove(tabs.map((tab) => tab.id)).catch(() => {});
      }
      return groups.length;
    })()`);
    note('closed agent tab groups', closedGroups);
    await new Promise((delay) => setTimeout(delay, 3_000));

    console.log('stage: teardown lifecycle');
    const disabled = await packMessage(evaluate, launched.cdp, optionsSession, { type: 'packs:disable', packId: PACK_ID });
    check('disable succeeds', disabled?.ok === true, JSON.stringify(disabled).slice(0, 160));
    const removed = await packMessage(evaluate, launched.cdp, optionsSession, { type: 'packs:remove', releaseDigest });
    check('remove succeeds', removed?.ok === true, JSON.stringify(removed).slice(0, 160));
    const resetReply = await packMessage(evaluate, launched.cdp, optionsSession, { type: 'packs:reset' });
    note('manager reset', JSON.stringify(resetReply).slice(0, 160));

    const executorGone = await (async () => {
      for (let attempt = 0; attempt < 15; attempt += 1) {
        const open = JSON.parse(await evaluate(launched.cdp, optionsSession,
          `chrome.tabs.query({}).then((tabs) => JSON.stringify(tabs.map((tab) => tab.url).filter((url) => url === ${JSON.stringify(EXECUTOR_URL)})))`));
        if (open.length === 0) return true;
        await new Promise((delay) => setTimeout(delay, 1_000));
      }
      return false;
    })();
    check('executor tab is closed after removal', executorGone);

    console.log('stage: baseline after');
    const baselineAfter = await readStableBaseline(evaluate, launched.cdp, optionsSession, 'after');
    check('profile baseline is deep-equal after the full lifecycle', baselineAfter === baselineBefore,
      baselineAfter === baselineBefore ? '' : `before=${baselineBefore} after=${baselineAfter}`);
  } finally {
    try { await session?.shutdown?.(); } catch { /* dedicated browser teardown */ }
    try { launched?.cdp?.close(); } catch { /* released below */ }
    launched?.chrome?.unref?.();
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }

  const failed = checks.filter((entry) => !entry.ok);
  console.log(`PACK EXTERNAL LIVE: ${checks.length - failed.length}/${checks.length} PASS`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

// A runner that does work at import time drives a browser (§13); the guard is the contract.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('FATAL', (error && error.stack) || error);
    process.exitCode = 1;
  });
}
