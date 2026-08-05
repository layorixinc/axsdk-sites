import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CdpClient, attachAfterExtensionReload, closePageOnFailure, isQuotaError, prepareReloadedPage, prunableDebugKeys,
  disposableChatKeys, reclaimPlan, shouldPruneDebugStorage,
  resetSession,
} from './cdp.mjs';

// A dev profile accumulates per-session chat and SSE telemetry until chrome.storage.local is full, and
// then every store sync fails with an opaque quota error. Only telemetry is ever reclaimable.
test('only debug telemetry keys are reclaimable', () => {
  const keys = [
    'axsdk:lua',
    'axsdk:flows',
    'axsdk:sites',
    'axsdk:binding:abc:chat',
    'axsdk:binding:abc:sse-events',
    'axsdk:binding:def:debug-events',
  ];
  assert.deepEqual(prunableDebugKeys(keys), ['axsdk:binding:abc:sse-events', 'axsdk:binding:def:debug-events']);
  assert.deepEqual(prunableDebugKeys([]), []);
});

test('a quota failure is recognised from the extension error text', () => {
  assert.equal(isQuotaError(new Error('Uncaught (in promise) Error: Resource::kQuotaBytes quota exceeded')), true);
  assert.equal(isQuotaError(new Error('QUOTA_BYTES quota exceeded')), true);
  assert.equal(isQuotaError(new Error('Cannot find context with specified id')), false);
  assert.equal(isQuotaError(null), false);
});

function fakeSocket() {
  const listeners = new Map();
  return {
    sent: [],
    closed: false,
    addEventListener(type, listener) {
      const existing = listeners.get(type) ?? new Set();
      existing.add(listener);
      listeners.set(type, existing);
    },
    emit(type, event = {}) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    send(payload) { this.sent.push(payload); },
    close() { this.closed = true; },
  };
}

test('closes a newly attached page when reload readiness fails', async () => {
  let closes = 0;
  const page = { close: () => { closes += 1; } };

  await assert.rejects(
    () => closePageOnFailure(page, async () => {
      throw new Error('runtime unavailable');
    }),
    /runtime unavailable/i,
  );
  assert.equal(closes, 1);
});

test('preserves a successfully prepared page for the caller', async () => {
  let closes = 0;
  const page = { close: () => { closes += 1; } };
  const value = await closePageOnFailure(page, async () => ({ ready: true }));

  assert.deepEqual(value, { ready: true });
  assert.equal(closes, 0);
});

test('skips Lua readiness only when a caller explicitly requests setup-prompt reload', async () => {
  let closes = 0;
  let navigations = 0;
  let readinessChecks = 0;
  const page = { close: () => { closes += 1; } };

  const result = await prepareReloadedPage(page, {
    destination: 'https://axsdk.ai/',
    target: { id: 'target' },
    extensionId: 'extension-id',
    options: {},
    waitForRuntime: false,
    navigatePage: async () => { navigations += 1; },
    waitForRuntimeFn: async () => { readinessChecks += 1; },
  });

  assert.deepEqual(result, {
    page,
    target: { id: 'target' },
    reloaded: true,
    extensionId: 'extension-id',
    url: 'https://axsdk.ai/',
  });
  assert.equal(navigations, 1);
  assert.equal(readinessChecks, 0);
  assert.equal(closes, 0);
});

test('fails attachment when the target never completes the WebSocket handshake', async () => {
  const socket = fakeSocket();
  const client = new CdpClient('ws://dead-target', { connectTimeoutMs: 5, createSocket: () => socket });

  await assert.rejects(() => client.ready, /Timed out attaching to ws:\/\/dead-target/);
  await assert.rejects(() => client.send('Page.enable'), /Timed out attaching to ws:\/\/dead-target/);
  assert.equal(socket.sent.length, 0);
});

// send() awaits the handshake before it registers the request, so the fake socket only observes the
// frame on the next macrotask; the flush keeps these tests off that race.
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('fails in-flight requests when the socket drops mid-operation', async () => {
  const socket = fakeSocket();
  const client = new CdpClient('ws://live-target', { connectTimeoutMs: 50, createSocket: () => socket });
  socket.emit('open');
  await client.ready;

  const pending = client.send('Runtime.evaluate', { expression: '1' });
  await flush();
  assert.equal(socket.sent.length, 1);
  socket.emit('close');

  await assert.rejects(() => pending, /CDP socket closed/);
  await assert.rejects(() => client.send('Page.enable'), /CDP socket closed/);
});

test('resolves requests routed back over an open socket', async () => {
  const socket = fakeSocket();
  const client = new CdpClient('ws://live-target', { connectTimeoutMs: 50, createSocket: () => socket });
  socket.emit('open');

  const pending = client.send('Runtime.evaluate', { expression: '1 + 1' });
  await flush();
  socket.emit('message', { data: JSON.stringify({ id: 1, result: { value: 2 } }) });

  assert.deepEqual(await pending, { value: 2 });
});

test('reuses a live tab after an extension reload', async () => {
  let opened = 0;
  const result = await attachAfterExtensionReload('http://127.0.0.1:9235', {}, 'https://axsdk.ai/', {
    listTargetsFn: async () => [{ type: 'page', url: 'https://axsdk.ai/ko' }],
    attachActiveFn: async () => ({ page: { id: 'live' }, target: { url: 'https://axsdk.ai/ko' } }),
    openPageFn: async () => { opened += 1; return { id: 'fresh' }; },
  });

  assert.deepEqual(result.page, { id: 'live' });
  assert.equal(opened, 0);
});

