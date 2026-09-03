import assert from 'node:assert/strict';
import test from 'node:test';

import { extensionStatus, installExtension, uninstallExtension } from './src/ops/extension.mjs';

/**
 * The install mechanism, decided by measurement on 2026-09-03 rather than by preference:
 *
 * - CDP `Extensions.loadUnpacked` registers the build for THAT BROWSER SESSION ONLY. Measured: an
 *   install reported success, the browser was closed, and the very next `ext status` on the same
 *   profile read `installed false`.
 * - `--load-extension` + a GRACEFUL `Browser.close` is durable: the extension is present on every
 *   later launch, its service worker registers, and developer mode + the Allow-User-Scripts row
 *   persist (`chrome.userScripts` is there after a restart). Killing the browser instead loses all
 *   of it, because Chrome writes `Preferences` during shutdown.
 *
 * So installing is: ATTACH the build to the profile, RELAUNCH so Chrome loads it, enable the two
 * toggles once, and RECORD the fingerprint. The fake below refuses what the real thing refuses and
 * persists what the real thing persists.
 */
function fakeBrowser({ attachedDist, recorded, toggles = false, failAttach, presentAfterUninstall = false } = {}) {
  const calls = [];
  const state = {
    attachedDist,
    recorded,
    devMode: toggles,
    row: toggles,
    present: attachedDist !== undefined,
    presentAfterUninstall,
  };
  return {
    calls,
    async open() {
      calls.push('open');
      return {
        extensionId: 'ihdaghiiieaomningbeokfdkcpnpihpb',
        present: state.present,
        recordedFingerprint: state.present ? state.recorded : undefined,
        attachedDist: state.attachedDist,
      };
    },
    async attachBuild(dist) {
      calls.push(`attach:${dist}`);
      if (failAttach !== undefined) throw new Error(failAttach);
      state.attachedDist = dist;
    },
    async detachBuild() { calls.push('detach'); state.attachedDist = undefined; },
    async relaunch() {
      calls.push('relaunch');
      // Chrome loads whatever is attached, and the persisted toggles survive a graceful close.
      state.present = state.attachedDist !== undefined;
    },
    async setDevMode(on) { calls.push(`devMode:${on}`); state.devMode = on; },
    async setUserScriptsRow(on) {
      calls.push(`row:${on}`);
      if (state.devMode) state.row = on;
    },
    async userScriptsReady() { calls.push('ready?'); return state.present && state.devMode && state.row; },
    async recordBuild(fingerprint) { calls.push(`record:${fingerprint}`); state.recorded = fingerprint; },
    async uninstall(id) {
      calls.push(`uninstall:${id}`);
      state.present = state.presentAfterUninstall;
    },
    async lastUncaughtError() { calls.push('log?'); return undefined; },
    async close() { calls.push('close'); },
  };
}

const target = { profile: 'packdev', port: 39701, dist: 'D:/dist', fingerprint: '9f3c2a1e' };

test('a profile already carrying this exact build is left alone', async () => {
  // A relaunch would kill whatever session the developer is looking at.
  const browser = fakeBrowser({ attachedDist: 'D:/dist', recorded: '9f3c2a1e', toggles: true });
  const result = await installExtension(browser, target);
  assert.equal(result.outcome, 'up-to-date');
  assert.ok(!browser.calls.some((call) => call === 'relaunch' || call.startsWith('attach:')), browser.calls.join(','));
  assert.equal(browser.calls.at(-1), 'close');
});

test('a fresh install attaches, relaunches, enables both toggles, then records the build', async () => {
  const browser = fakeBrowser();
  const result = await installExtension(browser, target);
  assert.equal(result.outcome, 'installed');
  assert.equal(result.userScripts, true);
  const order = browser.calls.filter((call) => /attach|relaunch|devMode|row|record/.test(call));
  assert.deepEqual(order, [
    'attach:D:/dist', 'relaunch', 'devMode:true', 'row:true', 'record:9f3c2a1e',
  ], 'the build must be loaded before its toggles can be set, and recorded only once it is up');
});

