import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

import { createExternalPackConfiguration } from '../../../axsdk-sdk-js/packages/axsdk-extension-cdp/src/packs/external.ts';
import { packExternalDefines } from '../../../axsdk-sdk-js/packages/axsdk-extension-cdp/scripts/pack-external-vite.ts';
import { PACK_REGISTRY_BASE_URL, packRegistryConfig } from './registry.ts';

const CONFIG_PATH = resolve(import.meta.dir, '../scenarios/pack-external.config.json');

/**
 * X6: the external-build configuration the live gate hands to `bun run build`. Pinned here so the
 * gate can never drift from the published registry: the SAME validator the build runs accepts it,
 * and the registry entry is byte-coherent with `packRegistryConfig()` — one source of truth for the
 * unsigned trust shape.
 */
describe('external live-gate build configuration', () => {
  test('the build validator accepts the gate config and emits our registry + executor', async () => {
    const defines = packExternalDefines({
      AXSDK_PACK_EXTERNAL: '1',
      AXSDK_PACK_EXTERNAL_CONFIG: CONFIG_PATH,
    });
    expect(defines.__AXSDK_PACK_EXTERNAL__).toBe('true');
    const config = JSON.parse(defines.__AXSDK_PACK_EXTERNAL_CONFIG__!);
    // BOTH validators must accept it: the build-time one AND the runtime parser the service worker runs
    // at module load — their drift cost a day: the built SW threw "missing schemaVersion" at fresh-
    // profile registration while the build validator passed, and the ONLY symptom was a silent,
    // never-registered service worker (chrome_debug.log carried the real sentence).
    expect(() => createExternalPackConfiguration(config)).not.toThrow();
    expect(config.executorUrl).toBe('https://layorixinc.github.io/axsdk-sites/pack-executor.html');
    expect(config.registries).toHaveLength(1);
    expect(config.registries[0]).toEqual({
      id: packRegistryConfig().id,
      baseUrl: PACK_REGISTRY_BASE_URL,
      trustRoots: [],
      unsigned: true,
    });
  });
});
