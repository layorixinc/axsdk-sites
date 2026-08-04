import assert from 'node:assert/strict';
import test from 'node:test';

import { loadLuaModules } from './harness.mjs';

// The last three `kind: remote` tools. They stayed durable for one reason: the comparison a user browses
// has to survive from the turn that BUILT it to the turn that pages or filters it, and the runtime's
// `state: session` is keyed by (session, TOOL) — so `rank` cannot hand anything to `present`.
//
// Flow state can. `inputSelector` is an allowlist (FLOWS.md §4), so a deterministic node reads the
// comparison at zero prompt cost while no model node ever selects it. What travels is a SCALAR, because
// an empty Lua table encodes as `{}` and a tool schema expecting an array then rejects it.
//
// The ranking, folding, windowing and refinement logic is NOT reimplemented here: `54_comparison.lua` and
// `55_offers.lua` are already loaded as runtime modules. This adapter only moves the snapshot in and out
// of flow state, which is the whole of what was missing.

const MODULES = [
  '_common/scripts/00_base.lua',
  '_common/scripts/44_pagination.lua',
  '_common/scripts/45_offer_view.lua',
  '_common/scripts/50_commerce_core.lua',
  '_common/scripts/51_relevance.lua',
  '_common/scripts/52_identity.lua',
  '_common/scripts/54_comparison.lua',
  '_common/scripts/55_offers.lua',
  '_common/rpc/73_rpc_offers.lua',
];

/** A runtime with `json`, which is what carries the snapshot as one scalar. */
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

const OFFERS = [
  {
    site: 'amazon', product_id: 'B1', id: 'B1', name: 'Logitech M185 Mouse',
    price: 12.99, currency: 'USD', price_base: 12.99, base_currency: 'USD',
    shipping_cost: 0, shipping_base: 0, total_base: 12.99, cost_complete: true,
  },
  {
    site: 'walmart', product_id: 'W2', id: 'W2', name: 'Logitech M185 Wireless Mouse',
    price: 11.5, currency: 'USD', price_base: 11.5, base_currency: 'USD',
    shipping_cost: 0, shipping_base: 0, total_base: 11.5, cost_complete: true,
  },
  {
    site: 'ssg', product_id: 'S3', id: 'S3', name: '로지텍 M185 무선마우스',
    price: 14000, currency: 'KRW', price_base: 9.6, base_currency: 'USD',
    shipping_cost: 0, shipping_base: 0, total_base: 9.6, cost_complete: true,
  },
];

test('ranking hands back the comparison as one scalar', () => {
  // A table would arrive as a JSON object where the schema expects an array, and flow state validated by
  // a tool schema is exactly where that bites. One string, split by the consumer.
  const lua = runtime();
  const ranked = lua.call('AX_RPC_OFFERS.rank', { verified_offers: OFFERS });
  lua.close();

  assert.equal(typeof ranked.comparison_state, 'string');
  assert.ok(ranked.comparison_state.length > 0);
  assert.ok(ranked.comparison_id, 'the listing must be identified');
  assert.match(ranked.question ?? '', /M185/);
});

test('a later turn pages the comparison the earlier turn built', () => {
  // The reason these three could not be ported. `rank` runs in one turn, `present` in the next, and the
  // runtime gives them separate session scopes — so the only channel is what the flow carries between
  // them. Two separate Lua states here, deliberately: nothing may survive in a module global.
  const first = runtime();
  const ranked = first.call('AX_RPC_OFFERS.rank', { verified_offers: OFFERS });
  first.close();

  const later = runtime();
  const paged = later.call('AX_RPC_OFFERS.present', {
    comparison_state: ranked.comparison_state,
    comparison_id: ranked.comparison_id,
    view_page: 1,
  });
  later.close();

  assert.equal(paged.error, undefined, `paging failed: ${paged.error}`);
  assert.equal(paged.comparison_id, ranked.comparison_id, 'paging keeps the same listing');
  assert.match(paged.question ?? '', /M185/);
});