test('a build that changed on disk is re-attached and relaunched', async () => {
  const browser = fakeBrowser({ attachedDist: 'D:/dist', recorded: '41ab77c2', toggles: true });
  const result = await installExtension(browser, target);
  assert.equal(result.outcome, 'installed');
  assert.ok(browser.calls.includes('relaunch'), 'Chrome only picks up a new build at launch');
  assert.equal(result.fingerprint, '9f3c2a1e');
});

test('a profile whose toggles are off is repaired without re-attaching the same build', async () => {
  const browser = fakeBrowser({ attachedDist: 'D:/dist', recorded: '9f3c2a1e', toggles: false });
  const result = await installExtension(browser, target);
  assert.equal(result.outcome, 'repaired');
  assert.equal(result.userScripts, true);
  assert.ok(!browser.calls.some((call) => call.startsWith('attach:')), 'nothing to re-attach');
  assert.deepEqual(browser.calls.filter((call) => /devMode|row/.test(call)), ['devMode:true', 'row:true']);
});

test('a refused attach carries its RAW reason and still closes the browser', async () => {
  const browser = fakeBrowser({ failAttach: 'EACCES: permission denied' });
  await assert.rejects(() => installExtension(browser, target), /EACCES: permission denied/);
  assert.equal(browser.calls.at(-1), 'close');
});

test('an install that cannot reach user scripts refuses instead of claiming success', async () => {
  const browser = fakeBrowser();
  browser.setDevMode = async () => { browser.calls.push('devMode:noop'); };
  await assert.rejects(() => installExtension(browser, target), /user scripts/i);
});

test('uninstall detaches the build and RELAUNCHES, because a flag-loaded build cannot be removed live', async () => {
  // Measured 2026-09-03: CDP `Extensions.uninstall` removes a loadUnpacked install, and does NOT
  // remove one Chrome was given on the command line — the profile answered "still reachable" every
  // time. Detaching and letting Chrome start without the flag is what actually removes it.
  const browser = fakeBrowser({ attachedDist: 'D:/dist', recorded: '9f3c2a1e', toggles: true });
  const result = await uninstallExtension(browser, target);
  assert.equal(result.outcome, 'uninstalled');
  assert.deepEqual(browser.calls.filter((call) => /detach|relaunch|uninstall:/.test(call)), ['detach', 'relaunch']);
});

test('uninstalling a profile that carries nothing answers absent and touches nothing', async () => {
  const browser = fakeBrowser();
  const result = await uninstallExtension(browser, target);
  assert.equal(result.outcome, 'absent');
  assert.ok(!browser.calls.some((call) => call === 'detach' || call === 'relaunch'));
});

test('an uninstall that leaves the extension reachable is a FAILURE, never a success', async () => {
  const browser = fakeBrowser({ attachedDist: 'D:/dist', recorded: '9f3c2a1e' });
  browser.relaunch = async () => { browser.calls.push('relaunch:noop'); };
  await assert.rejects(() => uninstallExtension(browser, target), /still reachable/i);
});

test('status reports what was read, and marks a build that no longer matches dist', async () => {
  const browser = fakeBrowser({ attachedDist: 'D:/dist', recorded: '41ab77c2', toggles: true });
  assert.deepEqual(await extensionStatus(browser, target), {
    profile: 'packdev',
    extensionId: 'ihdaghiiieaomningbeokfdkcpnpihpb',
    installed: true,
    attachedDist: 'D:/dist',
    fingerprint: '41ab77c2',
    stale: true,
    userScripts: true,
    lastError: undefined,
  });
});

test('status surfaces the last uncaught worker error — the only place a silent worker speaks', async () => {
  const browser = fakeBrowser({ attachedDist: 'D:/dist', recorded: '9f3c2a1e', toggles: true });
  browser.lastUncaughtError = async () => 'Uncaught Error: External Pack configuration is missing schemaVersion';
  const status = await extensionStatus(browser, target);
  assert.match(status.lastError, /missing schemaVersion/);
  assert.equal(status.stale, false);
});

test('status on an empty profile calls nothing stale — unknown stays unknown', async () => {
  const status = await extensionStatus(fakeBrowser(), target);
  assert.equal(status.installed, false);
  assert.equal(status.stale, false);
  assert.equal(status.fingerprint, undefined);
});
