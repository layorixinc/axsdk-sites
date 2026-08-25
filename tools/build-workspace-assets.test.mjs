// Contract tests for the content-addressed package workspace producer.
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'build-workspace-assets.mjs');
const exec = promisify(execFile);
const RPC_DEMO_SOURCE = 'local demo = {}\r\nreturn demo\r\n';
const hash = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

async function runCli(args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [script, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function makeFixture(t, { modules = ['_common.00_base', '_common.90_rpc_demo'], rpc = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'axsdk-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '_common', 'scripts'), { recursive: true });
  await mkdir(join(root, 'exsite', 'scripts'), { recursive: true });
  await writeFile(join(root, 'index.md'), '# Sites\n\n- [exsite](https://exsite.example.com)\n');
  await writeFile(join(root, '_common', 'flows.yaml'), [
    'flowTools:',
    '  demo_tool:',
    '    description: fixture tool',
    '    execute:',
    '      kind: runtime',
    '      implementation: lua',
    `      modules: [${modules.map((name) => JSON.stringify(name)).join(', ')}]`,
    '      entry: run',
    '',
  ].join('\r\n'));
  await writeFile(join(root, '_common', 'scripts', '00_base.lua'), 'function AX_base() return 1 end\n');
  if (rpc) {
    await mkdir(join(root, '_common', 'rpc'), { recursive: true });
    await writeFile(join(root, '_common', 'rpc', '90_rpc_demo.lua'), RPC_DEMO_SOURCE);
  }
  await writeFile(join(root, 'exsite', 'flows.yaml'), 'flowTools: {}\n');
  await writeFile(join(root, 'exsite', 'scripts', '10_site.lua'), 'function AX_site() return 2 end\n');
  return root;
}

const manifestPath = (root) => join(root, 'dist', 'workspace-manifest.json');
const assetPath = (root, ref, base = join(root, 'dist')) =>
  join(base, 'workspace-assets', `${ref.slice('sha256:'.length)}.txt`);

async function builtManifest(root, args = []) {
  const build = await runCli([`--root=${root}`, ...args]);
  assert.equal(build.code, 0, `build failed: ${build.stderr}`);
  const outArg = args.find((arg) => arg.startsWith('--out='));
  const path = outArg ? outArg.slice('--out='.length) : manifestPath(root);
  return { build, path, manifest: JSON.parse(await readFile(path, 'utf8')) };
}

function allRefs(manifest) {
  return new Set([
    manifest.workspace.index,
    ...Object.values(manifest.workspace.flows),
    ...Object.values(manifest.workspace.lua),
    ...Object.values(manifest.workspace.sitemaps),
    ...Object.values(manifest.workspace.widgets),
    ...Object.values(manifest.workspace.modules).flatMap((layer) => Object.values(layer)),
  ]);
}

test('build emits a version-2 reference graph with one verified file per unique asset', async (t) => {
  const root = await makeFixture(t);
  const { build, manifest } = await builtManifest(root);

  assert.deepEqual(Object.keys(manifest).sort(), ['assets', 'digest', 'generatedAt', 'version', 'workspace']);
  assert.equal(manifest.version, 2);
  assert.match(manifest.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal('stores' in manifest, false);
  assert.deepEqual(Object.keys(manifest.workspace).sort(), ['flows', 'index', 'lua', 'modules', 'sitemaps', 'widgets']);
  assert.deepEqual(Object.keys(manifest.workspace.lua), [':'], 'site config Lua is generator input, not a runtime asset');
  const refs = allRefs(manifest);
  assert.deepEqual(new Set(Object.keys(manifest.assets)), refs);
  for (const ref of refs) {
    const source = await readFile(assetPath(root, ref), 'utf8');
    assert.equal(Buffer.byteLength(source), manifest.assets[ref].bytes);
    assert.equal(hash(source), ref);
  }
  assert.match(build.stdout, /unique assets/);
  assert.match(build.stdout, /not a persisted-store value/);
  assert.match(build.stdout, /all 2 flow-declared names carried/);
});

test('runtime modules are separate content-addressed assets preserving disk bytes', async (t) => {
  const root = await makeFixture(t);
  await writeFile(join(root, '_common', 'rpc', '91_rpc_extra.lua'), 'return { extra = 1 }\n');
  const { manifest } = await builtManifest(root);
  assert.deepEqual(Object.keys(manifest.workspace.modules[':']), [
    '_common.90_rpc_demo', '_common.91_rpc_extra', '_common.00_base',
  ]);
  const ref = manifest.workspace.modules[':']['_common.90_rpc_demo'];
  assert.equal(await readFile(assetPath(root, ref), 'utf8'), RPC_DEMO_SOURCE);
});

test('a declared script module is carried without an rpc directory', async (t) => {
  const root = await makeFixture(t, { modules: ['_common.00_base'], rpc: false });
  const { manifest } = await builtManifest(root);
  assert.deepEqual(Object.keys(manifest.workspace.modules[':']), ['_common.00_base']);
  const check = await runCli([`--root=${root}`, '--check']);
  assert.equal(check.code, 0, check.stderr);
});

test('a valid flow above the persisted 256 KiB value limit still becomes a package asset', async (t) => {
  const root = await makeFixture(t, { modules: ['_common.00_base'], rpc: false });
  await appendFile(join(root, '_common', 'flows.yaml'), `padding: ${'x'.repeat(270 * 1024)}\n`);
  const { manifest } = await builtManifest(root);
  const ref = manifest.workspace.flows[':'];
  assert.ok(manifest.assets[ref].bytes > 256 * 1024);
  assert.equal(hash(await readFile(assetPath(root, ref), 'utf8')), ref);
});

test('--check passes fresh, ignores generatedAt alone, and writes nothing', async (t) => {
  const root = await makeFixture(t);
  const { path, manifest } = await builtManifest(root);
  manifest.generatedAt = '1999-01-01T00:00:00.000Z';
  await writeFile(path, JSON.stringify(manifest, null, 2));
  const before = await readFile(path, 'utf8');
  const check = await runCli([`--root=${root}`, '--check']);
  assert.equal(check.code, 0, check.stderr);
  assert.equal(await readFile(path, 'utf8'), before);
});

test('--check fails on source drift and orphan asset files without rewriting', async (t) => {
  const root = await makeFixture(t);
  const { path } = await builtManifest(root);
  const before = await readFile(path, 'utf8');
  await appendFile(join(root, '_common', 'rpc', '90_rpc_demo.lua'), 'local drift = true\r\n');
  const sourceDrift = await runCli([`--root=${root}`, '--check']);
  assert.notEqual(sourceDrift.code, 0);
  assert.equal(await readFile(path, 'utf8'), before);

  await builtManifest(root);
  await writeFile(join(root, 'dist', 'workspace-assets', 'orphan.txt'), 'hidden');
  const orphan = await runCli([`--root=${root}`, '--check']);
  assert.notEqual(orphan.code, 0);
  assert.match(orphan.stderr, /file set drift/);
});

test('--out writes the manifest and asset directory beside it', async (t) => {
  const root = await makeFixture(t);
  const out = join(root, 'package', 'workspace-manifest.json');
  const { manifest } = await builtManifest(root, [`--out=${out}`]);
  await readFile(assetPath(root, manifest.workspace.index, dirname(out)), 'utf8');
});

test('an unresolvable declared module fails before any manifest is written', async (t) => {
  const root = await makeFixture(t, { modules: ['_common.00_base', '_common.99_missing'] });
  const build = await runCli([`--root=${root}`]);
  assert.notEqual(build.code, 0);
  assert.match(build.stderr, /_common\.99_missing/);
  await assert.rejects(readFile(manifestPath(root), 'utf8'));
});