test('opens a fresh tab when only the destroyed extension target remains', async () => {
  let attaches = 0;
  const result = await attachAfterExtensionReload('http://127.0.0.1:9235', {}, 'https://axsdk.ai/', {
    listTargetsFn: async () => [{ type: 'page', url: 'chrome-extension://id/options.html' }],
    attachActiveFn: async () => { attaches += 1; throw new Error('should not attach'); },
    openPageFn: async (cdpUrl, url) => ({ id: 'fresh', url }),
  });

  assert.deepEqual(result, { page: { id: 'fresh', url: 'https://axsdk.ai/' }, target: null });
  assert.equal(attaches, 0);
});

test('opens a fresh tab when the target list cannot be read', async () => {
  const result = await attachAfterExtensionReload('http://127.0.0.1:9235', {}, 'https://axsdk.ai/', {
    listTargetsFn: async () => { throw new Error('endpoint unavailable'); },
    attachActiveFn: async () => { throw new Error('should not attach'); },
    openPageFn: async () => ({ id: 'fresh' }),
  });

  assert.deepEqual(result, { page: { id: 'fresh' }, target: null });
});

// The extension's per-session chat + SSE telemetry grows until chrome.storage.local is full, and then
// durable calls fail mid-flow ("could not persist before navigation"). A live comparison lost a whole
// store to this, so the harness reclaims telemetry before it reaches the ceiling, not after.
test('storage is reclaimed before the quota actually bites', () => {
  const quota = 10 * 1024 * 1024;
  assert.equal(shouldPruneDebugStorage(quota * 0.5, quota), false);
  assert.equal(shouldPruneDebugStorage(quota * 0.79, quota), false);
  assert.equal(shouldPruneDebugStorage(quota * 0.81, quota), true);
  assert.equal(shouldPruneDebugStorage(quota, quota), true);
});

test('an unknown usage reading never triggers a blind prune', () => {
  assert.equal(shouldPruneDebugStorage(null, 10), false);
  assert.equal(shouldPruneDebugStorage(5, 0), false);
  assert.equal(shouldPruneDebugStorage(undefined, undefined), false);
});

// Old session chats — not telemetry — became the largest consumer (7.9 MB of 10 MB) and blocked durable
// calls. They are disposable in a dev profile, but the chat the user is looking at never is.
test('only chats from finished sessions are disposable', () => {
  const keys = [
    'axsdk:binding:aaa:chat',
    'axsdk:binding:bbb:chat',
    'axsdk:group:123:chat',
    'axsdk:lua',
    'axsdk:flows',
    'axsdk:sites',
  ];
  assert.deepEqual(
    disposableChatKeys(keys, ['axsdk:binding:bbb:chat']),
    ['axsdk:binding:aaa:chat', 'axsdk:group:123:chat'],
  );
});

test('an unknown active chat never empties the whole store', () => {
  const keys = ['axsdk:binding:aaa:chat', 'axsdk:lua'];
  assert.deepEqual(disposableChatKeys(keys, []), [], 'without a known active chat, keep every chat');
  assert.deepEqual(disposableChatKeys([], ['x']), []);
});

// Telemetry alone was 275 KB of a 10.46 MB problem: the bulk is finished-session chat. An automatic
// reclaim that stops at telemetry leaves the next durable call to fail the same way.
test('reclaim escalates to finished chats only when telemetry was not enough', () => {
  const quota = 10 * 1024 * 1024;
  assert.equal(reclaimPlan(quota * 0.5, quota), 'none');
  assert.equal(reclaimPlan(quota * 0.9, quota), 'telemetry');
  assert.equal(reclaimPlan(quota * 0.9, quota, quota * 0.85), 'chats', 'still above the mark after telemetry');
  assert.equal(reclaimPlan(quota * 0.9, quota, quota * 0.4), 'telemetry', 'telemetry freed enough');
});

// Three unintended cart adds came from the same shape: a shopping session left PAUSED on a comparison
// window treats the next bare number as a SELECTION, and a selection is the approval turn. The workaround
// was to send "취소" first, which works only while cancel works — and cancel was itself broken for a while.
//
// So the harness gets a way to start clean. The browser call is injected, because what this has to get
// right is WHAT it clears, not how it reaches the page.

/** A fake AX context that records the script it was handed and answers like the real store would. */
function fakeContext(answer = {}) {
  const calls = [];
  const call = async (page, options, script, args) => {
    calls.push({ script, args });
    return { sessionId: 'session-new', clearedMessages: 4, ...answer };
  };
  return { call, calls };
}

test('a reset mints a new session and leaves nothing of the old turn behind', async () => {
  // A paused flow survives in three places at once. Clearing the messages but not the session state
  // leaves the node still paused; clearing both but not the deferred calls leaves a durable step that
  // resumes into a conversation that no longer exists.
  const { call, calls } = fakeContext();
  const result = await resetSession({ page: {}, options: {} }, { call });

  assert.equal(calls.length, 1, 'one round trip: a reset that half-lands is worse than none');
  const script = calls[0].script;
  for (const required of ['setMessages', 'clearSessionState', 'setDeferredCalls', 'setSession']) {
    assert.match(script, new RegExp(required), `a reset must call ${required}`);
  }
  assert.equal(result.sessionId, 'session-new', 'the caller has to be able to see it worked');
});

test('a reset reports what it could not do rather than claiming success', async () => {
  // The AX context answers null when the extension is still reconnecting — after `reload-ext`, exactly
  // when a test script is most likely to call this. Saying "reset" then would send the next scenario into
  // whatever gate was still open.
  const call = async () => null;
  await assert.rejects(
    () => resetSession({ page: {}, options: {} }, { call }),
    /chat store/i,
    'an unreachable store is an error, not a quiet no-op',
  );
});
