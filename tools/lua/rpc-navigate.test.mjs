import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { loadLuaModules } from './harness.mjs';
import { installRpcStub, makePage } from './rpc-stub.mjs';

// `AX_navigate` was classified as a platform-owned command for a long time. It is not: it builds a URL
// from a link plus query params, navigates, and confirms arrival against an expected URL — which in the
// runtime is `nav.navigate` + `nav.wait_for_navigation` + `dom.get_location_href`, the combination the
// search and quote paths already run live.
//
// The confirmation is the part worth keeping. A fired navigation is not an arrival, and the durable tool
// said so with an `expectedUrl` hint; answering "go" for a navigation that never landed would send the
// next node to read a page that is still the old one.

// Both modules, because the tool declares both: the opener reads each store's home from the generated
// site data rather than keeping a second list of hosts.
const lua = loadLuaModules(['_common/rpc/62_rpc_sites.lua', '_common/rpc/66_rpc_navigate.lua']);
after(() => lua.close());

const SITE = 'http://bluemoonsoft.com/front/main';

const go = (page, args) => {
  installRpcStub(lua, page);
  return lua.call('AX_RPC_NAV.navigate_page', args);
};

const navigated = (page) => page.ops.filter((entry) => entry.op === 'nav.navigate').map((entry) => entry.params.url);
const hrefReads = (page) => page.ops.filter((entry) => entry.op === 'dom.get_location_href').length;

test('a relative link is resolved against the page we are on', () => {
  const page = makePage({ href: SITE, dom: {}, afterNavigate: {} });
  const result = go(page, { link: '/front/product' });

  assert.equal(result.next, 'go');
  assert.deepEqual(navigated(page), ['http://bluemoonsoft.com/front/product']);
});

test('an absolute link is used as given', () => {
  const page = makePage({ href: SITE, dom: {}, afterNavigate: {} });
  go(page, { link: 'http://bluemoonsoft.com/front/quote' });

  assert.deepEqual(navigated(page), ['http://bluemoonsoft.com/front/quote']);
});

test('params become a query string, percent-encoded', () => {
  const page = makePage({ href: SITE, dom: {}, afterNavigate: {} });
  go(page, { link: '/front/search', params: { q: '블루문 견적', page: 2 } });

  const url = navigated(page)[0];
  assert.match(url, /^http:\/\/bluemoonsoft\.com\/front\/search\?/);
  assert.match(url, /q=%EB%B8%94%EB%A3%A8%EB%AC%B8%20%EA%B2%AC%EC%A0%81|q=%EB%B8%94%EB%A3%A8%EB%AC%B8\+%EA%B2%AC%EC%A0%81/);
  assert.match(url, /page=2/);
});

test('params are ordered, so the same request produces the same URL', () => {
  // A Lua table has no order. Sorting the keys keeps the URL stable across runs, which is what makes a
  // navigation comparable to the one before it — and a cache hit possible at all.
  const first = makePage({ href: SITE, dom: {}, afterNavigate: {} });
  go(first, { link: '/s', params: { b: '2', a: '1', c: '3' } });
  const second = makePage({ href: SITE, dom: {}, afterNavigate: {} });
  go(second, { link: '/s', params: { c: '3', a: '1', b: '2' } });

  assert.equal(navigated(first)[0], navigated(second)[0]);
  assert.match(navigated(first)[0], /\?a=1&b=2&c=3$/);
});

test('being already there is not a navigation', () => {
  const page = makePage({ href: SITE, dom: {}, afterNavigate: {} });
  const result = go(page, { link: '/front/main' });

  assert.equal(result.next, 'go');
  assert.deepEqual(navigated(page), [], 'nothing to do');
});

test('a navigation that never lands is reported, not called success', () => {
  // The durable tool checked arrival against `expectedUrl` for this reason. Answering "go" would send the
  // next node to read a page that is still the previous one.
  const page = makePage({ href: SITE, dom: {}, afterNavigate: {}, navigationFails: true });
  const result = go(page, { link: '/front/product' });

  assert.equal(result.next, 'error');
  assert.equal(result.error, 'navigation_failed');
});

