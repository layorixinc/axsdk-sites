import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { readFileSync } from 'node:fs';

import { loadLuaModules } from './harness.mjs';
import { installRpcStub, makePage } from './rpc-stub.mjs';

// The durable storefront owned a checkpoint state machine (prepare → navigation_armed → …) because a
// navigation destroyed the Lua context and the command had to resume into it. An RPC script keeps its own
// stack across the navigation, so the machine collapses into a straight line: look, maybe move, wait, read.
// What must NOT collapse is the honesty of the outcomes — "moved but nothing rendered", "cards but no
// prices", and "already here" are different facts and the flow branches on them.

const lua = loadLuaModules([
  '_common/rpc/61_rpc_storefront.lua',
]);
after(() => lua.close());

const CONFIG = {
  site: '11st',
  search_url: 'https://search.11st.co.kr/pc/total-search',
  search_param: 'kwd',
  search_extra: { tabId: 'TOTAL_SEARCH' },
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

function search(page, args = {}, config = CONFIG) {
  installRpcStub(lua, page);
  const value = lua.call('AX_RPC_STOREFRONT.search', config, { query: '마우스', ...args });
  return { value, ops: page.ops };
}

function card(id, name, price) {
  return { text: `${name} ${price}`, url: `https://www.11st.co.kr/products/${id}`, title: name, price_text: price };
}

// ── the straight line ────────────────────────────────────────────────────────

test('a search that must move navigates, waits for the href, then waits for the grid', () => {
  const page = makePage({
    href: 'https://www.google.com/',
    afterNavigate: { 'li.card': [card('1', '무선 마우스', '10,000원')] },
  });
  const { value, ops } = search(page);

  assert.equal(value.next, 'ok');
  const names = ops.map((entry) => entry.op);
  assert.ok(names.includes('nav.navigate'), 'must navigate when off the result page');
  // href first, then the element: a live document answers from the OLD page and passes a selector check
  // that means nothing yet.
  assert.ok(names.indexOf('dom.get_location_href') < names.lastIndexOf('dom.exists'),
    'the href must be observed before the readiness selector');
});

test('the query the site was asked is carried into the url', () => {
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [card('1', 'x', '1원')] } });
  const { ops } = search(page, { query: '로지텍 M185' });
  const nav = ops.find((entry) => entry.op === 'nav.navigate');
  assert.match(nav.params.url, /kwd=/);
  assert.match(nav.params.url, /tabId=TOTAL_SEARCH/);
  assert.ok(/%EB%A1%9C%EC%A7%80%ED%85%8D/.test(nav.params.url), `query must be encoded: ${nav.params.url}`);
});

test('already on the result page for that query: no navigation at all', () => {
  const page = makePage({
    href: 'https://search.11st.co.kr/pc/total-search?kwd=%EB%A7%88%EC%9A%B0%EC%8A%A4&tabId=TOTAL_SEARCH',
    dom: { 'li.card': [card('1', '무선 마우스', '10,000원')] },
  });
  const { value, ops } = search(page);

  assert.equal(value.next, 'ok');
  assert.ok(!ops.some((entry) => entry.op === 'nav.navigate'), 'a re-search costs a page load for nothing');
});

// ── outcomes that must stay distinct ─────────────────────────────────────────

test('the page never moved', () => {
  const page = makePage({ href: 'https://www.google.com/', navigationFails: true });
  const { value } = search(page);
  assert.equal(value.next, 'error');
  assert.equal(value.error, 'navigation_stuck');
});

test('moved, but the grid never rendered', () => {
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: {} });
  const { value } = search(page);
  assert.equal(value.next, 'no_results');
  assert.equal(value.cards_seen, 0);
});

test('cards rendered but none of them carries a price', () => {
  // Walmart does this: tiles exist, "Options from $X" only. Reporting it as no_results made a working
  // store look like it does not sell the product.
  const page = makePage({
    href: 'https://www.google.com/',
    afterNavigate: { 'li.card': [{ text: 'Options from', url: 'https://www.11st.co.kr/products/9', title: 'x' }] },
  });
  const { value } = search(page);
  assert.equal(value.next, 'price_unavailable');
  assert.ok(value.cards_seen > 0, 'the fact that cards existed must survive');
});

// ── cost and safety ──────────────────────────────────────────────────────────

test('the grid is read in one round trip', () => {
  const page = makePage({
    href: 'https://www.google.com/',
    afterNavigate: { 'li.card': [card('1', 'a', '1원'), card('2', 'b', '2원'), card('3', 'c', '3원')] },
  });
  const { value, ops } = search(page);
  assert.equal(value.candidates.length, 3);
  assert.equal(ops.filter((entry) => entry.op === 'dom.query_all').length, 1,
    'one query_all for the whole grid — a selector per field per row would be dozens of round trips');
});

test('a read-only search never touches a write op', () => {
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [card('1', 'a', '1원')] } });
  const { ops } = search(page);
  const writes = ops.filter((entry) => /^(dom\.(click|set_value|set_form_field_value|submit_form)|page\.eval)$/.test(entry.op));
  assert.deepEqual(writes, [], 'search must not be able to press anything');
});

test('the candidate carries what a comparison needs', () => {
  const page = makePage({
    href: 'https://www.google.com/',
    afterNavigate: { 'li.card': [card('42', '로지텍 M185', '19,400원')] },
  });
  const { value } = search(page);
  const first = value.candidates[0];
  assert.equal(first.product_id, '42');
  assert.equal(first.name, '로지텍 M185');
  assert.equal(first.price, 19400);
  assert.equal(first.currency, 'KRW');
  assert.equal(first.url, 'https://www.11st.co.kr/products/42');
  assert.equal(first.site, '11st');
});

test('a row with no id or no price is dropped, not guessed', () => {
  const page = makePage({
    href: 'https://www.google.com/',
    afterNavigate: {
      'li.card': [
        card('7', '진짜', '1,000원'),
        { text: 'no link', title: '링크없음', price_text: '2,000원' },
        { text: 'no price', url: 'https://www.11st.co.kr/products/8', title: '가격없음' },
      ],
    },
  });
  const { value } = search(page);
  assert.deepEqual(value.candidates.map((entry) => entry.product_id), ['7']);
  assert.equal(value.cards_seen, 3, 'what was on the page is reported even when little survives');
});

