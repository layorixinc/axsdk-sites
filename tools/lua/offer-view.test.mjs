import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { loadLuaModules } from './harness.mjs';

const lua = loadLuaModules(['_common/scripts/45_offer_view.lua']);
after(() => lua.close());

function offer(overrides = {}) {
  return {
    site: 'coupang',
    product_id: 'p1',
    name: '로지텍 무선마우스 M185',
    price: 10690,
    currency: 'KRW',
    shipping_cost: 2500,
    total_base: 9.03,
    total_for_quantity: 13190,
    cost_complete: true,
    rating: 4.5,
    review_count: 120,
    sponsored: false,
    ...overrides,
  };
}

// ── refine parsing ────────────────────────────────────────────────────────────
// The model forwards the user's sentence verbatim; every interpretation happens here, so an
// unsupported sentence must be reported rather than guessed into a filter.

test('parses a price ceiling written in Korean man-won units', () => {
  const parsed = lua.call('AX_OFFER_VIEW.parse_refine', '3만원 이하로 보여줘');
  assert.equal(parsed.unparsed, false);
  assert.equal(parsed.filters.price_max, 30000);
});

test('parses a plain numeric price ceiling and a floor', () => {
  assert.equal(lua.call('AX_OFFER_VIEW.parse_refine', '20000원 이하').filters.price_max, 20000);
  assert.equal(lua.call('AX_OFFER_VIEW.parse_refine', '10000원 이상').filters.price_min, 10000);
});

test('parses shipping, rating, sponsored, and site filters', () => {
  assert.equal(lua.call('AX_OFFER_VIEW.parse_refine', '무료배송만').filters.free_shipping_only, true);
  assert.equal(lua.call('AX_OFFER_VIEW.parse_refine', '평점 4점 이상').filters.min_rating, 4);
  assert.equal(lua.call('AX_OFFER_VIEW.parse_refine', '광고 빼고').filters.exclude_sponsored, true);
  assert.deepEqual(lua.call('AX_OFFER_VIEW.parse_refine', '쿠팡 것만 보여줘').filters.sites, ['coupang']);
});

test('parses sort intents', () => {
  assert.equal(lua.call('AX_OFFER_VIEW.parse_refine', '싼 순으로').sort, 'total_asc');
  assert.equal(lua.call('AX_OFFER_VIEW.parse_refine', '평점 높은 순').sort, 'rating_desc');
});

test('reports an unparsed sentence instead of inventing a filter', () => {
  const parsed = lua.call('AX_OFFER_VIEW.parse_refine', '적당히 괜찮은 걸로 알아서 골라줘');
  assert.equal(parsed.unparsed, true);
  assert.deepEqual(parsed.filters, {});
  // An absent key means "propose no change"; the flow only overwrites state for keys it receives.
  assert.equal(parsed.sort ?? null, null);
});

test('recognizes an explicit filter reset', () => {
  const parsed = lua.call('AX_OFFER_VIEW.parse_refine', '필터 해제');
  assert.equal(parsed.reset, true);
  assert.equal(parsed.unparsed, false);
});

test('detects a re-search request as out of scope for view filters', () => {
  const parsed = lua.call('AX_OFFER_VIEW.parse_refine', 'M185 말고 M240으로 다시 찾아줘');
  assert.equal(parsed.rescope, true);
  assert.equal(parsed.unparsed, false);
});

// ── filter + sort application ─────────────────────────────────────────────────

test('applies filters conjunctively and keeps input order within a sort', () => {
  const items = [
    offer({ product_id: 'a', total_base: 20, shipping_cost: 0, rating: 3.9 }),
    offer({ product_id: 'b', total_base: 10, shipping_cost: 2500, rating: 4.8 }),
    offer({ product_id: 'c', total_base: 15, shipping_cost: 0, rating: 4.2 }),
  ];
  const kept = lua.call('AX_OFFER_VIEW.apply', items, { filters: { free_shipping_only: true }, sort: 'total_asc' });
  assert.deepEqual(kept.map((entry) => entry.product_id), ['c', 'a']);
});

test('sorts by rating and by native price on request', () => {
  const items = [
    offer({ product_id: 'a', total_base: 20, price: 30000, rating: 3.9 }),
    offer({ product_id: 'b', total_base: 10, price: 50000, rating: 4.8 }),
  ];
  assert.deepEqual(
    lua.call('AX_OFFER_VIEW.apply', items, { sort: 'rating_desc' }).map((entry) => entry.product_id),
    ['b', 'a'],
  );
  assert.deepEqual(
    lua.call('AX_OFFER_VIEW.apply', items, { sort: 'price_asc' }).map((entry) => entry.product_id),
    ['a', 'b'],
  );
});

