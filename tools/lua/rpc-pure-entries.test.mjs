import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { COMMERCE_LAYER, loadLuaModules } from './harness.mjs';

// Twelve `_common` files use no browser API at all. Moving them into the runtime is the largest part of
// the migration and the least risky: the logic does not change, only where it runs.
//
// What DOES change is how the arguments arrive. A `kind: remote` tool receives the tool's `input:`
// mapping; a runtime lua tool receives the node's SELECTED FLOW STATE. That difference already cost one
// live round when every store refused with an empty site, so each ported command gets an entry point
// that states the mapping in Lua and a test that pins it.

const lua = loadLuaModules([
  '_common/scripts/00_base.lua',
  '_common/scripts/44_pagination.lua',
  '_common/scripts/45_offer_view.lua',
  ...COMMERCE_LAYER,
  '_common/rpc/63_pure_entries.lua',
]);
after(() => lua.close());

const STORE_RESULT = {
  site: '11st',
  status: 'candidates',
  candidates: [
    { site: '11st', product_id: '1', id: '1', name: '로지텍 M185 무선 마우스', price: 19400, currency: 'KRW', shipping_cost: 0, shipping_currency: 'KRW', url: 'https://www.11st.co.kr/products/1' },
  ],
};
const CONTEXT = { query: '로지텍 M185 마우스', quantity: 1, requested_brand: '로지텍' };

test('normalize reads the site and query out of the node state', () => {
  const value = lua.call('AX_RPC_PURE.normalize_store_result', {
    item: { site: '11st' },
    context: CONTEXT,
    store_result: STORE_RESULT,
  });

  assert.equal(value.next, 'done');
  assert.equal(value.store_result.site, '11st');
  assert.ok(Object.values(value.store_result.candidates ?? {}).length >= 1);
});


test('normalize refuses without a site rather than normalizing nothing', () => {
  // The command answers `error: missing_site` and the flow would branch `done` on it anyway; naming the
  // refusal keeps a mapping mistake from looking like a store with no matches.
  const value = lua.call('AX_RPC_PURE.normalize_store_result', { context: CONTEXT, store_result: STORE_RESULT });
  assert.equal(value.store_result.error, 'missing_site');
});

test('collect merges a page and decides whether another is worth a navigation', () => {
  const value = lua.call('AX_RPC_PURE.collect_store_page', {
    item: { site: '11st' },
    context: CONTEXT,
    store_result: STORE_RESULT,
    collected: null,
    page: 1,
    query: '로지텍 M185 마우스',
  });

  assert.ok(['done', 'more', 'retry_query'].includes(value.next), `unexpected branch ${value.next}`);
  assert.equal(value.page, 1);
  assert.ok(Object.values(value.collected ?? {}).length >= 1, 'the page must be merged into the accumulator');
});

test('collect carries the wording it tried, so a retry does not repeat it', () => {
  const value = lua.call('AX_RPC_PURE.collect_store_page', {
    item: { site: '11st' }, context: CONTEXT, store_result: { site: '11st', status: 'no_results', candidates: [] },
    collected: null, page: 1, query: '로지텍 M185 마우스', tried_queries: '로지텍 M185 마우스',
  });
  assert.match(String(value.tried_queries ?? ''), /로지텍 M185 마우스/);
});

// Nine more commands cross the line and every one of their `input:` blocks is a flat rename of node
// state. Writing nine hand-rolled entries would be nine chances to mistype a key that the runtime then
// silently passes as nil — the failure that already made every store refuse with an empty site. So the
// renames live in ONE table beside the commands, and the entry is generic.

test('a ported command receives the keys its input block named', () => {
  const value = lua.call('AX_RPC_PURE.run', 'AX_verify_product_offers', {
    store_results: [{ key: '11st', status: 'completed', value: { store_result: STORE_RESULT } }],
    identity_id: 'identity-1', identity_kind: 'standardized_model',
    identity_brand: '로지텍', identity_model: 'M185', product_category: '마우스',
  });
  // `results` <- `store_results` and `hard_constraints` <- `locked_hard_constraints` are the renames
  // this command needs; getting either wrong verifies nothing and the comparison has no offers to rank.
  assert.notEqual(value.next, 'error');
  assert.ok(Object.values(value.verified_offers ?? {}).length >= 1,
    'the offer must survive the rename into the verifier');
});

test('a constant in the mapping is passed through', () => {
  // `max_options: 6` is part of the contract, not of the state.
  const value = lua.call('AX_RPC_PURE.run', 'AX_build_product_options', {
    discovery_results: [], discovery_query: '마우스', product_category: '마우스',
  });
  assert.ok(value.next);
});

test('the compact post-screening summary is reachable through the runtime dispatcher', () => {
  const value = lua.call('AX_RPC_PURE.run', 'AX_summarize_store_outcomes', {
    store_results: [{ key: '11st', status: 'completed', value: { store_result: STORE_RESULT } }],
  });
  assert.equal(value.next, 'done');
  assert.equal(value.store_outcomes[0].site, '11st');
  assert.equal(value.store_outcomes[0].status, 'candidates');
});

test('a command nobody mapped is refused, not called blind', () => {
  const value = lua.call('AX_RPC_PURE.run', 'AX_not_a_command', {});
  assert.equal(value.next, 'error');
  assert.equal(value.error, 'unmapped_command');
});

test('the identity chain keeps its own keys', () => {
  const prepared = lua.call('AX_RPC_PURE.run', 'AX_prepare_product_identity', {
    product_category: '마우스', requested_brand: '로지텍', requested_model: 'M185',
  });
  assert.equal(prepared.identity_status, 'exact');
  assert.equal(prepared.identity_model, 'M185');
});

