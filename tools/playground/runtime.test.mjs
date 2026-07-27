import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inspectStoredActivation,
  waitForStoredActivation,
} from './runtime.mjs';

function snapshot({
  domain = null,
  commands = [{ command: 'AX_common', scriptId: 'stored-lua:' }],
} = {}) {
  return {
    runtime: {
      currentSite: domain ? { domain } : null,
      commands,
    },
  };
}


test('requires the expected site and its stored Lua layer before declaring navigation ready', () => {

  assert.deepEqual(inspectStoredActivation(snapshot({ commands: [] }), {
    expectedDomain: null,
    requireCommonLua: true,
  }), {
    ready: false,
    activeDomain: null,
    reason: 'common_lua',
    sources: { store: [], remote: [], local: [], builtin: [] },
  });
  assert.deepEqual(inspectStoredActivation(snapshot(), {
    expectedDomain: 'example',
    requireSiteLua: true,
  }), {
    ready: false,
    activeDomain: null,
    reason: 'site_domain',
    sources: { store: ['AX_common'], remote: [], local: [], builtin: [] },
  });

  assert.deepEqual(inspectStoredActivation(snapshot({ domain: 'example' }), {
    expectedDomain: 'example',
    requireSiteLua: true,
  }), {
    ready: false,
    activeDomain: 'example',
    reason: 'site_lua',
    sources: { store: ['AX_common'], remote: [], local: [], builtin: [] },
  });

  const ready = inspectStoredActivation(snapshot({
    domain: 'example',
    commands: [
      { command: 'AX_common', scriptId: 'stored-lua:' },
      { command: 'AX_site', scriptId: 'stored-lua:example' },
    ],
  }), {
    expectedDomain: 'example',
    requireSiteLua: true,
  });
  assert.equal(ready.ready, true);
  assert.equal(ready.activeDomain, 'example');
  assert.deepEqual(ready.sources, {
    store: ['AX_common', 'AX_site'],
    remote: [],
    local: [],
    builtin: [],
  });
});

test('waits through asynchronous local site activation rather than racing Lua readiness', async () => {
  const sequence = [
    snapshot(),
    snapshot({ domain: 'example' }),
    snapshot({
      domain: 'example',
      commands: [
        { command: 'AX_common', scriptId: 'stored-lua:' },
        { command: 'AX_site', scriptId: 'stored-lua:example' },
      ],
    }),
  ];
  let polls = 0;
  const receipt = await waitForStoredActivation(async () => sequence[Math.min(polls++, sequence.length - 1)], {
    expectedDomain: 'example',
    requireSiteLua: true,
    timeoutMs: 500,
    intervalMs: 0,
    delay: async () => {},
  });

  assert.equal(polls, 3);
  assert.equal(receipt.activeDomain, 'example');
  assert.equal(receipt.ready, true);
});

test('rejects a remote or in-memory command source even if the expected site is active', () => {
  const remote = inspectStoredActivation(snapshot({
    domain: 'example',
    commands: [{ command: 'AX_remote', scriptId: 'example/scripts/00.lua' }],
  }), {
    expectedDomain: 'example',
  });
  assert.equal(remote.ready, false);
  assert.equal(remote.reason, 'command_source');

  const local = inspectStoredActivation(snapshot({
    domain: 'example',
    commands: [{ command: 'AX_local', scriptId: 'ax-local-example' }],
  }), {
    expectedDomain: 'example',
  });
  assert.equal(local.ready, false);
  assert.equal(local.reason, 'command_source');
});
