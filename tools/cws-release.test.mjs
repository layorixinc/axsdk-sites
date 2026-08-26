import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { buildCwsRelease } from './build-cws-release.mjs';
import { packageHash } from './rpc-package.mjs';
import { createReleaseManifest, verifyReleaseManifest } from './cws-release.mjs';

const hash = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'axsdk-cws-release-'));
  const distDir = join(root, 'dist');
  await mkdir(join(distDir, 'workspace-assets'), { recursive: true });
  await writeFile(join(distDir, 'manifest.json'), JSON.stringify({ manifest_version: 3, version: '0.1.0' }));
  await writeFile(join(distDir, 'service-worker.js'), 'console.log("release");\n');

  const source = {
    index: '# Sites\n- [demo](https://demo.example.com)\n',
    flow: 'flowTools:\n  demo:\n    execute:\n      modules: ["_common.demo"]\n',
    module: 'return { release = true }\n',
  };
  const ref = Object.fromEntries(Object.entries(source).map(([key, text]) => [key, hash(text)]));
  const workspace = {
    index: ref.index,
    flows: { ':': ref.flow },
    lua: {},
    modules: { ':': { '_common.demo': ref.module } },
    sitemaps: {},
    widgets: {},
  };
  const manifest = {
    version: 2,
    digest: hash(stable(workspace)),
    generatedAt: '2026-08-18T00:00:00.000Z',
    assets: Object.fromEntries(Object.entries(source).map(([key, text]) => [ref[key], { bytes: Buffer.byteLength(text) }])),
    workspace,
  };
  await writeFile(join(distDir, 'workspace-manifest.json'), `${JSON.stringify(manifest)}\n`);
  for (const [key, text] of Object.entries(source)) {
    await writeFile(join(distDir, 'workspace-assets', `${ref[key].slice(7)}.txt`), text);
  }

  const backend = {
    appId: 'browser-extension',
    revision: 42,
    hash: { luaModules: { '_common.demo': packageHash(source.module) } },
  };
  return { root, distDir, backend, manifest, ref };
}

test('the release manifest binds extension files, workspace assets, and backend modules', async () => {
  const { distDir, backend, manifest: workspace } = await fixture();
  const manifest = await createReleaseManifest({ distDir, backend });

  assert.equal(manifest.version, 1);
  assert.equal(manifest.extension.version, '0.1.0');
  assert.equal(manifest.workspace.digest, workspace.digest);
  assert.equal(Object.keys(manifest.workspace.assets).length, 3);
  assert.equal(manifest.runtime.moduleCount, 1);
  assert.equal(manifest.backend.appId, 'browser-extension');
  assert.equal(manifest.backend.revision, 42);
  assert.match(manifest.releaseId, /^sha256:[0-9a-f]{64}$/);
  await verifyReleaseManifest({ distDir, manifest, backend });
});

test('a stale backend module blocks manifest creation', async () => {
  const { distDir, backend } = await fixture();
  backend.hash.luaModules['_common.demo'] = packageHash('return { stale = true }\n');
  await assert.rejects(createReleaseManifest({ distDir, backend }), /backend module drift.*_common\.demo/i);
});

test('a changed extension file invalidates an existing manifest', async () => {
  const { distDir, backend } = await fixture();
  const manifest = await createReleaseManifest({ distDir, backend });
  await writeFile(join(distDir, 'release-manifest.json'), `${JSON.stringify(manifest)}\n`);
  await writeFile(join(distDir, 'service-worker.js'), 'console.log("changed");\n');
  await assert.rejects(verifyReleaseManifest({ distDir, manifest, backend }), /release manifest drift/i);
});

test('a changed package asset is rejected before release evidence can be regenerated', async () => {
  const { distDir, backend, ref } = await fixture();
  const manifest = await createReleaseManifest({ distDir, backend });
  await writeFile(join(distDir, 'workspace-assets', `${ref.flow.slice(7)}.txt`), 'tampered');
  await assert.rejects(verifyReleaseManifest({ distDir, manifest, backend }), /failed content verification/i);
});

const archiveModulePath = resolve(
  fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'axsdk-sdk-js', 'packages',
  'axsdk-extension-cdp', 'scripts', 'cws-archive.mjs',
);