test('filters by price bounds against the native price, not the converted base', () => {
  const items = [
    offer({ product_id: 'cheap', price: 10000, total_base: 7 }),
    offer({ product_id: 'dear', price: 40000, total_base: 28 }),
  ];
  const kept = lua.call('AX_OFFER_VIEW.apply', items, { filters: { price_max: 30000 } });
  assert.deepEqual(kept.map((entry) => entry.product_id), ['cheap']);
});

test('keeps incomplete-cost offers out only when the caller asks', () => {
  const items = [offer({ product_id: 'known' }), offer({ product_id: 'partial', cost_complete: false })];
  assert.equal(lua.call('AX_OFFER_VIEW.apply', items, {}).length, 2);
  assert.deepEqual(
    lua.call('AX_OFFER_VIEW.apply', items, { filters: { complete_cost_only: true } }).map((e) => e.product_id),
    ['known'],
  );
});

// ── paging arithmetic ─────────────────────────────────────────────────────────

test('clamps page bounds and reports the page count', () => {
  assert.deepEqual(lua.call('AX_OFFER_VIEW.page_bounds', 12, 2, 5), { first: 6, last: 10, page: 2, pages: 3 });
  assert.deepEqual(lua.call('AX_OFFER_VIEW.page_bounds', 12, 99, 5), { first: 11, last: 12, page: 3, pages: 3 });
  assert.deepEqual(lua.call('AX_OFFER_VIEW.page_bounds', 0, 1, 5), { first: 0, last: 0, page: 1, pages: 1 });
});

test('resolves page commands without leaving the range', () => {
  assert.equal(lua.call('AX_OFFER_VIEW.resolve_page', 1, 'next', null, 3), 2);
  assert.equal(lua.call('AX_OFFER_VIEW.resolve_page', 3, 'next', null, 3), 3);
  assert.equal(lua.call('AX_OFFER_VIEW.resolve_page', 1, 'prev', null, 3), 1);
  assert.equal(lua.call('AX_OFFER_VIEW.resolve_page', 2, 'last', null, 3), 3);
  assert.equal(lua.call('AX_OFFER_VIEW.resolve_page', 2, null, 3, 3), 3);
  assert.equal(lua.call('AX_OFFER_VIEW.resolve_page', 2, null, 9, 3), 3);
});

// ── window rendering ──────────────────────────────────────────────────────────
// The model never sees the offer list, only this text, so the window must stay inside a fixed
// character budget no matter how many offers exist.

test('renders one window with global numbering and a total count', () => {
  const items = Array.from({ length: 12 }, (_, index) => offer({
    product_id: `p${index + 1}`,
    name: `상품 ${index + 1}`,
    total_for_quantity: 10000 + index,
  }));
  const view = lua.call('AX_OFFER_VIEW.render', items, { page: 2, page_size: 5, display_currency: 'KRW' });

  assert.equal(view.page, 2);
  assert.equal(view.pages, 3);
  assert.equal(view.total, 12);
  assert.match(view.text, /6\./);
  assert.match(view.text, /10\./);
  assert.doesNotMatch(view.text, /(^|\n)1\./);
  assert.match(view.text, /12/);
});

test('keeps the rendered window inside the character budget by degrading fields', () => {
  const items = Array.from({ length: 5 }, (_, index) => offer({
    product_id: `p${index + 1}`,
    name: `아주 긴 상품명 ${'가'.repeat(120)} ${index + 1}`,
    condition: '새 상품',
    rating: 4.4,
  }));
  const view = lua.call('AX_OFFER_VIEW.render', items, { page: 1, page_size: 5, budget_chars: 700 });

  assert.ok(view.text.length <= 700, `window was ${view.text.length} chars`);
  assert.equal(view.truncated, true);
  for (let number = 1; number <= 5; number += 1) {
    assert.match(view.text, new RegExp(`(^|\\n)${number}\\.`));
  }
});

test('always keeps number, site, and total on every line', () => {
  const items = [offer({ name: '가'.repeat(200), total_for_quantity: 13190 })];
  const view = lua.call('AX_OFFER_VIEW.render', items, { page: 1, page_size: 5, budget_chars: 260, display_currency: 'KRW' });
  const line = view.text.split('\n').find((entry) => entry.startsWith('1.'));
  assert.ok(line, 'numbered line missing');
  assert.match(line, /coupang/);
  assert.match(line, /13,?190/);
});