// An empty grid and a bot wall look identical to a reader that only counts cards, and the difference
// decides what the user is told: "this store had nothing" versus "this store wants you to prove you are
// human". Reporting the first when the second is true is a claim about prices that were never compared,
// and the multi-store loop uses it to decide whether reading page two is worth a navigation.

const WALLED = {
  ...CONFIG,
  blocked_selectors: [{ selector: '#captcha', error: 'access_denied' }],
  blocked_text: [{ text: '비정상적인 접근', error: 'access_denied' }],
  blocked_urls: [{ text: '/blocked', error: 'access_denied' }],
  login_urls: ['/login'],
  login_selector: '#signin',
};

test('a captcha element is access_denied, never no_results', () => {
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { '#captcha': [{}] } });
  const { value } = search(page, {}, WALLED);
  assert.equal(value.next, 'access_denied');
  assert.equal(value.error, 'access_denied');
});

test('a block phrase in the body is access_denied', () => {
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { body: [{ text: '비정상적인 접근이 감지되었습니다' }] } });
  assert.equal(search(page, {}, WALLED).value.next, 'access_denied');
});

test('a landing url that is the block page is access_denied', () => {
  const page = makePage({ href: 'https://www.google.com/', landsAt: 'https://search.11st.co.kr/blocked', afterNavigate: {} });
  assert.equal(search(page, {}, WALLED).value.next, 'access_denied');
});

test('being bounced to a login page is login_required, not an empty store', () => {
  const page = makePage({ href: 'https://www.google.com/', landsAt: 'https://search.11st.co.kr/login?redirect=1', afterNavigate: {} });
  const { value } = search(page, {}, WALLED);
  assert.equal(value.next, 'login_required');
});

test('a login form on the page is login_required', () => {
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { '#signin': [{}] } });
  assert.equal(search(page, {}, WALLED).value.next, 'login_required');
});

test('an ordinary empty grid is still no_results', () => {
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: {} });
  assert.equal(search(page, {}, WALLED).value.next, 'no_results');
});

test('a walled store is classified before the grid is read', () => {
  // Reading first and classifying second costs a query_all on a page that has no grid, and worse, lets a
  // wall that happens to render one card report `ok`.
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { '#captcha': [{}], 'li.card': [card('1', 'x', '1원')] } });
  const { value } = search(page, {}, WALLED);
  assert.equal(value.next, 'access_denied');
});

test('a site-specific block reason branches on a stable key and reports itself', () => {
  // Live: naver answered `next: "security_verification_required"` because that is what its config calls
  // the wall. A branch key is not a message — every site would need its own branch and any flow that did
  // not enumerate it would fall through `invalidNext` into a generic error, losing the reason entirely.
  // So the KEY is finite and the REASON rides along.
  const naverish = {
    ...CONFIG,
    blocked_selectors: [{ selector: '#wall', error: 'security_verification_required' }],
  };
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { '#wall': [{}] } });
  const { value } = search(page, {}, naverish);

  assert.equal(value.next, 'access_denied');
  assert.equal(value.error, 'security_verification_required');
});

test('a login wall reports its own reason too', () => {
  const withReason = { ...CONFIG, login_selector: '#signin' };
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { '#signin': [{}] } });
  const { value } = search(page, {}, withReason);
  assert.equal(value.next, 'login_required');
  assert.equal(value.error, 'login_required');
});

// Paging is opt-in per site and costs a full navigation per page. Three of the nine storefronts declare
// a shape; the rest stay on page one on purpose, because a guessed parameter either does nothing or
// silently returns page one again while the caller believes it read something new.

const PAGED = {
  ...CONFIG,
  pagination: { mode: 'query', param: 'page', start: 1, step: 1, max_pages: 2, next_selector: 'a.next' },
};

test('a site that declares no paging never gets a page parameter', () => {
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [card('1', 'x', '1원')] } });
  const { ops } = search(page, { page: 2 });
  const nav = ops.find((entry) => entry.op === 'nav.navigate');
  assert.ok(!/[?&]page=/.test(nav.params.url), `no paging declared, so no parameter: ${nav.params.url}`);
});

test('a declared shape produces the parameter it declares', () => {
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [card('1', 'x', '1원')] } });
  const { ops } = search(page, { page: 2 }, PAGED);
  assert.match(ops.find((entry) => entry.op === 'nav.navigate').params.url, /[?&]page=2/);
});

test('page one is the bare search url', () => {
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [card('1', 'x', '1원')] } });
  const { ops } = search(page, { page: 1 }, PAGED);
  assert.ok(!/[?&]page=/.test(ops.find((entry) => entry.op === 'nav.navigate').params.url));
});

test('a next control that is present says there is more', () => {
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [card('1', 'x', '1원')], 'a.next': [{}] } });
  assert.equal(search(page, {}, PAGED).value.has_more, true);
});

test('a next control that was looked for and is absent says there is no more', () => {
  // A probed-and-absent control beats a row count: a full page of results can still be the last one.
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [card('1', 'x', '1원')] } });
  assert.equal(search(page, {}, PAGED).value.has_more, false);
});

test('a site that cannot tell reports nothing rather than false', () => {
  // Absent means "cannot tell" and the caller treats it as no more. Answering `false` would claim a
  // check that never happened.
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [card('1', 'x', '1원')] } });
  const { value } = search(page, {});
  assert.equal(value.has_more, undefined);
  assert.equal(value.pagination_supported, false);
});

test('a paging site reports that paging is supported', () => {
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [card('1', 'x', '1원')] } });
  assert.equal(search(page, {}, PAGED).value.pagination_supported, true);
});

// Some storefronts render their grid from a hydration payload and give the DOM only build-generated
// class names. ssg is one: live, the RPC reader saw `cards_seen: 0` where the production sweep reads six
// rows. The payload carries one clean record per product, so it is read FIRST where a site offers it and
// the DOM pass stays as the fallback.

const PAYLOAD_SELECTOR = 'script#__NEXT_DATA__';
const EMBEDDED = {
  ...CONFIG,
  prefer_embedded: true,
  embedded_json_selector: PAYLOAD_SELECTOR,
  embedded_item_key: 'itemId',
  embedded_fields: { url: ['itemUrl'], title: ['itemName'], price_text: ['finalPrice'] },
  product_id_patterns: ['/p/(%d+)'],
  product_url_prefix: 'https://www.ssg.com/item/',
};
const payloadPage = (json, extra = {}) => makePage({
  href: 'https://www.google.com/',
  afterNavigate: { [PAYLOAD_SELECTOR]: [{ text: json }], ...extra },
});

