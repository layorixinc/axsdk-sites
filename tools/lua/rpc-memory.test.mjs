import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { loadLuaModules } from './harness.mjs';

// The memory store stays on the device — a second one would split from the one the client already writes
// to, and moving addresses and ordering habits off the device is a product decision. So these are ops, and
// each costs a round trip.
//
// The behaviour that matters here is what happens when the client cannot answer them: the ops were
// published before the extension implemented them, and a memory flow that dies is worse than one that says
// the store could not be reached.

const lua = loadLuaModules(['_common/rpc/70_rpc_memory.lua']);
after(() => lua.close());

const calls = [];
lua.expose({
  memory: {
    get: (key) => { calls.push(['get', key]); return key ? { key, value: 'saved' } : { keys: ['home', 'work'] }; },
    search: (regex) => { calls.push(['search', regex]); return { ok: true, markdown: `hits for ${regex}` }; },
    set_bulk: (entries) => { calls.push(['set_bulk', entries]); return { ok: true, written: 2 }; },
    delete: (keys) => { calls.push(['delete', keys]); return { ok: true, deleted: keys.length }; },
  },
});

test('listing returns every key', () => {
  const result = lua.call('AX_RPC_MEMORY.get', {});

  assert.equal(result.next, 'report');
  assert.deepEqual(Object.values(result.memory_result.keys), ['home', 'work']);
});

test('one key returns its value', () => {
  const result = lua.call('AX_RPC_MEMORY.get', { key: 'home' });

  assert.equal(result.memory_result.value, 'saved');
  assert.deepEqual(calls.at(-1), ['get', 'home']);
});

test('a search without a regex asks for one instead of matching everything', () => {
  const before = calls.length;
  const result = lua.call('AX_RPC_MEMORY.search', { regex: '' });

  assert.equal(result.error, 'missing_regex');
  assert.equal(calls.length, before, 'nothing may be sent');
});

test('a delete with no keys deletes nothing', () => {
  const before = calls.length;
  const result = lua.call('AX_RPC_MEMORY.delete', { keys: [] });

  assert.equal(result.error, 'missing_keys');
  assert.equal(calls.length, before, 'nothing may be sent');
});

test('a write carries the entries through unchanged', () => {
  const result = lua.call('AX_RPC_MEMORY.set_bulk', { memory: { home: 'Seoul', work: '' } });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.at(-1)[1], { home: 'Seoul', work: '' });
});

test('a client with no memory ops is reported, not crashed into', () => {
  // The ops were published before the extension implemented them. A flow that dies here tells the user
  // nothing; a flow that says the store could not be reached tells them what happened.
  const bare = loadLuaModules(['_common/rpc/70_rpc_memory.lua']);
  for (const [entry, args] of [
    ['AX_RPC_MEMORY.get', {}],
    ['AX_RPC_MEMORY.search', { regex: 'home' }],
    ['AX_RPC_MEMORY.set_bulk', { memory: { a: 'b' } }],
    ['AX_RPC_MEMORY.delete', { keys: ['a'] }],
  ]) {
    const result = bare.call(entry, args);
    assert.equal(result.error, 'memory_op_unavailable', entry);
    assert.equal(result.ok, false, entry);
  }
  bare.close();
});

test('an op the client registered but refuses is told apart from one it never had', () => {
  // `command_unresolved` means "never implemented"; anything else is the store's own failure, and the two
  // call for different things — one is a platform gap, the other is worth retrying.
  const flaky = loadLuaModules(['_common/rpc/70_rpc_memory.lua']);
  flaky.expose({
    memory: {
      get: () => { throw new Error('rpc memory.get failed: command_unresolved: memory.get'); },
      search: () => { throw new Error('rpc memory.search failed: store_locked'); },
    },
  });

  assert.equal(flaky.call('AX_RPC_MEMORY.get', {}).error, 'memory_op_unavailable');
  assert.equal(flaky.call('AX_RPC_MEMORY.search', { regex: 'x' }).error, 'memory_unavailable');
  flaky.close();
});

test('a refusal carries the raw reason, not just a category', () => {
  // "unavailable" on its own cost a whole round of diagnosis: it could not tell an op the client never
  // registered from one we failed to DECLARE properly — and we made exactly that mistake once, granting
  // `net.fetch` through `rpc.allow`, which is for ops and does not reach `net`.
  const bare = loadLuaModules(['_common/rpc/70_rpc_memory.lua']);
  assert.match(bare.call('AX_RPC_MEMORY.get', {}).reason, /no memory global/);
  bare.close();

  const refusing = loadLuaModules(['_common/rpc/70_rpc_memory.lua']);
  refusing.expose({
    memory: { get: () => { throw new Error('rpc memory.get failed: command_unresolved: memory.get'); } },
  });
  assert.match(refusing.call('AX_RPC_MEMORY.get', {}).reason, /command_unresolved/);
  refusing.close();
});