test('the published archive is the staging archive that re-verified after extraction', {
  skip: !existsSync(archiveModulePath),
}, async () => {
  const { root, distDir, backend } = await fixture();
  const archivePath = join(root, 'release.zip');
  const archiveApi = await import(pathToFileURL(archiveModulePath).href);
  const release = await buildCwsRelease({ distDir, archivePath, backend, archiveApi });

  assert.equal(release.manifest.releaseId, JSON.parse(await readFile(`${archivePath}.manifest.json`, 'utf8')).releaseId);
  assert.ok(release.archive.entries.includes('release-manifest.json'));
  assert.ok(release.archive.entries.some((entry) => entry.startsWith('workspace-assets/')));
  assert.deepEqual((await archiveApi.inspectCwsArchive({ archivePath })).entries, release.archive.entries);
});

test('the uploaded manifest carries no field the Chrome Web Store refuses', {
  skip: !existsSync(archiveModulePath),
}, async () => {
  // Measured 2026-08-26 on the real console: an upload whose manifest declares `key` is refused with
  // "key 입력란은 매니페스트에 허용되지 않습니다". The docs' advice to paste the item's public key into
  // `key` is for loading UNPACKED during development, and our dev harness pins its extension id that
  // way — so the developer copy keeps the field and only the uploaded copy may not have it.
  const { root, distDir, backend } = await fixture();
  const developer = { manifest_version: 3, version: '0.1.0', key: 'A'.repeat(392), update_url: 'https://clients2.google.com/service/update2/crx' };
  await writeFile(join(distDir, 'manifest.json'), `${JSON.stringify(developer, null, 2)}\n`);
  const archivePath = join(root, 'release.zip');
  const archiveApi = await import(pathToFileURL(archiveModulePath).href);
  await buildCwsRelease({ distDir, archivePath, backend, archiveApi });

  const extracted = join(root, 'inspect');
  await archiveApi.extractCwsArchive({ archivePath, outDir: extracted });
  const uploaded = JSON.parse(await readFile(join(extracted, 'manifest.json'), 'utf8'));
  assert.equal('key' in uploaded, false);
  assert.equal('update_url' in uploaded, false);
  assert.equal(uploaded.manifest_version, 3);
  assert.equal(uploaded.version, '0.1.0');

  const source = JSON.parse(await readFile(join(distDir, 'manifest.json'), 'utf8'));
  assert.equal(source.key, developer.key, 'the developer copy keeps the id-pinning key');
});

test('the release manifest hashes the manifest the store receives, not the developer copy', {
  skip: !existsSync(archiveModulePath),
}, async () => {
  const { root, distDir, backend } = await fixture();
  const developer = { manifest_version: 3, version: '0.1.0', key: 'B'.repeat(392) };
  await writeFile(join(distDir, 'manifest.json'), `${JSON.stringify(developer, null, 2)}\n`);
  const archivePath = join(root, 'release.zip');
  const archiveApi = await import(pathToFileURL(archiveModulePath).href);
  const release = await buildCwsRelease({ distDir, archivePath, backend, archiveApi });

  const extracted = join(root, 'inspect');
  await archiveApi.extractCwsArchive({ archivePath, outDir: extracted });
  const uploadedBytes = await readFile(join(extracted, 'manifest.json'));
  assert.equal(release.manifest.extension.files['manifest.json'], hash(uploadedBytes));
  assert.notEqual(release.manifest.extension.files['manifest.json'], hash(await readFile(join(distDir, 'manifest.json'))));
});

test('backend drift leaves a previously approved archive untouched', async () => {
  const { root, distDir, backend } = await fixture();
  const archivePath = join(root, 'release.zip');
  const approved = Buffer.from('previous approved archive');
  await writeFile(archivePath, approved);
  backend.hash.luaModules['_common.demo'] = packageHash('stale');
  let archiveCalled = false;

  await assert.rejects(buildCwsRelease({
    distDir,
    archivePath,
    backend,
    archiveApi: { createCwsArchive: async () => { archiveCalled = true; } },
  }), /backend module drift/i);
  assert.equal(archiveCalled, false);
  assert.deepEqual(await readFile(archivePath), approved);
});
