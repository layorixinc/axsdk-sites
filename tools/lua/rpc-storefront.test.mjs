import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { loadLuaModules } from './harness.mjs';
import { installRpcStub, makePage } from './rpc-stub.mjs';

// The durable storefront owned a checkpoint state machine (prepare → navigation_armed → …) because a
// navigation destroyed the Lua context and the command had to resume into it. An RPC script keeps its own
// stack across the navigation, so the machine collapses into a straight line: look, maybe move, wait, read.
// What must NOT collapse is the honesty of the outcomes — "moved but nothing rendered", "cards but no
// prices", and "already here" are different facts and the flow branches on them.

const lua = loadLuaModules([
  'playground/_common/scripts/16_rpc_storefront.lua',
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
