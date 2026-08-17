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

// ── anchors decide, descriptors only score ────────────────────────────────────

test('a descriptive English query still reaches Korean listings', () => {
  for (const query of ['Logitech M185 mouse', 'Logitech M185 wireless mouse', 'Logitech M185']) {
    const kept = comparison(KOREAN_LISTINGS, query, { identity_model: 'M185', identity_brand: 'Logitech', brand_aliases: LOGITECH });
    assert.equal(kept.length, 3, `${query} kept ${kept.length}`);
  }
});

test('a listing of a different model is still refused', () => {
  const kept = comparison(
    [...KOREAN_LISTINGS, { product_id: 'other', name: '로지텍 M170 무선마우스', price: 90, currency: 'USD', shipping_cost: 0 }],
    'Logitech M185 mouse',
    { identity_model: 'M185', identity_brand: 'Logitech', brand_aliases: LOGITECH },
  );
  assert.deepEqual(kept.map((entry) => entry.product_id).sort(), ['k1', 'k2', 'k3']);
});

test('a listing of another brand is refused even when the model code collides', () => {
  const kept = comparison(
    [{ product_id: 'x', name: '샤오미 M185 무선마우스', price: 50, currency: 'USD', shipping_cost: 0 }],
    'Logitech M185',
    { identity_model: 'M185', identity_brand: 'Logitech', brand_aliases: LOGITECH },
  );
  assert.equal(kept.length, 0);
});

test('a brand token only matches as a WORD, never inside one', () => {
  // The model anchor is byte-boundary aware (`anchor_present`); the brand half was a bare substring `find`.
  // A short brand therefore matched inside any word containing it, and "GE" is the case that makes it real:
  // it sits inside Range, Storage, Vintage, Package — the exact vocabulary of the appliance listings a GE
  // search returns. The brand anchor decides INCLUSION, so a competitor's product enters the comparison and
  // the (유사) label then presents it as a near match of the requested one.
  //
  // Korean is unaffected by design: its bytes are not ASCII alphanumerics, so a Korean token surrounded by
  // Korean already satisfies the boundary — which is why every test above keeps passing.
  const wrong = comparison(
    [{ product_id: 'x', name: 'Samsung Range with Storage Drawer RF285', price: 900, currency: 'USD', shipping_cost: 0 }],
    'GE RF285',
    { identity_model: 'RF285', identity_brand: 'GE', brand_aliases: ['GE'] },
  );
  assert.equal(wrong.length, 0, '"ge" inside Range/Storage is not the brand GE');

  // The real thing still matches, in a different case and beside punctuation.
  const right = comparison(
    [{ product_id: 'y', name: 'ge RF285 french door refrigerator', price: 900, currency: 'USD', shipping_cost: 0 }],
    'GE RF285',
    { identity_model: 'RF285', identity_brand: 'GE', brand_aliases: ['GE'] },
  );
  assert.deepEqual(right.map((entry) => entry.product_id), ['y']);
});

test('every kept candidate is labelled exact or partial', () => {
  // "ergonomic" is in the query and in one title only, which is exactly what separates an exact title
  // from a similar one.
  const kept = comparison(
    [
      { product_id: 'full', name: 'Logitech M185 ergonomic wireless mouse', price: 100, currency: 'USD', shipping_cost: 0 },
      ...KOREAN_LISTINGS,
    ],
    'Logitech M185 ergonomic mouse',
    { identity_brand: 'Logitech', brand_aliases: LOGITECH },
  );

  const byId = Object.fromEntries(kept.map((entry) => [entry.product_id, entry]));
  assert.equal(byId.full.match_level, 'exact');
  assert.equal(byId.k1.match_level, 'partial');
  assert.ok(Array.isArray(byId.k1.match_missing) || typeof byId.k1.match_missing === 'string');
});

test('exact matches are ordered ahead of partial ones', () => {
  // Recall keeps up to six per store and the comparison cap is applied after the model screens them, so
  // what matters here is the ORDER: the exact title must lead, because a bounded list is cut from the end.
  const candidates = [
    ...KOREAN_LISTINGS,
    { product_id: 'full', name: 'Logitech M185 ergonomic mouse black', price: 103, currency: 'USD', shipping_cost: 0 },
  ];
  const kept = comparison(candidates, 'Logitech M185 ergonomic mouse', { identity_brand: 'Logitech', brand_aliases: LOGITECH });

  assert.equal(kept.length, 4);
  assert.equal(kept[0].product_id, 'full', 'an exact title must not be pushed out by partials');
  assert.deepEqual(kept.slice(1).map((entry) => entry.match_level), ['partial', 'partial', 'partial']);
});

test('a query with no model code keeps the strict all-token rule', () => {
  // Without an anchor there is nothing to be confident about, so a loose match would let a keyboard
  // through on a mouse comparison.
  const candidates = [
    { product_id: 'mouse', name: '로지텍 무선 마우스', price: 10, currency: 'USD', shipping_cost: 0 },
    { product_id: 'keyboard', name: '로지텍 무선 키보드', price: 20, currency: 'USD', shipping_cost: 0 },
  ];
  const kept = comparison(candidates, '로지텍 무선 마우스');
  assert.deepEqual(kept.map((entry) => entry.product_id), ['mouse']);
});

test('the model anchor tolerates the spacing and case storefronts use', () => {
  const candidates = [
    { product_id: 'a', name: '로지텍 m185 무선마우스', price: 10, currency: 'USD', shipping_cost: 0 },
    { product_id: 'b', name: '로지텍 M-185 무선마우스', price: 11, currency: 'USD', shipping_cost: 0 },
    { product_id: 'c', name: '로지텍 M185r 무선마우스', price: 12, currency: 'USD', shipping_cost: 0 },
  ];
  const kept = comparison(candidates, 'Logitech M185', { identity_model: 'M185', identity_brand: 'Logitech', brand_aliases: LOGITECH });
  const ids = kept.map((entry) => entry.product_id);

  assert.ok(ids.includes('a'), 'lowercase model code must match');
  assert.ok(ids.includes('b'), 'a hyphenated model code must match');
  assert.ok(!ids.includes('c'), 'a longer model code is a different product');
});

// ── the window tells the user which rows are only similar ─────────────────────

test('a partial match is marked in the rendered window', () => {
  const ranked = lua.call('AX_rank_store_offers', {
    identity_id: 'id-1',
    failures: [],
    verified_offers: [
      {
        site: 'ssg', product_id: 'k1', name: '로지텍정품 M185 무선 광 마우스', price: 19400, currency: 'KRW',
        shipping_cost: 0, base_currency: 'USD', total_base: 13.2, total_for_quantity: 19400, cost_complete: true,
        identity_id: 'id-1', match_level: 'partial',
      },
      {
        site: 'amazon', product_id: 'a1', name: 'Logitech M185 Wireless Mouse', price: 13.95, currency: 'USD',
        shipping_cost: 0, base_currency: 'USD', total_base: 13.95, total_for_quantity: 13.95, cost_complete: true,
        identity_id: 'id-1', match_level: 'exact',
      },
    ],
  });

  const partialLine = ranked.comparison_text.split('\n').find((line) => line.includes('로지텍정품'));
  const exactLine = ranked.comparison_text.split('\n').find((line) => line.includes('Logitech M185 Wireless'));
  assert.match(partialLine, /유사/);
  assert.doesNotMatch(exactLine, /유사/);
});
