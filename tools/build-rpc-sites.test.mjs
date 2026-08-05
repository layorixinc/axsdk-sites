import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { loadLuaModules } from './lua/harness.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readSiteConfigs, serializeSites, mirrorReader, repoRoot, PRODUCTION_READER, PLAYGROUND_READER, STOREFRONT_SITES } from './build-rpc-sites.mjs';

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

// The reader lives in the production layer. The Playground exercises the SAME file so that a pilot run
// proves something about what ships — two hand-maintained copies would agree only until the first fix
// landed in one of them.

test('the playground reader is a copy of the production one', () => {
  const production = readFileSync(join(repoRoot, PRODUCTION_READER), 'utf8');
  const mirror = readFileSync(join(repoRoot, PLAYGROUND_READER), 'utf8');
  assert.equal(mirror, production,
    `run \`npm run build:rpc:sites\` — ${PLAYGROUND_READER} has drifted from ${PRODUCTION_READER}`);
});

test('mirroring is what makes them equal, not luck', () => {
  const production = readFileSync(join(repoRoot, PRODUCTION_READER), 'utf8');
  writeFileSync(join(repoRoot, PLAYGROUND_READER), '-- drifted\n');
  try {
    mirrorReader();
    assert.equal(readFileSync(join(repoRoot, PLAYGROUND_READER), 'utf8'), production);
  } finally {
    writeFileSync(join(repoRoot, PLAYGROUND_READER), production);
  }
});

test('the committed module is what the generator produces right now', () => {
  // Every other test here serializes in memory and compares to the adapters, so a STALE file on disk
  // passes them all. Measured: the 11st shipping selector was fixed in the adapter, `62_rpc_sites.lua`
  // still carried the old one, and the production RPC path — which reads `RPC_SITES`, not the adapter —
  // kept using it. The fix was committed, gated, live-tested and never once in effect.
  //
  // `build:rpc` does not run this generator (`build:rpc:sites` is separate), so nothing regenerates it by
  // accident either. Same lesson as `build:schema --check`: a generated artifact that is committed needs
  // a check that it is current, or it is just a stale copy with a comment claiming otherwise.
  const generated = serializeSites(configs);

  // The generator's two outputs — the default target and the playground mirror it is invoked with.
  for (const target of ['_common/rpc/62_rpc_sites.lua', 'playground/_common/rpc/17_rpc_sites.lua']) {
    const committed = readFileSync(join(repoRoot, target), 'utf8');
    assert.equal(
      committed.replace(/\r\n/g, '\n').trim(),
      generated.replace(/\r\n/g, '\n').trim(),
      `${target} is stale — run \`npm run build:rpc:sites\``,
    );
  }
});
