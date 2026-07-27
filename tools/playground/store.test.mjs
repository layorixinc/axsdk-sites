import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  EXTENSION_CONFIG_KEY,
  FLOWS_STATE_KEY,
  LUA_STATE_KEY,
  PLAYGROUND_STATE_KEY,
  SITES_STATE_KEY,
  WIDGETS_STATE_KEY,
  PLAYGROUND_LUA_OPERATIONS,
  createPlaygroundStorageWrite,
  verifyPlaygroundSnapshot,
} from './store.mjs';
import { loadWorkspace } from './sources.mjs';

function workspace() {
  const sites = {
    state: {
      index: {
        source: 'local',
        indexUrl: '',
        indexMd: '- [Example](https://example.com): [`example`](example)\n',
        loadedAt: '2026-07-16T00:00:00.000Z',
        commonFlowsYaml: '',
        commonScripts: [],
        commonWidgets: [],
      },
      sites: {},
    },
    version: 0,
  };
  const flows = { ':': 'extends: app\n', ':example': 'extends: app\n' };
  const lua = { ':': 'function AX_common() return {} end\n', ':example': 'function AX_example() return {} end\n' };
  const widgets = { state: { widgets: {} }, version: 0 };
  return {
    sites,
    flows,
    lua,
    widgets,
    index: { raw: sites.state.index.indexMd, entries: [{ hostname: 'example.com', domain: 'example' }], domains: ['example'] },
    indexDigest: 'index-digest',
    widgetsDigest: 'widgets-digest',
    sourceDigest: 'source-digest',
    layers: {
      ':': { flowsDigest: 'common-flow', luaDigest: 'common-lua' },
      ':example': { flowsDigest: 'site-flow', luaDigest: 'site-lua' },
    },
  };
}

test('creates one canonical local-source write while preserving unrelated extension configuration', () => {
  const source = workspace();
  const write = createPlaygroundStorageWrite(source, {
    existingConfig: {
      remote_sites: true,
      remoteLuaEnabled: true,
      remoteSiteFlowsEnabled: true,
      remoteWidgetsEnabled: true,
      storedFlowsEnabled: false,
      debug: true,
    },
    home: 'https://axsdk.ai/',
    writtenAt: '2026-07-16T00:01:00.000Z',
  });

  assert.deepEqual(Object.keys(write.payload).sort(), [
    EXTENSION_CONFIG_KEY,
    FLOWS_STATE_KEY,
    LUA_STATE_KEY,
    PLAYGROUND_STATE_KEY,
    SITES_STATE_KEY,
    WIDGETS_STATE_KEY,
  ].sort());
  assert.deepEqual(JSON.parse(write.payload[SITES_STATE_KEY]), source.sites);
  assert.deepEqual(JSON.parse(write.payload[FLOWS_STATE_KEY]), { state: { flows: source.flows }, version: 0 });
  assert.deepEqual(JSON.parse(write.payload[LUA_STATE_KEY]), { state: { lua: source.lua }, version: 0 });
  assert.deepEqual(JSON.parse(write.payload[WIDGETS_STATE_KEY]), source.widgets);
  assert.deepEqual(write.payload[EXTENSION_CONFIG_KEY], {
    remote_sites: false,
    remoteLuaEnabled: true,
    remoteSiteFlowsEnabled: true,
    remoteWidgetsEnabled: true,
    storedFlowsEnabled: true,
    debug: true,
    luaOperations: PLAYGROUND_LUA_OPERATIONS,
  });
  assert.deepEqual(write.stamp, {
    version: 1,
    sourceDigest: 'source-digest',
    indexDigest: 'index-digest',
    widgetsDigest: 'widgets-digest',
    indexDomains: 1,
    layers: source.layers,
    home: 'https://axsdk.ai/',
    writtenAt: '2026-07-16T00:01:00.000Z',
  });
});