test('a refinement that changes WHICH offers are listed reissues the listing', () => {
  // Any change to the membership of the window invalidates every number the user was just shown. The
  // durable version reissued `comparison_id` for that reason and the port keeps it: a stale number must
  // fail resolution rather than select a different product.
  const first = runtime();
  const ranked = first.call('AX_RPC_OFFERS.rank', { verified_offers: OFFERS });
  first.close();

  const later = runtime();
  // Only the KRW row converts under ten dollars, so this drops rows rather than reordering them.
  const refined = later.call('AX_RPC_OFFERS.refine', {
    comparison_state: ranked.comparison_state,
    comparison_id: ranked.comparison_id,
    refine_request: '10달러 이하',
  });
  later.close();

  assert.equal(refined.error, undefined, `refine failed: ${refined.error}`);
  assert.notEqual(refined.comparison_id, ranked.comparison_id, 'a changed listing must be a new listing');
  assert.equal(typeof refined.comparison_state, 'string');
});

test('a refinement that changes nothing keeps the listing', () => {
  // The default sort is already cheapest-first, so asking for it again lists the same offers in the same
  // order. Reissuing there would invalidate numbers the user can still see on screen.
  const first = runtime();
  const ranked = first.call('AX_RPC_OFFERS.rank', { verified_offers: OFFERS });
  first.close();

  const later = runtime();
  const same = later.call('AX_RPC_OFFERS.refine', {
    comparison_state: ranked.comparison_state,
    comparison_id: ranked.comparison_id,
    refine_request: '싼 순으로',
  });
  later.close();

  assert.equal(same.error, undefined, `refine failed: ${same.error}`);
  assert.equal(same.comparison_id, ranked.comparison_id);
});

test('a comparison from a different listing is refused, not silently re-rendered', () => {
  // The number the user typed belongs to a listing. Answering from another one hands them a product they
  // never saw, which is the failure a comparison id exists to make impossible.
  const first = runtime();
  const ranked = first.call('AX_RPC_OFFERS.rank', { verified_offers: OFFERS });
  first.close();

  const later = runtime();
  const wrong = later.call('AX_RPC_OFFERS.present', {
    comparison_state: ranked.comparison_state,
    comparison_id: 'cmp-somethingelse',
  });
  later.close();

  assert.equal(wrong.error, 'stale_comparison');
});

test('garbage in flow state is an error, never a fabricated empty listing', () => {
  // Flow state is text and text can arrive truncated. An unreadable snapshot must say so; rendering an
  // empty window would tell the user their search found nothing.
  const lua = runtime();
  const broken = lua.call('AX_RPC_OFFERS.present', { comparison_state: '{not json', comparison_id: 'cmp-1' });
  const missing = lua.call('AX_RPC_OFFERS.present', { comparison_id: 'cmp-1' });
  lua.close();

  assert.equal(broken.error, 'comparison_unreadable');
  assert.equal(missing.error, 'comparison_unreadable');
});

test('a runtime without json refuses rather than dropping the comparison', () => {
  // The snapshot cannot travel without an encoder. Answering as though the listing were empty would be a
  // claim about prices nobody compared.
  const bare = loadLuaModules(MODULES);
  const result = bare.call('AX_RPC_OFFERS.rank', { verified_offers: OFFERS });
  bare.close();

  assert.equal(result.error, 'json_unavailable');
});

test('ranking answers in the branch vocabulary its node routes', () => {
  // The node routes `done | partial | empty | error`. The adapter answered `ask`, which no branch names,
  // so `invalidNext` sent the whole turn to the error terminal — live, after the entire comparison had
  // been built: both stores searched, screening judged, offers verified, a `comparison_id` issued, and
  // then "요청을 처리하는 중 문제가 발생했습니다".
  //
  // The rule is already settled: a command picks its own `next` and the adapter passes it through. This
  // one overwrote it with a constant.
  const lua = runtime();
  const ranked = lua.call('AX_RPC_OFFERS.rank', { verified_offers: OFFERS });
  lua.close();

  assert.ok(
    ['done', 'partial', 'empty'].includes(ranked.next),
    `\`${ranked.next}\` is not a branch the node routes`,
  );
});
