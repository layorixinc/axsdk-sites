import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { loadLuaModules } from './harness.mjs';

const lua = loadLuaModules([
  '_common/scripts/00_base.lua',
  '_common/scripts/44_pagination.lua',
  '_common/scripts/45_offer_view.lua',
  '_common/scripts/50_commerce.lua',
]);
after(() => lua.close());

function variants(options) {
  const result = lua.call('AX_COMMERCE.query_variants', options);
  return Array.isArray(result) ? result : [];
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

// ── brand equivalence for matching, also from the model ──────────────────────
// A Korean listing writes "로지텍" where the query says "Logitech". Matching needs that equivalence too,
// and it now comes from the same model-supplied field rather than a table in this file.

test('a listing in the other script matches when the model supplied the brand alias', () => {
  const candidates = [{ product_id: 'k1', name: '로지텍 M185 무선마우스', price: 19400, currency: 'USD', shipping_cost: 0 }];
  const withAlias = lua.call('AX_COMMERCE.normalize_candidates', 'ssg', candidates, 1, 'Logitech M185', {
    purpose: 'comparison', identity_brand: 'Logitech', identity_model: 'M185', brand_aliases: 'Logitech|로지텍',
  });
  assert.equal(withAlias.length, 1);
  assert.equal(withAlias[0].match_level, 'exact');
});

test('without the alias the same listing is not claimed to match', () => {
  const candidates = [{ product_id: 'k1', name: '로지텍 M185 무선마우스', price: 19400, currency: 'USD', shipping_cost: 0 }];
  const kept = lua.call('AX_COMMERCE.normalize_candidates', 'ssg', candidates, 1, 'Logitech M185', {
    purpose: 'comparison', identity_brand: 'Logitech', identity_model: 'M185',
  });
  assert.equal(Array.isArray(kept) ? kept.length : 0, 0);
});

test('a brand alias never lets a different model through', () => {
  const candidates = [{ product_id: 'other', name: '로지텍 M750 무선마우스', price: 30000, currency: 'USD', shipping_cost: 0 }];
  const kept = lua.call('AX_COMMERCE.normalize_candidates', 'ssg', candidates, 1, 'Logitech M185', {
    purpose: 'comparison', identity_brand: 'Logitech', identity_model: 'M185', brand_aliases: 'Logitech|로지텍',
  });
  assert.equal(Array.isArray(kept) ? kept.length : 0, 0);
});

test('an alias vouches only for the name it spells', () => {
  // "Logitech|로지텍" says nothing about the word "ergonomic". Letting the alias set answer for every token
  // made a Korean listing that never mentions it an exact match for an English descriptor.
  const listing = { name: '로지텍 M185 무선마우스' };
  const options = { identity_brand: 'Logitech', brand_aliases: 'Logitech|로지텍' };
  assert.equal(lua.call('AX_COMMERCE.relevance_match', listing, 'Logitech M185 ergonomic', options).level, 'partial');
  assert.equal(lua.call('AX_COMMERCE.relevance_match', listing, 'Logitech M185', options).level, 'exact');
});
