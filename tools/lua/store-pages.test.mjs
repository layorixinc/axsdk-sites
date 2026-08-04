import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { COMMERCE_LAYER, loadLuaModules } from './harness.mjs';

const lua = loadLuaModules([
  '_common/scripts/00_base.lua',
  '_common/scripts/44_pagination.lua',
  '_common/scripts/45_offer_view.lua',
  ...COMMERCE_LAYER,
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

test('the merged store result carries the screening set, not the comparison cap', () => {
  // The comparison keeps three offers per store, but WHICH three is a relevance judgement, so the pages
  // hand the wider recall set forward and the cap is applied after the verdict.
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
    result: {
      site: 'coupang', query: 'M185', has_more: true, page: 2,
      candidates: [candidate('c'), candidate('d'), candidate('e'), candidate('f'), candidate('g')],
    },
  });

  assert.equal(second.store_result.candidates.length, 6, 'the screening set is six per store');
  assert.deepEqual(second.store_result.candidates.map((entry) => entry.product_id), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('a full first page still stops the paging at the comparison target', () => {
  // Widening what is CARRIED must not widen what is CHASED: three relevant rows already answer the store.
  const step = lua.call('AX_collect_store_page', {
    collected: null,
    page: 1,
    remote_used: 2,
    remote_budget: 10,
    result: {
      site: 'coupang', query: 'M185', has_more: true, page: 1,
      candidates: [candidate('a'), candidate('b'), candidate('c')],
    },
  });
  assert.equal(step.next, 'done');
  assert.equal(step.stop_reason, 'target_reached');
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

// ── a page full of cards nobody could price ──────────────────────────────────
// Walmart renders its search tiles with the price arriving separately, and it A/B tests which automation
// id carries it. A read that finds 24 cards and prices none of them is not "this store has no such
// product" — reporting it as no_results made the store look absent from the comparison.

test('cards found but none priced is reported as an unreadable price', () => {
  assert.equal(lua.call('AX_STOREFRONT.read_outcome', 24, 0), 'price_unavailable');
  assert.equal(lua.call('AX_STOREFRONT.read_outcome', 1, 0), 'price_unavailable');
});

test('no cards at all is still no_results', () => {
  assert.equal(lua.call('AX_STOREFRONT.read_outcome', 0, 0), 'no_results');
});

test('any usable row means the read succeeded', () => {
  assert.equal(lua.call('AX_STOREFRONT.read_outcome', 24, 3) ?? null, null);
  assert.equal(lua.call('AX_STOREFRONT.read_outcome', 3, 3) ?? null, null);
});

// ── a price written twice in one string ──────────────────────────────────────
// Walmart's tile prints the screen-reader form glued to the real one: "Now$4999current price Now
// $49.99". Reading the first amount turned $49.99 into 4999 — a 100x error that would have poisoned
// every comparison it entered.

test('a price text holding both forms is read as the decimal one', () => {
  const cases = [
    ['Now$4999current price Now $49.99', 49.99],
    ['$2612current price $26.12', 26.12],
    ['current price $7.00', 7],
  ];
  for (const [text, expected] of cases) {
    const amount = lua.call('AX_STOREFRONT.parse_candidate_price', text, 'USD', 'decimal_preferred');
    assert.equal(amount, expected, `${text} -> ${amount}`);
  }
});

test('two prices with no marker saying which is current are refused', () => {
  // "$1452Options from $9.88" could be $14.52 or $9.88 and nothing in the text decides. A wrong price in
  // a price comparison is worse than a missing row, which the store status already explains.
  assert.equal(lua.call('AX_STOREFRONT.parse_candidate_price', '$1452Options from $9.88', 'USD', 'decimal_preferred') ?? null, null);
});

test('a price with no decimal form at all is still read', () => {
  assert.equal(lua.call('AX_STOREFRONT.parse_candidate_price', '$120', 'USD', 'decimal_preferred'), 120);
  assert.equal(lua.call('AX_STOREFRONT.parse_candidate_price', 'US$1,299', 'USD', 'decimal_preferred'), 1299);
});

test('the other strategies are untouched', () => {
  assert.equal(lua.call('AX_STOREFRONT.parse_candidate_price', '19,400원 무료배송 970원 적립', 'KRW', 'last_before_shipping'), 19400);
  assert.equal(lua.call('AX_STOREFRONT.parse_candidate_price', '$49.99', 'USD'), 49.99);
});

// ── retrying a store with the other wording ──────────────────────────────────
// A store that answers the first wording never pays for another navigation. One that returns nothing
// relevant is asked again in the other wordings the model wrote for this request, before the loop gives
// up on it. The wordings travel with the request; nothing here decides what a word means.

function collect(args) {
  return lua.call('AX_collect_store_page', {
    remote_used: 2, remote_budget: 10, purpose: 'comparison',
    context: { identity_brand: 'Logitech', identity_model: 'M185', query_variants: '로지텍 M185|로지텍 무선마우스 M185' },
    ...args,
  });
}

test('a store that found nothing is retried with the next wording', () => {
  const step = collect({
    page: 1, site: 'ssg', query: 'Logitech M185',
    result: { site: 'ssg', query: 'Logitech M185', error: 'no_results', candidates: [], has_more: false },
  });

  assert.equal(step.next, 'retry_query');
  assert.equal(step.page, 1, 'a new wording starts at page one');
  assert.ok(/로지텍/.test(step.query), `expected the korean wording, got ${step.query}`);
});

test('a store that found something is never retried', () => {
  const step = collect({
    page: 1, site: 'ssg', query: 'Logitech M185',
    result: { site: 'ssg', query: 'Logitech M185', candidates: [candidate('a')], has_more: false },
  });
  assert.equal(step.next, 'done');
  assert.equal(step.stop_reason, 'no_more_pages');
});

test('the wordings run out and the loop stops', () => {
  const step = collect({
    page: 1, site: 'ssg', query: '로지텍 무선마우스 M185',
    tried_queries: 'Logitech M185|로지텍 M185|로지텍 무선마우스 M185',
    result: { site: 'ssg', query: '로지텍 무선마우스 M185', error: 'no_results', candidates: [], has_more: false },
  });
  assert.equal(step.next, 'done');
  assert.equal(step.stop_reason, 'queries_exhausted');
});

test('a store is tried once when the model offered no other wording', () => {
  const step = lua.call('AX_collect_store_page', {
    remote_used: 2, remote_budget: 10, purpose: 'comparison',
    page: 1, site: 'ssg', query: 'Logitech M185',
    context: { identity_brand: 'Logitech', identity_model: 'M185' },
    result: { site: 'ssg', query: 'Logitech M185', error: 'no_results', candidates: [], has_more: false },
  });
  assert.equal(step.next, 'done');
  assert.equal(step.stop_reason, 'queries_exhausted');
});

test('a blocked store is not retried with other wordings', () => {
  const step = collect({
    page: 1, site: 'ssg', query: 'Logitech M185',
    result: { site: 'ssg', error: 'security_verification_required', candidates: [] },
  });
  assert.equal(step.next, 'done');
  assert.equal(step.stop_reason, 'store_error');
});

test('every attempted wording is recorded so none is repeated', () => {
  const step = collect({
    page: 1, site: 'ssg', query: 'Logitech M185',
    result: { site: 'ssg', query: 'Logitech M185', error: 'no_results', candidates: [], has_more: false },
  });
  assert.match(step.tried_queries, /Logitech M185/);
  assert.ok(!step.tried_queries.includes(step.query), 'the next wording has not been tried yet');
});

// ── the product id a card actually carries ───────────────────────────────────
// 11st stopped putting a product link on its result cards: every anchor is an ad-server redirect and the
// id survives only inside a data attribute (`data-log-body` = {"content_type":"PRODUCT","content_no":"917…"}).
// Reading it needs two things this module owns: patterns must be tried against the ATTRIBUTE, not only
// the href, and an attribute no pattern understands must not be mined for a first token — every card
// would then answer "content_type", one id would swallow the whole grid, and 24 listings would arrive as
// one row. That is exactly what a live search returned: 156 cards on the page, 1 candidate read.

const ELEVEN = {
  product_id_patterns: ['/products/(%d+)', '"content_no"%s*:%s*"(%d+)"'],
};

test('the id is read out of the attribute the card carries it in', () => {
  const attr = '{"content_type":"PRODUCT","content_no":"9170626560","link_url":"https://action.adoffice.11st.co.kr/act"}';
  assert.equal(lua.call('AX_STOREFRONT.product_id_from', ELEVEN, null, attr), '9170626560');
});

test('a href still wins when the card has a real product link', () => {
  assert.equal(lua.call('AX_STOREFRONT.product_id_from', ELEVEN, 'https://www.11st.co.kr/products/1234567890', null), '1234567890');
});

test('a plain id attribute is still taken as the id', () => {
  assert.equal(lua.call('AX_STOREFRONT.product_id_from', { product_id_patterns: [] }, null, 'v1-4455'), 'v1-4455');
});

test('a structured attribute nobody can parse yields no id at all', () => {
  const attr = '{"content_type":"PRODUCT","other_no":"9170626560"}';
  assert.equal(lua.call('AX_STOREFRONT.product_id_from', { product_id_patterns: ['/products/(%d+)'] }, null, attr), null);
});

test('a card with neither a link nor a usable attribute is dropped, not guessed', () => {
  assert.equal(lua.call('AX_STOREFRONT.product_id_from', ELEVEN, 'https://action.adoffice.11st.co.kr/act/click/v1/landing?clickData=abc', null), null);
});

test('a store that found nothing returns no candidates key at all', () => {
  // An empty Lua table encodes as a JSON OBJECT, and the fan-out validates each task result against
  // `candidates: [array, "null"]`. Live, every run: walmart searched three wordings, found nothing, and
  // came back `result does not satisfy task.resultSchema: candidates: Invalid input` — so the store was
  // reported as a technical failure rather than as a store with no matches, and every comparison in the
  // session was single-store.
  //
  // This is the fourth boundary this same empty list has crossed. It is absent or it is a defect.
  const empty = lua.call('AX_collect_store_page', {
    site: 'walmart',
    query: 'nothing matches this',
    store_result: { site: 'walmart', status: 'candidates', candidates: [], error: 'no_results' },
    page: 1,
  });

  assert.equal(empty.collected, undefined, 'no matches means no list, not an empty one');
  assert.equal(
    empty.store_result?.candidates, undefined,
    'the nested result is validated too — an empty list has to be absent at every boundary, not the first one found',
  );
});

test('FX rates arrive when the runtime hands the payload back as a body string', () => {
  // Measured live: the runtime's `net.fetch` answers `{body, headers, ok, status}` and never a `json`
  // field, whatever `response = "json"` asks for. The FX code read `response.json`, so a 200 with a
  // perfectly good rate table read as `fx_fetch_failed` — no `price_base`, no total, and every row of a
  // TOTAL-COST comparison printed "총 미확인" with the shipping cost right beside the price.
  //
  // `71_rpc_zip.lua` already learned this and decodes the body. One transport, one decoder.
  const withNet = loadLuaModules([
    '_common/scripts/00_base.lua',
    '_common/scripts/44_pagination.lua',
    '_common/scripts/45_offer_view.lua',
    ...COMMERCE_LAYER,
  ]);
  withNet.expose({
    json: { encode: (value) => JSON.stringify(value), decode: (text) => JSON.parse(text) },
    net: {
      fetch: () => ({
        ok: true,
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount: 1, base: 'USD', date: '2026-08-04', rates: { KRW: 1427.11 } }),
      }),
    },
  });

  const fx = withNet.call('AX_COMMERCE.fetch_fx_rates', ['KRW']);
  withNet.close();

  assert.equal(fx.error, undefined, `FX failed: ${fx.error}`);
  assert.equal(Math.round(fx.rates.KRW), 1427);
});