test('a payload store reads its rows from the payload', () => {
  const json = '{"items":[' +
    '{"itemId":"111","itemName":"무선 마우스 A","finalPrice":"10000","itemUrl":"/p/111"},' +
    '{"itemId":"222","itemName":"무선 마우스 B","finalPrice":"20000","itemUrl":"/p/222"}]}';
  const { value } = search(payloadPage(json), {}, EMBEDDED);

  assert.equal(value.next, 'ok');
  assert.deepEqual(value.candidates.map((c) => [c.product_id, c.name, c.price]), [
    ['111', '무선 마우스 A', 10000],
    ['222', '무선 마우스 B', 20000],
  ]);
});

test('a field never crosses into the next item', () => {
  // The load-bearing property. If the price of the NEXT product can be picked up for a record that has
  // none, the comparison shows a real product at somebody else's price — worse than a missing row.
  const json = '{"items":[' +
    '{"itemId":"111","itemName":"가격 없는 상품","itemUrl":"/p/111"},' +
    '{"itemId":"222","itemName":"이웃 상품","finalPrice":"20000","itemUrl":"/p/222"}]}';
  const { value } = search(payloadPage(json), {}, EMBEDDED);

  assert.deepEqual(value.candidates.map((c) => [c.product_id, c.price]), [['222', 20000]]);
});

test('escaped text arrives readable', () => {
  const json = '{"items":[{"itemId":"111","itemName":"27\\" 모니터 \\/ 대형","finalPrice":"10000","itemUrl":"/p/111"}]}';
  assert.equal(search(payloadPage(json), {}, EMBEDDED).value.candidates[0].name, '27" 모니터 / 대형');
});

test('no payload on the page falls back to the rendered grid', () => {
  // The card URL has to match THIS config's id pattern; a fixture that does not is testing the fixture.
  const domRow = { text: 'DOM 상품 5,000원', url: 'https://www.ssg.com/p/999', title: 'DOM 상품', price_text: '5,000원' };
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [domRow] } });
  const { value } = search(page, {}, EMBEDDED);
  assert.equal(value.next, 'ok');
  assert.deepEqual(value.candidates.map((c) => c.name), ['DOM 상품']);
});

test('a grid that yields nothing falls back to the payload even when the DOM is preferred', () => {
  // Walmart renders a grid whose price fields are empty, so it reads the DOM first — and must still have
  // somewhere to fall to rather than reporting an empty store.
  const domFirst = { ...EMBEDDED, prefer_embedded: false };
  const json = '{"items":[{"itemId":"333","itemName":"페이로드 상품","finalPrice":"7000","itemUrl":"/p/333"}]}';
  const { value } = search(payloadPage(json), {}, domFirst);
  assert.deepEqual(value.candidates.map((c) => [c.product_id, c.price]), [['333', 7000]]);
});

test('the payload obeys the same row limit as the grid', () => {
  const items = Array.from({ length: 30 }, (_, i) =>
    `{"itemId":"${100 + i}","itemName":"상품 ${i}","finalPrice":"${1000 + i}","itemUrl":"/p/${100 + i}"}`).join(',');
  const limited = { ...EMBEDDED, result_limit: 5 };
  assert.equal(search(payloadPage(`{"items":[${items}]}`), {}, limited).value.candidates.length, 5);
});

// 11st routes every card through an ad-server redirect, so the href carries no product id at all; the id
// survives only in the anchor's `data-log-body` JSON. Deriving ids from the href alone made a grid of 156
// cards dedupe down to one — a store full of listings reporting almost nothing.

const ATTR_ID = {
  ...CONFIG,
  result_id_selector: 'a.c-card-item__anchor[data-log-body]',
  result_id_attr: 'data-log-body',
  product_id_patterns: ['/products/(%d+)', '"content_no"%s*:%s*"(%d+)"'],
};
const adRow = (id, name, price) => ({
  text: `${name} ${price}`,
  url: 'https://action.adoffice.11st.co.kr/act?trcKey=abc',
  title: name,
  price_text: price,
  root_id: `{"content_type":"PRODUCT","content_no":"${id}"}`,
});

test('an id hidden in an attribute is read when the href has none', () => {
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [adRow('9170626560', '무선 마우스', '10,000원')] } });
  const { value } = search(page, {}, ATTR_ID);
  assert.equal(value.candidates[0]?.product_id, '9170626560');
});

test('cards that differ only in the attribute stay distinct', () => {
  // The dedupe key is the id. When every card answered the same id the grid collapsed to one row.
  const rows = ['111', '222', '333'].map((id, i) => adRow(id, `상품 ${i}`, `${i + 1},000원`));
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': rows } });
  assert.equal(search(page, {}, ATTR_ID).value.candidates.length, 3);
});

test('a structured attribute no pattern understands yields nothing, not a first token', () => {
  // Mining the first token out of `{"content_type":"PRODUCT",…}` gave every card the id "content_type".
  const noPattern = { ...ATTR_ID, product_id_patterns: ['/products/(%d+)'] };
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [adRow('9170626560', 'x', '1원')] } });
  // An empty Lua table marshals to an object, not an array (AGENTS §9), so assert the emptiness
  // itself rather than the shape the converter happened to choose.
  assert.equal(Object.keys(search(page, {}, noPattern).value.candidates).length, 0);
});

test('a bare attribute id is taken as the id', () => {
  const bare = { ...ATTR_ID, product_id_patterns: ['^(%d+)$'] };
  const row = { ...adRow('777', 'x', '1원'), root_id: '777' };
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [row] } });
  assert.equal(search(page, {}, bare).value.candidates[0]?.product_id, '777');
});

test('the href still wins when it carries the id', () => {
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [card('4242', 'x', '1원')] } });
  assert.equal(search(page, {}, ATTR_ID).value.candidates[0]?.product_id, '4242');
});

// Live, 11st found 24 cards and produced zero candidates. Its title selector is a CSS LIST
// (`.c-card-item__name dd, img[alt]`) and the browser answers with the first match in document order —
// the image, whose textContent is empty. The durable reader survives that by also asking for the image's
// `alt`; this reader never requested the field it then read from the row.
//
// The lesson generalises: whatever the reader consumes it must ASK for. So the requested set is the
// durable reader's set, and the comparison's own fields — shipping, brand, model, rating — come with it,
// because a row without them is folded out of the default window as an unknown total.

