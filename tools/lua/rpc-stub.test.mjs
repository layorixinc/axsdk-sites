import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { loadLuaModules } from './harness.mjs';
import { installRpcStub, makePage } from './rpc-stub.mjs';

// A fixture that stands in for a capability MUST enforce the runtime's constraints. This file pins the
// ones a permissive stub would hide, because it already hid one for months.
//
// `nav.wait_for_navigation` takes ONE spec table in both runtimes — the CDP dom port
// (`axsdk-core/src/lua/dom-port.ts`: `async (spec: AXLuaValue = null)`, reading `url`/`timeout`/
// `interval` off it) and the durable path (`default-capabilities.ts`: `luaArg(args, 0)`). Every
// `_common/rpc` caller wrote `nav.wait_for_navigation(from, { timeout = 8000, interval = 200 })`, and the
// second argument was silently dropped: `optionOf` returns null for a non-object, so the wait ran on the
// port defaults of 30000 ms and 100 ms. Against a `deadlineMs` the platform caps at 120000 that is a real
// budget leak, and it was invisible from Lua.
//
// It stayed invisible because THIS stub accepted `(from, opts)` and honoured `opts`. Nothing else could
// have caught it short of timing a live run.
const lua = loadLuaModules(['_common/scripts/00_base.lua']);
after(() => lua.close());

function withStub(source) {
  const page = makePage({ href: 'https://example.test/one' });
  installRpcStub(lua, page);
  lua.define(`function AX_STUB_PROBE()\n${source}\nend`);
  return { page, run: () => lua.call('AX_STUB_PROBE') };
}

test('a second argument to wait_for_navigation is refused, the way the runtime ignores it', () => {
  const { run } = withStub('return nav.wait_for_navigation("https://example.test/one", { timeout = 10 })');

  assert.throws(run, /wait_for_navigation/,
    'the runtime takes one spec table; a caller passing two must fail here, not in production');
});

test('one spec table is accepted and its timeout is honoured', () => {
  const { page, run } = withStub('return nav.wait_for_navigation({ timeout = 30, interval = 10 })');

  assert.equal(run(), false, 'the href never changes, so the wait times out rather than raising');
  const polls = page.ops.filter((entry) => entry.op === 'dom.get_location_href').length;
  assert.ok(polls >= 1 && polls <= 6, `a 30ms/10ms bound polls a handful of times, saw ${polls}`);
});

test('no argument at all is accepted, as the port default', () => {
  const { run } = withStub('return nav.wait_for_navigation()');

  assert.equal(typeof run(), 'boolean');
});

test('a spec naming a url waits for the href to contain it, not to differ from it', () => {
  // The opposite of what a `from` argument meant. A caller migrating `(from, opts)` to `{ url = from }`
  // would wait for a URL it is already on and return immediately — which is why the migration drops it.
  const { run } = withStub('return nav.wait_for_navigation({ url = "example.test/one", timeout = 30, interval = 10 })');

  assert.equal(run(), true, 'the current href already contains it, so this is satisfied at once');
});