test('grants portable cross-origin handoff to every mapped commerce search origin', () => {
  const opener = PLAYGROUND_LUA_OPERATIONS.find((operation) => operation.command === 'AX_playground_open_site');
  assert.deepEqual(opener, {
    command: 'AX_playground_open_site',
    portable: true,
    allowedOrigins: [
      'https://search.11st.co.kr',
      'https://ko.aliexpress.com',
      'https://www.amazon.com',
      'https://www.coupang.com',
      'https://www.ebay.com',
      'https://www.etsy.com',
      'https://www.gmarket.co.kr',
      'https://search.shopping.naver.com',
      'https://www.ssg.com',
      'https://www.walmart.com',
    ],
    checkpointMaxBytes: 8 * 1024,
  });
  assert.equal(
    PLAYGROUND_LUA_OPERATIONS.find((operation) => operation.command === 'AX_search_product')?.portable,
    undefined,
  );
});

test('verifies canonical storage and effective runtime source policy', () => {
  const source = workspace();
  const write = createPlaygroundStorageWrite(source, {
    existingConfig: {},
    home: 'https://axsdk.ai/',
    writtenAt: '2026-07-16T00:01:00.000Z',
  });
  const receipt = verifyPlaygroundSnapshot({
    storage: write.payload,
    runtime: {
      config: {
        remote_sites: false,
        remote_lua: false,
        remote_widgets: false,
        clientFlows: { remoteSites: false, stored: true },
        lua: {
          enabled: true,
          operations: PLAYGROUND_LUA_OPERATIONS,
        },
      },
      sitesIndex: source.sites.state.index,
      currentSite: null,
      commands: [
        { command: 'AX_common', scriptId: 'stored-lua:' },
        { command: 'AX_default', scriptId: 'axsdk-default-form-tools' },
      ],
    },
  }, source, { home: 'https://axsdk.ai/' });

  assert.deepEqual(receipt, {
    indexDigest: 'index-digest',
    indexDomains: 1,
    sourceDigest: 'source-digest',
    widgetsDigest: 'widgets-digest',
    fromStore: 1,
    fromRemote: 0,
    fromLocal: 0,
  });
});

test('accepts only generated local stubs after a site navigation', () => {
  const source = workspace();
  const write = createPlaygroundStorageWrite(source, {
    existingConfig: {},
    home: 'https://axsdk.ai/',
    writtenAt: '2026-07-16T00:01:00.000Z',
  });
  const sites = JSON.parse(write.payload[SITES_STATE_KEY]);
  sites.state.sites.example = {
    domain: 'example',
    sitemapMd: '',
    flowsYaml: '',
    knowledgeIndexYaml: '',
    groups: [],
    knowledge: {},
    scripts: [],
    widgets: [],
    downloadedAt: '2026-07-16T00:02:00.000Z',
    errors: [],
  };
  sites.state.index.loadedAt = '2026-07-16T00:03:00.000Z';

  const receipt = verifyPlaygroundSnapshot({
    storage: { ...write.payload, [SITES_STATE_KEY]: JSON.stringify(sites) },
    runtime: {
      config: {
        remote_sites: false,
        remote_lua: false,
        remote_widgets: false,
        clientFlows: { remoteSites: false, stored: true },
        lua: {
          enabled: true,
          operations: PLAYGROUND_LUA_OPERATIONS,
        },
      },
      sitesIndex: source.sites.state.index,
      currentSite: null,
      commands: [{ command: 'AX_common', scriptId: 'stored-lua:' }],
    },
  }, source, { home: 'https://axsdk.ai/', allowLazyLocalSites: true });
  assert.equal(receipt.fromStore, 1);

  sites.state.sites.example.scripts = [{ source: 'not a generated local stub' }];
  assert.throws(
    () => verifyPlaygroundSnapshot({
      storage: { ...write.payload, [SITES_STATE_KEY]: JSON.stringify(sites) },
      runtime: {
        config: {
          remote_sites: false,
          remote_lua: false,
          remote_widgets: false,
          clientFlows: { remoteSites: false, stored: true },
          lua: {
            enabled: true,
            operations: PLAYGROUND_LUA_OPERATIONS,
          },
        },
        sitesIndex: source.sites.state.index,
        currentSite: null,
        commands: [{ command: 'AX_common', scriptId: 'stored-lua:' }],
      },
    }, source, { home: 'https://axsdk.ai/', allowLazyLocalSites: true }),
    /non-local cache/i,
  );
});