const RICH = {
  ...CONFIG,
  result_title_selector: '.name, img[alt]',
  result_image_selector: 'img',
  result_brand_selector: '.brand',
  result_model_selector: '.model',
  result_shipping_selector: '.ship',
  result_rating_selector: '.rate',
  result_reviews_selector: '.reviews',
  result_condition_selector: '.cond',
  result_delivery_selector: '.delivery',
};

test('a title that only exists as an image alt is still a name', () => {
  const row = { text: '무선 마우스', url: 'https://www.11st.co.kr/products/55', title: '', image_alt: '무선 마우스', price_text: '9,900원' };
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [row] } });
  assert.equal(search(page, {}, RICH).value.candidates[0]?.name, '무선 마우스');
});

test('the reader asks for every field it reads', () => {
  const row = { text: 'x', url: 'https://www.11st.co.kr/products/55', title: '무선 마우스', price_text: '9,900원' };
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [row] } });
  search(page, {}, RICH);
  const fields = page.ops.find((entry) => entry.op === 'dom.query_all').params.fields ?? {};
  for (const name of ['url', 'title', 'image_alt', 'brand', 'manufacturer_model', 'price_text',
    'shipping_text', 'rating_text', 'reviews_text', 'condition', 'delivery_text']) {
    assert.ok(fields[name], `${name} must be requested`);
  }
});

test('the candidate carries what the comparison ranks on', () => {
  const row = {
    text: 'x', url: 'https://www.11st.co.kr/products/55', title: '무선 마우스', price_text: '9,900원',
    brand: '로지텍', manufacturer_model: 'M185', shipping_text: '무료배송', rating_text: '4.5',
    reviews_text: '120', condition: '새 상품', delivery_text: '내일 도착',
  };
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [row] } });
  const candidate = search(page, {}, RICH).value.candidates[0];

  assert.equal(candidate.brand, '로지텍');
  assert.equal(candidate.manufacturer_model, 'M185');
  assert.equal(candidate.shipping_text, '무료배송');
  assert.equal(candidate.rating_text, '4.5');
  assert.equal(candidate.condition, '새 상품');
});

// The comparison ranks on a TOTAL, so a row that reaches it with only `shipping_text` has no known total
// and is folded out of the default window. Parsing that text is therefore not a nicety — without it the
// window the user reads is empty.
//
// The distinction that decides correctness: 무료배송 is 0 and "no shipping information" is nil. Treating
// the second as the first makes a store look like the cheapest one on the page.

// The reader only requests fields the config declares — the contract asserted just above — so a
// fixture that sets a row field without declaring its selector is testing nothing.
const COSTED = { ...CONFIG, result_shipping_selector: '.ship', shipping_from_text: true, price_from_text: true };
const costRow = (over) => ({ text: '무선 마우스 9,900원', url: 'https://www.11st.co.kr/products/55', title: '무선 마우스', price_text: '9,900원', ...over });
const costOf = (over, config = COSTED) => {
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [costRow(over)] } });
  return search(page, {}, config).value.candidates[0];
};

test('a stated shipping fee becomes a number in its own currency', () => {
  const c = costOf({ shipping_text: '배송비 2,500원' });
  assert.equal(c.shipping_cost, 2500);
  assert.equal(c.shipping_currency, 'KRW');
});

test('free shipping is zero, not unknown', () => {
  assert.equal(costOf({ shipping_text: '무료배송' }).shipping_cost, 0);
  assert.equal(costOf({ shipping_text: 'Free shipping' }).shipping_cost, 0);
});

test('no shipping information is unknown, never zero', () => {
  // A row with nothing to say about shipping must not be ranked as if it shipped for nothing.
  const c = costOf({ shipping_text: '내일 도착' });
  assert.equal(c.shipping_cost, undefined);
});

test('a currency symbol in the text wins over the site default', () => {
  const c = costOf({ price_text: '$12.99', shipping_text: 'Shipping $3.00' });
  assert.equal(c.price, 12.99);
  assert.equal(c.currency, 'USD');
  assert.equal(c.shipping_cost, 3);
  assert.equal(c.shipping_currency, 'USD');
});

test('a store that hides shipping in the row text is still read', () => {
  // Six of the eight adapters declare `shipping_from_text`, because the fee is not in a field of its own.
  const c = costOf({ text: '무선 마우스 9,900원 무료배송', shipping_text: undefined });
  assert.equal(c.shipping_cost, 0);
});

test('the row text is not mined for shipping unless the site says so', () => {
  // Guessing would read "2,500" out of any row that happens to mention a number near a delivery word.
  const c = costOf({ text: '무선 마우스 9,900원 배송비 2,500원', shipping_text: undefined }, { ...CONFIG, result_shipping_selector: '.ship', price_from_text: true });
  assert.equal(c.shipping_cost, undefined);
});

test('a number with no shipping word nearby is not a shipping fee', () => {
  const c = costOf({ shipping_text: '2,500 포인트 적립' });
  assert.equal(c.shipping_cost, undefined);
});

test('a bare number near a shipping word in the row text is not a fee', () => {
  // Live on 11st: a card named EMBLEM came back with `shipping_cost: 4.7` — its seller rating, sitting
  // inside the window after a delivery word in the card's concatenated text. A 4.7 KRW delivery fee makes
  // that row look nearly free in a total-cost comparison.
  //
  // A dedicated shipping field may hold a bare number; the row text may not. There the figure has to
  // carry a currency mark to be believed.
  const rowText = '무선 마우스 9,900원 배송비 판매자 평점4.7 리뷰 (23)';
  const page = makePage({
    href: 'https://www.google.com/',
    afterNavigate: { 'li.card': [{ text: rowText, url: 'https://www.11st.co.kr/products/55', title: '무선 마우스', price_text: '9,900원', shipping_text: '' }] },
  });
  assert.equal(search(page, {}, COSTED).value.candidates[0].shipping_cost, undefined);
});

