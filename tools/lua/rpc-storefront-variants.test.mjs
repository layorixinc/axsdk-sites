import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { loadLuaModules } from './harness.mjs';
import { installRpcStub, makePage } from './rpc-stub.mjs';

/**
 * A store searched in the WRONG LANGUAGE finds nothing, and the single-site flow had no second try.
 *
 * Measured live 2026-08-27: the collector's prompt says "a SHORT English product search term" — written
 * when this flow was amazon-only — so a Korean request on coupang searched
 * `q=Logitech+M185+mouse` and answered `no_results`, while the same page carries 60 product units for the
 * Korean wording. The gate then had nothing to ask about and skipped the item entirely, which is what made
 * the listing capture unshootable.
 *
 * The multi-store flow already had this mechanism (§13: variants are "tried only when a store found
 * NOTHING, capped at 3, because each costs a navigation"). This gives the single-site search the same one,
 * so the fix does not depend on a model following an instruction.
 */

const lua = loadLuaModules(['_common/rpc/62_rpc_sites.lua', '_common/rpc/61_rpc_storefront.lua']);
after(() => lua.close());

const COUPANG = 'https://www.coupang.com/';

/** A coupang search page that only answers rows for the KOREAN wording. */
const store = ({ answersFor = '로지텍 M185 마우스', rows = 3 } = {}) => {
  // The store's OWN keys, read from the generated site data: rows are
  // `li[data-id]:has(a[href*="/vp/products/"])`, titles are `img[alt]`, and the current Next layout
  // exposes the amount the buyer pays at `.fw-font-bold > span`. The card text also contains a smaller
  // per-egg amount, so falling back to whole-row mining would compare one egg against one tray.
  const cards = [];
  for (let index = 1; index <= rows; index += 1) {
    cards.push({
      text: `로지텍 M185 무선마우스 ${index} 13,900원 (1개당 463원) 내일 도착 최대 695원 적립`,
      price_text: '13,900원',
      // A NUMERIC id, because the store's own pattern is `/vp/products/(%d+)` — a letter there drops the
      // row and the reader answers about prices it never reached.
      url: `https://www.coupang.com/vp/products/900${index}`,
      image_alt: `로지텍 M185 무선마우스 ${index}`,
    });
  }
  const page = makePage({ href: COUPANG, dom: { body: [{ text: 'coupang' }] } });
  // The store answers rows only when the address carries the wording it understands.
  page.navigate = (url) => {
    page.navigated = url;
    page.href = url;
    // Compare on the DECODED address: the reader encodes spaces as `+` and the rest percent-wise, and a
    // fixture that guesses that encoding tests the guess.
    const carries = decodeURIComponent(String(url)).replace(/\+/g, ' ').includes(answersFor);
    const ROWS = 'li[data-id]:has(a[href*="/vp/products/"])';
    page.dom = carries
      ? { body: [{ text: 'coupang' }], [ROWS]: cards }
      : { body: [{ text: 'coupang' }], [ROWS]: [] };
    return null;
  };
  return page;
};

const search = (page, args) => {
  installRpcStub(lua, page);
  return lua.call('AX_RPC_STOREFRONT.run_open_site_search', args);
};

// Spaces ride as `+` in a query string, so the decode has to undo that too — otherwise every wording
// assertion is comparing against a string the address never contains.
const searched = (page) => page.ops
  .filter((op) => op.op === 'nav.navigate')
  .map((op) => decodeURIComponent(String(op.params?.url ?? op.params)).replace(/\+/g, ' '));

test('the first wording is used on its own when it finds something', () => {
  const page = store();
  const answer = search(page, { query: '로지텍 M185 마우스', query_variants: 'Logitech M185 mouse' });

  assert.equal(answer.next, 'done');
  assert.ok((answer.candidates ?? []).length > 0);
  // One navigation: a variant that is not needed must not cost a page load.
  assert.equal(searched(page).length, 1);
});

test('coupang reads the tray price instead of the smaller per-unit amount', () => {
  const page = store();
  const answer = search(page, { query: '로지텍 M185 마우스', query_variants: '' });
  assert.equal(answer.candidates?.[0]?.price, 13_900,
    'the configured current-price field must win over the per-unit amount in the card text');
});

