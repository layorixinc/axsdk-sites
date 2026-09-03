/**
 * The UNSIGNED pack registry producer (EXTERNAL_PACK_TASK_PLAN X2, decision 2026-09-03).
 *
 * Trust model: the user chose the source, transport is TLS, and every document and asset is
 * content-addressed — the same digest chain the SDK verifier enforces (`unsigned: true` registry
 * config). No signature exists anywhere in the output, and no signing key exists at all; the
 * "signing key custodian" decision gate is gone with it.
 *
 * Output layout (GitHub Pages serves `docs/` — measured X0-2: byte-exact, no redirects):
 *   docs/packs/registry/index.json
 *   docs/packs/registry/revocations.json
 *   docs/packs/registry/releases/<sha256 hex>.json
 *   docs/packs/registry/assets/<sha256 hex>
 *
 * Determinism: canonical JSON everywhere; the ONLY variable is the index/revocation sequence, which
 * `main()` derives from the committed registry — an unchanged release set keeps the committed
 * sequence, a changed one bumps it (rollback protection is sequence-monotonic in the verifier).
 * `--check` refuses stale committed output (the `62_rpc_sites.lua` lesson: a generated file whose
 * tests build in memory passes while the committed bytes drift).
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, type CanonicalJsonValue } from '../../../axsdk-sdk-js/packages/axsdk-packs/src/canonical.ts';
import type { ConfiguredPackRegistry } from '../../../axsdk-sdk-js/packages/axsdk-extension-cdp/src/packs/registry.ts';
import { buildFirstPartyPackInputs } from './first-party.ts';
import { buildServiceQuotesPackInputs } from './service-quotes.ts';

export const PACK_REGISTRY_BASE_URL = 'https://layorixinc.github.io/axsdk-sites/packs/registry/';
export const PACK_REGISTRY_DIRECTORY = 'docs/packs/registry';

export function packRegistryConfig(): ConfiguredPackRegistry {
  return { id: 'layorix-packs', baseUrl: PACK_REGISTRY_BASE_URL, trustRoots: [], unsigned: true };
}

export interface PackRegistryBuild {
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly summary: {
    readonly indexSequence: number;
    readonly releases: readonly { packId: string; version: string; releaseDigest: string }[];
  };
}

const encoder = new TextEncoder();

function document(value: unknown): Uint8Array {
  return encoder.encode(canonicalJson(value as CanonicalJsonValue));
}

export async function buildPackRegistry(
  root: string,
  { indexSequence, revocationSequence = indexSequence }: { indexSequence: number; revocationSequence?: number },
): Promise<PackRegistryBuild> {
  const built = await buildFirstPartyPackInputs(root);
  const serviceQuotes = await buildServiceQuotesPackInputs(root);
  const files: Record<string, Uint8Array> = {};
  const releases = [built.shopping, built.storeX, serviceQuotes.pack].map((pack) => ({
    packId: pack.manifest.pack.id,
    version: pack.manifest.pack.version,
    releaseDigest: pack.releaseDigest,
  }));
  for (const pack of [built.shopping, built.storeX, serviceQuotes.pack]) {
    files[`releases/${pack.releaseDigest.slice('sha256:'.length)}.json`] = document(pack.release);
  }
  for (const [ref, bytes] of Object.entries({ ...built.assets, ...serviceQuotes.assets })) {
    files[`assets/${ref.slice('sha256:'.length)}`] = Uint8Array.from(bytes);
  }
  files['index.json'] = document({
    schemaVersion: 2,
    kind: 'index',
    signed: { sequence: indexSequence, releases },
  });
  // Published even when empty: an absent file is the 404 branch, not an empty set (X0-2).
  files['revocations.json'] = document({
    schemaVersion: 2,
    kind: 'revocation',
    signed: { sequence: revocationSequence, revocations: [] },
  });
  return { files, summary: { indexSequence, releases } };
}

async function readCommitted(root: string): Promise<Record<string, Uint8Array>> {
  const base = resolve(root, PACK_REGISTRY_DIRECTORY);
  const committed: Record<string, Uint8Array> = {};
  let entries;
  try {
    entries = await readdir(base, { recursive: true, withFileTypes: true });
  } catch {
    return committed;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = join(entry.parentPath ?? entry.path, entry.name);
    const relativePath = absolute.slice(base.length + 1).replaceAll('\\', '/');
    committed[relativePath] = new Uint8Array(await readFile(absolute));
  }
  return committed;
}

function committedSequence(committed: Record<string, Uint8Array>): { sequence: number; releases: string } | undefined {
  const bytes = committed['index.json'];
  if (bytes === undefined) return undefined;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed?.signed?.sequence !== 'number') return undefined;
    return { sequence: parsed.signed.sequence, releases: canonicalJson(parsed.signed.releases ?? []) };
  } catch {
    return undefined;
  }
}

/** The sequence the NEXT build must carry: committed when unchanged, committed+1 when the set moved. */
async function nextBuild(root: string): Promise<PackRegistryBuild> {
  const committed = committedSequence(await readCommitted(root));
  const probe = await buildPackRegistry(root, { indexSequence: committed?.sequence ?? 1 });
  if (committed === undefined) return probe;
  const unchanged = canonicalJson(probe.summary.releases as unknown as CanonicalJsonValue) === committed.releases;
  return unchanged ? probe : buildPackRegistry(root, { indexSequence: committed.sequence + 1 });
}

/** Returns the paths whose committed bytes differ from the supplied build (missing or extra included). */
export async function comparePackRegistry(
  root: string,
  files: Readonly<Record<string, Uint8Array>>,
): Promise<string[]> {
  const committed = await readCommitted(root);
  const paths = new Set([...Object.keys(committed), ...Object.keys(files)]);
  const different: string[] = [];
  for (const path of [...paths].sort()) {
    const left = committed[path];
    const right = files[path];
    if (left === undefined || right === undefined
      || Buffer.compare(Buffer.from(left), Buffer.from(right)) !== 0) {
      different.push(path);
    }
  }
  return different;
}

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const check = process.argv.includes('--check');
  const built = await nextBuild(root);
  const drift = await comparePackRegistry(root, built.files);
  if (check) {
    if (drift.length > 0) {
      console.error(`pack registry is stale — rebuild with: bun tools/packs/registry.ts\n  ${drift.join('\n  ')}`);
      process.exitCode = 1;
      return;
    }
    console.log(`pack registry check ok — sequence ${built.summary.indexSequence}, ${Object.keys(built.files).length} files`);
    return;
  }
  const base = resolve(root, PACK_REGISTRY_DIRECTORY);
  await rm(base, { recursive: true, force: true });
  for (const [path, bytes] of Object.entries(built.files)) {
    const absolute = join(base, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
  }
  console.log(`pack registry -> ${PACK_REGISTRY_DIRECTORY}`);
  console.log(`  sequence ${built.summary.indexSequence}, ${Object.keys(built.files).length} files, ${built.summary.releases.length} releases (unsigned by decision 2026-09-03)`);
  for (const release of built.summary.releases) {
    console.log(`  ${release.packId}@${release.version} ${release.releaseDigest}`);
  }
}

if (import.meta.main) await main();