test('a fee stated with its currency in the row text is still read', () => {
  const rowText = '무선 마우스 9,900원 배송비 2,500원 판매자 평점4.7';
  const page = makePage({
    href: 'https://www.google.com/',
    afterNavigate: { 'li.card': [{ text: rowText, url: 'https://www.11st.co.kr/products/55', title: '무선 마우스', price_text: '9,900원', shipping_text: '' }] },
  });
  assert.equal(search(page, {}, COSTED).value.candidates[0].shipping_cost, 2500);
});

test('a dedicated shipping field may state a bare number', () => {
  const page = makePage({
    href: 'https://www.google.com/',
    afterNavigate: { 'li.card': [{ text: 'x', url: 'https://www.11st.co.kr/products/55', title: '무선 마우스', price_text: '9,900원', shipping_text: 'shipping 2500' }] },
  });
  assert.equal(search(page, {}, COSTED).value.candidates[0].shipping_cost, 2500);
});

// The production pipeline is three steps and only the first touches the browser: search the store, then
// normalize (pure), then merge pages (pure). So the cutover replaces exactly one tool, and its result has
// to look to the normalizer like what the durable adapter returned — `status` and `candidates`, not this
// reader's branch key.

const runStore = (page, args, sites) => {
  installRpcStub(lua, page);
  lua.define(`RPC_SITES = ${sites}`);
  return lua.call('AX_RPC_STOREFRONT.run_store_search', args);
};
const SITES_LUA = `{ ["11st"] = { site = "11st", search_url = "https://search.11st.co.kr/pc/total-search",
  search_param = "kwd", search_path_marker = "/pc/total-search", result_selector = "li.card",
  result_url_selector = "a", result_title_selector = ".name", result_price_selector = ".price",
  default_currency = "KRW", product_id_patterns = { "/products/(%d+)" } } }`;

test('a found store looks to the normalizer like the durable adapter did', () => {
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [card('1', '무선 마우스', '9,900원')] } });
  const value = runStore(page, { site: '11st', query: '마우스' }, SITES_LUA);

  assert.equal(value.next, 'done');
  assert.equal(value.store_result.status, 'candidates');
  assert.equal(value.store_result.site, '11st');
  assert.equal(value.store_result.candidates.length, 1);
});

test('an empty store reports no_results as its status', () => {
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: {} });
  const value = runStore(page, { site: '11st', query: '마우스' }, SITES_LUA);
  assert.equal(value.next, 'done');
  assert.equal(value.store_result.status, 'no_results');
});

test('a wall keeps the store-specific reason the user is shown', () => {
  // `C.store_status` renders one line naming the store and what the user must do; a generic
  // "access_denied" would erase the sentence it builds.
  const walled = SITES_LUA.replace('product_id_patterns = { "/products/(%d+)" }',
    'product_id_patterns = { "/products/(%d+)" }, blocked_selectors = { { selector = "#wall", error = "security_verification_required" } }');
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { '#wall': [{}] } });
  const value = runStore(page, { site: '11st', query: '마우스' }, walled);
  assert.equal(value.store_result.status, 'security_verification_required');
  assert.equal(value.store_result.error, 'security_verification_required');
});

test('a site with no RPC config is refused, not silently empty', () => {
  // amazon and ebay carry bespoke layers and are not part of this cutover. Returning an empty result for
  // them would read as "that store had nothing".
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: {} });
  const value = runStore(page, { site: 'amazon', query: '마우스' }, SITES_LUA);
  assert.equal(value.next, 'unsupported_site');
  assert.equal(value.store_result.status, 'site_not_ported');
});

test('the result never asks the caller to come back mid-navigation', () => {
  // The durable adapter answered `navigating` and the flow looped back into it. An RPC script keeps its
  // own stack across the navigation, so that branch has nothing left to mean.
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [card('1', 'x', '1원')] } });
  const value = runStore(page, { site: '11st', query: '마우스' }, SITES_LUA);
  assert.notEqual(value.next, 'navigating');
  assert.ok(!value.store_result.pending);
});

test('a refusal says whether the data module is missing or the site is', () => {
  // Live, both 11st and ssg refused with a bare `unsupported_site`, and the two possible causes — the
  // site data module never loaded, or this store genuinely has no config — need different fixes. A
  // refusal that cannot tell them apart costs a diagnosis round every time.
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: {} });

  installRpcStub(lua, page);
  lua.define('RPC_SITES = nil');
  const noModule = lua.call('AX_RPC_STOREFRONT.run_store_search', { site: '11st', query: 'x' });
  assert.equal(noModule.next, 'unsupported_site');
  assert.equal(noModule.error, 'site_data_unavailable');

  installRpcStub(lua, page);
  lua.define('RPC_SITES = { ["11st"] = { site = "11st" } }');
  const noSite = lua.call('AX_RPC_STOREFRONT.run_store_search', { site: 'amazon', query: 'x' });
  assert.equal(noSite.next, 'unsupported_site');
  assert.equal(noSite.error, 'site_not_ported');
  assert.deepEqual(noSite.known_sites, ['11st']);
});

test('a refusal still produces a store_result, so the reason travels', () => {
  // The flow maps `store_result` and nothing else. A refusal that puts its reason anywhere else is a
  // reason the flow cannot see — live, two stores refused and the output showed only the branch name.
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: {} });
  installRpcStub(lua, page);
  lua.define('RPC_SITES = { ["11st"] = { site = "11st" } }');
  const refused = lua.call('AX_RPC_STOREFRONT.run_store_search', { site: 'amazon', query: 'x' });

  assert.equal(refused.store_result.status, 'site_not_ported');
  assert.equal(refused.store_result.error, 'site_not_ported');
  assert.equal(refused.store_result.site, 'amazon');
});

test('the entry reads the shape an action_contract actually hands it', () => {
  // A `kind: remote` tool gets the `input:` mapping; a runtime lua tool gets the node's SELECTED FLOW
  // STATE. The worker selects `item`, `context`, `page`, `query` — so the site arrives as `item.site`,
  // not `site`. Live, reading only the flat key made every store refuse with an empty site.
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [card('7', '무선 마우스', '9,900원')] } });
  installRpcStub(lua, page);
  lua.define(`RPC_SITES = ${SITES_LUA}`);
  const value = lua.call('AX_RPC_STOREFRONT.run_store_search', {
    item: { site: '11st' },
    context: { query: '마우스' },
    page: 1,
  });

  assert.equal(value.next, 'done');
  assert.equal(value.store_result.site, '11st');
  assert.equal(value.store_result.candidates.length, 1);
});

