import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { loadLuaModules } from './harness.mjs';

const lua = loadLuaModules(['_common/scripts/44_pagination.lua']);
after(() => lua.close());

const queryMode = { mode: 'query', param: 'page', start: 1, step: 1, max_pages: 2 };
const offsetMode = { mode: 'offset', param: 'start', start: 0, step: 24, max_pages: 2 };

// ── page targeting ────────────────────────────────────────────────────────────

test('the first page needs no extra parameter', () => {
  const plan = lua.call('AX_PAGINATION.plan_page', queryMode, 1);
  assert.equal(plan.supported, true);
  assert.equal(plan.needs_navigation, false);
  assert.deepEqual(plan.params, {});
});

test('a query-mode page becomes a page parameter', () => {
  const plan = lua.call('AX_PAGINATION.plan_page', queryMode, 2);
  assert.equal(plan.supported, true);
  assert.equal(plan.needs_navigation, true);
  assert.deepEqual(plan.params, { page: 2 });
});

test('an offset-mode page becomes a row offset', () => {
  assert.deepEqual(lua.call('AX_PAGINATION.plan_page', offsetMode, 2).params, { start: 24 });
  // A third page needs a site that allows it; the cap itself is asserted separately.
  assert.deepEqual(lua.call('AX_PAGINATION.plan_page', { ...offsetMode, max_pages: 3 }, 3).params, { start: 48 });
});

test('a click-mode page reports the selector instead of parameters', () => {
  const plan = lua.call('AX_PAGINATION.plan_page', { mode: 'click', next_selector: 'a[aria-label="다음"]', max_pages: 2 }, 2);
  assert.equal(plan.supported, true);
  assert.equal(plan.mode, 'click');
  assert.equal(plan.selector, 'a[aria-label="다음"]');
});

test('a site without pagination config is explicitly unsupported past page one', () => {
  const first = lua.call('AX_PAGINATION.plan_page', null, 1);
  assert.equal(first.supported, true);
  assert.equal(first.needs_navigation, false);

  const second = lua.call('AX_PAGINATION.plan_page', null, 2);
  assert.equal(second.supported, false);
  assert.equal(second.error, 'pagination_unsupported');
});

test('a page beyond the site cap is refused rather than guessed', () => {
  const plan = lua.call('AX_PAGINATION.plan_page', queryMode, 3);
  assert.equal(plan.supported, false);
  assert.equal(plan.error, 'page_out_of_range');
});

test('the default page cap is two for the first cut', () => {
  const plan = lua.call('AX_PAGINATION.plan_page', { mode: 'query', param: 'page' }, 3);
  assert.equal(plan.supported, false);
  assert.equal(plan.error, 'page_out_of_range');
  assert.equal(lua.call('AX_PAGINATION.max_pages', { mode: 'query', param: 'page' }), 2);
});

// ── accumulation across pages ─────────────────────────────────────────────────

test('merging stamps the source page and preserves read order', () => {
  const merged = lua.call('AX_PAGINATION.merge_pages', [], [{ product_id: 'a' }, { product_id: 'b' }], 1);
  assert.equal(merged.added, 2);
  assert.deepEqual(merged.items.map((entry) => entry.product_id), ['a', 'b']);
  assert.deepEqual(merged.items.map((entry) => entry.source_page), [1, 1]);
});

test('merging drops duplicates already seen on an earlier page', () => {
  const first = lua.call('AX_PAGINATION.merge_pages', [], [{ product_id: 'a' }, { product_id: 'b' }], 1);
  const second = lua.call('AX_PAGINATION.merge_pages', first.items, [{ product_id: 'b' }, { product_id: 'c' }], 2);

  assert.equal(second.added, 1);
  assert.deepEqual(second.items.map((entry) => entry.product_id), ['a', 'b', 'c']);
  assert.deepEqual(second.items.map((entry) => entry.source_page), [1, 1, 2]);
});

test('merging ignores rows without a product id', () => {
  const merged = lua.call('AX_PAGINATION.merge_pages', [], [{ product_id: 'a' }, { name: 'no id' }], 1);
  assert.equal(merged.added, 1);
  assert.equal(merged.items.length, 1);
});

// ── stop rules ────────────────────────────────────────────────────────────────
// Four independent reasons to stop; the first that applies wins, and every stop names itself so the
// caller can report why a comparison is thinner than the user expected.

test('continues while below the target and inside every budget', () => {
  const decision = lua.call('AX_PAGINATION.should_continue', {
    collected: 4, target: 9, page: 1, max_pages: 2, added: 4, remote_used: 2, remote_budget: 5, has_more: true,
  });
  assert.equal(decision.continue, true);
});

test('stops once enough qualifying candidates are collected', () => {
  const decision = lua.call('AX_PAGINATION.should_continue', {
    collected: 9, target: 9, page: 1, max_pages: 2, added: 9, remote_used: 2, remote_budget: 5, has_more: true,
  });
  assert.equal(decision.continue, false);
  assert.equal(decision.reason, 'target_reached');
});

test('stops at the page cap', () => {
  const decision = lua.call('AX_PAGINATION.should_continue', {
    collected: 4, target: 9, page: 2, max_pages: 2, added: 2, remote_used: 3, remote_budget: 5, has_more: true,
  });
  assert.equal(decision.continue, false);
  assert.equal(decision.reason, 'page_cap');
});

test('stops when the remote budget cannot afford another page', () => {
  const decision = lua.call('AX_PAGINATION.should_continue', {
    collected: 2, target: 9, page: 1, max_pages: 2, added: 2, remote_used: 5, remote_budget: 5, has_more: true,
  });
  assert.equal(decision.continue, false);
  assert.equal(decision.reason, 'budget_exhausted');
});

test('stops when a page added nothing new', () => {
  const decision = lua.call('AX_PAGINATION.should_continue', {
    collected: 3, target: 9, page: 1, max_pages: 2, added: 0, remote_used: 2, remote_budget: 5, has_more: true,
  });
  assert.equal(decision.continue, false);
  assert.equal(decision.reason, 'no_new_results');
});

test('stops when the site reports no further page', () => {
  const decision = lua.call('AX_PAGINATION.should_continue', {
    collected: 3, target: 9, page: 1, max_pages: 2, added: 3, remote_used: 2, remote_budget: 5, has_more: false,
  });
  assert.equal(decision.continue, false);
  assert.equal(decision.reason, 'no_more_pages');
});

test('an unreported next page is treated as no next page', () => {
  // `has_more` absent means the adapter could not tell; spending a navigation on a guess is worse than
  // stopping, so only an explicit `true` continues the loop.
  const decision = lua.call('AX_PAGINATION.should_continue', {
    collected: 1, target: 9, page: 1, max_pages: 2, added: 1, remote_used: 2, remote_budget: 5,
  });
  assert.equal(decision.continue, false);
  assert.equal(decision.reason, 'no_more_pages');
});

test('a page that yielded nothing usable still tries the next page', () => {
  // Page one full of irrelevant rows is exactly when page two is worth reading; the page cap bounds it.
  const decision = lua.call('AX_PAGINATION.should_continue', {
    collected: 0, target: 3, page: 1, max_pages: 2, added: 0, remote_used: 2, remote_budget: 10, has_more: true,
  });
  assert.equal(decision.continue, true);
});

test('a repeated page stops once something was already collected', () => {
  const decision = lua.call('AX_PAGINATION.should_continue', {
    collected: 2, target: 9, page: 1, max_pages: 3, added: 0, remote_used: 2, remote_budget: 10, has_more: true,
  });
  assert.equal(decision.continue, false);
  assert.equal(decision.reason, 'no_new_results');
});