test('renders an empty result without pretending there are offers', () => {
  const view = lua.call('AX_OFFER_VIEW.render', [], { page: 1, page_size: 5 });
  assert.equal(view.total, 0);
  assert.equal(view.pages, 1);
  assert.match(view.text, /0/);
});

// ── snapshot signature ────────────────────────────────────────────────────────
// Paging must keep the comparison snapshot; changing what the list contains must invalidate it.

test('signature ignores page moves and changes with filters or sort', () => {
  const base = lua.call('AX_OFFER_VIEW.signature', { free_shipping_only: true }, 'total_asc');
  const same = lua.call('AX_OFFER_VIEW.signature', { free_shipping_only: true }, 'total_asc');
  const otherSort = lua.call('AX_OFFER_VIEW.signature', { free_shipping_only: true }, 'rating_desc');
  const otherFilter = lua.call('AX_OFFER_VIEW.signature', { free_shipping_only: true, price_max: 30000 }, 'total_asc');

  assert.equal(base, same);
  assert.notEqual(base, otherSort);
  assert.notEqual(base, otherFilter);
});

test('signature is order independent for equivalent filter sets', () => {
  const first = lua.call('AX_OFFER_VIEW.signature', { price_max: 30000, free_shipping_only: true }, 'total_asc');
  const second = lua.call('AX_OFFER_VIEW.signature', { free_shipping_only: true, price_max: 30000 }, 'total_asc');
  assert.equal(first, second);
});

// ── price thresholds are currency-aware ──────────────────────────────────────
// "3만원 이하" means 30,000 KRW. Comparing that number against a USD price let every USD offer through a
// filter the user meant to exclude them from (observed live on an SSG + Amazon comparison).

function mixed() {
  return [
    { site: 'ssg', product_id: 'krw-cheap', price: 19400, currency: 'KRW', price_base: 13.28, base_currency: 'USD', total_base: 13.28, shipping_cost: 0 },
    { site: 'ssg', product_id: 'krw-dear', price: 52000, currency: 'KRW', price_base: 35.6, base_currency: 'USD', total_base: 35.6, shipping_cost: 0 },
    { site: 'amazon', product_id: 'usd-cheap', price: 13.95, currency: 'USD', price_base: 13.95, base_currency: 'USD', total_base: 13.95, shipping_cost: 0 },
    { site: 'amazon', product_id: 'usd-dear', price: 41.0, currency: 'USD', price_base: 41.0, base_currency: 'USD', total_base: 41.0, shipping_cost: 0 },
  ];
}

test('a won threshold is read as won, whatever the offer quotes', () => {
  const parsed = lua.call('AX_OFFER_VIEW.parse_refine', '3만원 이하만 보여줘');
  assert.equal(parsed.filters.price_max, 30000);
  assert.equal(parsed.filters.price_currency, 'KRW');

  const kept = lua.call('AX_OFFER_VIEW.apply', mixed(), { filters: parsed.filters, sort: 'total_asc' });
  assert.deepEqual(kept.map((entry) => entry.product_id).sort(), ['krw-cheap', 'usd-cheap']);
});

test('a dollar threshold is read as dollars', () => {
  const parsed = lua.call('AX_OFFER_VIEW.parse_refine', '$20 이하');
  assert.equal(parsed.filters.price_max, 20);
  assert.equal(parsed.filters.price_currency, 'USD');

  const kept = lua.call('AX_OFFER_VIEW.apply', mixed(), { filters: parsed.filters });
  assert.deepEqual(kept.map((entry) => entry.product_id).sort(), ['krw-cheap', 'usd-cheap']);
});

test('a threshold in a currency nothing quotes is refused, not guessed', () => {
  assert.equal(lua.call('AX_OFFER_VIEW.filter_error', mixed(), { price_max: 30, price_currency: 'JPY' }), 'price_currency_unknown');
  assert.equal(lua.call('AX_OFFER_VIEW.filter_error', mixed(), { price_max: 30000, price_currency: 'KRW' }) ?? null, null);
});

test('a bare number compares against the offer own price', () => {
  const parsed = lua.call('AX_OFFER_VIEW.parse_refine', '20000 이하');
  assert.equal(parsed.filters.price_max, 20000);
  assert.equal(parsed.filters.price_currency ?? null, null);
  const kept = lua.call('AX_OFFER_VIEW.apply', mixed(), { filters: parsed.filters });
  assert.deepEqual(kept.map((entry) => entry.product_id).sort(), ['krw-cheap', 'usd-cheap', 'usd-dear']);
});
