import { isDeepStrictEqual } from 'node:util';

import {
  callInAxContext,
  classifyCommandSources,
  listCommands,
  reloadExtension,
} from '../harness/cdp.mjs';
import { waitForStoredActivation } from './runtime.mjs';

export const SITES_STATE_KEY = 'axsdk:sites';
export const FLOWS_STATE_KEY = 'axsdk:flows';
export const LUA_STATE_KEY = 'axsdk:lua';
export const WIDGETS_STATE_KEY = 'axsdk:widgets';
export const EXTENSION_CONFIG_KEY = 'axsdk:extension:config';
export const PLAYGROUND_STATE_KEY = 'axsdk:playground';

// The playground granted a `lua.operations` capability per durable command. Every one of those commands
// is gone — the flows run over RPC, where the capability is `rpc.allow` on the tool itself — so the
// profile no longer asks the host for durable state it will never use.
//
// Kept as an empty list rather than deleted: it is the shape the config writer and its canonical-storage
// assertions read, and an absent key and an empty grant are different facts about the profile.
export const PLAYGROUND_LUA_OPERATIONS = Object.freeze([]);

const STORAGE_KEYS = [
  SITES_STATE_KEY,
  FLOWS_STATE_KEY,
  LUA_STATE_KEY,
  WIDGETS_STATE_KEY,
  EXTENSION_CONFIG_KEY,
  PLAYGROUND_STATE_KEY,
];

function asRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function parseEnvelope(raw, label) {
  if (typeof raw !== 'string') throw new Error(`${label} storage entry is missing`);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} storage entry is not JSON`);
  }
}

function assertDeepEqual(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`${label} is not canonical`);
}

function normalizeSitesEnvelopeForValidation(sites, label) {
  const envelope = asRecord(sites, label);
  const state = asRecord(envelope.state, `${label}.state`);
  const index = asRecord(state.index, `${label}.state.index`);
  if (typeof index.loadedAt !== 'string' || !Number.isFinite(Date.parse(index.loadedAt))) {
    throw new Error(`${label}.state.index.loadedAt must be an ISO timestamp`);
  }
  return {
    ...envelope,
    state: {
      ...state,
      index: { ...index, loadedAt: '<runtime timestamp>' },
    },
  };
}

function assertCanonicalSitesEnvelope(actual, expected) {
  assertDeepEqual(
    normalizeSitesEnvelopeForValidation(actual, SITES_STATE_KEY),
    normalizeSitesEnvelopeForValidation(expected, SITES_STATE_KEY),
    SITES_STATE_KEY,
  );
}

function assertGeneratedLocalStub(site, domain) {
  if (!site || typeof site !== 'object' || Array.isArray(site)) {
    throw new Error(`${SITES_STATE_KEY} contains a non-local cache record for ${domain}`);
  }
  const { downloadedAt, ...contents } = site;
  const expected = {
    domain,
    sitemapMd: '',
    flowsYaml: '',
    knowledgeIndexYaml: '',
    groups: [],
    knowledge: {},
    scripts: [],
    widgets: [],
    errors: [],
  };
  if (
    !isDeepStrictEqual(contents, expected)
    || typeof downloadedAt !== 'string'
    || !Number.isFinite(Date.parse(downloadedAt))
  ) {
    throw new Error(`${SITES_STATE_KEY} contains a non-local cache record for ${domain}`);
  }
}

function validateLazyLocalSites(sites, workspace) {
  const state = asRecord(sites.state, `${SITES_STATE_KEY}.state`);
  const canonicalWithoutCache = {
    ...sites,
    state: { ...state, sites: {} },
  };
  assertCanonicalSitesEnvelope(canonicalWithoutCache, workspace.sites);

  const cachedSites = asRecord(state.sites, `${SITES_STATE_KEY}.state.sites`);
  for (const [domain, site] of Object.entries(cachedSites)) {
    if (!workspace.index.domains.includes(domain)) {
      throw new Error(`${SITES_STATE_KEY} contains a non-local cache record for ${domain}`);
    }
    assertGeneratedLocalStub(site, domain);
  }
}

function flowEnvelope(flows) {
  return { state: { flows }, version: 0 };
}

function luaEnvelope(lua) {
  return { state: { lua }, version: 0 };
}

function buildStamp(workspace, { home, writtenAt }) {
  return {
    version: 1,
    sourceDigest: workspace.sourceDigest,
    indexDigest: workspace.indexDigest,
    widgetsDigest: workspace.widgetsDigest,
    indexDomains: workspace.index.domains.length,
    layers: workspace.layers,
    home,
    writtenAt,
  };
}

/**
 * Returns the exact chrome.storage.local.set payload for one playground sync. Individual remote
 * layer toggles intentionally stay untouched: remote_sites is the single effective source policy.
 */
export function createPlaygroundStorageWrite(workspace, {
  existingConfig = {},
  home,
  writtenAt = new Date().toISOString(),
} = {}) {
  if (!home || !/^https:\/\//.test(home)) throw new Error('Playground home must be an HTTPS URL');
  const config = asRecord(existingConfig, 'Existing extension config');
  const stamp = buildStamp(workspace, { home, writtenAt });
  return {
    stamp,
    payload: {
      [SITES_STATE_KEY]: JSON.stringify(workspace.sites),
      [FLOWS_STATE_KEY]: JSON.stringify(flowEnvelope(workspace.flows)),
      [LUA_STATE_KEY]: JSON.stringify(luaEnvelope(workspace.lua)),
      [WIDGETS_STATE_KEY]: JSON.stringify(workspace.widgets),
      [EXTENSION_CONFIG_KEY]: {
        ...config,
        remote_sites: false,
        storedFlowsEnabled: true,
        luaOperations: PLAYGROUND_LUA_OPERATIONS,
      },
      [PLAYGROUND_STATE_KEY]: stamp,
    },
  };
}

function validateStorage(storage, workspace, { home, allowLazyLocalSites = false }) {
  const sites = parseEnvelope(storage[SITES_STATE_KEY], SITES_STATE_KEY);
  if (allowLazyLocalSites) {
    validateLazyLocalSites(sites, workspace);
  } else {
    assertCanonicalSitesEnvelope(sites, workspace.sites);
    if (!isDeepStrictEqual(sites?.state?.sites, {})) {
      throw new Error(`${SITES_STATE_KEY} must begin with canonical empty sites cache`);
    }
  }
  assertDeepEqual(parseEnvelope(storage[FLOWS_STATE_KEY], FLOWS_STATE_KEY), flowEnvelope(workspace.flows), FLOWS_STATE_KEY);
  assertDeepEqual(parseEnvelope(storage[LUA_STATE_KEY], LUA_STATE_KEY), luaEnvelope(workspace.lua), LUA_STATE_KEY);
  assertDeepEqual(parseEnvelope(storage[WIDGETS_STATE_KEY], WIDGETS_STATE_KEY), workspace.widgets, WIDGETS_STATE_KEY);

  const config = asRecord(storage[EXTENSION_CONFIG_KEY], EXTENSION_CONFIG_KEY);
  if (config.remote_sites !== false) throw new Error(`${EXTENSION_CONFIG_KEY}.remote_sites must be false`);
  if (config.storedFlowsEnabled !== true) throw new Error(`${EXTENSION_CONFIG_KEY}.storedFlowsEnabled must be true`);
  if (!isDeepStrictEqual(config.luaOperations, PLAYGROUND_LUA_OPERATIONS)) {
    throw new Error(`${EXTENSION_CONFIG_KEY}.luaOperations must match the Playground durable-operation allowlist`);
  }

  const expectedStamp = buildStamp(workspace, {
    home,
    writtenAt: asRecord(storage[PLAYGROUND_STATE_KEY], PLAYGROUND_STATE_KEY).writtenAt,
  });
  assertDeepEqual(storage[PLAYGROUND_STATE_KEY], expectedStamp, PLAYGROUND_STATE_KEY);
}

function validateRuntime(runtime, workspace) {
  const config = asRecord(runtime.config, 'Runtime config');
  if (config.remote_sites !== false) throw new Error('Runtime remote_sites must be false');
  if (config.remote_lua !== false) throw new Error('Runtime remote_lua must be false');
  if (config.remote_widgets !== false) throw new Error('Runtime remote_widgets must be false');
  if (config.clientFlows?.remoteSites !== false || config.clientFlows?.stored !== true) {
    throw new Error('Runtime clientFlows must be { remoteSites: false, stored: true }');
  }
  if (!isDeepStrictEqual(config.lua, {
    enabled: true,
    operations: PLAYGROUND_LUA_OPERATIONS,
  })) {
    throw new Error('Runtime Lua durable-operation grants do not match the Playground allowlist');
  }

  const index = asRecord(runtime.sitesIndex, 'Runtime sites index');
  const expectedIndex = workspace.sites.state.index;
  if (index.source !== 'local' || index.indexUrl !== '' || index.indexMd !== expectedIndex.indexMd) {
    throw new Error('Runtime local sites index does not match the workspace');
  }
  if (runtime.currentSite !== null && runtime.currentSite !== undefined) {
    throw new Error('Home runtime must not have an active site layer');
  }

  const sources = classifyCommandSources(runtime.commands || []);
  if (sources.remote.length > 0) throw new Error(`Remote command sources are active: ${sources.remote.join(', ')}`);
  if (sources.local.length > 0) throw new Error(`In-memory local command sources are active: ${sources.local.join(', ')}`);
  if (Object.keys(workspace.lua).length > 0 && sources.store.length === 0) {
    throw new Error('No stored Lua command source is active');
  }
  return sources;
}

/**
 * Validates both raw persisted state and a fresh AXSDK runtime snapshot. Sync requires an empty
 * sites cache; later status checks may opt into generated local stubs created by a site navigation.
 */
export function verifyPlaygroundSnapshot(snapshot, workspace, { home, allowLazyLocalSites = false } = {}) {
  if (!home) throw new Error('Verification requires the configured home URL');
  const storage = asRecord(snapshot.storage, 'Storage snapshot');
  validateStorage(storage, workspace, { home, allowLazyLocalSites });
  const sources = validateRuntime(asRecord(snapshot.runtime, 'Runtime snapshot'), workspace);
  return {
    indexDigest: workspace.indexDigest,
    indexDomains: workspace.index.domains.length,
    sourceDigest: workspace.sourceDigest,
    widgetsDigest: workspace.widgetsDigest,
    fromStore: sources.store.length,
    fromRemote: sources.remote.length,
    fromLocal: sources.local.length,
  };
}

export async function readPlaygroundSnapshot(session) {
  const snapshot = await callInAxContext(session.page, session.options, `async function(keys, configKey) {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      throw new Error('chrome.storage.local unavailable in this context');
    }
    const storage = await chrome.storage.local.get(keys);
    const persistedConfig = storage[configKey];
    storage[configKey] = persistedConfig && typeof persistedConfig === 'object' && !Array.isArray(persistedConfig)
      ? {
        remote_sites: persistedConfig.remote_sites,
        storedFlowsEnabled: persistedConfig.storedFlowsEnabled,
        luaOperations: persistedConfig.luaOperations,
      }
      : {};
    const sdk = globalThis._AXSDK || globalThis.AXSDK;
    const runtimeLua = sdk?.config?.lua;
    const sitesState = sdk?.getSitesStore?.().getState?.();
    return {
      storage,
      runtime: {
        config: sdk?.config ? {
          remote_sites: sdk.config.remote_sites,
          remote_lua: sdk.config.remote_lua,
          remote_widgets: sdk.config.remote_widgets,
          clientFlows: sdk.config.clientFlows ?? null,
          lua: runtimeLua === true
            ? true
            : runtimeLua && typeof runtimeLua === 'object'
              ? {
                enabled: runtimeLua.enabled === true,
                operations: Array.isArray(runtimeLua.operations)
                  ? runtimeLua.operations.map((operation) => ({
                    command: operation?.command,
                    portable: operation?.portable,
                    allowedOrigins: operation?.allowedOrigins,
                    checkpointMaxBytes: operation?.checkpointMaxBytes,
                  }))
                  : [],
              }
              : null,
        } : null,
        sitesIndex: sitesState?.index ?? null,
        currentSite: sitesState?.currentSite ? { domain: sitesState.currentSite.domain } : null,
      },
    };
  }`, [STORAGE_KEYS, EXTENSION_CONFIG_KEY]);
  snapshot.runtime.commands = await listCommands(session);
  return snapshot;
}

/**
 * Applies host-owned configuration before persisted source. A configuration change can make the
 * live content runtime rehydrate its old stores; cold-reload it first, then write local layers and
 * cold-reload again so the final runtime can only observe the new canonical source.
 */
export async function syncPlaygroundStores(session, workspace, {
  home,
  writtenAt = new Date().toISOString(),
  reload = true,
} = {}) {
  const write = createPlaygroundStorageWrite(workspace, { existingConfig: {}, home, writtenAt });
  const { [EXTENSION_CONFIG_KEY]: configPatch, ...storagePayload } = write.payload;

  const configChanged = await callInAxContext(session.page, session.options, `async function(configKey, configPatch, apply) {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      throw new Error('chrome.storage.local unavailable in this context');
    }
    const current = await chrome.storage.local.get(configKey);
    const existing = current?.[configKey];
    const config = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
    const next = { ...config, ...configPatch };
    const changed = JSON.stringify(config) !== JSON.stringify(next);
    if (changed && apply) await chrome.storage.local.set({ [configKey]: next });
    return changed;
  }`, [EXTENSION_CONFIG_KEY, configPatch, reload]);

  if (configChanged && !reload) {
    throw new Error('Playground host configuration changed; sync requires reload=true to avoid stale-store rehydration');
  }

  let freshSession = session;
  if (configChanged) {
    const reloaded = await reloadExtension(session.cdpUrl, session.options, { url: home });
    if (reloaded.page !== session.page) {
      try { session.page.close(); } catch { /* old CDP socket is already invalid after reload */ }
    }
    freshSession = { page: reloaded.page, options: session.options, cdpUrl: session.cdpUrl };
  }

  await callInAxContext(freshSession.page, freshSession.options, `async function(payload) {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      throw new Error('chrome.storage.local unavailable in this context');
    }
    await chrome.storage.local.set(payload);
    return Object.keys(payload);
  }`, [storagePayload]);

  if (reload) {
    const reloaded = await reloadExtension(freshSession.cdpUrl, freshSession.options, { url: home });
    if (reloaded.page !== freshSession.page) {
      try { freshSession.page.close(); } catch { /* old CDP socket is already invalid after reload */ }
    }
    freshSession = { page: reloaded.page, options: freshSession.options, cdpUrl: freshSession.cdpUrl };
  }

  await waitForStoredActivation(() => readPlaygroundSnapshot(freshSession), {
    expectedDomain: null,
    requireCommonLua: Object.hasOwn(workspace.lua, ':'),
  });

  const snapshot = await readPlaygroundSnapshot(freshSession);
  const receipt = verifyPlaygroundSnapshot(snapshot, workspace, { home });
  return { ...receipt, stamp: write.stamp, session: freshSession };
}
