import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { COMMERCE_LAYER, loadLuaModules } from './harness.mjs';

// Twelve `_common` files use no browser API at all. Moving them into the runtime is the largest part of
// the migration and the least risky: the logic does not change, only where it runs.
//
// What DOES change is how the arguments arrive. A `kind: remote` tool receives the tool's `input:`
// mapping; a runtime lua tool receives the node's SELECTED FLOW STATE. That difference already cost one
// live round when every store refused with an empty site, so each ported command gets an entry point
// that states the mapping in Lua and a test that pins it.

const lua = loadLuaModules([
  '_common/scripts/00_base.lua',
  '_common/scripts/44_pagination.lua',
  '_common/scripts/45_offer_view.lua',
  ...COMMERCE_LAYER,
  '_common/rpc/63_pure_entries.lua',
]);
after(() => lua.close());

const STORE_RESULT = {
  site: '11st',
  status: 'candidates',
  candidates: [
    { site: '11st', product_id: '1', id: '1', name: '로지텍 M185 무선 마우스', price: 19400, currency: 'KRW', shipping_cost: 0, shipping_currency: 'KRW', url: 'https://www.11st.co.kr/products/1' },
  ],
};
const CONTEXT = { query: '로지텍 M185 마우스', quantity: 1, requested_brand: '로지텍' };

test('normalize reads the site and query out of the node state', () => {
  const value = lua.call('AX_RPC_PURE.normalize_store_result', {
    item: { site: '11st' },
    context: CONTEXT,
    store_result: STORE_RESULT,
  });

  assert.equal(value.next, 'done');
  assert.equal(value.store_result.site, '11st');
  assert.ok(Object.values(value.store_result.candidates ?? {}).length >= 1);
});

test('normalize refuses without a site rather than normalizing nothing', () => {
  // The command answers `error: missing_site` and the flow would branch `done` on it anyway; naming the
  // refusal keeps a mapping mistake from looking like a store with no matches.
  const value = lua.call('AX_RPC_PURE.normalize_store_result', { context: CONTEXT, store_result: STORE_RESULT });
  assert.equal(value.store_result.error, 'missing_site');
});

test('collect merges a page and decides whether another is worth a navigation', () => {
  const value = lua.call('AX_RPC_PURE.collect_store_page', {
    item: { site: '11st' },
    context: CONTEXT,
    store_result: STORE_RESULT,
    collected: null,
    page: 1,
    query: '로지텍 M185 마우스',
  });

  assert.ok(['done', 'more', 'retry_query'].includes(value.next), `unexpected branch ${value.next}`);
  assert.equal(value.page, 1);
  assert.ok(Object.values(value.collected ?? {}).length >= 1, 'the page must be merged into the accumulator');
});

test('collect carries the wording it tried, so a retry does not repeat it', () => {
  const value = lua.call('AX_RPC_PURE.collect_store_page', {
    item: { site: '11st' }, context: CONTEXT, store_result: { site: '11st', status: 'no_results', candidates: [] },
    collected: null, page: 1, query: '로지텍 M185 마우스', tried_queries: '로지텍 M185 마우스',
  });
  assert.match(String(value.tried_queries ?? ''), /로지텍 M185 마우스/);
});
