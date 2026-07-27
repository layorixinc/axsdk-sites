import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';

import { loadLuaModules } from './harness.mjs';

// Every user turn runs in a fresh Lua context: a navigation destroys module state, so nothing a later
// turn needs may live in a Lua global. The offer list travels in flow state (the browsing node is
// deterministic and reads it from there); only the rendered window has to survive for the model-called
// presentation tool, and the session store accepts strings only.
const lua = loadLuaModules([
  'tools/lua/fixtures/session_state_stub.lua',
  '_common/scripts/00_base.lua',
  '_common/scripts/44_pagination.lua',
  '_common/scripts/45_offer_view.lua',
  '_common/scripts/50_commerce.lua',
]);
after(() => lua.close());

function offers(count) {
  return Array.from({ length: count }, (_, index) => ({
    site: index % 2 === 0 ? 'ssg' : 'amazon',
    product_id: `p${index + 1}`,
    name: `로지텍 M170 옵션 ${index + 1}`,
    price: 10000 + (index * 1000),
    currency: 'KRW',
    shipping_cost: index % 2 === 0 ? 0 : 2500,
    base_currency: 'USD',
    total_base: 7 + index,
    total_for_quantity: 10000 + (index * 1000),
    cost_complete: true,
    rating: 4.8 - (index * 0.1),
    identity_id: 'id-1',
  }));
}

let ranked;
beforeEach(() => {
  lua.call('session_state.clear');
  ranked = lua.call('AX_rank_store_offers', { verified_offers: offers(8), identity_id: 'id-1', failures: [] });
});

test('ranking persists the window as strings the session store accepts', () => {
  const keys = lua.call('session_state.keys');
  assert.ok(keys.length > 0, 'nothing was persisted');
  for (const key of keys) {
    assert.equal(typeof lua.call('session_state.get', key), 'string', `${key} must be stored as a string`);
  }
});

test('presenting works in the next turn, after the Lua context is gone', () => {
  lua.call('TEST_SESSION.drop_lua_context');
  const shown = lua.call('AX_present_store_offers', { comparison_id: ranked.comparison_id });

  assert.equal(shown.error ?? null, null);
  assert.equal(shown.question, ranked.comparison_text);
  assert.equal(shown.view_page, 1);
  assert.equal(shown.view_total, 8);
});

test('an unknown comparison id is still refused', () => {
  lua.call('TEST_SESSION.drop_lua_context');
  assert.equal(lua.call('AX_present_store_offers', { comparison_id: 'cmp-nope' }).error, 'stale_comparison');
});

// ── browsing runs off flow state, not Lua state ───────────────────────────────

test('paging works from flow state alone after the Lua context is gone', () => {
  lua.call('TEST_SESSION.drop_lua_context');
  const next = lua.call('AX_refine_store_offers', {
    comparison_id: ranked.comparison_id,
    offers: ranked.offers,
    all_offers: ranked.offers,
    view_page: 1,
    page_command: 'next',
  });

  assert.equal(next.next, 'ask');
  assert.equal(next.comparison_id, ranked.comparison_id);
  assert.equal(next.view_page, 2);
  assert.match(next.question, /(^|\n)6\./);
});

test('a page move re-persists the window for the next presentation turn', () => {
  const next = lua.call('AX_refine_store_offers', {
    comparison_id: ranked.comparison_id,
    offers: ranked.offers,
    all_offers: ranked.offers,
    view_page: 1,
    page_command: 'next',
  });
  lua.call('TEST_SESSION.drop_lua_context');

  const shown = lua.call('AX_present_store_offers', { comparison_id: next.comparison_id });
  assert.equal(shown.question, next.question);
  assert.equal(shown.view_page, 2);
});

test('filtering works from flow state and reissues the comparison', () => {
  lua.call('TEST_SESSION.drop_lua_context');
  const filtered = lua.call('AX_refine_store_offers', {
    comparison_id: ranked.comparison_id,
    offers: ranked.offers,
    all_offers: ranked.offers,
    view_page: 1,
    refine_request: '무료배송만',
  });

  assert.equal(filtered.view_total, 4);
  assert.notEqual(filtered.comparison_id, ranked.comparison_id);
  assert.equal(filtered.offers.length, 4);
  assert.equal(filtered.all_offers.length, 8, 'the unfiltered list must travel on so a reset can restore it');

  lua.call('TEST_SESSION.drop_lua_context');
  const shown = lua.call('AX_present_store_offers', { comparison_id: filtered.comparison_id });
  assert.equal(shown.error ?? null, null);
  assert.equal(shown.view_total, 4);
  // The pre-filter numbering must no longer be presentable.
  assert.equal(lua.call('AX_present_store_offers', { comparison_id: ranked.comparison_id }).error, 'stale_comparison');
});

test('a reset restores the full list from the carried-over offers', () => {
  const filtered = lua.call('AX_refine_store_offers', {
    comparison_id: ranked.comparison_id,
    offers: ranked.offers,
    all_offers: ranked.offers,
    view_page: 1,
    refine_request: '무료배송만',
  });
  lua.call('TEST_SESSION.drop_lua_context');

  const restored = lua.call('AX_refine_store_offers', {
    comparison_id: filtered.comparison_id,
    offers: filtered.offers,
    all_offers: filtered.all_offers,
    view_page: 1,
    refine_request: '필터 해제',
  });
  assert.equal(restored.view_total, 8);
});

test('a browsing call against a superseded comparison is refused', () => {
  const filtered = lua.call('AX_refine_store_offers', {
    comparison_id: ranked.comparison_id,
    offers: ranked.offers,
    all_offers: ranked.offers,
    view_page: 1,
    refine_request: '무료배송만',
  });

  const stale = lua.call('AX_refine_store_offers', {
    comparison_id: ranked.comparison_id,
    offers: filtered.offers,
    all_offers: filtered.all_offers,
    view_page: 1,
    page_command: 'next',
  });
  assert.equal(stale.error, 'stale_comparison');
  assert.equal(stale.next, 'error', 'a lost listing must leave the browsing loop');
});