test('landing somewhere else is reported with where we actually are', () => {
  // A login bounce or a canonical rewrite lands elsewhere. The durable tool treated a prefix match as
  // arrival and anything else as unresolved; what the caller needs is the truth plus the landing.
  const page = makePage({
    href: SITE, dom: {}, afterNavigate: {},
    landsAt: 'http://bluemoonsoft.com/login?next=%2Ffront%2Fproduct',
  });
  const result = go(page, { link: '/front/product' });

  assert.equal(result.next, 'error');
  assert.equal(result.error, 'wrong_landing');
  assert.match(result.href, /\/login/);
});

test('a link that is not a link is refused before anything moves', () => {
  const page = makePage({ href: SITE, dom: {}, afterNavigate: {} });
  const result = go(page, {});

  assert.equal(result.next, 'error');
  assert.equal(result.error, 'missing_link');
  assert.deepEqual(navigated(page), []);
});

test('an off-site link is refused: this tool navigates within the site', () => {
  // The node's whole purpose is picking a page out of the current site's sitemap. Following an absolute
  // URL to another host would leave the flow's site behind without saying so.
  const page = makePage({ href: SITE, dom: {}, afterNavigate: {} });
  const result = go(page, { link: 'https://example.com/elsewhere' });

  assert.equal(result.next, 'error');
  assert.equal(result.error, 'offsite_link');
  assert.deepEqual(navigated(page), []);
});

test('a fragment-only target is a same-document move, not a wait for a document', () => {
  // Measured live (bluemoonsoft): `nav.navigate` to `.../front/main#modal/docuray` from `.../front/main`
  // leaves the href readable WITH the fragment immediately, and the site's own router then consumes the
  // hash and rewrites the URL without it. A new document never arrives, so `wait_for_navigation` has
  // nothing to wait for — and a read taken after it shows the fragment gone, which the old code reported
  // as `navigation_failed`: an answer whose own doc comment means "the browser never moved".
  const page = makePage({ href: SITE, dom: {}, afterNavigate: {} });
  const result = go(page, { link: '/front/main#modal/docuray' });

  assert.equal(result.next, 'go');
  assert.equal(result.navigated, 'within_document');
  assert.equal(result.href, 'http://bluemoonsoft.com/front/main#modal/docuray');
  assert.deepEqual(navigated(page), ['http://bluemoonsoft.com/front/main#modal/docuray']);
});

test('the same-document arrival is decided before any wait could destroy the evidence', () => {
  // The site consumes its own hash a moment after applying it. One read of `here`, one read right after
  // the navigation — a third href read means a wait ran first, and by then the fragment is gone.
  const page = makePage({ href: SITE, dom: {}, afterNavigate: {} });
  const result = go(page, { link: '/front/main#modal/docuray' });

  assert.equal(result.next, 'go');
  assert.equal(hrefReads(page), 2, 'here + one immediate arrival read, no wait polls');
});

test('a fragment the runtime never applies is refused by name, not called go', () => {
  // A false positive here tells the user a page opened that never did — worse than the failure it
  // replaces. And `navigation_failed` would be wrong too: that answer means "the browser never moved",
  // where this one means "the runtime would not perform a same-document move".
  const page = makePage({ href: SITE, dom: {}, afterNavigate: {}, navigationFails: true });
  const result = go(page, { link: '/front/main#modal/docuray' });

  assert.equal(result.next, 'error');
  assert.equal(result.error, 'same_document_refused');
  assert.equal(result.reason, 'fragment_not_applied');
});

test('a runtime that refuses the move is answered from its refusal, not second-guessed', () => {
  // Measured live: `nav.navigate` can answer `{ok=false, reason="window_not_available"}` with the href
  // unchanged. The old code ignored the return value entirely, which is how a refusal became an
  // arrival question in the first place.
  const page = makePage({ href: SITE, dom: {}, afterNavigate: {}, navigateRefusal: 'window_not_available' });
  const result = go(page, { link: '/front/main#modal/docuray' });

  assert.equal(result.next, 'error');
  assert.equal(result.error, 'same_document_refused');
  assert.equal(result.reason, 'window_not_available');
  assert.equal(hrefReads(page), 1, 'a refusal is an answer; nothing to poll for');
});

