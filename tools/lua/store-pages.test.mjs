import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { COMMERCE_LAYER, loadLuaModules } from './harness.mjs';
import { installRpcStub, makePage } from './rpc-stub.mjs';

const lua = loadLuaModules([
  '_common/scripts/00_base.lua',
  '_common/scripts/44_pagination.lua',
  '_common/scripts/45_offer_view.lua',
  ...COMMERCE_LAYER,
  '_common/rpc/61_rpc_storefront.lua',
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

// One ported store's shape, enough for the RPC reader. The durable adapter layer these facts were first
// pinned against is deleted; the reader that serves every store in production is
// `_common/rpc/61_rpc_storefront.lua`, so the same facts are asserted through it, off a stubbed page.
const READER = {
  site: '11st',
  search_url: 'https://search.11st.co.kr/pc/total-search',
  search_param: 'kwd',
  search_path_marker: '/pc/total-search',
  result_selector: 'li.card',
  result_ready_selector: 'li.card',
  result_url_selector: 'a',
  result_title_selector: '.name',
  result_price_selector: '.price',
  result_limit: 24,
  default_currency: 'KRW',
  product_id_patterns: ['/products/(%d+)'],
  product_url_prefix: 'https://www.11st.co.kr/products/',
};

function readStore(page, config = READER, args = {}) {
  installRpcStub(lua, page);
  return lua.call('AX_RPC_STOREFRONT.search', config, { query: '마우스', ...args });
}

const row = (id, name, price) => ({ text: `${name} ${price}`, url: `https://www.11st.co.kr/products/${id}`, title: name, price_text: price });

// ── page planning ─────────────────────────────────────────────────────────────
// The durable adapter exposed these through `AX_STOREFRONT.page_plan`, a one-line wrapper around
// `44_pagination` — an RPC module that stays. The wrapper is gone; the module answers directly.

test('a storefront config exposes its page plan through the pagination module', () => {
  const plan = lua.call('AX_PAGINATION.plan_page', pagedConfig.pagination, 2);
  assert.equal(plan.supported, true);
  assert.deepEqual(plan.params, { page: 2 });
});

test('a storefront without a pagination block stays single page', () => {
  const plan = lua.call('AX_PAGINATION.plan_page', null, 2);
  assert.equal(plan.supported, false);
  assert.equal(plan.error, 'pagination_unsupported');
});

// Whether another page is worth fetching was `AX_STOREFRONT.has_more_from(count, supported, probed)`.
// The RPC reader answers the same question off the page itself. Two of the durable facts carried over
// unchanged and are asserted here: a probed-and-present next control claims more, and a probed-and-absent
// one refuses even on a full page. The other two were deliberately REFINED by the RPC port and are pinned
// elsewhere: a site that cannot probe reports NOTHING rather than guessing from the row count
// (rpc-storefront.test.mjs, 'a site that cannot tell reports nothing rather than false'), and an empty
// page with pages left IS read again ('a first page with no relevant rows reads the next page', below).

const PAGED_READER = { ...READER, pagination: { mode: 'query', param: 'page', start: 1, step: 1, max_pages: 2, next_selector: 'a.next' } };

test('a probed and present next control says there is more', () => {
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [row('1', 'x', '1,000원')], 'a.next': [{}] } });
  assert.equal(readStore(page, PAGED_READER).has_more, true);
});

