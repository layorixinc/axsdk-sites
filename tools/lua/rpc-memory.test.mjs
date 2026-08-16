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

test('an empty value is a delete, in the same call as the saves', () => {
  // This test used to assert the table went through UNCHANGED — a shape we invented before the ops
  // existed, which then passed for weeks while the real client would have answered `bad_params`. The
  // contract is `{ entries: [{ key, value? }] }`, and leaving `value` out is how a key is removed.
  const result = lua.call('AX_RPC_MEMORY.set_bulk', { memory: { home: 'Seoul', work: '' } });

  assert.equal(result.ok, true);
  const sent = calls.at(-1)[1];
  assert.deepEqual(sent.find((entry) => entry.key === 'home'), { key: 'home', value: 'Seoul' });
  assert.deepEqual(sent.find((entry) => entry.key === 'work'), { key: 'work' });
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

test('writes are sent in the shape the client actually accepts', () => {
  // Twice wrong, twice for the same reason: we read the CLIENT handler (`rpc-ops.ts:331`) and encoded its
  // params object, `{ entries: [...] }`. But Lua does not build the params object — the binding is
  // POSITIONAL and the runtime wraps it. `docs/rpc_lua_authoring.md` §4 is the signature that matters:
  //
  //   memory | get(key?) · search(regex) · set_bulk(entries) · delete(key)
  //
  // Sending the wrapper produced a live `bad_params`, which reads exactly like a broken op. `get` and
  // `search` were already positional and always worked, which is what hid it.
  const calls = [];
  const lua = loadLuaModules(['_common/rpc/70_rpc_memory.lua']);
  lua.expose({
    memory: {
      set_bulk: (entries) => { calls.push(['set_bulk', entries]); return true; },
      delete: (key) => { calls.push(['delete', key]); return true; },
    },
  });

  lua.call('AX_RPC_MEMORY.set_bulk', { memory: { home: 'Seoul' } });
  // An absent value deletes that key, so a multi-key delete is ONE round trip, not one per key.
  lua.call('AX_RPC_MEMORY.delete', { keys: ['home', 'work'] });
  lua.close();

  const written = calls[0][1];
  assert.ok(Array.isArray(written), `set_bulk takes the array itself, got ${JSON.stringify(written)}`);
  assert.deepEqual(written, [{ key: 'home', value: 'Seoul' }]);

  const removed = calls.at(-1);
  assert.equal(removed[0], 'set_bulk', 'a multi-key delete rides set_bulk, in one call');
  assert.deepEqual(removed[1].map((entry) => entry.key).sort(), ['home', 'work']);
  assert.ok(removed[1].every((entry) => entry.value === undefined), 'no value means remove');
});

// ── the deterministic capture (AX_RPC_MEMORY.capture) ────────────────────────
//
// The planner drops a TRAILING "기억해줘" clause and no prompt formulation moved it (§13): measured, the memory
// entry either arrived with the VALUE STRIPPED ("전화번호 기억해줘") or was not emitted at all, three runs of
// three. So the capture cannot depend on the planner's segmentation. It runs as a `beforeIntent` hook, which is
// deterministic and receives the user's OWN message — measured live: `userMessages` is an array of strings
// carrying the full text, phone number intact.
//
// The consent boundary is the whole risk of doing it this way, so it is a pure condition and it is tested first.
// §13: "Route a standalone declarative personal fact with no remember/save/retrieve instruction to out_of_scope;
// never reinterpret it as consent to save."
const capture = (text) => lua.call('AX_RPC_MEMORY.capture', { userMessages: [text] });

test('a message with no memory clause captures NOTHING, however much it looks like a fact', () => {
  for (const text of [
    '내 전화번호는 415-555-0199야',
    '이메일 hong@test.com 으로 연락 줘',
    '샌프란시스코 94103에서 청소 견적 줘. 이름 홍길동, 전화 415-555-0100',
    'my phone is 415-555-0199',
  ]) {
    const result = capture(text);
    assert.equal(result.next, 'skip', `must not capture: ${text}`);
    assert.equal(result.memory_entries, undefined, `must carry no entries: ${text}`);
  }
});

test('an explicit clause captures the value beside it', () => {
  const result = capture('샌프란시스코 94103에서 청소 견적 줘. 내 전화번호 415-555-0199 기억해줘.');
  assert.equal(result.next, 'save');
  assert.deepEqual(result.memory_entries, [{ key: 'phone', value: '415-555-0199' }]);
});

test('the clause may sit anywhere, which is the point', () => {
  const trailing = capture('청소 견적 줘. 내 전화번호 415-555-0199 기억해줘.');
  const leading = capture('내 전화번호 415-555-0199 기억해줘. 그리고 청소 견적 줘.');
  assert.deepEqual(trailing.memory_entries, leading.memory_entries);
  assert.equal(trailing.next, 'save');
});

test('email, phone and zip are recognised, and several in one message are all captured', () => {
  const result = capture('이름은 홍길동, 이메일은 gildong@test.com, 전화번호는 415-555-0155 이야. 기억해줘.');
  const byKey = Object.fromEntries((result.memory_entries ?? []).map((entry) => [entry.key, entry.value]));
  assert.equal(byKey.email, 'gildong@test.com');
  assert.equal(byKey.phone, '415-555-0155');
  assert.equal(result.next, 'save');
});

test('English clauses count too', () => {
  assert.equal(capture('remember my email is hong@test.com').next, 'save');
  assert.equal(capture('please save my phone 415-555-0199').next, 'save');
  assert.equal(capture('forget my email').next, 'skip', 'a forget with no value is not a save');
});

test('a clause with no recognisable value captures nothing rather than guessing', () => {
  const result = capture('전화번호 기억해줘');
  assert.equal(result.next, 'skip');
  assert.equal(result.memory_entries, undefined);
});

test('the latest message is the one read, and junk input is not a crash', () => {
  assert.equal(lua.call('AX_RPC_MEMORY.capture', {}).next, 'skip');
  assert.equal(lua.call('AX_RPC_MEMORY.capture', { userMessages: [] }).next, 'skip');
  const result = lua.call('AX_RPC_MEMORY.capture', {
    userMessages: ['청소 견적 줘', '내 이메일 a@b.com 기억해줘'],
  });
  assert.equal(result.next, 'save', 'the newest message carries the clause');
  assert.deepEqual(result.memory_entries, [{ key: 'email', value: 'a@b.com' }]);
});
