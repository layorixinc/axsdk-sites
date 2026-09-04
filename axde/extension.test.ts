import assert from 'node:assert/strict';
import { test } from 'bun:test';

import { extensionStatus, installExtension, uninstallExtension } from './src/ops/extension.ts';

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
function fakeBrowser({
  attachedDist, recorded, toggles = false, failAttach, presentAfterUninstall = false, reused = false,
} = {}) {
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
        reused,
      };
    },
    async attachBuild(dist) {
      calls.push(`attach:${dist}`);
      if (failAttach !== undefined) throw new Error(failAttach);
      state.attachedDist = dist;
    },
    async detachBuild() { calls.push('detach'); state.attachedDist = undefined; },
    // Measured 2026-09-04: `chrome.runtime.reload()` RE-READS the unpacked build from disk (a
    // field planted in the dist manifest appeared afterwards), so a CONTENT change needs no
    // relaunch — and a relaunch would take down the browser `axde launch` left running.
    async refresh() {
      calls.push('refresh');
      state.present = state.attachedDist !== undefined;
      return { present: state.present, recordedFingerprint: state.recorded };
    },
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
    async release() { calls.push('release'); },
    // "Leave it as you found it": close only a browser this process launched.
    async finish() { calls.push(reused ? 'release' : 'close'); },
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

/**
 * SUPERSEDED by the refresh branch, and the property is the same one: a build that changed on disk
 * is APPLIED. The mechanism moved because a relaunch was measured to be unnecessary for a content
 * change — `chrome.runtime.reload()` re-reads the unpacked build — and harmful, because it takes
 * down the browser `axde launch` left running.
 */
test('a build that changed on disk is applied without a relaunch', async () => {
  const browser = fakeBrowser({ attachedDist: 'D:/dist', recorded: '41ab77c2', toggles: true });
  const result = await installExtension(browser, target);
  assert.equal(result.outcome, 'refreshed');
  assert.ok(browser.calls.includes('refresh'), browser.calls.join(','));
  assert.ok(!browser.calls.includes('relaunch'), 'Chrome re-reads an unpacked build on reload');
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

test('a READ leaves a browser it did not launch running — stage 2a leaves one up on purpose', async () => {
  // Measured 2026-09-04: `profile ls` read the row as `up` and then closed the browser `launch` had
  // deliberately left running, so the very next launch found a dead port and silently spawned a
  // second Chrome. A read that destroys what it reports on is not a read.
  const browser = fakeBrowser({ attachedDist: 'D:/dist', recorded: '9f3c2a1e', toggles: true, reused: true });
  await extensionStatus(browser, target);
  assert.ok(browser.calls.includes('release'), browser.calls.join(','));
  assert.ok(!browser.calls.includes('close'), 'closing a browser this command found running is destructive');
});

test('a browser the read LAUNCHED is closed gracefully, so it leaves nothing behind', async () => {
  const browser = fakeBrowser({ attachedDist: 'D:/dist', recorded: '9f3c2a1e', toggles: true });
  await extensionStatus(browser, target);
  assert.ok(browser.calls.includes('close'), browser.calls.join(','));
  assert.ok(!browser.calls.includes('release'));
});

/**
 * A build whose CONTENT changed is applied by refreshing the extension, not by relaunching Chrome.
 *
 * Measured 2026-09-04: `chrome.runtime.reload()` from the options page re-reads the unpacked build
 * from disk — a `short_name` planted in the dist manifest was visible afterwards — and the service
 * worker target changed while the browser stayed up. A relaunch would kill whatever session `axde
 * launch` had deliberately left running (stage 2a).
 */
test('a content-only change REFRESHES the extension and leaves the browser up', async () => {
  const browser = fakeBrowser({ attachedDist: 'D:/dist', recorded: 'old-print', toggles: true });
  const result = await installExtension(browser, { ...target, fingerprint: 'new-print' });

  assert.equal(result.outcome, 'refreshed');
  assert.ok(browser.calls.includes('refresh'), browser.calls.join(','));
  assert.ok(!browser.calls.includes('relaunch'), 'a relaunch would take the browser down');
  assert.ok(!browser.calls.some((call) => call.startsWith('attach')), 'the attachment did not change');
  assert.ok(browser.calls.includes('record:new-print'), 'and the new build is recorded');
});

test('an ATTACHMENT change still relaunches, because Chrome reads the flag at launch', async () => {
  const browser = fakeBrowser({ attachedDist: 'D:/old-dist', recorded: 'old-print', toggles: true });
  const result = await installExtension(browser, { ...target, fingerprint: 'new-print' });

  assert.equal(result.outcome, 'installed');
  assert.ok(browser.calls.includes('attach:D:/dist'), browser.calls.join(','));
  assert.ok(browser.calls.includes('relaunch'));
  assert.ok(!browser.calls.includes('refresh'));
});

test('a refresh that leaves the extension unreachable is a FAILURE, never a success', async () => {
  const browser = fakeBrowser({ attachedDist: 'D:/dist', recorded: 'old-print', toggles: true });
  browser.refresh = async () => { browser.calls.push('refresh'); return { present: false }; };

  await assert.rejects(
    () => installExtension(browser, { ...target, fingerprint: 'new-print' }),
    /did not come up/,
  );
});

test('a refreshed extension has its toggles re-checked: the worker restarted', async () => {
  // The row a careless refresh misses. Developer mode and the row persist on disk, but
  // `chrome.userScripts` is answered by a NEW worker, so it has to be asked again.
  const browser = fakeBrowser({ attachedDist: 'D:/dist', recorded: 'old-print', toggles: true });
  await installExtension(browser, { ...target, fingerprint: 'new-print' });
  // The contract is ORDER, not count: the answer must come from the new worker, so the question is
  // asked AFTER the refresh. `ensureUserScripts` asks once and returns early when it is already on.
  const order = browser.calls.filter((call) => call === 'refresh' || call === 'ready?');
  assert.deepEqual(order, ['refresh', 'ready?'], browser.calls.join(','));
});

test('install leaves a browser it ADOPTED running — the same rule a read follows', async () => {
  // Measured live 2026-09-04: the refresh applied the new build and the `finally` then closed the
  // browser `axde launch` had left up, so "a changed build without a relaunch" was true and useless.
  // `finish()` closes only what this process launched (stage 2a).
  const browser = fakeBrowser({ attachedDist: 'D:/dist', recorded: 'old-print', toggles: true, reused: true });
  await installExtension(browser, { ...target, fingerprint: 'new-print' });

  assert.ok(browser.calls.includes('release'), browser.calls.join(','));
  assert.ok(!browser.calls.includes('close'), 'closing an adopted browser is destructive');
});

test('a browser install LAUNCHED is still closed gracefully, so the toggles reach disk', async () => {
  const browser = fakeBrowser({ attachedDist: 'D:/dist', recorded: 'old-print', toggles: true });
  await installExtension(browser, { ...target, fingerprint: 'new-print' });

  assert.ok(browser.calls.includes('close'), browser.calls.join(','));
  assert.ok(!browser.calls.includes('release'));
});
