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
