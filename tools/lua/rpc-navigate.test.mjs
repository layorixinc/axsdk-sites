import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { loadLuaModules } from './harness.mjs';
import { installRpcStub, makePage } from './rpc-stub.mjs';

// What is left of this module is the OPENER. The same-site page navigation it also carried existed for
// one site (bluemoonsoft), and that site was removed from the product on 2026-08-26 — so
// `AX_RPC_NAV.navigate_page` and the helpers only it used went with it rather than staying as a second
// navigation path nobody calls.
//
// The confirmation is the part worth keeping: a fired navigation is not an arrival, and answering "go"
// for a navigation that never landed sends the next node to read a page that is still the old one.

// Both modules, because the tool declares both: the opener reads each store’s home from the generated
// site data rather than keeping a second list of hosts.
const lua = loadLuaModules(['_common/rpc/62_rpc_sites.lua', '_common/rpc/66_rpc_navigate.lua']);
after(() => lua.close());

const navigated = (page) => page.ops.filter((entry) => entry.op === 'nav.navigate').map((entry) => entry.params.url);
const hrefReads = (page) => page.ops.filter((entry) => entry.op === 'dom.get_location_href').length;
test('opening a site by slug lands on its home', () => {
  // Two flows genuinely need to BE on a site before their next step: the checkout has to reach amazon's
  // cart, and the single-site shopping loop searches "whichever store is open". Deleting the opener broke
  // both — the search flows that navigate to a search URL themselves are the ones that never needed it.
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

test('opening an already-active site does not repeat a successful href read outside pcall', () => {
  // The exact artifact hit rpc_timeout on the duplicate second read: the protected probe succeeded, then
  // the expression discarded its value and called the same op again unprotected.
  const page = makePage({
    href: 'https://www.amazon.com/s?k=mouse',
    dom: {},
    afterNavigate: {},
    flakyEvery: 2,
  });
  installRpcStub(lua, page);

  const result = lua.call('AX_RPC_NAV.open_site', { site: 'amazon' });
  assert.equal(result.next, 'search');
  assert.deepEqual(navigated(page), []);
  assert.equal(hrefReads(page), 1);
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

// The single-site shopping loop searches and adds to the cart on WHATEVER STORE IS OPEN — both readers
// derive the adapter from the page, and `shopping_add_to_cart` says so in its own comment. The one thing
// that pinned the whole flow to one store was the opener's argument: flow state carried `site: amazon`,
// nothing ever updated it, so a user standing on coupang.com asking to buy something was NAVIGATED AWAY
// to amazon and shopped there. Nine of the ten published stores were unreachable from that flow.
test('with no store named, the store already open is the store', () => {
  const page = makePage({ href: 'https://www.coupang.com/np/search?q=mouse', dom: {}, afterNavigate: {} });
  installRpcStub(lua, page);
  const result = lua.call('AX_RPC_NAV.open_site', {});

  assert.equal(result.next, 'search');
  assert.equal(result.site, 'coupang');
  assert.equal(result.site_source, 'current_page');
  assert.deepEqual(navigated(page), [], 'the user is already where they asked to shop');
});

test('a named store wins over the page the user happens to be on', () => {
  const page = makePage({ href: 'https://www.coupang.com/np/search?q=mouse', dom: {}, afterNavigate: {} });
  installRpcStub(lua, page);
  const result = lua.call('AX_RPC_NAV.open_site', { site: 'ebay' });

  assert.equal(result.site, 'ebay');
  assert.equal(result.site_source, 'requested');
  assert.deepEqual(navigated(page), ['https://www.ebay.com/']);
});

test('an unpublished page with no store named falls back, and says that it did', () => {
  // A default is honest only while it is VISIBLE: the reply has to name the store it chose, or the user
  // reads amazon results for a request they never pointed anywhere.
  const page = makePage({ href: 'https://axsdk.ai/ko', dom: {}, afterNavigate: {} });
  installRpcStub(lua, page);
  const result = lua.call('AX_RPC_NAV.open_site', {});

  assert.equal(result.site, 'amazon');
  assert.equal(result.site_source, 'default');
  assert.deepEqual(navigated(page), ['https://www.amazon.com/']);
});

test('the open store is matched by host, subdomain-tolerant, from the generated site data', () => {
  for (const [href, site] of [
    ['https://www.11st.co.kr/products/1', '11st'],
    ['https://search.11st.co.kr/pc/total-search?kwd=x', '11st'],
    ['https://www.ebay.com/itm/123', 'ebay'],
    ['https://ko.aliexpress.com/item/1.html', 'aliexpress'],
    ['https://shopping.naver.com/', 'naver-shopping'],
  ]) {
    const page = makePage({ href, dom: {}, afterNavigate: {} });
    installRpcStub(lua, page);
    const result = lua.call('AX_RPC_NAV.open_site', {});
    assert.equal(result.site, site, `${href} -> ${result.site}`);
    assert.equal(result.site_source, 'current_page');
    assert.deepEqual(navigated(page), [], `${site} was already open`);
  }
});

test('a site the caller named that nobody published is still refused by name', () => {
  // The fallback must not swallow a caller mistake: an unknown slug is a bug, not "use amazon".
  const page = makePage({ href: 'https://www.coupang.com/', dom: {}, afterNavigate: {} });
  installRpcStub(lua, page);
  const result = lua.call('AX_RPC_NAV.open_site', { site: 'nowhere' });

  assert.equal(result.next, 'error');
  assert.equal(result.error, 'unknown_site');
  assert.deepEqual(navigated(page), []);
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
  ]) {
    assert.equal(sites.call('__home', slug), expected, slug);
  }
  sites.close();
});
