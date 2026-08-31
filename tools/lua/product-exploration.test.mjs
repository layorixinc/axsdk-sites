import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { loadLuaModules } from './harness.mjs';

const MODULES = [
  '_common/scripts/00_base.lua',
  '_common/scripts/44_pagination.lua',
  '_common/scripts/45_offer_view.lua',
  '_common/scripts/46_candidate_browser.lua',
  '_common/scripts/50_commerce_core.lua',
  '_common/scripts/51_relevance.lua',
  '_common/scripts/52_identity.lua',
  '_common/scripts/53_verify.lua',
  '_common/scripts/54_comparison.lua',
  '_common/scripts/55_offers.lua',
  '_common/rpc/73_rpc_offers.lua',
];

function runtime() {
  const lua = loadLuaModules(MODULES);
  lua.expose({
    json: {
      encode: (value) => JSON.stringify(value),
      decode: (text) => JSON.parse(text),
    },
  });
  return lua;
}

const lua = runtime();
after(() => lua.close());

const discoveryResults = [
  {
    key: '11st', status: 'completed', value: { site: '11st', candidates: [
      {
        site: '11st', product_id: 'm185-11', name: 'Logitech M185 Wireless Mouse Black',
        manufacturer_model: 'M185', brand: 'Logitech', price: 17900, currency: 'KRW',
        shipping_cost: 0, unit_total: 17900, url: 'https://www.11st.co.kr/products/m185-11',
        facets: {
          brand: { value: 'Logitech', evidence: 'Logitech' },
          color: { value: 'black', evidence: 'Black' },
        },
      },
      {
        site: '11st', product_id: 'm240-11', name: 'Logitech M240 Silent Bluetooth Mouse White',
        manufacturer_model: 'M240', brand: 'Logitech', price: 24900, currency: 'KRW',
        shipping_cost: 0, unit_total: 24900, url: 'https://www.11st.co.kr/products/m240-11',
        facets: {
          brand: { value: 'Logitech', evidence: 'Logitech' },
          color: { value: 'white', evidence: 'White' },
          connectivity: { value: 'bluetooth', evidence: 'Bluetooth' },
        },
      },
    ] },
  },
  {
    key: 'walmart', status: 'completed', value: { site: 'walmart', candidates: [
      {
        site: 'walmart', product_id: 'm185-wm', name: 'Logitech M185 Wireless Mouse Black',
        manufacturer_model: 'M185', brand: 'Logitech', price: 12.99, currency: 'USD',
        shipping_cost: 0, unit_total: 12.99, url: 'https://www.walmart.com/ip/m185-wm',
        facets: {
          brand: { value: 'Logitech', evidence: 'Logitech' },
          color: { value: 'black', evidence: 'Black' },
        },
      },
      {
        site: 'walmart', product_id: 'other-wm', name: 'Acme Basic Wireless Mouse Blue',
        brand: 'Acme', price: 8.5, currency: 'USD', shipping_cost: 0, unit_total: 8.5,
        url: 'https://www.walmart.com/ip/other-wm',
        facets: {
          brand: { value: 'Acme', evidence: 'Acme' },
          color: { value: 'blue', evidence: 'Blue' },
        },
      },
    ] },
  },
];

test('exact model requests retain a model-free exploration query and store frontier', () => {
  const prepared = lua.call('AX_prepare_product_identity', {
    identity_kind: 'standardized_model',
    product_category: 'wireless mouse',
    requested_brand: 'Logitech',
    requested_model: 'M185',
    query: 'Logitech M185 wireless mouse',
    stores: [{ site: '11st' }, { site: 'walmart' }],
  });

  assert.equal(prepared.next, 'lock');
  assert.equal(prepared.exploration_query, 'Logitech wireless mouse');
  assert.deepEqual(prepared.discovery_sites, [{ site: '11st' }, { site: 'walmart' }]);
});

test('model-free and spec-equivalent requests explore before locking', () => {
  for (const request of [
    {
      identity_kind: 'standardized_model', product_category: 'wireless mouse',
      requested_brand: 'Logitech', query: 'Logitech wireless mouse',
    },
    {
      identity_kind: 'spec_equivalent', product_category: '계란', query: '특란 30구',
      hard_constraints: { grade: 'XL', count: 30 },
    },
  ]) {
    const prepared = lua.call('AX_prepare_product_identity', {
      ...request,
      stores: [{ site: 'coupang' }, { site: 'gmarket' }],
    });
    assert.equal(prepared.next, 'explore', JSON.stringify(prepared));
    assert.equal(prepared.exploration_query, request.query);
    assert.equal(prepared.discovery_sites.length, 2);
  }
});

