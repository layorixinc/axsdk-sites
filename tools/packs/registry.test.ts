import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { fetchVerifiedPackRelease } from '../../../axsdk-sdk-js/packages/axsdk-extension-cdp/src/packs/registry.ts';
import { emptyPackLifecycleState } from '../../../axsdk-sdk-js/packages/axsdk-extension-cdp/src/packs/store.ts';
import {
  PACK_REGISTRY_BASE_URL,
  buildPackRegistry,
  comparePackRegistry,
  packRegistryConfig,
} from './registry.ts';

const ROOT = resolve(import.meta.dir, '../..');

function fileFetch(files: Readonly<Record<string, Uint8Array>>): typeof fetch {
  const basePath = new URL(PACK_REGISTRY_BASE_URL).pathname;
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!url.pathname.startsWith(basePath)) return new Response('outside registry', { status: 404 });
    const body = files[url.pathname.slice(basePath.length)];
    return body === undefined
      ? new Response('not found', { status: 404 })
      : new Response(body.slice(), { status: 200 });
  }) as typeof fetch;
}

async function verify(files: Readonly<Record<string, Uint8Array>>, packId: string, version: string) {
  return fetchVerifiedPackRelease({
    registry: packRegistryConfig(),
    now: () => '2026-09-03T12:00:00Z',
    fetch: fileFetch(files),
  }, { packId, version }, emptyPackLifecycleState());
}

describe('unsigned pack registry producer', () => {
  test('two builds with the same inputs are byte-identical', async () => {
    const first = await buildPackRegistry(ROOT, { indexSequence: 1 });
    const second = await buildPackRegistry(ROOT, { indexSequence: 1 });
    expect(Object.keys(second.files).sort()).toEqual(Object.keys(first.files).sort());
    for (const [path, bytes] of Object.entries(first.files)) {
      expect(Buffer.compare(Buffer.from(bytes), Buffer.from(second.files[path]!)), path).toBe(0);
    }
  });

  test('no emitted document carries a signature, and revocations exist even when empty', async () => {
    const built = await buildPackRegistry(ROOT, { indexSequence: 1 });
    const decode = (path: string) => JSON.parse(new TextDecoder().decode(built.files[path]!));
    expect(decode('index.json').signature).toBeUndefined();
    expect(decode('revocations.json')).toMatchObject({ kind: 'revocation', signed: { revocations: [] } });
    for (const path of Object.keys(built.files)) {
      if (path.startsWith('releases/')) expect(decode(path).signature).toBeUndefined();
    }
  });

  test('the SDK verifier resolves both published packs through the digest chain', async () => {
    const built = await buildPackRegistry(ROOT, { indexSequence: 1 });
    for (const entry of built.summary.releases) {
      const result = await verify(built.files, entry.packId, entry.version);
      if (!result.ok) throw new Error(`${entry.packId}: ${result.reason}: ${result.detail}`);
      expect(result.graph.keyId).toBe('user-source');
    }
    expect(built.summary.releases.map((entry) => entry.packId).sort())
      .toEqual(['example.store-x', 'layorix.shopping']);
  });

  test('a same-length tamper in a published asset answers asset_hash_mismatch', async () => {
    const built = await buildPackRegistry(ROOT, { indexSequence: 1 });
    const shopping = built.summary.releases.find((entry) => entry.packId === 'layorix.shopping')!;
    const assetPath = Object.keys(built.files)
      .find((path) => path.startsWith('assets/') && new TextDecoder().decode(built.files[path]!).includes('__AXSDK_LUA_RUN__'))!;
    const tampered = Uint8Array.from(built.files[assetPath]!);
    tampered[0] = tampered[0] === 32 ? 9 : 32;
    const result = await verify({ ...built.files, [assetPath]: tampered }, shopping.packId, shopping.version);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('asset_hash_mismatch');
  });

  test('a committed registry equal to the build reports no drift; one flipped byte is named', async () => {
    const built = await buildPackRegistry(ROOT, { indexSequence: 4 });
    const tempRoot = await mkdtemp(join(tmpdir(), 'axsdk-pack-registry-'));
    try {
      for (const [path, bytes] of Object.entries(built.files)) {
        const absolute = join(tempRoot, 'docs/packs/registry', path);
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, bytes);
      }
      expect(await comparePackRegistry(tempRoot, built.files)).toEqual([]);

      // Stale committed output: one flipped byte in any committed file is named, not tolerated.
      const indexBytes = Uint8Array.from(built.files['index.json']!);
      indexBytes[indexBytes.length - 3] ^= 1;
      await writeFile(join(tempRoot, 'docs/packs/registry', 'index.json'), indexBytes);
      const stale = await comparePackRegistry(tempRoot, built.files);
      expect(stale).toEqual(['index.json']);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('the registry config is the unsigned shape the verifier enforces', () => {
    expect(packRegistryConfig()).toEqual({
      id: 'layorix-packs',
      baseUrl: PACK_REGISTRY_BASE_URL,
      trustRoots: [],
      unsigned: true,
    });
  });
});
