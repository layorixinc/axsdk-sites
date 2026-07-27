import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { loadLuaModules } from './harness.mjs';

const lua = loadLuaModules([
  '_common/scripts/00_base.lua',
  '_common/scripts/44_pagination.lua',
  '_common/scripts/45_offer_view.lua',
  '_common/scripts/50_commerce.lua',
  '_common/scripts/60_storefront.lua',
]);
after(() => lua.close());

const pagedConfig = { site: 'coupang', pagination: { mode: 'query', param: 'page', start: 1, step: 1, max_pages: 2 } };

function candidate(id, overrides = {}) {
  return {
    product_id: id,
    id,
    name: `로지텍 M185 ${id}`,
    price: 10690,
    currency: 'KRW',
    shipping_cost: 0,
    cost_complete: true,
    total_base: 7.3,
    ...overrides,
  };
}

// ── adapter-side page planning ────────────────────────────────────────────────

test('a storefront config exposes its page plan through the adapter layer', () => {
  const plan = lua.call('AX_STOREFRONT.page_plan', pagedConfig, 2);
  assert.equal(plan.supported, true);
  assert.deepEqual(plan.params, { page: 2 });
});

test('a storefront without a pagination block stays single page', () => {
  const plan = lua.call('AX_STOREFRONT.page_plan', { site: 'etsy' }, 2);
  assert.equal(plan.supported, false);
  assert.equal(plan.error, 'pagination_unsupported');
});

test('has_more only claims another page when one is reachable and this page had rows', () => {
  assert.equal(lua.call('AX_STOREFRONT.has_more_from', 12, true, null), true);
  assert.equal(lua.call('AX_STOREFRONT.has_more_from', 0, true, null), false);
  assert.equal(lua.call('AX_STOREFRONT.has_more_from', 12, false, null), false);
  // An explicitly probed and absent "next page" control outranks the row count.
  assert.equal(lua.call('AX_STOREFRONT.has_more_from', 12, true, false), false);
  assert.equal(lua.call('AX_STOREFRONT.has_more_from', 12, true, true), true);
});

// ── collecting pages into one store result ────────────────────────────────────

test('a first page below the per-store target asks for another page', () => {
  const collected = lua.call('AX_collect_store_page', {
    collected: null,
    page: 1,
    remote_used: 2,
    remote_budget: 10,
    result: { site: 'coupang', query: 'M185', candidates: [candidate('a')], has_more: true, page: 1 },
  });

  assert.equal(collected.next, 'more');
  assert.equal(collected.page, 2);
  assert.equal(collected.collected_count, 1);
  assert.deepEqual(collected.collected.map((entry) => entry.product_id), ['a']);
});

test('a page that fills the per-store target stops the loop', () => {
  const collected = lua.call('AX_collect_store_page', {
    collected: null,
    page: 1,
    remote_used: 2,
    remote_budget: 10,
    result: {
      site: 'coupang',
      query: 'M185',
      candidates: [candidate('a'), candidate('b'), candidate('c')],
      has_more: true,
      page: 1,
    },
  });

  assert.equal(collected.next, 'done');
  assert.equal(collected.stop_reason, 'target_reached');
  assert.equal(collected.store_result.candidates.length, 3);
});

test('a second page is merged into one store result and re-ranked by page order', () => {
  const first = lua.call('AX_collect_store_page', {
    collected: null,
    page: 1,
    remote_used: 2,
    remote_budget: 10,
    result: { site: 'coupang', query: 'M185', candidates: [candidate('a')], has_more: true, page: 1 },
  });
  const second = lua.call('AX_collect_store_page', {
    collected: first.collected,
    page: 2,
    remote_used: 4,
    remote_budget: 10,
    result: { site: 'coupang', query: 'M185', candidates: [candidate('a'), candidate('b')], has_more: false, page: 2 },
  });

  assert.equal(second.next, 'done');
  assert.equal(second.stop_reason, 'no_more_pages');
  assert.deepEqual(second.store_result.candidates.map((entry) => entry.product_id), ['a', 'b']);
  assert.deepEqual(second.store_result.candidates.map((entry) => entry.source_page), [1, 2]);
  assert.equal(second.store_result.pages_read, 2);
});

