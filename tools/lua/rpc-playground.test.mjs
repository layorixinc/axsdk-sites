import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { loadLuaModules } from './harness.mjs';
import { installRpcStub, makePage } from './rpc-stub.mjs';

// The playground was the last place durable survived, and it was not a clean split. A runtime twin
// (`rpc_storefront_search`) already sat beside three tools that still reached `AX_search_product`
// through the durable path to do the same job, and the checkpoint flow verified a durable grant that
// production no longer has. Two paths for one job is the drift this repo keeps paying for.
//
// `17_rpc_sites` for the store configs, `61_rpc_storefront` for the reader these entries delegate to.
const lua = loadLuaModules([
  'playground/_common/rpc/17_rpc_sites.lua',
  'playground/_common/rpc/61_rpc_storefront.lua',
  'playground/_common/rpc/18_rpc_playground.lua',
  'playground/_common/rpc/19_rpc_playground_search.lua',
]);
after(() => lua.close());

const call = (page, entry, args) => {
  installRpcStub(lua, page);
  return lua.call(entry === 'search' ? 'AX_RPC_PLAYGROUND_SEARCH.search' : `AX_RPC_PLAYGROUND.${entry}`, args);
};

const navigated = (page) => page.ops.filter((entry) => entry.op === 'nav.navigate').map((entry) => entry.params.url);

test('opening a site navigates to that store and reports arrival once', () => {
  // The durable command answered `navigating` and expected to be called again, because a navigation
  // destroyed its context. This one keeps its stack across the reload, so the caller gets one answer.
  const page = makePage({ href: 'https://www.google.com/', landsAt: 'https://www.amazon.com/' });
  const result = call(page, 'open_site', { site: 'amazon' });

  assert.equal(result.next, 'search');
  assert.equal(result.open_site_status, 'ready');
  assert.equal(navigated(page).length, 1, 'one navigation, not a retry loop');
  assert.match(navigated(page)[0], /amazon\.com/);
});

test('landing somewhere else is reported, not retried', () => {
  // A login wall and a canonical redirect both end here. Answering `search` for a page that is not the
  // store sends the next node to read whatever the browser happens to be showing.
  const page = makePage({ href: 'https://www.google.com/', landsAt: 'https://accounts.google.com/signin' });
  const result = call(page, 'open_site', { site: 'amazon' });

  assert.equal(result.next, 'error');
  assert.equal(result.error, 'open_site_off_target');
});

test('a site the playground does not carry refuses before it navigates', () => {
  const page = makePage({ href: 'https://www.google.com/' });
  const result = call(page, 'open_site', { site: 'nowhere-mart' });

  assert.equal(result.error, 'unsupported_site');
  assert.deepEqual(navigated(page), [], 'a refusal must not cost a navigation');
});

test('the worker envelope is read as well as the flat arguments', () => {
  // The fan-out worker receives its SELECTED FLOW STATE, so the site arrives as `item.site` and the
  // query as `context.query`. Reading only the flat keys made every store in the production fan-out
  // refuse with an empty site — the same envelope this worker uses.
  const page = makePage({ href: 'https://www.google.com/', landsAt: 'https://www.amazon.com/' });
  const result = call(page, 'open_site', { item: { site: 'amazon' }, index: 0, key: 'amazon', context: {} });

  assert.equal(result.next, 'search');
  assert.equal(result.site, 'amazon');
});

test('a search with no query refuses instead of searching for nothing', () => {
  const page = makePage({ href: 'https://www.amazon.com/' });
  const result = call(page, 'search', { site: 'amazon', context: {} });

  assert.equal(result.search_error, 'missing_query');
  assert.deepEqual(navigated(page), []);
});

test('a search that finds nothing says so and carries no empty list', () => {
  // An empty Lua table encodes as a JSON OBJECT and fails every `[array, "null"]` boundary it reaches.
  // Absent is the answer; `no_results` is the reason.
  const page = makePage({ href: 'https://www.amazon.com/', afterNavigate: {} });
  const result = call(page, 'search', { site: 'amazon', query: 'nothing at all' });

  assert.equal(result.next, 'error');
  assert.equal(result.candidates, undefined, 'no matches means no list, not an empty one');
  assert.ok(result.search_error, 'and the reason has to be nameable');
});

test('the checkpoint proves the declared op answers, and names a refusal raw', () => {
  // It replaces a durable checkpoint whose goal was "verify the host grants operation-private durable
  // state". There is none left, so it verifies the grant that took its place: a declared op answering.
  const page = makePage({ href: 'https://www.amazon.com/' });
  const ok = call(page, 'checkpoint', { label: 'flow-checkpoint' });

  assert.equal(ok.next, 'done');
  assert.equal(ok.ok, true);
  assert.equal(ok.label, 'flow-checkpoint');
  assert.match(ok.href, /amazon/);

  // `command_unresolved` (the client never registered the op) and a denial have opposite fixes, so the
  // raw reason has to survive outward rather than being flattened to a category.
  const refused = makePage({ href: 'https://www.amazon.com/', refuseOps: ['dom.get_location_href'] });
  const bad = call(refused, 'checkpoint', { label: 'flow-checkpoint' });

  assert.equal(bad.next, 'grant_required');
  assert.equal(bad.ok, false);
  assert.ok(bad.error && bad.error !== 'grant_required', `the raw reason must survive: ${bad.error}`);
});
