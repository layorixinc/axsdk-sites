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

test('a fragment-only target does not navigate at all: the document is already open', () => {
  // Three live measurements settled this, in order. `nav.navigate` to `.../front/main#modal/docuray` from
  // `.../front/main` succeeds and does NOT move the hash — six consecutive reads show the un-fragmented
  // URL. No anchor for the fragment exists on the page (`a[href*="#modal/docuray"]` matched 0, and the
  // only docuray link leaves the site), so there is nothing to click either. And reaching the same URL as
  // a real cross-document navigation lands with the hash consumed on a body that already contains that
  // section's own words.
  //
  // So the section lives in the document we have. Firing a move the runtime will not perform costs a
  // round trip and muddies the trace, and reporting an error tells the caller a page could not be opened
  // while it is open and readable.
  const page = makePage({ href: SITE, dom: {}, afterNavigate: {} });
  const result = go(page, { link: '/front/main#modal/docuray' });

  assert.equal(result.next, 'go');
  assert.equal(result.navigated, 'already_open');
  assert.equal(result.href, SITE, 'where we actually are, fragment and all not applied');
  assert.equal(result.fragment, 'modal/docuray', 'so a caller needing that section can say so');
  assert.deepEqual(navigated(page), [], 'nothing fired');
});

test('the answer costs one read and no wait', () => {
  // No new document is coming, so there is nothing to wait for — and a wait would only spend the budget
  // that the tools with the most round trips are already short of.
  const page = makePage({ href: SITE, dom: {}, afterNavigate: {} });
  const result = go(page, { link: '/front/main#modal/docuray' });

  assert.equal(result.next, 'go');
  assert.equal(hrefReads(page), 1, 'just `here`');
});

test('a runtime that would refuse the move is never asked', () => {
  // The refusal shapes that used to drive this branch — `{ok=false, reason="window_not_available"}` and a
  // fragment the runtime never applies — cannot arise when nothing is fired. `window_not_available` in
  // particular turned out to be a symptom of the harness restarting the session host, not of the runtime.
  const page = makePage({ href: SITE, dom: {}, afterNavigate: {}, navigateRefusal: 'window_not_available' });
  const result = go(page, { link: '/front/main#modal/docuray' });

  assert.equal(result.next, 'go');
  assert.equal(result.navigated, 'already_open');
  assert.deepEqual(navigated(page), []);
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

// ── a fragment on the document already open IS arrival ───────────────────────
//
// Measured live on bluemoonsoft, and it settles what `same_document_refused` should have been:
//   - `nav.navigate` to a fragment-only target succeeds (returns nil) and does NOT move the hash — six
//     consecutive reads show the un-fragmented URL.
//   - No anchor for that fragment exists on the page: `a[href*="#modal/docuray"]` matched 0, and the only
//     docuray link points at a different site. So there is nothing to click either.
//   - Reaching `/front/main#modal/docuray` as a real cross-document navigation lands on `/front/main`
//     with the hash consumed and a body that already contains "docuray" and "Office DRM".
//
// The content is in the document we are on. Refusing tells the caller a page could not be opened when the
// page is open and readable; the honest answer is that this runtime is already as close as it gets, so the
// reader should read. `navigated` distinguishes it, so a caller that genuinely needs the hash can tell.
test('a fragment on the page already open reports arrival, not a refusal', () => {
  const page = makePage({ href: 'https://shop.test/front/main' });
  installRpcStub(lua, page);

  const value = lua.call('AX_RPC_NAV.navigate_page', { link: '/front/main#modal/docuray' });

  assert.equal(value.next, 'go');
  assert.equal(value.navigated, 'already_open');
  assert.equal(value.href, 'https://shop.test/front/main');
  assert.equal(value.fragment, 'modal/docuray', 'the caller learns which section was asked for');
});

test('the fragment move is not even attempted when the document is already open', () => {
  // Firing a navigation the runtime will not perform costs a round trip and can only confuse the trace.
  const page = makePage({ href: 'https://shop.test/front/main' });
  installRpcStub(lua, page);

  lua.call('AX_RPC_NAV.navigate_page', { link: '/front/main#modal/docuray' });

  assert.equal(page.ops.filter((entry) => entry.op === 'nav.navigate').length, 0);
});

test('a fragment on a DIFFERENT path is still a real navigation', () => {
  const page = makePage({
    href: 'https://shop.test/front/main',
    afterNavigate: {},
    landsAt: 'https://shop.test/front/other#part',
  });
  installRpcStub(lua, page);

  const value = lua.call('AX_RPC_NAV.navigate_page', { link: '/front/other#part' });

  assert.equal(page.ops.filter((entry) => entry.op === 'nav.navigate').length, 1);
  assert.equal(value.next, 'go');
  assert.notEqual(value.navigated, 'already_open');
});
// The arrival wait must name its TARGET. Without a `url` the port asks "has the address changed since I
// started" and reads that baseline through a round trip, so a navigation that commits first — an Amazon search
// commits in ~460ms, about what one op costs — can never look like a change, and the wait polls its whole
// ceiling before answering false. The navigate tool verifies its own landing afterwards, so the answer stays right; what it
// loses is the ceiling in round trips, and §13 records that op budget IS the feature budget (a quote wizard died
// on `deadline exceeded` for exactly this class of waste). `settleAfter: 0` is that race.
test('a page navigation that commits immediately does not burn the arrival ceiling', () => {
  const page = makePage({ href: SITE, settleAfter: 0, dom: {}, afterNavigate: {} });
  go(page, { url: 'http://bluemoonsoft.com/front/product' });
  assert.ok(hrefReads(page) <= 20,
    `arrival should not poll its 12000/250 ceiling — got ${hrefReads(page)} href reads`);
});
