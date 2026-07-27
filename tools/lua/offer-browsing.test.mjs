import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';

import { loadLuaModules } from './harness.mjs';

const lua = loadLuaModules([
  '_common/scripts/00_base.lua',
  '_common/scripts/44_pagination.lua',
  '_common/scripts/45_offer_view.lua',
  '_common/scripts/50_commerce.lua',
]);
after(() => lua.close());

const SITES = ['coupang', 'ssg', 'amazon'];

function offers(count, overrides = () => ({})) {
  return Array.from({ length: count }, (_, index) => ({
    site: SITES[index % SITES.length],
    product_id: `p${index + 1}`,
    name: `로지텍 M185 옵션 ${index + 1}`,
    price: 10000 + (index * 1000),
    currency: 'KRW',
    shipping_cost: index % 2 === 0 ? 0 : 3000,
    shipping_currency: 'KRW',
    base_currency: 'USD',
    total_base: 7 + index,
    total_for_quantity: 10000 + (index * 1000) + (index % 2 === 0 ? 0 : 3000),
    cost_complete: true,
    rating: 4.9 - (index * 0.1),
    identity_id: 'id-1',
    ...overrides(index),
  }));
}

function rank(list) {
  return lua.call('AX_rank_store_offers', { verified_offers: list, identity_id: 'id-1', failures: [] });
}

let ranked;
beforeEach(() => { ranked = rank(offers(8)); });

// The browsing node is deterministic: it hands the tool the listing and window it currently holds in
// flow state. `view` carries the page forward exactly as the flow's own state does.
let view = { page: 1, offers: null, all_offers: null, comparison_id: null };
beforeEach(() => { view = { page: 1, offers: ranked.offers, all_offers: ranked.offers, comparison_id: ranked.comparison_id }; });

function browse(args = {}) {
  const result = lua.call('AX_refine_store_offers', {
    comparison_id: view.comparison_id,
    offers: view.offers,
    all_offers: view.all_offers,
    view_page: view.page,
    ...args,
  });
  if (!result.error && result.next === 'ask') {
    view = {
      page: result.view_page,
      offers: result.offers ?? view.offers,
      all_offers: result.all_offers ?? view.all_offers,
      comparison_id: result.comparison_id,
    };
  }
  return result;
}

// ── ranking keeps the whole list, shows one window ────────────────────────────
// The prompt cost must not grow with the number of offers: state holds every offer, the model only ever
// sees the current window.

test('ranking keeps every verified offer in state', () => {
  assert.equal(ranked.offers.length, 8);
  assert.equal(ranked.view_total, 8);
  assert.equal(ranked.view_page, 1);
  assert.equal(ranked.view_pages, 2);
});

test('the presented text is one window, not the whole list', () => {
  assert.match(ranked.comparison_text, /(^|\n)1\./);
  assert.match(ranked.comparison_text, /(^|\n)5\./);
  assert.doesNotMatch(ranked.comparison_text, /(^|\n)6\./);
  assert.ok(ranked.comparison_text.length < 1400, `window was ${ranked.comparison_text.length} chars`);
});

test('a comparison that fits one page says so', () => {
  const small = rank(offers(3));
  assert.equal(small.view_pages, 1);
  assert.match(small.comparison_text, /(^|\n)3\./);
});

// ── presentation + paging ─────────────────────────────────────────────────────

test('presenting returns the current window for the current comparison only', () => {
  const shown = lua.call('AX_present_store_offers', { comparison_id: ranked.comparison_id });
  assert.equal(shown.question, ranked.comparison_text);
  assert.equal(lua.call('AX_present_store_offers', { comparison_id: 'cmp-stale' }).error, 'stale_comparison');
});

test('paging forward keeps the snapshot and continues the global numbering', () => {
  const next = browse({ page_command: 'next' });

  assert.equal(next.next, 'ask');
  assert.equal(next.comparison_id, ranked.comparison_id, 'a page move must not invalidate the snapshot');
  assert.equal(next.view_page, 2);
  assert.match(next.question, /(^|\n)6\./);
  assert.match(next.question, /(^|\n)8\./);
  assert.doesNotMatch(next.question, /(^|\n)1\./);
});

test('paging past the end stays on the last page', () => {
  browse({ page_command: 'next' });
  const clamped = browse({ page_command: 'next' });
  assert.equal(clamped.view_page, 2);
});

test('an absolute page number is honoured and a stale snapshot is refused', () => {
  assert.equal(browse({ page_number: 2 }).view_page, 2);
  const stale = browse({ comparison_id: 'cmp-old', page_command: 'next' });
  assert.equal(stale.error, 'stale_comparison');
  // The flow routes this to a terminal that explains itself; answering "ask" sent the model back into
  // the same failing call seven times in one live turn.
  assert.equal(stale.next, 'error');
});

// ── refinement ────────────────────────────────────────────────────────────────