test('exploration groups grounded models and keeps unique listings selectable', () => {
  const built = lua.call('AX_build_product_exploration', {
    results: discoveryResults,
    query: 'wireless mouse',
    product_category: 'wireless mouse',
    identity_kind: 'standardized_model',
    max_groups: 15,
  });

  assert.equal(built.next, 'present');
  assert.ok(built.exploration_id?.startsWith('exp-'));
  assert.equal(built.groups.filter((group) => group.identity_model === 'M185').length, 1,
    'the same manufacturer model is one group across stores');
  assert.ok(built.groups.some((group) => group.identity_model === 'M240'));
  assert.ok(built.groups.some((group) => group.identity_kind === 'unique_listing'
    && group.source_refs?.[0]?.product_id === 'other-wm'),
  'a grounded store-unique result remains a selectable result');
  assert.ok(built.facet_catalog.some((facet) => facet.facet === 'color' && facet.value === 'black'));
});

test('facet evidence is verified against the exact rendered title before it enters exploration', () => {
  const screened = lua.call('AX_apply_exploration_screening', {
    store_results: discoveryResults,
    screening_ids: '11st:m185-11|11st:m240-11',
    keep: '1,2',
    facets_json: JSON.stringify({
      '11st:m185-11': {
        color: { value: 'black', evidence: 'Black' },
        form: { value: 'cooked', evidence: '구운란' },
      },
      '11st:m240-11': {
        color: { value: 'white', evidence: 'White' },
      },
    }),
  });

  assert.equal(screened.next, 'done');
  const candidates = screened.store_results[0].value.store_result.candidates;
  assert.equal(candidates[0].facets.color.value, 'black');
  assert.equal(candidates[0].facets.form, undefined, 'unseen evidence must be discarded');
  assert.equal(candidates[1].facets.color.value, 'white');
});

test('exploration is carried as one scalar and can be refined across Lua turns', () => {
  const first = runtime();
  const built = first.call('AX_RPC_OFFERS.build_exploration', {
    discovery_results: discoveryResults,
    exploration_query: 'wireless mouse',
    product_category: 'wireless mouse',
    identity_kind: 'standardized_model',
  });
  first.close();

  assert.equal(typeof built.exploration_state, 'string');
  assert.ok(built.exploration_id);
  assert.match(built.question ?? '', /M185/);

  const second = runtime();
  const filtered = second.call('AX_RPC_OFFERS.refine_exploration', {
    exploration_state: built.exploration_state,
    exploration_id: built.exploration_id,
    refine_request: 'Logitech만 보여줘',
  });
  second.close();

  assert.equal(filtered.next, 'ask');
  assert.notEqual(filtered.exploration_id, built.exploration_id,
    'changed membership or numbering must invalidate old numbers');
  assert.match(filtered.question ?? '', /M185/);
  assert.doesNotMatch(filtered.question ?? '', /Acme/);
});

test('an exploration-only sort issues a new snapshot instead of falling into unparsed refinement', () => {
  const first = runtime();
  const built = first.call('AX_RPC_OFFERS.build_exploration', {
    discovery_results: discoveryResults,
    exploration_query: 'wireless mouse',
    product_category: 'wireless mouse',
    identity_kind: 'standardized_model',
  });
  first.close();

  const second = runtime();
  const sorted = second.call('AX_RPC_OFFERS.refine_exploration', {
    exploration_state: built.exploration_state,
    exploration_id: built.exploration_id,
    refine_request: '이름순으로 보여줘',
  });
  second.close();

  assert.equal(sorted.next, 'ask');
  assert.notEqual(sorted.exploration_id, built.exploration_id);
  assert.doesNotMatch(sorted.question ?? '', /적용하지 못했습니다/);
});

