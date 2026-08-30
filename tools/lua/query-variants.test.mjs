import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { COMMERCE_LAYER, loadLuaModules } from './harness.mjs';

const lua = loadLuaModules([
  '_common/scripts/00_base.lua',
  '_common/scripts/44_pagination.lua',
  '_common/scripts/45_offer_view.lua',
  ...COMMERCE_LAYER,
]);
after(() => lua.close());

function variants(options) {
  const result = lua.call('AX_COMMERCE.query_variants', options);
  return Array.isArray(result) ? result : [];
}

function prefill(requestText) {
  return lua.call('AX_COMMERCE.prefill_total_cost_request', { requestText });
}

// The wordings come from the model, which knows the product and the stores in scope. This module owns
// only the mechanics: the user's own query leads, the model's alternatives follow in the order it gave
// them, nothing is repeated, and the list is bounded because each extra wording costs a navigation.
// A pipe-separated string is used rather than an array because an empty Lua table crosses the tool
// boundary as an object and fails array validation (AGENTS.md §9).

test('the caller\'s own query always leads', () => {
  const list = variants({ query: 'Logitech M185', query_variants: '로지텍 M185|로지텍 무선마우스 M185' });
  assert.equal(list[0], 'Logitech M185');
});

test('the model\'s wordings follow in the order it gave them', () => {
  const list = variants({ query: 'Logitech M185', query_variants: '로지텍 M185|로지텍 무선마우스 M185' });
  assert.deepEqual(list, ['Logitech M185', '로지텍 M185', '로지텍 무선마우스 M185']);
});

test('a wording the model repeated is only tried once', () => {
  const list = variants({ query: 'Logitech M185', query_variants: 'Logitech M185|로지텍 M185|  로지텍 M185  ' });
  assert.deepEqual(list, ['Logitech M185', '로지텍 M185']);
});

test('the list is bounded because every extra wording is a navigation', () => {
  const list = variants({
    query: 'Logitech M185',
    query_variants: '로지텍 M185|로지텍 무선마우스|로지텍 마우스 M185|M185 마우스|로지텍',
  });
  assert.ok(list.length <= 3, `too many navigations: ${list.length}`);
  assert.equal(list[0], 'Logitech M185');
});

test('no wordings from the model means the query is tried alone', () => {
  assert.deepEqual(variants({ query: 'Logitech M185' }), ['Logitech M185']);
  assert.deepEqual(variants({ query: 'Logitech M185', query_variants: '' }), ['Logitech M185']);
  assert.deepEqual(variants({ query: 'Logitech M185', query_variants: '   |  ' }), ['Logitech M185']);
});

test('nothing is invented when the model stayed silent', () => {
  // No curated table exists any more: a query with no model-supplied alternatives is tried exactly once,
  // whatever language it is in.
  assert.deepEqual(variants({ query: '무선 마우스', site: 'amazon' }), ['무선 마우스']);
  assert.deepEqual(variants({ query: 'flux capacitor', site: 'coupang' }), ['flux capacitor']);
});

test('an empty query yields nothing to try', () => {
  assert.deepEqual(variants({ query: '', query_variants: '로지텍' }), []);
});

test('an explicit three-store comparison is ready before the model runs', () => {
  const result = prefill('Logitech M185를 Amazon, Walmart, eBay에서 배송비 포함 총액으로 비교해줘');
  assert.equal(result.next, 'ready');
  assert.deepEqual(result.stores, [
    { site: 'amazon' },
    { site: 'walmart' },
    { site: 'ebay' },
  ]);
});

test('site groups expand deterministically in the documented order', () => {
  const result = prefill('Compare Logitech M185 across all global stores');
  assert.equal(result.next, 'ready');
  assert.deepEqual(result.stores, [
    { site: 'amazon' },
    { site: 'walmart' },
    { site: 'ebay' },
    { site: 'aliexpress' },
    { site: 'etsy' },
  ]);
});

test('an incomplete request stays on the clarification path', () => {
  assert.equal(prefill('Logitech M185를 Amazon에서 찾아줘').next, 'collect');
  assert.equal(prefill('Amazon, Walmart에서 비교해줘').next, 'collect');
});

test('11st is a store name, never a quantity', () => {
  const result = prefill('로지텍 M185를 11번가와 SSG에서 비교해줘');
  assert.equal(result.next, 'ready');
  assert.deepEqual(result.stores, [{ site: '11st' }, { site: 'ssg' }]);
});

// ── brand equivalence for broad discovery recall, also from the model ────────
// Comparison relevance is judged by the LLM. Discovery still needs a bounded, grounded model-choice
// surface, so its broad recall guard can use the model-supplied spelling of the requested brand.

test('a discovery row in the other script survives with the supplied brand alias', () => {
  const candidates = [{
    product_id: 'k1', name: '로지텍 M185 무선마우스', price: 19400, currency: 'USD', shipping_cost: 0,
  }];
  const withAlias = lua.call('AX_COMMERCE.normalize_candidates', 'ssg', candidates, 1, 'Logitech M185', {
    purpose: 'discovery', requested_brand: 'Logitech', brand_aliases: 'Logitech|로지텍',
  });
  assert.equal(withAlias.length, 1);
});

test('discovery does not invent a brand equivalence the model omitted', () => {
  const candidates = [{
    product_id: 'k1', name: '로지텍 M185 무선마우스', price: 19400, currency: 'USD', shipping_cost: 0,
  }];
  const withoutAlias = lua.call('AX_COMMERCE.normalize_candidates', 'ssg', candidates, 1, 'Logitech M185', {
    purpose: 'discovery', requested_brand: 'Logitech',
  });
  assert.equal(Array.isArray(withoutAlias) ? withoutAlias.length : 0, 0);
});

test('a short discovery brand must match a word, never a substring in another brand', () => {
  const candidates = [{
    product_id: 's1',
    name: 'Samsung 25 cu ft Storage Refrigerator RF29',
    manufacturer_model: 'RF29',
    price: 1000,
    currency: 'USD',
    shipping_cost: 0,
  }];
  const result = lua.call('AX_COMMERCE.normalize_candidates', 'amazon', candidates, 1, 'GE refrigerator', {
    purpose: 'discovery', requested_brand: 'GE', brand_aliases: 'GE',
  });
  assert.equal(Array.isArray(result) ? result.length : 0, 0);
});