test('a probed and absent next control refuses another page even when this one is full', () => {
  const rows = Array.from({ length: 24 }, (_, index) => row(`${100 + index}`, `상품 ${index}`, '1,000원'));
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': rows } });
  assert.equal(readStore(page, PAGED_READER).has_more, false);
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

const unpricedRow = (id) => ({ text: 'Options from', url: `https://www.11st.co.kr/products/${id}`, title: 'x' });

test('cards found but none priced is reported as an unreadable price', () => {
  for (const count of [24, 1]) {
    const rows = Array.from({ length: count }, (_, index) => unpricedRow(200 + index));
    const value = readStore(makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': rows } }));
    assert.equal(value.next, 'price_unavailable');
    assert.equal(value.cards_seen, count, 'the fact that cards existed must survive');
  }
});

test('no cards at all is still no_results', () => {
  const value = readStore(makePage({ href: 'https://www.google.com/', afterNavigate: {} }));
  assert.equal(value.next, 'no_results');
  assert.equal(value.cards_seen, 0);
});

test('any usable row means the read succeeded', () => {
  const priced = [row('1', 'a', '1,000원'), row('2', 'b', '2,000원'), row('3', 'c', '3,000원')];
  const filler = Array.from({ length: 21 }, (_, index) => unpricedRow(300 + index));
  const value = readStore(makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [...priced, ...filler] } }));
  assert.equal(value.next, 'ok');
  assert.equal(value.error ?? null, null);
  assert.equal(value.candidates.length, 3);
});

// ── a price written twice in one string ──────────────────────────────────────
// Walmart's tile prints the screen-reader form glued to the real one: "Now$4999current price Now
// $49.99". Reading the first amount turned $49.99 into 4999 — a 100x error that would have poisoned
// every comparison it entered.

const priceOf = (text, over = {}) => {
  const page = makePage({
    href: 'https://www.google.com/',
    afterNavigate: { 'li.card': [{ text, url: 'https://www.11st.co.kr/products/55', title: '마우스', price_text: '' }] },
  });
  return readStore(page, { ...READER, price_from_text: true, ...over });
};

test('a price text holding both forms is read as the decimal one', () => {
  const cases = [
    ['Now$4999current price Now $49.99', 49.99],
    ['$2612current price $26.12', 26.12],
    ['current price $7.00', 7],
  ];
  for (const [text, expected] of cases) {
    const value = priceOf(text, { price_text_strategy: 'decimal_preferred', default_currency: 'USD' });
    assert.equal(value.candidates[0]?.price, expected, `${text} -> ${value.candidates[0]?.price}`);
  }
});

test('two prices with no marker saying which is current are refused', () => {
  // "$1452Options from $9.88" could be $14.52 or $9.88 and nothing in the text decides. A wrong price in
  // a price comparison is worse than a missing row, which the store status already explains.
  const value = priceOf('$1452Options from $9.88', { price_text_strategy: 'decimal_preferred', default_currency: 'USD' });
  assert.equal(Object.keys(value.candidates).length, 0, 'the row is dropped, not guessed');
  assert.equal(value.next, 'price_unavailable');
});

test('a price with no decimal form at all is still read', () => {
  assert.equal(priceOf('$120', { price_text_strategy: 'decimal_preferred', default_currency: 'USD' }).candidates[0]?.price, 120);
  assert.equal(priceOf('US$1,299', { price_text_strategy: 'decimal_preferred', default_currency: 'USD' }).candidates[0]?.price, 1299);
});

test('the other strategies are untouched', () => {
  assert.equal(priceOf('19,400원 무료배송 970원 적립', { price_text_strategy: 'last_before_shipping' }).candidates[0]?.price, 19400);
  assert.equal(priceOf('$49.99', { default_currency: 'USD' }).candidates[0]?.price, 49.99);
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
// Reading it needs two things the reader owns: patterns must be tried against the ATTRIBUTE, not only
// the href, and an attribute no pattern understands must not be mined for a first token — every card
// would then answer "content_type", one id would swallow the whole grid, and 24 listings would arrive as
// one row. That is exactly what a live search returned: 156 cards on the page, 1 candidate read.

const ATTR_READER = {
  ...READER,
  result_id_selector: 'a.c-card-item__anchor[data-log-body]',
  result_id_attr: 'data-log-body',
  product_id_patterns: ['/products/(%d+)', '"content_no"%s*:%s*"(%d+)"'],
};
const adRow = (attr, name = '무선 마우스', price = '10,000원', url = 'https://action.adoffice.11st.co.kr/act?trcKey=abc') =>
  ({ text: `${name} ${price}`, url, title: name, price_text: price, root_id: attr });

test('the id is read out of the attribute the card carries it in', () => {
  const attr = '{"content_type":"PRODUCT","content_no":"9170626560","link_url":"https://action.adoffice.11st.co.kr/act"}';
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [adRow(attr)] } });
  assert.equal(readStore(page, ATTR_READER).candidates[0]?.product_id, '9170626560');
});