test('an explicit query still wins over the shared one', () => {
  // The collector hands back the wording this store's own listings use; until then the shared query
  // stands. Both arrive in the same state, so precedence has to be stated.
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [card('7', 'x', '1원')] } });
  installRpcStub(lua, page);
  lua.define(`RPC_SITES = ${SITES_LUA}`);
  lua.call('AX_RPC_STOREFRONT.run_store_search', {
    item: { site: '11st' }, context: { query: '공용 검색어' }, query: '이 스토어 표현', page: 1,
  });
  const nav = page.ops.find((entry) => entry.op === 'nav.navigate');
  assert.ok(/%EC%9D%B4%20%EC%8A%A4|%EC%9D%B4\+%EC%8A%A4/.test(nav.params.url) || decodeURIComponent(nav.params.url).includes('이 스토어 표현'),
    `the store's own wording must be used: ${nav.params.url}`);
});

// A payload states shipping either as a scalar on the record ("dlvryFee":"0") or as a nested block
// ("shippingCostInfo":[{"text":"무료배송"}]). ssg uses the block, and not mining it made every ssg row
// fold as an unconfirmed total in production where the durable reader had priced it.

const SHIPPED = {
  ...EMBEDDED,
  embedded_fields: { url: ['itemUrl'], title: ['itemName'], price_text: ['finalPrice'] },
};

test('shipping stated in a nested block is read', () => {
  const json = '{"items":[{"itemId":"111","itemName":"마우스","finalPrice":"10000","itemUrl":"/p/111",' +
    '"shippingCostInfo":[{"text":"배송비 2,500원"}]}]}';
  assert.equal(search(payloadPage(json), {}, SHIPPED).value.candidates[0].shipping_cost, 2500);
});

test('free shipping in the block is zero', () => {
  const json = '{"items":[{"itemId":"111","itemName":"마우스","finalPrice":"10000","itemUrl":"/p/111",' +
    '"shippingCostInfo":[{"text":"무료배송"}]}]}';
  assert.equal(search(payloadPage(json), {}, SHIPPED).value.candidates[0].shipping_cost, 0);
});

test('a configured shipping field wins over the block', () => {
  const withField = { ...SHIPPED, embedded_fields: { ...SHIPPED.embedded_fields, shipping_text: ['dlvryFee'] } };
  const json = '{"items":[{"itemId":"111","itemName":"마우스","finalPrice":"10000","itemUrl":"/p/111",' +
    '"dlvryFee":"배송비 3,000원","shippingCostInfo":[{"text":"무료배송"}]}]}';
  assert.equal(search(payloadPage(json), {}, withField).value.candidates[0].shipping_cost, 3000);
});

test('a neighbour block is not borrowed', () => {
  // The same chunk boundary that protects the price protects the fee: a record with no shipping block
  // must not inherit the next record's.
  const json = '{"items":[' +
    '{"itemId":"111","itemName":"배송 미표기","finalPrice":"10000","itemUrl":"/p/111"},' +
    '{"itemId":"222","itemName":"이웃","finalPrice":"20000","itemUrl":"/p/222","shippingCostInfo":[{"text":"배송비 2,500원"}]}]}';
  const rows = search(payloadPage(json), {}, SHIPPED).value.candidates;
  assert.equal(rows.find((c) => c.product_id === '111').shipping_cost, undefined);
  assert.equal(rows.find((c) => c.product_id === '222').shipping_cost, 2500);
});

test('the payload item key IS the id', () => {
  // Reproduced against ssg's real 221 KB payload: zero candidates. The item key match captures the id and
  // this reader threw the capture away, leaving the row to find an id in `itemUrl` — which for ssg does
  // not carry one. A payload that names every product still produced an empty store.
  const json = '{"dataList":[{"itemId":"1000070929636","itemName":"로지텍 M185",' +
    '"itemUrl":"https://www.ssg.com/item/itemView.ssg?itemId=1000070929636&siteNo=6004",' +
    '"rawPrimaryPrice":"16900","shippingCostInfo":[{"type":"배송비","text":"무료배송"}]}]}';
  const ssgish = {
    ...CONFIG,
    prefer_embedded: true,
    embedded_json_selector: PAYLOAD_SELECTOR,
    embedded_item_key: 'itemId',
    embedded_fields: { url: ['itemUrl'], title: ['itemName'], price_text: ['rawPrimaryPrice'] },
    product_id_patterns: ['/itemView%.ssg%?itemId=(%d+)'],
  };
  const candidate = search(payloadPage(json), {}, ssgish).value.candidates[0];

  assert.equal(candidate.product_id, '1000070929636');
  assert.equal(candidate.price, 16900);
  assert.equal(candidate.shipping_cost, 0);
});

test('a payload id survives even when no url pattern matches', () => {
  const json = '{"dataList":[{"itemId":"777","itemName":"마우스","itemUrl":"https://www.ssg.com/opaque","rawPrimaryPrice":"1000"}]}';
  const noUrlId = {
    ...CONFIG, prefer_embedded: true, embedded_json_selector: PAYLOAD_SELECTOR, embedded_item_key: 'itemId',
    embedded_fields: { url: ['itemUrl'], title: ['itemName'], price_text: ['rawPrimaryPrice'] },
    product_id_patterns: ['/never/(%d+)'],
  };
  assert.equal(search(payloadPage(json), {}, noUrlId).value.candidates[0]?.product_id, '777');
});

// Live, three separate turns died on the FIRST op: `rpc dom.get_location_href failed: rpc_timeout`,
// always moments after the extension reloaded and the channel was still attaching. One refused read is
// not a page problem and it should not cost the whole store — the worker marked it `failed` and the
// comparison lost it entirely.
//
// The tight `opTimeoutMs` exists for navigating polls, where a document that accepts a poll and then
// unloads must not hold the script. The opening read is not that, so it gets one more chance.

test('a channel still attaching costs a couple of retries, not the store', () => {
  const page = makePage({
    href: 'https://www.google.com/',
    failHrefTimes: 2,
    afterNavigate: { 'li.card': [card('1', '무선 마우스', '9,900원')] },
  });
  const { value } = search(page);
  assert.equal(value.next, 'ok');
  assert.equal(value.candidates.length, 1);
});