test('a wording that finds nothing is retried with the next one', () => {
  const page = store();
  const answer = search(page, { query: 'Logitech M185 mouse', query_variants: '로지텍 M185 마우스' });

  assert.equal(answer.next, 'done');
  assert.ok((answer.candidates ?? []).length > 0, JSON.stringify(answer).slice(0, 200));
  const urls = searched(page);
  assert.equal(urls.length, 2, urls.join(' | '));
  assert.ok(urls[0].includes('Logitech M185 mouse'));
  assert.ok(urls[1].includes('로지텍 M185 마우스'));
});

test('variants are capped, because each one costs a navigation', () => {
  const page = store({ answersFor: 'never matched' });
  search(page, {
    query: 'one',
    query_variants: 'two|three|four|five|six',
  });
  // The first query plus at most three variants — the same bound the multi-store flow carries.
  assert.ok(searched(page).length <= 4, searched(page).join(' | '));
});

test('an empty variant list changes nothing', () => {
  const page = store({ answersFor: 'never matched' });
  const answer = search(page, { query: 'one', query_variants: '' });
  assert.equal(searched(page).length, 1);
  assert.equal(answer.store_result?.status, 'no_results');
});

test('a blocked store is never retried — no wall opens for a synonym', () => {
  // §13 records this for the multi-store variants and it holds here for the same reason.
  const page = makePage({
    href: COUPANG,
    // The store's OWN wall selector: `iframe[src*="captcha"], form[action*="captcha"], .captcha`.
    dom: { body: [{ text: 'coupang' }], '.captcha': [{ text: '보안문자' }] },
  });
  page.navigate = (url) => { page.navigated = url; page.href = url; return null; };
  const answer = search(page, { query: 'one', query_variants: 'two|three' });
  assert.equal(searched(page).length, 1, searched(page).join(' | '));
  assert.notEqual(answer.store_result?.status, 'candidates');
});

test('a wall met ON a retry stops the retrying', () => {
  // The first wording finds nothing, the second hits the store's bot wall. Asking a third time spends a
  // page load on a page that will refuse it — §13: no wall opens for a synonym. The wall on the FIRST
  // query never enters the loop at all, so only this shape can catch the missing break.
  const page = makePage({ href: COUPANG, dom: { body: [{ text: 'coupang' }] } });
  const ROWS = 'li[data-id]:has(a[href*="/vp/products/"])';
  page.navigate = (url) => {
    page.navigated = url;
    page.href = url;
    const wording = decodeURIComponent(String(url)).replace(/\+/g, ' ');
    page.dom = wording.includes('two')
      ? { body: [{ text: 'coupang' }], '.captcha': [{ text: '보안문자' }] }
      : { body: [{ text: 'coupang' }], [ROWS]: [] };
    return null;
  };
  const answer = search(page, { query: 'one', query_variants: 'two|three' });

  const urls = searched(page);
  assert.equal(urls.length, 2, urls.join(' | '));
  // And the wall is what the store gets reported as — not "nothing found", which is a claim about
  // listings nobody was shown.
  assert.equal(answer.store_result?.status, 'captcha_required');
});

test('coupang\'s 403 page is a refusal, not an empty result', () => {
  // Measured live 2026-08-27 on the search URL: 3,531 bytes, `<div id="error403">`, visible text
  // "요청하신 페이지의 사용권한이 없습니다." — and the reader answered `no_results`, a claim about listings
  // nobody was shown. The configured wall markers ("access denied", "비정상적인 접근") do not appear on it.
  // The ELEMENT alone — no sentence in the body, so only the selector can decide.
  const structural = makePage({
    href: COUPANG,
    dom: { body: [{ text: '쿠팡!' }], '#error403': [{ text: '' }] },
  });
  structural.navigate = (url) => { structural.navigated = url; structural.href = url; return null; };
  assert.equal(search(structural, { query: '로지텍 M185 마우스' }).store_result?.status, 'access_denied');

  // The SENTENCE alone — a rendering that drops the id still has to be refused, not called empty.
  const textual = makePage({
    href: COUPANG,
    dom: { body: [{ text: '쿠팡! 요청하신 페이지의 사용권한이 없습니다.' }] },
  });
  textual.navigate = (url) => { textual.navigated = url; textual.href = url; return null; };
  const answer = search(textual, { query: '로지텍 M185 마우스' });
  assert.notEqual(answer.store_result?.status, 'no_results');
  assert.equal(answer.store_result?.status, 'access_denied');
});
