import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { loadLuaModules } from './harness.mjs';
import { installRpcStub, makePage } from './rpc-stub.mjs';

// The Thumbtack quote flow is where the durable design cost the most: every page-level tool had to be
// re-entrant and page-detecting because a navigation destroyed the Lua context, and resuming across it
// was measured at 12–21 seconds. A runtime script keeps its stack, so the same read becomes a straight
// line — and the load determination that needed a durable primitive becomes a plain loop.
//
// What must NOT be lost is why that loop exists. The results list hydrates: reading the first answer
// reports a half-rendered page as the final one, and a service that has fifteen pros comes back with
// three. So the reader settles on a stable count before it believes the page.

const lua = loadLuaModules([
  '_common/rpc/61_rpc_storefront.lua',
  '_common/rpc/64_rpc_thumbtack.lua',
]);
after(() => lua.close());

const CARD = '[data-test="pro-list-result"]';
const pro = (name, rating) => ({ text: `${name} ${rating}`, title: name, rating_text: String(rating), url: `https://www.thumbtack.com/p/${name}` });

const search = (page, args = {}) => {
  installRpcStub(lua, page);
  return { value: lua.call('AX_RPC_THUMBTACK.search_service', { query: 'house cleaning', zip_code: '94101', ...args }), ops: page.ops };
};

test('the reader waits for the list to stop growing', () => {
  const page = makePage({
    href: 'https://www.google.com/',
    afterNavigate: {},
    sequence: { [CARD]: [[pro('A', 4.5)], [pro('A', 4.5), pro('B', 4.8)], [pro('A', 4.5), pro('B', 4.8), pro('C', 5)], [pro('A', 4.5), pro('B', 4.8), pro('C', 5)]] },
  });
  const { value } = search(page);

  assert.equal(value.next, 'ok');
  assert.equal(Object.values(value.candidates).length, 3, 'a list still growing must not be read as final');
});

test('a settled empty list is no_results, not a slow page', () => {
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: {}, sequence: { [CARD]: [[], [], []] } });
  assert.equal(search(page).value.next, 'no_results');
});

test('a rejected ZIP is its own answer, never an empty service', () => {
  // Thumbtack answers a bad ZIP with a banner and an empty list. Reporting `no_results` would send the
  // user looking for another service when the postcode is what it disliked.
  const page = makePage({
    href: 'https://www.google.com/',
    afterNavigate: { '[data-test="invalid-zip"]': [{ text: 'Enter a valid ZIP' }] },
    sequence: { [CARD]: [[], []] },
  });
  const { value } = search(page);
  assert.equal(value.next, 'invalid_zip');
  assert.equal(value.zip_code, '94101');
});

test('the search is fired once, not on every poll', () => {
  const page = makePage({
    href: 'https://www.google.com/',
    afterNavigate: {},
    sequence: { [CARD]: [[pro('A', 4.5)], [pro('A', 4.5)]] },
  });
  const { ops } = search(page);
  assert.equal(ops.filter((entry) => entry.op === 'nav.navigate').length, 1);
});

test('a candidate carries what the shortlist ranks on', () => {
  const page = makePage({
    href: 'https://www.google.com/',
    afterNavigate: {},
    sequence: { [CARD]: [[pro('Clean Co', 4.9)], [pro('Clean Co', 4.9)]] },
  });
  const candidate = Object.values(search(page).value.candidates)[0];
  assert.equal(candidate.name, 'Clean Co');
  assert.equal(candidate.rating, 4.9);
});
