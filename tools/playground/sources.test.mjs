import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';

import {
  LOCAL_SITES_INDEX_MAX_BYTES,
  loadWorkspace,
  parseLocalSitesIndex,
} from './sources.mjs';

async function withWorkspace(files, fn) {
  const root = await mkdtemp(join(tmpdir(), 'axsdk-playground-'));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const target = join(root, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
    }
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('parses hostname aliases with core-compatible link precedence', () => {
  const entries = parseLocalSitesIndex([
    '# Local sites',
    '- [Display name](https://example.com): [`example`](example)',
    '- [example](https://www.example.com/)',
    '- [admin](https://admin.example.com/): [ignored](example)',
  ].join('\n'));

  assert.deepEqual(entries, [
    { hostname: 'example.com', domain: 'example' },
    { hostname: 'www.example.com', domain: 'example' },
    { hostname: 'admin.example.com', domain: 'example' },
  ]);
});

test('rejects conflicting hostnames, playground home, invalid domains, and oversized indices', () => {
  assert.throws(
    () => parseLocalSitesIndex('- [one](https://example.com): [one](one)\n- [two](https://example.com): [two](two)'),
    /conflicting hostname/i,
  );
  assert.throws(
    () => parseLocalSitesIndex('- [home](https://axsdk.ai): [home](home)'),
    /axsdk\.ai/i,
  );
  assert.throws(
    () => parseLocalSitesIndex('- [bad](https://example.com): [bad](not/a/domain)'),
    /invalid.*domain/i,
  );
  assert.throws(
    () => parseLocalSitesIndex('x'.repeat(LOCAL_SITES_INDEX_MAX_BYTES + 1)),
    /exceeds/i,
  );
});

test('loads canonical local state and independent common/site bundles in lexical order', async () => {
  await withWorkspace({
    'index.md': [
      '- [Example](https://example.com): [`example`](example)',
      '- [Example alias](https://www.example.com): [`example`](example)',
    ].join('\n'),
    '_common/flows.yaml': 'extends: app\nflows: {}\n',
    '_common/scripts/10_second.lua': 'AX_common_order = (AX_common_order or "") .. "second"\n',
    '_common/scripts/00_first.lua': 'AX_common_order = "first"\n',
    'example/flows.yaml': 'extends: app\nflows: {}\n',
    'example/scripts/10_site.lua': 'AX_example_value = "site"\n',
    'example/scripts/00_common.lua': 'AX_example_value = "common"\n',
  }, async (root) => {
    const now = () => new Date('2026-07-16T00:00:00.000Z');
    const workspace = await loadWorkspace(root, { now });

    assert.deepEqual(workspace.index.entries, [
      { hostname: 'example.com', domain: 'example' },
      { hostname: 'www.example.com', domain: 'example' },
    ]);
    assert.deepEqual(workspace.sites, {
      state: {
        index: {
          source: 'local',
          indexUrl: '',
          indexMd: '- [Example](https://example.com): [`example`](example)\n- [Example alias](https://www.example.com): [`example`](example)',
          loadedAt: '2026-07-16T00:00:00.000Z',
          commonFlowsYaml: '',
          commonScripts: [],
          commonWidgets: [],
        },
        sites: {},
      },
      version: 0,
    });
    assert.deepEqual(Object.keys(workspace.flows), [':', ':example']);
    assert.deepEqual(Object.keys(workspace.lua), [':', ':example']);
    assert.deepEqual(workspace.widgets, { state: { widgets: {} }, version: 0 });
    assert.match(workspace.lua[':'], /_common\/scripts\/00_first\.lua/);
    assert.match(workspace.lua[':'], /_common\/scripts\/10_second\.lua/);
    assert.ok(workspace.lua[':'].indexOf('00_first.lua') < workspace.lua[':'].indexOf('10_second.lua'));
    assert.match(workspace.lua[':example'], /example\/scripts\/00_common\.lua/);
    assert.match(workspace.lua[':example'], /example\/scripts\/10_site\.lua/);
    assert.ok(!workspace.lua[':example'].includes('_common/scripts/00_first.lua'));
    assert.equal(workspace.sourceDigest, (await loadWorkspace(root, { now })).sourceDigest);
  });
});

test('rejects discovered layers that are absent from the local index and nested scripts', async () => {
  await withWorkspace({
    'index.md': '- [Example](https://example.com): [`example`](example)\n',
    '_common/flows.yaml': 'extends: app\n',
    'orphan/scripts/00_orphan.lua': 'AX_orphan = true\n',
  }, async (root) => {
    await assert.rejects(() => loadWorkspace(root), /does not appear in index/i);
  });

  await withWorkspace({
    'index.md': '- [Example](https://example.com): [`example`](example)\n',
    '_common/flows.yaml': 'extends: app\n',
    'example/scripts/nested/00_bad.lua': 'AX_bad = true\n',
  }, async (root) => {
    await assert.rejects(() => loadWorkspace(root), /nested scripts/i);
  });
});

test('loads the checked-in isolated playground fixture', async () => {
  const root = fileURLToPath(new URL('../../playground/', import.meta.url));
  const workspace = await loadWorkspace(root);

  const commerceSites = [
    'amazon',
    'walmart',
    'ebay',
    'aliexpress',
    'etsy',
    'coupang',
    'naver-shopping',
    'gmarket',
    '11st',
    'ssg',
  ];
  assert.deepEqual(workspace.index.entries, [
    { hostname: 'example.com', domain: 'example' },
    { hostname: 'search.11st.co.kr', domain: '11st' },
    { hostname: 'ko.aliexpress.com', domain: 'aliexpress' },
    { hostname: 'www.amazon.com', domain: 'amazon' },
    { hostname: 'www.coupang.com', domain: 'coupang' },
    { hostname: 'www.ebay.com', domain: 'ebay' },
    { hostname: 'www.etsy.com', domain: 'etsy' },
    { hostname: 'www.gmarket.co.kr', domain: 'gmarket' },
    { hostname: 'search.shopping.naver.com', domain: 'naver-shopping' },
    { hostname: 'www.ssg.com', domain: 'ssg' },
    { hostname: 'www.walmart.com', domain: 'walmart' },
  ]);
  assert.deepEqual(Object.keys(workspace.flows), [':', ':example']);
  // The site Lua layer is two pings now. Every site's `AX_search_product` existed to expose the durable
  // storefront, and the flows read the RPC storefront instead — so the layer that remains is exactly the
  // one the CLI uses to prove common and site Lua actually loaded.
  assert.deepEqual(Object.keys(workspace.lua), [':', ':example']);
  assert.equal(workspace.sites.state.index.source, 'local');
  assert.deepEqual(workspace.sites.state.sites, {});
  const commonLua = workspace.lua[':'];
  assert.match(commonLua, /\bAX_playground_common_ping\b/);
  assert.match(workspace.lua[':example'], /\bAX_playground_site_ping\b/);
  for (const gone of ['AX_playground_open_site', 'AX_PLAYGROUND_DURABLE', 'AX_PLAYGROUND_COMMERCE', 'AX_PLAYGROUND_STOREFRONT', 'AX_search_product']) {
    assert.doesNotMatch(commonLua, new RegExp(`\\b${gone}\\b`), `${gone} is durable and must not ship`);
  }
  const commonFlow = YAML.parse(workspace.flows[':']);
  // The entry is an in-engine hop; the remote fixture runs one node later, because a router entry's
  // remote call is executed by the extension and never consumed by the engine.
  assert.equal(
    commonFlow.router.routes.find((route) => route.intent === 'playground_amazon_search')?.entry,
    'playground_amazon_search.start',
  );
  assert.equal(commonFlow.flows.playground_amazon_search.nodes.start.next.run, 'run');
  assert.equal(commonFlow.flowTools.playground_amazon_entry.execute.kind, 'runtime');
  assert.equal(
    commonFlow.router.routes.find((route) => route.intent === 'playground_multi_site_search')?.entry,
    'playground_multi_site_search.collect',
  );
  assert.equal(commonFlow.flows.playground_amazon_search.state.query, 'wireless trackball mouse');
  // Was `execute.tool: AX_search_product` — the durable command. A runtime tool is INLINED by the flow
  // that names it and one inline action backs exactly one node, so a shared id across flows fails the
  // whole document with `inline action duplicates existing action` — measured live. One thin entry per
  // flow, all delegating to the same module.
  for (const id of ['playground_search_amazon_fixture', 'playground_search_shopping', 'playground_search_worker']) {
    const search = commonFlow.flowTools[id];
    assert.equal(search.execute.kind, 'runtime', `${id} must be runtime`);
    assert.match(search.execute.lua, /AX_RPC_PLAYGROUND_SEARCH\.search/);
    assert.deepEqual(search.parameters.required, [], 'it serves a flat caller and a worker envelope');
  }
  assert.equal(commonFlow.flows.playground_amazon_search.nodes.run.id, 'playground_search_amazon_fixture');
  // The opener hops are gone: the search navigates to its own URL, so opening the store first was a page
  // load spent for nothing — the same thing production learned when it deleted its openers.
  assert.equal(commonFlow.flows.shopping.nodes.open_amazon, undefined);
  assert.equal(commonFlow.flows.playground_multi_site_search.nodes.search_stores.id, 'shopping_search_sites');
  assert.equal(commonFlow.flowTools.shopping_search_sites.execute.implementation, 'flow.map');
  assert.equal(commonFlow.flowTools.shopping_search_sites.execute.flow, 'playground_search_one_site');
  assert.equal(commonFlow.flowTools.shopping_search_sites.execute.concurrency, 1);
  assert.deepEqual(commonFlow.flowTools.shopping_search_sites.parameters.properties.stores.minItems, 2);
  const shoppingRoute = commonFlow.router.routes.find((route) => route.intent === 'shopping');
  assert.equal(shoppingRoute?.entry, 'shopping.collect_query');
  assert.equal(commonFlow.flows.shopping.state.site, 'amazon');
  assert.equal(commonFlow.flows.shopping.nodes.search_amazon.id, 'playground_search_shopping');
  assert.equal(commonFlow.flows.shopping.nodes.collect_query.next.search, 'search_amazon');
  // The durable handoff (`AX_playground_open_site`) is gone entirely rather than ported: the search
  // navigates to its own URL, so the opener was a page load spent for nothing.
  assert.equal(commonFlow.flowTools.playground_open_site, undefined);
});
