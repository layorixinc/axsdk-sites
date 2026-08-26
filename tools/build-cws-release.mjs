import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createReleaseManifest, verifyReleaseManifest, writeReleaseManifest } from './cws-release.mjs';
import { fetchPackage } from './rpc-package.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const archiveModulePath = resolve(repoRoot, '..', 'axsdk-sdk-js', 'packages', 'axsdk-extension-cdp', 'scripts', 'cws-archive.mjs');

export async function readBackendRelease({ baseUrl, appId, apiKey, fetchImpl = fetch }) {
  if (!baseUrl || !appId || !apiKey) throw new Error('CWS release verification requires backend URL, app id, and API key');
  const remote = await fetchPackage({
    baseUrl,
    appId,
    headers: {
      'x-api-key': apiKey,
      'x-app-id': appId,
      'x-app-user-id': 'axsdk-sites-cws-release',
      'x-app-user-name': 'CWS release verifier',
      origin: 'http://localhost:3334',
    },
    fetchImpl,
  });
  return { appId, revision: remote.revision, hash: remote.hash };
}

/**
 * Fields the Chrome Web Store refuses in an uploaded manifest.
 *
 * `key` pins the extension id when a directory is loaded UNPACKED, which is how the dev harness keeps one
 * profile and one id across builds — so the developer copy must keep it. The store derives the id from its
 * own key pair and refuses the upload outright (measured 2026-08-26 on the console: "key 입력란은
 * 매니페스트에 허용되지 않습니다"). `update_url` names an update server the store owns, and
 * `differential_fingerprint` is written by the store's own packager.
 */
const UPLOAD_FORBIDDEN_MANIFEST_FIELDS = ['key', 'update_url', 'differential_fingerprint'];

async function writeUploadManifest(stagedDist) {
  const path = join(stagedDist, 'manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  const removed = UPLOAD_FORBIDDEN_MANIFEST_FIELDS.filter((field) => field in manifest);
  if (removed.length === 0) return removed;
  for (const field of removed) delete manifest[field];
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return removed;
}

/**
 * Builds in a temporary directory and publishes only after the archive extracted from its own bytes
 * re-verifies. A backend mismatch therefore leaves the last approved artifact untouched.
 */
export async function buildCwsRelease({ distDir, archivePath, backend, archiveApi }) {
  const api = archiveApi ?? await import(pathToFileURL(archiveModulePath).href);
  const stagingRoot = await mkdtemp(join(tmpdir(), 'axsdk-cws-release-'));
  try {
    const stagedDist = join(stagingRoot, 'extension');
    const stagedArchive = join(stagingRoot, 'extension.zip');
    const extracted = join(stagingRoot, 'extracted');
    await cp(distDir, stagedDist, { recursive: true });
    // Before any evidence is computed, so the release manifest hashes the bytes the store receives.
    const removedFields = await writeUploadManifest(stagedDist);

    // Validate drift before producing any archive bytes, then write exactly that evidence into staging.
    await createReleaseManifest({ distDir: stagedDist, backend });
    const manifest = await writeReleaseManifest({ distDir: stagedDist, backend });
    const created = await api.createCwsArchive({ distDir: stagedDist, archivePath: stagedArchive });
    await api.extractCwsArchive({ archivePath: stagedArchive, outDir: extracted });
    const extractedManifest = JSON.parse(await readFile(join(extracted, 'release-manifest.json'), 'utf8'));
    await verifyReleaseManifest({ distDir: extracted, manifest: extractedManifest, backend });
    if (extractedManifest.releaseId !== manifest.releaseId) throw new Error('extracted release id does not match staging');
    // The archive is what gets uploaded, so the refusal is read off the extracted bytes, not off intent.
    const uploaded = JSON.parse(await readFile(join(extracted, 'manifest.json'), 'utf8'));
    const forbidden = UPLOAD_FORBIDDEN_MANIFEST_FIELDS.filter((field) => field in uploaded);
    if (forbidden.length > 0) throw new Error(`CWS archive manifest declares fields the store refuses: ${forbidden.join(', ')}`);

    const archiveBytes = await readFile(stagedArchive);
    await mkdir(dirname(archivePath), { recursive: true });
    await writeFile(archivePath, archiveBytes);
    await writeFile(`${archivePath}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
    const published = await api.inspectCwsArchive({ archivePath });
    if (published.digest !== created.digest) throw new Error('published CWS archive differs from verified staging bytes');
    return { manifest, archive: published, removedFields };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { readFileSync } = await import('node:fs');
  const { parseEnvFile } = await import('./playground/credentials.mjs');
  const env = { ...parseEnvFile(readFileSync(join(repoRoot, '.env'), 'utf8')), ...process.env };
  const distFlag = process.argv.find((arg) => arg.startsWith('--dist='));
  const outFlag = process.argv.find((arg) => arg.startsWith('--out='));
  const appFlag = process.argv.find((arg) => arg.startsWith('--app='));
  const distDir = resolve(repoRoot, distFlag?.slice('--dist='.length)
    ?? '../axsdk-sdk-js/packages/axsdk-extension-cdp/dist');
  const archivePath = resolve(repoRoot, outFlag?.slice('--out='.length)
    ?? 'dist/axsdk-extension-cdp-cws.zip');
  const appId = appFlag?.slice('--app='.length) ?? env.AXSDK_APP_ID;
  if (appId !== env.AXSDK_APP_ID) throw new Error('CWS release must verify the production app id');

  const backend = await readBackendRelease({
    baseUrl: env.AXSDK_BASE_URL,
    appId,
    apiKey: env.AXSDK_API_KEY,
  });
  const release = await buildCwsRelease({ distDir, archivePath, backend });
  console.log(`CWS RELEASE ${release.manifest.releaseId}`);
  console.log(`  backend ${backend.appId} revision ${backend.revision}`);
  console.log(`  archive ${archivePath} ${release.archive.digest} ${(release.archive.size / 1024 / 1024).toFixed(2)} MiB`);
  console.log(`  entries ${release.archive.entries.length} · runtime modules ${release.manifest.runtime.moduleCount}`);
}