test('the runtime dispatcher preserves the commodity identity kind', () => {
  const prepared = lua.call('AX_RPC_PURE.run', 'AX_prepare_product_identity', {
    identity_kind: 'spec_equivalent',
    product_category: '계란',
    query: '계란 한판',
    hard_constraints: { package: '한판' },
    stores: [{ site: 'coupang' }, { site: 'ssg' }],
  });
  assert.equal(prepared.next, 'lock',
    'the dispatcher must not erase spec_equivalent and send a commodity into model discovery');
  assert.equal(prepared.identity_kind, 'spec_equivalent');
  assert.equal(prepared.canonical_query, '계란 한판');
});

test('an empty accumulator travels as absent, never as an empty table', () => {
  // Measured live on the multi-store discovery path, twice in one turn:
  //   actions.shopping_collect_store_page ... schema rejected value: collected: Invalid input
  // The node declares `collected: { type: [array, "null"] }`. An empty Lua table encodes as `{}` — an
  // OBJECT — so the tool wrote `{}` into state, the model relayed it back as an argument, and the schema
  // refused it. The array-type marker is not honoured on an empty list, and the schema already allows the
  // one encoding that cannot be mistaken: absent.
  const value = lua.call('AX_RPC_PURE.collect_store_page', {
    item: { site: '11st' },
    context: CONTEXT,
    // A store that found nothing: the accumulator stays empty and still has to survive the round trip.
    store_result: { site: '11st', status: 'no_results', candidates: [] },
    collected: null,
    page: 1,
    query: '로지텍 M185 마우스',
  });

  assert.ok(
    value.collected === undefined || value.collected === null || Array.isArray(value.collected),
    `an empty accumulator must not be an object, got ${JSON.stringify(value.collected)}`,
  );
});

test('a non-empty accumulator is still a list the schema accepts', () => {
  // The fix must not turn every accumulator into nothing: a page that DID collect rows has to arrive as a
  // sequence, or the next page would be merged into an empty one and the earlier stores would vanish.
  const value = lua.call('AX_RPC_PURE.collect_store_page', {
    item: { site: '11st' }, context: CONTEXT, store_result: STORE_RESULT, collected: null, page: 1,
    query: '로지텍 M185 마우스',
  });

  assert.ok(value.collected, 'a page with rows must be carried');
  assert.ok(Object.values(value.collected).length >= 1);
});

test('a retry records the wording it just tried, even when nobody echoed it', () => {
  // The multi-store discovery failure, traced node by node. Every `shopping_collect_store_page` answered
  //   {"next":"retry_query","query":"로지텍 무선 마우스","tried_queries":""}
  // — the same wording, forever, until `subflow node budget exhausted` ended discovery with no product
  // options at all. The accumulator only grew from `args.query`, which the caller does not always echo,
  // and `result.query` was nil because the normalizer hands the collector a WRAPPED result: the store's
  // own answer sits at `store_result.store_result`. With nothing recorded, the next pass picked the first
  // wording again and the loop could not make progress.
  const value = lua.call('AX_RPC_PURE.collect_store_page', {
    item: { site: '11st' },
    context: { query: '로지텍 무선 마우스', query_variants: 'Logitech wireless mouse|로지텍 마우스' },
    // Wrapped exactly the way the normalizer emits it, and with no `query` argument from the caller.
    store_result: { next: 'done', store_result: { site: '11st', status: 'no_results', candidates: [], query: '로지텍 무선 마우스' } },
    collected: null,
    page: 1,
  });

  assert.match(
    String(value.tried_queries ?? ''), /로지텍 무선 마우스/,
    'the wording just searched must be recorded, or the retry repeats it forever',
  );
  if (value.next === 'retry_query') {
    assert.notEqual(value.query, '로지텍 무선 마우스', 'a retry must ask something new');
  }
});

test('the store result a fan-out reads is not wrapped in another one', () => {
  // `flow.map` takes its per-item result from `resultFrom: store_result` and validates it against
  //   required: [site, candidates]
  // Live, every store failed that check:
  //   "site: expected string, received undefined; candidates: expected array, received object"
  // because the value was WRAPPED: `{next, store_result: {next, store_result: {site, candidates}}}`. The
  // site was two levels down. The same nesting already cost a diagnosis when the collector could not find
  // the query it had just searched.
  const value = lua.call('AX_RPC_PURE.normalize_store_result', {
    item: { site: '11st' },
    context: CONTEXT,
    store_result: { site: '11st', status: 'candidates', candidates: [{ product_id: '1', name: '로지텍 M185', price: 10000 }] },
  });

  const published = value.store_result ?? {};
  assert.equal(published.site, '11st', `site must be at the top of the published result: ${JSON.stringify(published).slice(0, 120)}`);
  assert.equal(published.store_result, undefined, 'a result wrapped in a result fails the fan-out schema');
});

test('a store that found nothing publishes no candidates rather than an empty object', () => {
  // `candidates` is declared `type: array`. An empty Lua table encodes as `{}` — an OBJECT — so a store
  // with no matches failed validation instead of reporting honestly that it found none.
  const value = lua.call('AX_RPC_PURE.normalize_store_result', {
    item: { site: '11st' },
    context: CONTEXT,
    store_result: { site: '11st', status: 'no_results', candidates: [] },
  });

  const published = value.store_result ?? {};
  assert.equal(published.site, '11st');
  assert.ok(
    published.candidates === undefined || Array.isArray(published.candidates),
    `an empty list must not be an object, got ${JSON.stringify(published.candidates)}`,
  );
});
