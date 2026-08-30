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

// Korean storefronts title the same product without the English brand or the category word. Requiring
// every query token silently emptied those stores: `Logitech M185 mouse` matched none of the three SSG
// listings below while `Logitech M185` matched all three. Relevance therefore anchors on what identifies
// the product (model code + brand) and scores the rest.
//
// The brand is written "로지텍" here and "Logitech" in the query. That equivalence is language knowledge,
// so it arrives WITH the request in `brand_aliases` (the model that read the request writes it) instead
// of living in a table inside the matcher.
const KOREAN_LISTINGS = [
  { product_id: 'k1', name: '로지텍정품 M185 무선 광 마우스 그레이', price: 100, currency: 'USD', shipping_cost: 0 },
  { product_id: 'k2', name: '로지텍코리아 공식 로지텍 M185 무선마우스', price: 101, currency: 'USD', shipping_cost: 0 },
  { product_id: 'k3', name: '[SSG]로지텍 M185 실버', price: 102, currency: 'USD', shipping_cost: 0 },
];
const LOGITECH = 'Logitech|로지텍';

function comparison(candidates, query, options = {}) {
  const kept = lua.call('AX_COMMERCE.normalize_candidates', 'ssg', candidates, 1, query, { purpose: 'comparison', ...options });
  // An empty Lua table arrives as {} — the documented array/object ambiguity, not a result shape.
  return Array.isArray(kept) ? kept : [];
}

// ── normalization prepares a bounded LLM judgement surface ───────────────────

test('comparison normalization never makes the semantic match decision', () => {
  // The next flow node gives these bounded rows to `judge_relevance`. Code that drops a row here makes
  // an identity decision before the LLM can see it. The control rows are deliberately wrong; keeping
  // them at this boundary is the contract, and the LLM screening verdict removes them later.
  const kept = comparison([
    ...KOREAN_LISTINGS,
    { product_id: 'other-model', name: '로지텍 M170 무선마우스', price: 90, currency: 'USD', shipping_cost: 0 },
    { product_id: 'other-brand', name: '샤오미 M185 무선마우스', price: 91, currency: 'USD', shipping_cost: 0 },
  ], 'Logitech M185 mouse', {
    identity_model: 'M185',
    identity_brand: 'Logitech',
    brand_aliases: LOGITECH,
  });

  assert.deepEqual(kept.map((entry) => entry.product_id),
    ['k1', 'k2', 'k3', 'other-model', 'other-brand']);
  assert.ok(kept.every((entry) => entry.match_level === undefined
    && entry.match_missing === undefined), 'only the LLM screening verdict may judge relevance');
});

test('the LLM surface is capped in store result order', () => {
  const candidates = Array.from({ length: 8 }, (_, index) => ({
    product_id: `p${index}`,
    name: `Store row ${index}`,
    price: 10 + index,
    currency: 'USD',
    shipping_cost: 0,
  }));
  const kept = comparison(candidates, 'anything');

  assert.equal(kept.length, 6);
  assert.deepEqual(kept.map((entry) => entry.product_id), ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
});

test('structurally unreadable rows do not consume the LLM budget', () => {
  const kept = comparison([
    { product_id: 'missing-name', price: 10, currency: 'USD', shipping_cost: 0 },
    { product_id: 'missing-price', name: 'No price', currency: 'USD', shipping_cost: 0 },
    { name: 'No id', price: 10, currency: 'USD', shipping_cost: 0 },
    { product_id: 'valid', name: 'Readable live row', price: 10, currency: 'USD', shipping_cost: 0 },
  ], 'anything');

  assert.deepEqual(kept.map((entry) => entry.product_id), ['valid']);
});