test('a refused cross-page navigation reports the refusal without waiting for it', () => {
  const page = makePage({ href: SITE, dom: {}, afterNavigate: {}, navigateRefusal: 'window_not_available' });
  const result = go(page, { link: '/front/product' });

  assert.equal(result.next, 'error');
  assert.equal(result.error, 'navigation_failed');
  assert.equal(result.reason, 'window_not_available');
  assert.equal(hrefReads(page), 1, 'no 12-second wait for a navigation the runtime refused');
});

test('a fragment on a DIFFERENT path is a real navigation, and it waits', () => {
  // Only a fragment-ONLY difference is a same-document move. A new path is a new document even when the
  // link carries a hash — and a site that consumes that hash on arrival has still landed on the right
  // document, which must not read as `wrong_landing`.
  const page = makePage({ href: SITE, dom: {}, afterNavigate: {} });
  const result = go(page, { link: '/front/product#spec' });

  assert.equal(result.next, 'go');
  assert.equal(result.navigated, true);
  assert.equal(result.href, 'http://bluemoonsoft.com/front/product');
  assert.deepEqual(navigated(page), ['http://bluemoonsoft.com/front/product#spec']);
  assert.ok(hrefReads(page) > 2, 'a cross-document navigation still waits for arrival');
});

test('opening a site by slug lands on its home', () => {
  // Three flows genuinely need to BE on a site before their next step: the checkout has to reach amazon's
  // cart, bluemoonsoft's page navigation is same-site only, and the single-site shopping loop searches
  // "whichever store is open". Deleting the opener broke all three — the search flows that navigate to a
  // search URL themselves are the ones that never needed it.
  const page = makePage({ href: 'https://www.google.com/', dom: {}, afterNavigate: {} });
  installRpcStub(lua, page);
  const result = lua.call('AX_RPC_NAV.open_site', { site: 'amazon' });

  assert.equal(result.next, 'search');
  assert.deepEqual(navigated(page), ['https://www.amazon.com/']);
});

test('already being on the site is not a navigation', () => {
  // Subdomain-tolerant on purpose: `www.amazon.com` is amazon.
  const page = makePage({ href: 'https://www.amazon.com/s?k=mouse', dom: {}, afterNavigate: {} });
  installRpcStub(lua, page);
  const result = lua.call('AX_RPC_NAV.open_site', { site: 'amazon' });

  assert.equal(result.next, 'search');
  assert.deepEqual(navigated(page), []);
});

test('a site nobody published is refused by name', () => {
  const page = makePage({ href: 'https://www.google.com/', dom: {}, afterNavigate: {} });
  installRpcStub(lua, page);
  const result = lua.call('AX_RPC_NAV.open_site', { site: 'nowhere' });

  assert.equal(result.next, 'error');
  assert.equal(result.error, 'unknown_site');
  assert.deepEqual(navigated(page), []);
});

test('a cross-domain open that never lands says so', () => {
  const page = makePage({ href: 'https://www.google.com/', dom: {}, afterNavigate: {}, navigationFails: true });
  installRpcStub(lua, page);
  const result = lua.call('AX_RPC_NAV.open_site', { site: 'thumbtack' });

  assert.equal(result.next, 'error');
  assert.equal(result.error, 'navigation_failed');
});

test('the published site list is the one the site data declares', () => {
  // Two sources for "where does this site live" drift apart, and the one nobody exercises is the one that
  // sends the browser to the wrong host. The commerce stores come from the generated data; only the sites
  // that data does not cover are named here.
  const sites = loadLuaModules(['_common/rpc/62_rpc_sites.lua', '_common/rpc/66_rpc_navigate.lua']);
  sites.define('function __home(slug) return AX_RPC_NAV.home_url(slug) end', 'home reader');
  for (const [slug, expected] of [
    ['amazon', 'https://www.amazon.com/'],
    ['ssg', 'https://www.ssg.com/'],
    ['thumbtack', 'https://www.thumbtack.com/'],
    ['bluemoonsoft', 'http://bluemoonsoft.com/'],
  ]) {
    assert.equal(sites.call('__home', slug), expected, slug);
  }
  sites.close();
});