test('accepts the checked-in fixture after its lazy site cache persists', async () => {
  const root = fileURLToPath(new URL('../../playground/', import.meta.url));
  const workspace = await loadWorkspace(root, {
    now: () => new Date('2026-07-16T00:10:00.000Z'),
  });
  const write = createPlaygroundStorageWrite(workspace, {
    existingConfig: {},
    home: 'https://axsdk.ai/',
    writtenAt: '2026-07-16T00:10:00.000Z',
  });
  const sites = JSON.parse(write.payload[SITES_STATE_KEY]);
  sites.state.index.loadedAt = '2026-07-16T00:01:00.000Z';
  sites.state.sites.example = {
    domain: 'example',
    sitemapMd: '',
    flowsYaml: '',
    knowledgeIndexYaml: '',
    groups: [],
    knowledge: {},
    scripts: [],
    widgets: [],
    downloadedAt: '2026-07-16T00:02:00.000Z',
    errors: [],
  };

  assert.doesNotThrow(() => verifyPlaygroundSnapshot({
    storage: { ...write.payload, [SITES_STATE_KEY]: JSON.stringify(sites) },
    runtime: {
      config: {
        remote_sites: false,
        remote_lua: false,
        remote_widgets: false,
        clientFlows: { remoteSites: false, stored: true },
        lua: {
          enabled: true,
          operations: PLAYGROUND_LUA_OPERATIONS,
        },
      },
      sitesIndex: sites.state.index,
      currentSite: null,
      commands: [{ command: 'AX_playground_common_ping', scriptId: 'stored-lua:' }],
    },
  }, workspace, { home: 'https://axsdk.ai/', allowLazyLocalSites: true }));
});

test('rejects stale cache, mismatched runtime policy, and remote command sources', () => {
  const source = workspace();
  const write = createPlaygroundStorageWrite(source, {
    existingConfig: {},
    home: 'https://axsdk.ai/',
    writtenAt: '2026-07-16T00:01:00.000Z',
  });

  const staleStorage = {
    ...write.payload,
    [SITES_STATE_KEY]: JSON.stringify({
      ...source.sites,
      state: { ...source.sites.state, sites: { example: { domain: 'example' } } },
    }),
  };
  assert.throws(
    () => verifyPlaygroundSnapshot({ storage: staleStorage, runtime: {} }, source, { home: 'https://axsdk.ai/' }),
    /canonical/i,
  );

  assert.throws(
    () => verifyPlaygroundSnapshot({
      storage: write.payload,
      runtime: {
        config: {
          remote_sites: false,
          remote_lua: true,
          remote_widgets: false,
          clientFlows: { remoteSites: false, stored: true },
          lua: {
            enabled: true,
            operations: PLAYGROUND_LUA_OPERATIONS,
          },
        },
        sitesIndex: source.sites.state.index,
        currentSite: null,
        commands: [],
      },
    }, source, { home: 'https://axsdk.ai/' }), /remote_lua/i);

  assert.throws(
    () => verifyPlaygroundSnapshot({
      storage: write.payload,
      runtime: {
        config: {
          remote_sites: false,
          remote_lua: false,
          remote_widgets: false,
          clientFlows: { remoteSites: false, stored: true },
          lua: {
            enabled: true,
            operations: PLAYGROUND_LUA_OPERATIONS,
          },
        },
        sitesIndex: source.sites.state.index,
        currentSite: null,
        commands: [{ command: 'AX_remote', scriptId: 'example/scripts/remote.lua' }],
      },
    }, source, { home: 'https://axsdk.ai/' }), /remote command/i);
});