test('the merged store result never exceeds the per-store offer cap', () => {
  const first = lua.call('AX_collect_store_page', {
    collected: null,
    page: 1,
    remote_used: 2,
    remote_budget: 10,
    result: { site: 'coupang', query: 'M185', candidates: [candidate('a'), candidate('b')], has_more: true, page: 1 },
  });
  const second = lua.call('AX_collect_store_page', {
    collected: first.collected,
    page: 2,
    remote_used: 4,
    remote_budget: 10,
    result: { site: 'coupang', query: 'M185', candidates: [candidate('c'), candidate('d'), candidate('e')], has_more: true, page: 2 },
  });

  assert.ok(second.store_result.candidates.length <= 3, `got ${second.store_result.candidates.length}`);
  assert.deepEqual(second.store_result.candidates.map((entry) => entry.product_id), ['a', 'b', 'c']);
});

test('a store error keeps whatever earlier pages produced and stops', () => {
  const first = lua.call('AX_collect_store_page', {
    collected: null,
    page: 1,
    remote_used: 2,
    remote_budget: 10,
    result: { site: 'coupang', query: 'M185', candidates: [candidate('a')], has_more: true, page: 1 },
  });
  const second = lua.call('AX_collect_store_page', {
    collected: first.collected,
    page: 2,
    remote_used: 4,
    remote_budget: 10,
    result: { site: 'coupang', query: 'M185', error: 'captcha_required', candidates: [] },
  });

  assert.equal(second.next, 'done');
  assert.equal(second.stop_reason, 'store_error');
  assert.equal(second.store_result.candidates.length, 1);
  // Lua cannot carry an explicit null, so a cleared error is an absent key.
  assert.equal(second.store_result.error ?? null, null);
  assert.equal(second.store_result.page_error, 'captcha_required');
});

test('an error on the very first page is reported as the store result error', () => {
  const collected = lua.call('AX_collect_store_page', {
    collected: null,
    page: 1,
    remote_used: 2,
    remote_budget: 10,
    result: { site: 'coupang', query: 'M185', error: 'no_results', candidates: [] },
  });

  assert.equal(collected.next, 'done');
  assert.equal(collected.store_result.error, 'no_results');
  assert.equal(collected.collected_count, 0);
});

test('discovery reads a wider target than a price comparison', () => {
  const rows = Array.from({ length: 4 }, (_, index) => candidate(`d${index}`));
  const comparison = lua.call('AX_collect_store_page', {
    collected: null, page: 1, remote_used: 2, remote_budget: 10, purpose: 'comparison',
    result: { site: 'coupang', query: 'M185', candidates: rows, has_more: true, page: 1 },
  });
  const discovery = lua.call('AX_collect_store_page', {
    collected: null, page: 1, remote_used: 2, remote_budget: 10, purpose: 'discovery',
    result: { site: 'coupang', query: 'M185', candidates: rows, has_more: true, page: 1 },
  });

  assert.equal(comparison.next, 'done');
  assert.equal(discovery.next, 'more');
});

test('the page loop stops when the worker has no remote calls left', () => {
  const collected = lua.call('AX_collect_store_page', {
    collected: null,
    page: 1,
    remote_used: 10,
    remote_budget: 10,
    result: { site: 'coupang', query: 'M185', candidates: [candidate('a')], has_more: true, page: 1 },
  });

  assert.equal(collected.next, 'done');
  assert.equal(collected.stop_reason, 'budget_exhausted');
});

test('a first page with no relevant rows reads the next page instead of giving up', () => {
  // Normalisation reports `no_results` for a page whose rows were all irrelevant. That is an empty page,
  // not a broken store, and page two is exactly where the missing match tends to be.
  const collected = lua.call('AX_collect_store_page', {
    collected: null,
    page: 1,
    remote_used: 2,
    remote_budget: 10,
    result: { site: 'ssg', query: 'M185', error: 'no_results', candidates: [], has_more: true },
  });

  assert.equal(collected.next, 'more');
  assert.equal(collected.page, 2);
});

test('a blocked store stops even when it claims another page exists', () => {
  const collected = lua.call('AX_collect_store_page', {
    collected: null,
    page: 1,
    remote_used: 2,
    remote_budget: 10,
    result: { site: 'ssg', query: 'M185', error: 'security_verification_required', candidates: [], has_more: true },
  });

  assert.equal(collected.next, 'done');
  assert.equal(collected.stop_reason, 'store_error');
  assert.equal(collected.store_result.error, 'security_verification_required');
});
