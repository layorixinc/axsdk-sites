import assert from 'node:assert/strict';
import { test } from 'bun:test';

import { launchHeaded, stopHeaded } from './src/ops/session.ts';

/**
 * The capability the decisions are allowed to reach. It records every call, because most of what
 * this stage promises is about what must NOT happen: no relaunch of a browser that is already up,
 * no toggle written by the command whose job is to report, and no graceful close by the command
 * whose job is to leave the browser running.
 */
function fakeBrowser({
  reused = false, present = true, toggles = true, pid = 4242,
  quietAfterStop = true, upBeforeStop = true, failOpen,
} = {}) {
  const calls = [];
  const record = { running: undefined };
  let stopped = false;
  return {
    calls,
    record,
    async open(target) {
      calls.push(`open:${target.detached === true ? 'detached' : 'attached'}`);
      if (failOpen) throw new Error(failOpen);
      return {
        extensionId: 'ihdaghiiieaomningbeokfdkcpnpihpb',
        attachedDist: 'D:/dist',
        present,
        recordedFingerprint: '9f3c2a1e',
        reused,
        pid: reused ? undefined : pid,
      };
    },
    async userScriptsReady() { return toggles; },
    async openTab(url) { calls.push(`openTab:${url}`); },
    async release() { calls.push('release'); },
    async close() { calls.push('close'); },
    async relaunch() { calls.push('relaunch'); },
    async setDevMode() { calls.push('setDevMode'); },
    async setUserScriptsRow() { calls.push('setUserScriptsRow'); },
    async reachable() { return stopped ? !quietAfterStop : upBeforeStop; },
    async stopAt(port) { calls.push(`stopAt:${port}`); stopped = true; },
    async recordRunning(entry) { calls.push(`recordRunning:${entry.profile}`); record.running = entry; },
    async clearRunning(name) { calls.push(`clearRunning:${name}`); record.running = undefined; },
  };
}

const at = { profile: 'packdev', port: 39701, dist: 'D:/dist', kind: 'axde' };

test('launch spawns DETACHED and leaves the browser running: it never closes what it started', async () => {
  const browser = fakeBrowser();
  const result = await launchHeaded(browser, at);
  assert.equal(result.outcome, 'launched');
  assert.equal(result.port, 39701);
  assert.equal(result.pid, 4242);
  assert.ok(browser.calls.includes('open:detached'), `detached spawn, got ${browser.calls.join(',')}`);
  assert.ok(browser.calls.includes('release'), 'the CDP connection is released');
  assert.ok(!browser.calls.includes('close'), 'a graceful close would defeat the whole command');
});

test('a browser already listening is REUSED, never relaunched — a relaunch kills a live session', async () => {
  const browser = fakeBrowser({ reused: true });
  const result = await launchHeaded(browser, at);
  assert.equal(result.outcome, 'already-running');
  assert.ok(!browser.calls.includes('relaunch'), browser.calls.join(','));
  assert.ok(!browser.calls.includes('close'));
});

test('launch REPORTS the extension state and repairs nothing — install stays the single writer', async () => {
  const browser = fakeBrowser({ toggles: false });
  const result = await launchHeaded(browser, at);
  assert.equal(result.userScripts, false);
  assert.equal(result.extension, 'up');
  assert.match(result.fix, /ext install/, 'the answer names the command that repairs it');
  assert.ok(!browser.calls.includes('setDevMode'), browser.calls.join(','));
  assert.ok(!browser.calls.includes('setUserScriptsRow'));
});

test('an absent extension is named as absent rather than reported as a controllable browser', async () => {
  const result = await launchHeaded(fakeBrowser({ present: false }), at);
  assert.equal(result.extension, 'absent');
  assert.match(result.fix, /ext install/);
});

test('launching a profile axde did not create is refused BY NAME unless forced', async () => {
  const browser = fakeBrowser();
  await assert.rejects(
    () => launchHeaded(browser, { ...at, profile: 'axsdk-extension-cdp', kind: 'foreign' }),
    /refused: axde did not create "axsdk-extension-cdp"/,
  );
  assert.deepEqual(browser.calls, [], 'a refused launch touches no browser at all');
  const forced = await launchHeaded(browser, { ...at, kind: 'foreign', force: true });
  assert.equal(forced.outcome, 'launched');
});

test('a start url is applied on the REUSE path too, where no launch flag can carry it', async () => {
  const fresh = fakeBrowser();
  await launchHeaded(fresh, { ...at, url: 'https://www.amazon.com/' });
  assert.ok(!fresh.calls.some((one) => one.startsWith('openTab')), 'a spawn carries it as an argument');

  const running = fakeBrowser({ reused: true });
  await launchHeaded(running, { ...at, url: 'https://www.amazon.com/' });
  assert.ok(running.calls.includes('openTab:https://www.amazon.com/'), running.calls.join(','));
});

test('the running record is written only for a launch that came up, and carries the pid', async () => {
  const browser = fakeBrowser();
  await launchHeaded(browser, at);
  // The name must travel WITH the call: the adapter has no session on the stop path, so a
  // closure variable set by an earlier `open` is not there to read (measured 2026-09-04 — the record
  // survived a stop because the clear threw on an undefined profile and a catch swallowed it).
  assert.ok(browser.calls.includes('recordRunning:packdev'), browser.calls.join(','));
  assert.equal(browser.record.running.pid, 4242);
  assert.equal(browser.record.running.port, 39701);
  assert.match(browser.record.running.startedAt, /^\d{4}-\d{2}-\d{2}T/);

  const failing = fakeBrowser({ failOpen: 'Chrome to accept a debugger connection: timed out' });
  await assert.rejects(() => launchHeaded(failing, at), /debugger connection/);
  assert.equal(failing.record.running, undefined, 'a browser that never came up records nothing');
});

test('stop closes gracefully and only then clears the record — killing loses the toggles', async () => {
  const browser = fakeBrowser();
  const result = await stopHeaded(browser, at);
  assert.equal(result.outcome, 'stopped');
  assert.deepEqual(browser.calls, ['stopAt:39701', 'clearRunning:packdev']);
});

test('a port still answering after the close is a FAILURE, never a reported success', async () => {
  const browser = fakeBrowser({ quietAfterStop: false });
  await assert.rejects(() => stopHeaded(browser, at), /still answering on 39701/);
  assert.ok(!browser.calls.includes('clearRunning:packdev'), 'a record cleared here would hide a live browser');
});

test('stopping a browser that is already quiet says so and clears a stale record', async () => {
  const browser = fakeBrowser({ upBeforeStop: false });
  const result = await stopHeaded(browser, at);
  assert.equal(result.outcome, 'already-stopped');
  assert.ok(!browser.calls.includes('stopAt:39701'), browser.calls.join(','));
  assert.ok(browser.calls.includes('clearRunning:packdev'));
});

test('stopping a profile axde did not create is refused BY NAME unless forced', async () => {
  const browser = fakeBrowser();
  await assert.rejects(
    () => stopHeaded(browser, { ...at, profile: 'axsdk-extension-cdp', kind: 'foreign' }),
    /refused: axde did not create "axsdk-extension-cdp"/,
  );
  assert.deepEqual(browser.calls, []);
});
