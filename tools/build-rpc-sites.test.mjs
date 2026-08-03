import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { loadLuaModules } from './lua/harness.mjs';
import { readSiteConfigs, serializeSites, STOREFRONT_SITES } from './build-rpc-sites.mjs';

// Three slices in a row failed the same way: the site adapters already declared what the reader needed
// — blocked markers, then paging, then the hydration payload — and the RPC site data had never received
// it. Each time the symptom was a plausible wrong answer (an empty store, a store that cannot page) and
// each time the fix was to copy a block by hand. The fourth omission is prevented by not copying.
//
// So the adapters are the source and this generator READS them: it loads the real Lua, takes the config
// table the adapter registered, and writes it out. Nothing is selected, so nothing can be forgotten.

const configs = readSiteConfigs();

test('every storefront adapter is read', () => {
  assert.deepEqual(Object.keys(configs).sort(), [...STOREFRONT_SITES].sort());
});

test('values come from the adapter, not from a pattern', () => {
  // ssg reads its rows from a hydration payload; these are the keys the reader needs and the ones that
  // were missing live.
  assert.equal(configs.ssg.prefer_embedded, true);
  assert.equal(configs.ssg.embedded_json_selector, 'script#__NEXT_DATA__');
  assert.equal(configs.ssg.embedded_item_key, 'itemId');
  assert.deepEqual(configs.ssg.pagination, { mode: 'query', param: 'page', start: 1, step: 1, max_pages: 2 });
});

test('the generated module reproduces the adapter data exactly', () => {
  // The round trip is the whole point: what the reader sees at runtime must be what the adapter declared,
  // key for key, with nothing chosen in between.
  const source = serializeSites(configs);
  const lua = loadLuaModules([], { globals: {} });
  lua.define(source, 'generated rpc sites');
  lua.define('function __dump() return RPC_SITES end');
  const roundTripped = lua.call('__dump');
  lua.close();

  assert.deepEqual(roundTripped, configs);
});

test('a value the generator cannot carry is reported, never dropped', () => {
  // A function in a config would vanish silently through serialization, and the reader would behave as
  // if the site had never declared it — the exact failure this generator exists to end.
  const withFunction = { demo: { site: 'demo', host_matches: () => true, result_selector: 'li' } };
  assert.throws(() => serializeSites(withFunction), /demo\.host_matches/);
});

test('strings that contain quotes and newlines survive', () => {
  const tricky = { demo: { site: 'demo', sel: 'a[data-x="1"]', note: "it's\nfine", list: ['a', 'b'], nested: { n: 1 } } };
  const lua = loadLuaModules([]);
  lua.define(serializeSites(tricky), 'tricky');
  lua.define('function __dump() return RPC_SITES end');
  assert.deepEqual(lua.call('__dump'), tricky);
  lua.close();
});