test('a channel that never answers is reported, not raised', () => {
  // Raising takes the whole worker down and the store disappears from the comparison. A classified
  // result keeps it visible as a store that could not be read.
  const page = makePage({ href: 'https://www.google.com/', failHrefTimes: 99, afterNavigate: {} });
  const { value } = search(page);
  assert.equal(value.next, 'error');
  assert.equal(value.error, 'rpc_unavailable');
});

// Live on coupang: `로지텍 무선 마우스, 블랙, M18519,400원` — the model code ends in digits and the price
// follows with no separator. Stripping commas and taking the first digit run reported the product at
// KRW 18,519,400. A wrong number in a price comparison is the worst thing this reader can produce, so an
// amount only counts when it does not CONTINUE an alphanumeric token. Hangul is multi-byte, so a Korean
// prefix never blocks a match.

const priceOf = (text, over = {}) => {
  const page = makePage({
    href: 'https://www.google.com/',
    afterNavigate: { 'li.card': [{ text, url: 'https://www.11st.co.kr/products/55', title: '마우스', price_text: '' }] },
  });
  return search(page, {}, { ...CONFIG, price_from_text: true, ...over }).value.candidates[0];
};

test('a model code glued to the price drops the row instead of inventing one', () => {
  // The digits cannot be separated without knowing where the model code ends, so the honest outcome is
  // no price and therefore no row. What must never happen is the naive reading, KRW 18,519,400.
  assert.equal(priceOf('로지텍 무선 마우스, 블랙, M18519,400원 모레 도착'), undefined);
});

test('the last price before the shipping words is the price', () => {
  // coupang prints the struck-through price, then the discount, then the real one, then the fee.
  const text = '로지텍 무선마우스, M185, Gray 할인 16,510원 36% 10,480원 배송비 2,500원 조건부 무료배송';
  assert.equal(priceOf(text, { price_text_strategy: 'last_before_shipping' }).price, 10480);
});

test('a reward figure after the cutoff is never the price', () => {
  const text = '로지텍 M185 19,400원 무료배송 최대 970원 적립';
  assert.equal(priceOf(text, { price_text_strategy: 'last_before_shipping' }).price, 19400);
});

test('the screen-reader form glued to the human one is not the price', () => {
  // walmart: "Now$4999current price Now $49.99" — `decimal_preferred` takes the marked one.
  const text = 'Logitech M185 Now$1699current price Now $16.99';
  assert.equal(priceOf(text, { price_text_strategy: 'decimal_preferred', default_currency: 'USD' }).price, 16.99);
});

// aliexpress does not take a query parameter: its search lives at a slugged path
// (`/w/wholesale-logitech-m185.html`). Live, the reader concatenated a nil `search_param` and the Lua
// error took the whole store out of the comparison — a missing config field should never cost more than
// the store it describes.

const PATH_SITE = {
  ...CONFIG,
  search_url: undefined,
  search_param: undefined,
  search_path_prefix: 'https://www.aliexpress.com/w/wholesale-',
  search_path_suffix: '.html',
  search_path_marker: '/w/wholesale-',
  pagination: { mode: 'query', param: 'page', start: 1, step: 1, max_pages: 2 },
};

test('a path-based store gets a slugged url, not a query parameter', () => {
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [card('1', 'x', '1원')] } });
  const { ops } = search(page, { query: 'logitech m185' }, PATH_SITE);
  const url = ops.find((entry) => entry.op === 'nav.navigate').params.url;
  assert.equal(url, 'https://www.aliexpress.com/w/wholesale-logitech-m185.html');
});

test('a path-based store still pages', () => {
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [card('1', 'x', '1원')] } });
  const { ops } = search(page, { query: 'mouse', page: 2 }, PATH_SITE);
  assert.match(ops.find((entry) => entry.op === 'nav.navigate').params.url, /wholesale-mouse\.html\?page=2/);
});

test('a store that declares no search shape is reported, not crashed', () => {
  // Raising loses the store entirely; the comparison then cannot even say which store it failed to read.
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: {} });
  const { value } = search(page, {}, { ...CONFIG, search_url: undefined, search_param: undefined });
  assert.equal(value.next, 'error');
  assert.equal(value.error, 'search_url_unavailable');
});

// ebay's search is the generic shape — navigate, wait, classify, read cards — with one field the shared
// reader did not carry: the seller's positive-feedback percentage, which the comparison ranks on. Adding
// it to the config is what lets ebay stop being a bespoke layer.

const SELLER_SITE = {
  ...CONFIG,
  result_seller_selector: '.seller',
  result_condition_selector: '.cond',
};

test('a seller signal is read when the site declares where it lives', () => {
  const row = {
    text: 'x', url: 'https://www.11st.co.kr/products/9', title: 'M185', price_text: '9,900원',
    seller_text: '99.2% positive feedback (1,470)', condition: 'Brand New',
  };
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [row] } });
  const candidate = search(page, {}, SELLER_SITE).value.candidates[0];

  assert.equal(candidate.seller_rating_percent, 99.2);
  assert.equal(candidate.review_count, 1470);
  assert.equal(candidate.condition, 'Brand New');
});

test('a seller line without a percentage yields no rating rather than a wrong one', () => {
  const row = { text: 'x', url: 'https://www.11st.co.kr/products/9', title: 'M185', price_text: '9,900원', seller_text: 'Top Rated Seller' };
  const page = makePage({ href: 'https://www.google.com/', afterNavigate: { 'li.card': [row] } });
  assert.equal(search(page, {}, SELLER_SITE).value.candidates[0].seller_rating_percent, undefined);
});

// The single-site shopping flow opens a store and then searches "the site that is open" — the node
// carries a query and nothing else. The durable adapter got the site for free, because the browser had
// already loaded that site's layer. A runtime script has no such context, so it resolves the site from
// the page it is looking at.

test('the open page decides which store is being searched', () => {
  installRpcStub(lua, makePage({ href: 'https://search.11st.co.kr/pc/total-search?kwd=x' }));
  lua.define('RPC_SITES = { ["11st"] = { site = "11st", hosts = { "search.11st.co.kr" } }, ssg = { site = "ssg", hosts = { "www.ssg.com" } } }');
  assert.equal(lua.call('AX_RPC_STOREFRONT.site_for_url', 'https://search.11st.co.kr/pc/total-search?kwd=x'), '11st');
  assert.equal(lua.call('AX_RPC_STOREFRONT.site_for_url', 'https://www.ssg.com/search.ssg?query=x'), 'ssg');
});