test('a filter reissues the comparison so old numbers cannot be reused', () => {
  const filtered = browse({ refine_request: '무료배송만 보여줘' });

  assert.equal(filtered.next, 'ask');
  assert.notEqual(filtered.comparison_id, ranked.comparison_id);
  assert.equal(filtered.view_page, 1);
  assert.equal(filtered.view_total, 4);
  assert.equal(filtered.offers.length, 4);
  for (const offer of filtered.offers) assert.equal(offer.shipping_cost, 0);
  assert.equal(filtered.offers[0].comparison_id, filtered.comparison_id);
});

test('a filter that matches nothing reports it instead of showing an empty window', () => {
  const empty = browse({ refine_request: '1000원 이하' });
  assert.equal(empty.refine_error, 'no_matches');
  // The previous listing stands and stays selectable, so the window still describes those offers.
  assert.equal(empty.comparison_id, ranked.comparison_id);
  assert.equal(empty.view_total, 8);
  assert.match(empty.question, /(^|\n)1\./);
});

test('an unparsed request asks again instead of guessing a filter', () => {
  const unclear = browse({ refine_request: '알아서 적당한 걸로' });

  assert.equal(unclear.next, 'ask');
  assert.equal(unclear.refine_error, 'unparsed');
  assert.equal(unclear.comparison_id, ranked.comparison_id);
  assert.equal(unclear.view_total, 8);
});

test('a reset restores the full list', () => {
  const filtered = browse({ refine_request: '무료배송만' });
  assert.equal(filtered.view_total, 4);

  const restored = browse({ refine_request: '필터 해제' });
  assert.equal(restored.view_total, 8);
});

test('a re-search request is routed out of the browsing loop', () => {
  const rescope = browse({ refine_request: 'M185 말고 M240으로 다시 찾아줘' });
  assert.equal(rescope.next, 'research');
  assert.equal(rescope.rescope_request, 'M185 말고 M240으로 다시 찾아줘');
});

test('sorting reorders the visible list and reissues the snapshot', () => {
  const sorted = browse({ refine_request: '평점 높은 순으로' });
  assert.notEqual(sorted.comparison_id, ranked.comparison_id);
  assert.equal(sorted.offers.length, 8);
  assert.ok(sorted.offers[0].rating >= sorted.offers[1].rating);
});

// ── selection across pages ────────────────────────────────────────────────────

test('a number from the second page selects that offer', () => {
  const next = browse({ page_command: 'next' });
  const resolved = lua.call('AX_resolve_store_offer', {
    choice_stage: 'asked',
    offers: ranked.offers,
    choice_index: 7,
    choice_comparison_id: next.comparison_id,
    comparison_id: next.comparison_id,
    identity_id: 'id-1',
  });

  assert.equal(resolved.next, 'add');
  assert.equal(resolved.product_id, 'p7');
  assert.equal(resolved.selected_rank, 7);
});

test('a number from a filtered list resolves against the filtered offers', () => {
  const filtered = browse({ refine_request: '무료배송만' });
  const resolved = lua.call('AX_resolve_store_offer', {
    choice_stage: 'asked',
    offers: filtered.offers,
    choice_index: 2,
    choice_comparison_id: filtered.comparison_id,
    comparison_id: filtered.comparison_id,
    identity_id: 'id-1',
  });

  assert.equal(resolved.next, 'add');
  assert.equal(resolved.product_id, filtered.offers[1].product_id);
});

test('a number issued against the pre-filter snapshot is refused', () => {
  const filtered = browse({ refine_request: '무료배송만' });
  const resolved = lua.call('AX_resolve_store_offer', {
    choice_stage: 'asked',
    offers: filtered.offers,
    choice_index: 2,
    choice_comparison_id: ranked.comparison_id,
    comparison_id: filtered.comparison_id,
    identity_id: 'id-1',
  });

  assert.equal(resolved.next, 'invalid');
  assert.equal(resolved.error, 'stale_comparison');
});

// ── the listing must survive every browsing turn ─────────────────────────────
// A page move returned no `offers`, so the flow state was wiped and the NEXT browsing call reported
// stale_comparison — observed live right after a filter that could not be grounded.

test('every browsing answer carries the listing it rendered', () => {
  for (const args of [{ page_command: 'next' }, { refine_request: '알 수 없는 문장' }, { refine_request: '1000원 이하' }]) {
    const answer = browse(args);
    assert.ok(Array.isArray(answer.offers) && answer.offers.length > 0,
      `${JSON.stringify(args)} returned no offers, which empties the flow state`);
    assert.ok(Array.isArray(answer.all_offers) && answer.all_offers.length > 0);
    assert.equal(answer.offers[0].comparison_id, answer.comparison_id);
  }
});

test('two browsing turns in a row keep working', () => {
  const first = browse({ page_command: 'next' });
  assert.equal(first.view_page, 2);
  const second = browse({ page_command: 'prev' });
  assert.equal(second.error ?? null, null, 'the second call must still see the listing');
  assert.equal(second.view_page, 1);
});