test('a current exploration number locks a new revision but a stale number is refused', () => {
  const first = runtime();
  const built = first.call('AX_RPC_OFFERS.build_exploration', {
    discovery_results: discoveryResults,
    exploration_query: 'wireless mouse',
    product_category: 'wireless mouse',
    identity_kind: 'standardized_model',
  });
  first.close();

  const second = runtime();
  const selected = second.call('AX_RPC_OFFERS.resolve_exploration', {
    exploration_state: built.exploration_state,
    exploration_id: built.exploration_id,
    choice_exploration_id: built.exploration_id,
    choice_index: 1,
    identity_revision: 4,
  });
  const stale = second.call('AX_RPC_OFFERS.resolve_exploration', {
    exploration_state: built.exploration_state,
    exploration_id: built.exploration_id,
    choice_exploration_id: 'exp-stale',
    choice_index: 1,
    identity_revision: 4,
  });
  second.close();

  assert.equal(selected.next, 'lock');
  assert.equal(selected.identity_revision, 5);
  assert.equal(selected.identity_approval, 'locked_product_identity');
  assert.equal(stale.error, 'stale_exploration');
  assert.equal(stale.identity_approval, undefined);
});

test('the flow-state exploration index crosses the runtime wrapper', () => {
  const first = runtime();
  const built = first.call('AX_RPC_OFFERS.build_exploration', {
    discovery_results: discoveryResults,
    exploration_query: 'wireless mouse',
    product_category: 'wireless mouse',
    identity_kind: 'standardized_model',
  });
  first.close();

  const second = runtime();
  const selected = second.call('AX_RPC_OFFERS.resolve_exploration', {
    exploration_state: built.exploration_state,
    exploration_id: built.exploration_id,
    choice_exploration_id: built.exploration_id,
    choice_exploration_index: 1,
    identity_revision: 4,
  });
  second.close();

  assert.equal(selected.next, 'lock');
  assert.equal(selected.identity_revision, 5);
});


test('a comparison follow-up can return to exploration or directly select a known model', () => {
  const exploration = runtime();
  const built = exploration.call('AX_RPC_OFFERS.build_exploration', {
    discovery_results: discoveryResults,
    exploration_query: 'wireless mouse',
    product_category: 'wireless mouse',
    identity_kind: 'standardized_model',
  });
  exploration.close();

  const generic = runtime();
  const restored = generic.call('AX_RPC_OFFERS.restore_exploration', {
    exploration_state: built.exploration_state,
    exploration_id: built.exploration_id,
    identity_change_request: '다른 모델 보여줘',
  });
  assert.equal(restored.next, 'present');
  const presented = generic.call('AX_RPC_OFFERS.present_exploration', {
    exploration_state: restored.exploration_state,
    exploration_id: restored.exploration_id,
  });
  assert.match(presented.question ?? '', /M185/);
  assert.match(presented.question ?? '', /M240/);
  generic.close();

  const direct = runtime();
  const switched = direct.call('AX_RPC_OFFERS.restore_exploration', {
    exploration_state: built.exploration_state,
    exploration_id: built.exploration_id,
    identity_change_request: 'M240으로 바꿔줘',
  });
  direct.close();
  assert.equal(switched.next, 'select');
  assert.equal(switched.choice_exploration_id, built.exploration_id);
  assert.ok(switched.choice_index > 0);
});

test('the comparison presenter recognizes identity changes before generic offer refinement', () => {
  const first = runtime();
  const ranked = first.call('AX_RPC_OFFERS.rank', {
    verified_offers: [{
      site: '11st', product_id: 'm185', name: 'Logitech M185 Wireless Mouse',
      price: 17900, currency: 'KRW', price_base: 12.5, base_currency: 'USD',
      shipping_cost: 0, shipping_base: 0, total_base: 12.5, cost_complete: true,
      identity_id: 'identity-m185',
    }],
    identity_id: 'identity-m185',
  });
  first.close();

  const second = runtime();
  const changed = second.call('AX_RPC_OFFERS.present', {
    comparison_state: ranked.comparison_state,
    comparison_id: ranked.comparison_id,
    choice_stage: 'asked',
    userMessages: ['M185 말고 M240으로 바꿔줘'],
  });
  second.close();

  assert.equal(changed.next, 'change_identity');
  assert.equal(changed.identity_change_request, 'M185 말고 M240으로 바꿔줘');
  assert.equal(changed.choice_index, undefined, 'identity changes never select a cart offer');
});