test('a subdomain of a declared host still resolves', () => {
  installRpcStub(lua, makePage({ href: 'https://www.google.com/' }));
  lua.define('RPC_SITES = { ebay = { site = "ebay", hosts = { "ebay.com" } } }');
  assert.equal(lua.call('AX_RPC_STOREFRONT.site_for_url', 'https://www.ebay.com/sch/i.html?_nkw=x'), 'ebay');
});

test('a page belonging to no ported store resolves to nothing', () => {
  // amazon is still bespoke; answering with some other store would search the wrong shop.
  installRpcStub(lua, makePage({ href: 'https://www.google.com/' }));
  lua.define('RPC_SITES = { ebay = { site = "ebay", hosts = { "ebay.com" } } }');
  assert.equal(lua.call('AX_RPC_STOREFRONT.site_for_url', 'https://www.amazon.com/s?k=x'), null);
});

test('searching the open store needs only a query', () => {
  const page = makePage({
    href: 'https://search.11st.co.kr/pc/total-search?kwd=old',
    afterNavigate: { 'li.card': [card('5', '무선 마우스', '9,900원')] },
  });
  installRpcStub(lua, page);
  lua.define(`RPC_SITES = { ["11st"] = ${SITES_LUA.replace(/^\{ \["11st"\] = /, '').replace(/ \}$/, '')}, hosts = { "search.11st.co.kr" } } }`.replace('} }, hosts', '}, hosts'));
  const value = lua.call('AX_RPC_STOREFRONT.run_open_site_search', { query: '마우스' });
  assert.equal(value.next, 'done');
  assert.equal(value.store_result.site, '11st');
});

test('the single-site search answers in the shape that flow already reads', () => {
  // Its `output:` maps `result.candidates` and `result.error` directly — the tool predates the worker's
  // `store_result` envelope. Reshaping the flow to match the reader would be the tail wagging the dog.
  const page = makePage({
    href: 'https://search.11st.co.kr/pc/total-search?kwd=old',
    afterNavigate: { 'li.card': [card('5', '무선 마우스', '9,900원')] },
  });
  installRpcStub(lua, page);
  lua.define('RPC_SITES = { ["11st"] = { site = "11st", hosts = { "search.11st.co.kr" }, search_url = "https://search.11st.co.kr/pc/total-search", search_param = "kwd", search_path_marker = "/pc/total-search", result_selector = "li.card", result_url_selector = "a", result_title_selector = ".name", result_price_selector = ".price", default_currency = "KRW", product_id_patterns = { "/products/(%d+)" } } }');
  const value = lua.call('AX_RPC_STOREFRONT.run_open_site_search', { query: '마우스' });

  assert.ok(Object.values(value.candidates ?? {}).length >= 1, 'candidates must be readable at the top level');
  assert.equal(value.error, undefined);
});

test('a transient op refusal does not throw away a page already read', () => {
  // Measured live on the multi-store comparison, after the accumulator fix let the flow get this far:
  //   shopping_search_one_store | "lua runtime error: ...:606: rpc dom.exists failed: rpc_timeout"
  // Every `dom.*` in this module is called raw, so one refused op while the channel re-attaches raises
  // out of the tool and the store is lost — including the candidates already parsed off the page. It is
  // the same lesson the quote and cart modules learned: a refusal is a fact about the CHANNEL, never
  // about the page, and the only honest answer is to retry once and then treat it as unknown.
  const page = makePage({
    href: 'https://search.11st.co.kr/pc/total-search?kwd=마우스',
    dom: { 'li.card': [card('1', '무선 마우스', '10,000원'), card('2', '유선 마우스', '8,000원')] },
    // Every third op is refused, which is what a re-attaching channel looks like.
    flakyEvery: 3,
  });
  const { value } = search(page);

  assert.ok(value, 'the tool must answer, not raise');
  assert.notEqual(value.next, undefined);
  assert.ok(
    Array.isArray(value.candidates) ? value.candidates.length >= 1 : value.next !== 'ok',
    `a page that parsed must not be discarded: ${JSON.stringify(value).slice(0, 160)}`,
  );
});

test('an unknown paging control is absent, never a claim', () => {
  // `has_more` is the field that raised. Absent means "could not tell" and the caller treats it as no
  // more; `false` would claim a check that never happened and stop a page that exists.
  const page = makePage({
    href: 'https://search.11st.co.kr/pc/total-search?kwd=마우스',
    dom: { 'li.card': [card('1', '무선 마우스', '10,000원')] },
    refuseOps: ['dom.exists'],
  });
  const { value } = search(page, {}, { ...CONFIG, pagination: { next_selector: '.next' } });

  assert.ok(value, 'the tool must answer, not raise');
  assert.notEqual(value.has_more, false, 'a refused probe must not answer "no more"');
});

// Measured on live Amazon: every search card carries TWO `h2` elements — the brand first, the product
// title second — and only the title sits inside the card's anchor:
//   h2s: ["Logitech", "M240 Compact Silent Bluetooth Wireless Mouse - Rose | ..."]
// The config asked for `"h2, h2 a"`, and a CSS list matches in DOCUMENT order, so the brand won. Every
// branded row came back named `Logitech` — and relevance REQUIRES the model code, so a search for M185
// matched nothing and the whole comparison reported no products.
//
// There is deliberately no reader-level test for this. The reader batches ONE `query_all` over the card
// selector and takes each field off the returned row, so a stub cannot express "which sub-selector the
// row's title came from" — a fixture here would assert on its own input. The contract that can fail is
// the one below, on the config.

test('the Amazon title selector cannot reach a heading outside the anchor', () => {
  // A contract on the CONFIG, because the defect was in data, not in code: every alternative has to
  // require an anchor ancestor, or the brand heading — which is not linked — matches first again.
  // The registry is a plain global table keyed by slug, not an accessor.
  const source = readFileSync(new URL('../../_common/rpc/62_rpc_sites.lua', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('RPC_SITES["amazon"]'));
  const selector = (/result_title_selector\s*=\s*"([^"]+)"/.exec(block) ?? [])[1] ?? '';
  assert.ok(selector.length > 0, 'amazon must declare a title selector');
  for (const part of selector.split(',')) {
    assert.match(part.trim(), /^a[.\s]/, `"${part.trim()}" would match a heading outside the anchor`);
  }
});
