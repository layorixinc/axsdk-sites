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
  assert.deepEqual(Object.keys(workspace.lua), [':', ...[...commerceSites, 'example'].sort().map((site) => `:${site}`)]);
  assert.equal(workspace.sites.state.index.source, 'local');
  assert.deepEqual(workspace.sites.state.sites, {});
  const commonLua = workspace.lua[':'];
  const amazonLua = workspace.lua[':amazon'];
  assert.match(amazonLua, /\bAX_search_product\b/);
  assert.match(commonLua, /\bAX_playground_open_site\b/);
  assert.match(commonLua, /\bAX_PLAYGROUND_DURABLE\b/);
  assert.match(commonLua, /\bAX_PLAYGROUND_COMMERCE\b/);
  assert.match(commonLua, /\bAX_PLAYGROUND_STOREFRONT\b/);
  assert.ok(
    commonLua.indexOf('_common/scripts/05_durable.lua')
      < commonLua.indexOf('_common/scripts/06_commerce_sites.lua'),
    'durable helper must load before the shared commerce map',
  );
  assert.ok(
    commonLua.indexOf('_common/scripts/06_commerce_sites.lua')
      < commonLua.indexOf('_common/scripts/15_storefront.lua'),
    'commerce map must load before the storefront search core',
  );
  assert.ok(
    commonLua.indexOf('_common/scripts/15_storefront.lua')
      < commonLua.indexOf('_common/scripts/20_open_site.lua'),
    'storefront core must load before the portable opener',
  );
  for (const site of commerceSites) {
    assert.match(workspace.lua[`:${site}`], /\bAX_search_product\b/, `${site} must expose a product search command`);
  }
  assert.match(amazonLua, /\bAX_PLAYGROUND_DURABLE\b/);
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
  // Was `execute.tool: AX_search_product` — the durable command. Three search tools that differed only
  // in the argument shape they accepted are now ONE: `clientFlows` inlines every declared module PER
  // TOOL against a 256 KiB ceiling, so a duplicated tool is a duplicated reader.
  const search = commonFlow.flowTools.playground_search_site;
  assert.equal(search.execute.kind, 'runtime');
  assert.match(search.execute.lua, /AX_RPC_PLAYGROUND_SEARCH\.search/);
  assert.deepEqual(search.parameters.required, [], 'it serves a flat caller and a worker envelope');
  assert.equal(commonFlow.flows.playground_amazon_search.nodes.run.id, 'playground_search_site');
  assert.equal(commonFlow.flows.playground_multi_site_search.nodes.search_stores.id, 'shopping_search_sites');
  assert.equal(commonFlow.flowTools.shopping_search_sites.execute.implementation, 'flow.map');
  assert.equal(commonFlow.flowTools.shopping_search_sites.execute.flow, 'playground_search_one_site');
  assert.equal(commonFlow.flowTools.shopping_search_sites.execute.concurrency, 1);
  assert.deepEqual(commonFlow.flowTools.shopping_search_sites.parameters.properties.stores.minItems, 2);
  const shoppingRoute = commonFlow.router.routes.find((route) => route.intent === 'shopping');
  assert.equal(shoppingRoute?.entry, 'shopping.collect_query');
  assert.equal(commonFlow.flows.shopping.state.site, 'amazon');
  assert.equal(commonFlow.flows.shopping.nodes.open_amazon.id, 'playground_open_site');
  assert.equal(commonFlow.flows.shopping.nodes.search_amazon.id, 'playground_search_site');
  // Was `execute.tool: AX_playground_open_site` — the durable handoff. It navigates over RPC now, and
  // accepts both the flat `site` and the worker's `item.site` so one tool serves both callers.
  assert.equal(commonFlow.flowTools.playground_open_site.execute.kind, 'runtime');
  assert.match(commonFlow.flowTools.playground_open_site.execute.lua, /AX_RPC_PLAYGROUND\.open_site/);
  assert.deepEqual(commonFlow.flowTools.playground_open_site.parameters.required, []);
});