test('a href still wins when the card has a real product link', () => {
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [row('1234567890', 'x', '1,000원')] } });
  assert.equal(readStore(page, ATTR_READER).candidates[0]?.product_id, '1234567890');
});

test('a plain id attribute is still taken as the id', () => {
  const bare = { ...ATTR_READER, product_id_patterns: [] };
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [adRow('v1-4455')] } });
  assert.equal(readStore(page, bare).candidates[0]?.product_id, 'v1-4455');
});

test('a structured attribute nobody can parse yields no id at all', () => {
  const attr = '{"content_type":"PRODUCT","other_no":"9170626560"}';
  const noPattern = { ...ATTR_READER, product_id_patterns: ['/products/(%d+)'] };
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [adRow(attr)] } });
  assert.equal(Object.keys(readStore(page, noPattern).candidates).length, 0);
});

test('a card with neither a link nor a usable attribute is dropped, not guessed', () => {
  const page = makePage({
    href: 'https://www.google.com/',
    afterNavigate: { 'li.card': [{ text: 'x 1,000원', url: 'https://action.adoffice.11st.co.kr/act/click/v1/landing?clickData=abc', title: 'x', price_text: '1,000원' }] },
  });
  assert.equal(Object.keys(readStore(page, ATTR_READER).candidates).length, 0);
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

// ── a store result may not say "candidates" and carry none ────────────────────
//
// Measured live on etsy: 24 cards read, relevance kept nothing, and the store result came back
//   {"site":"etsy","status":"candidates","candidates":{},"total_count":0,"stop_reason":"no_more_pages"}
// with no error field at all. The sweep's classifier reads the candidate list, then the error, and
// answered `unknown` — which is reserved for a reader that could not say. "Found nothing relevant" is
// `no_results`, and §13 already fixes that distinction: an empty page is not a failed store, and cards
// found but unpriced is `price_unavailable`, not `no_results`. A status that contradicts its own payload
// makes every one of those distinctions unreadable downstream.
test('a page whose candidates were all filtered reports no_results, not candidates', () => {
  const collected = lua.call('AX_collect_store_page', {
    collected: null,
    page: 1,
    remote_used: 2,
    remote_budget: 10,
    // What a reader answers after relevance emptied a full page: it SAW cards and kept none.
    result: {
      site: 'etsy',
      query: 'M185',
      status: 'candidates',
      candidates: [],
      cards_seen: 24,
      has_more: false,
      page: 1,
    },
  });

  const store = collected.store_result;
  assert.equal(store.total_count, 0);
  assert.equal(store.error, 'no_results', 'the outcome has to be nameable by the caller');
  assert.notEqual(store.status, 'candidates', 'a status may not contradict an empty payload');
});

test('a page error survives as the outcome when nothing was collected', () => {
  // §13: cards found but none priced is its own answer. The page error must win over the generic
  // no_results, because the two mean different things to the user.
  const collected = lua.call('AX_collect_store_page', {
    collected: null,
    page: 1,
    remote_used: 2,
    remote_budget: 10,
    result: {
      site: 'walmart',
      query: 'M185',
      status: 'price_unavailable',
      error: 'price_unavailable',
      candidates: [],
      cards_seen: 24,
      has_more: false,
      page: 1,
    },
  });

  assert.equal(collected.store_result.error, 'price_unavailable');
  assert.equal(collected.store_result.status, 'price_unavailable');
});

test('a page that DID collect keeps its candidates status', () => {
  const collected = lua.call('AX_collect_store_page', {
    collected: null,
    page: 1,
    remote_used: 2,
    remote_budget: 10,
    result: { site: 'coupang', query: 'M185', status: 'candidates', candidates: [candidate('a')], has_more: false, page: 1 },
  });

  assert.equal(collected.store_result.status, 'candidates');
  assert.equal(collected.store_result.error, undefined);
});
