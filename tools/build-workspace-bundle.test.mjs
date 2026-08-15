// Tests for tools/build-workspace-bundle.mjs — the M1 artifact builder.
//
// Everything runs against a throwaway fixture workspace built on disk per test, never the real repo
// tree: a test that reads the repo goes green whenever the repo happens to be healthy, which is the
// wrong reason. The CLI is exercised as a child process because exit codes ARE the contract
// (`--check` non-zero on drift is what CI consumes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'build-workspace-bundle.mjs');
const exec = promisify(execFile);

const STORE_KEYS = ['axsdk:sites', 'axsdk:flows', 'axsdk:lua', 'axsdk:widgets'];
const MODULES_KEY = 'axsdk:lua-modules';

/** The fixture rpc module — CRLF on purpose: carried sources must be the disk bytes, untouched. */
const RPC_DEMO_SOURCE = 'local demo = {}\r\nreturn demo\r\n';

/** Run the CLI; never throws — the exit code is an assertion target, not an accident. */
async function runCli(args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [script, ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/**
 * A minimal but real workspace: an index naming one site, a common flows document whose flowTool
 * declares one scripts/ module and one rpc/ module, and a site layer. `_common/flows.yaml` is
 * written CRLF because the real one is CRLF — a parser that trips on that trips in production.
 */
async function makeFixture(t, { modules = ['_common.00_base', '_common.90_rpc_demo'], rpc = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'axsdk-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await mkdir(join(root, '_common', 'scripts'), { recursive: true });
  await mkdir(join(root, 'exsite', 'scripts'), { recursive: true });

  await writeFile(join(root, 'index.md'), '# Sites\n\n- [exsite](https://exsite.example.com)\n');
  const flowsYaml = [
    'flowTools:',
    '  demo_tool:',
    '    description: fixture tool',
    '    execute:',
    '      kind: runtime',
    '      implementation: lua',
    `      modules: [${modules.map((name) => JSON.stringify(name)).join(', ')}]`,
    '      entry: run',
    '',
  ].join('\r\n');
  await writeFile(join(root, '_common', 'flows.yaml'), flowsYaml);
  await writeFile(join(root, '_common', 'scripts', '00_base.lua'), 'function AX_base() return 1 end\n');
  if (rpc) {
    await mkdir(join(root, '_common', 'rpc'), { recursive: true });
    await writeFile(join(root, '_common', 'rpc', '90_rpc_demo.lua'), RPC_DEMO_SOURCE);
  }
  await writeFile(join(root, 'exsite', 'flows.yaml'), 'flowTools: {}\n');
  await writeFile(join(root, 'exsite', 'scripts', '10_site.lua'), 'function AX_site() return 2 end\n');
  return root;
}

const artifactPath = (root) => join(root, 'dist', 'workspace-bundle.json');

test('build emits a version-1 bundle whose stores are envelope strings', async (t) => {
  const root = await makeFixture(t);
  const build = await runCli([`--root=${root}`]);
  assert.equal(build.code, 0, `build failed: ${build.stderr}`);

  const bundle = JSON.parse(await readFile(artifactPath(root), 'utf-8'));
  assert.deepEqual(Object.keys(bundle).sort(), ['digest', 'generatedAt', 'stores', 'version']);
  assert.equal(bundle.version, 1);
  assert.match(bundle.digest, /^[0-9a-f]{12}$/);
  assert.ok(Number.isFinite(Date.parse(bundle.generatedAt)), `generatedAt not a date: ${bundle.generatedAt}`);

  assert.deepEqual(Object.keys(bundle.stores).sort(), [...STORE_KEYS, MODULES_KEY].sort());
  for (const key of [...STORE_KEYS, MODULES_KEY]) {
    assert.equal(typeof bundle.stores[key], 'string', `${key} must be an envelope STRING`);
    const envelope = JSON.parse(bundle.stores[key]);
    assert.deepEqual(Object.keys(envelope).sort(), ['state', 'version'], `${key} envelope shape`);
    assert.equal(envelope.version, 0, `${key} envelope version`);
    assert.equal(typeof envelope.state, 'object');
  }

  // The report is the point of a build: digest, sizes, and where every declared module rides.
  assert.ok(build.stdout.includes(bundle.digest), 'stdout must report the digest');
  assert.match(build.stdout, /axsdk:flows\s.*KiB/, 'stdout must report per-store sizes');
  assert.match(build.stdout, /axsdk:lua-modules\s.*KiB/, 'stdout must report the module store size');
  assert.match(build.stdout, /total\s/, 'stdout must report the total');
  assert.match(build.stdout, /% of the 256 KiB per-layer/, 'stdout must report ceiling headroom');
  // The rpc modules ride in the bundle now; a warning that is always printed is one nobody reads.
  assert.ok(!build.stdout.includes('NOT in this bundle'), `stdout still claims a gap:\n${build.stdout}`);
  assert.ok(
    build.stdout.includes('all 2 declared modules are carried'),
    `stdout must say every declared module is carried:\n${build.stdout}`,
  );
});

test('the module store carries the rpc modules byte-for-byte, declared or not', async (t) => {
  const root = await makeFixture(t);
  // Undeclared but on disk: the store layer is directory-driven, exactly like scripts/ layers.
  await writeFile(join(root, '_common', 'rpc', '91_rpc_extra.lua'), 'return { extra = 1 }\n');
  const build = await runCli([`--root=${root}`]);
  assert.equal(build.code, 0, `build failed: ${build.stderr}`);

  const bundle = JSON.parse(await readFile(artifactPath(root), 'utf-8'));
  const envelope = JSON.parse(bundle.stores[MODULES_KEY]);
  assert.deepEqual(Object.keys(envelope.state), ['lua'], 'same createLuaLikeStore shape as axsdk:lua');
  const layer = JSON.parse(envelope.state.lua[':']);
  assert.deepEqual(layer, {
    '_common.90_rpc_demo': RPC_DEMO_SOURCE,
    '_common.91_rpc_extra': 'return { extra = 1 }\n',
  });
  assert.equal(
    layer['_common.90_rpc_demo'],
    await readFile(join(root, '_common', 'rpc', '90_rpc_demo.lua'), 'utf-8'),
    'the carried source must be the disk bytes — CRLF and all',
  );
});

test('a workspace with no rpc directory emits no module store and no gap talk', async (t) => {
  const root = await makeFixture(t, { modules: ['_common.00_base'], rpc: false });
  const build = await runCli([`--root=${root}`]);
  assert.equal(build.code, 0, `build failed: ${build.stderr}`);

  const bundle = JSON.parse(await readFile(artifactPath(root), 'utf-8'));
  assert.deepEqual(Object.keys(bundle.stores).sort(), [...STORE_KEYS].sort());
  assert.ok(!build.stdout.includes(MODULES_KEY), 'no module store, no module store row');
  assert.ok(!build.stdout.includes('NOT in this bundle'), 'nothing is missing, so nothing may claim to be');

  const check = await runCli([`--root=${root}`, '--check']);
  assert.equal(check.code, 0, `a four-store artifact must still check clean: ${check.stderr}`);
});

test('--check fails when an rpc module changes, and writes nothing', async (t) => {
  const root = await makeFixture(t);
  await runCli([`--root=${root}`]);
  const path = artifactPath(root);
  const before = await readFile(path, 'utf-8');

  await appendFile(join(root, '_common', 'rpc', '90_rpc_demo.lua'), 'local drift = true\r\n');
  const check = await runCli([`--root=${root}`, '--check']);
  assert.notEqual(check.code, 0, 'check must fail after an rpc module change');
  assert.equal(await readFile(path, 'utf-8'), before, '--check must not rewrite the artifact');
});

test('--out overrides the destination', async (t) => {
  const root = await makeFixture(t);
  const out = join(root, 'elsewhere', 'bundle.json');
  const build = await runCli([`--root=${root}`, `--out=${out}`]);
  assert.equal(build.code, 0, `build failed: ${build.stderr}`);
  const bundle = JSON.parse(await readFile(out, 'utf-8'));
  assert.equal(bundle.version, 1);
});

test('--check passes against a freshly written artifact', async (t) => {
  const root = await makeFixture(t);
  const build = await runCli([`--root=${root}`]);
  assert.equal(build.code, 0, `build failed: ${build.stderr}`);
  // Wall-clock time has moved since the build; only real drift may fail the check.
  const check = await runCli([`--root=${root}`, '--check']);
  assert.equal(check.code, 0, `fresh check must pass: ${check.stderr}`);
});

test('--check does NOT fail merely because generatedAt differs', async (t) => {
  const root = await makeFixture(t);
  await runCli([`--root=${root}`]);
  const path = artifactPath(root);
  const bundle = JSON.parse(await readFile(path, 'utf-8'));
  bundle.generatedAt = '1999-01-01T00:00:00.000Z';
  await writeFile(path, JSON.stringify(bundle, null, 2));
  const check = await runCli([`--root=${root}`, '--check']);
  assert.equal(check.code, 0, `a timestamp is not drift: ${check.stderr}`);
});

test('--check fails when a source file changed, and writes nothing', async (t) => {
  const root = await makeFixture(t);
  await runCli([`--root=${root}`]);
  const path = artifactPath(root);
  const before = await readFile(path, 'utf-8');

  await appendFile(join(root, '_common', 'scripts', '00_base.lua'), 'function AX_more() return 3 end\n');
  const check = await runCli([`--root=${root}`, '--check']);
  assert.notEqual(check.code, 0, 'check must fail after a source change');
  assert.equal(await readFile(path, 'utf-8'), before, '--check must not rewrite the artifact');
});

test('a flowTool declaring an unresolvable module fails the build', async (t) => {
  const root = await makeFixture(t, { modules: ['_common.00_base', '_common.99_missing'] });
  const build = await runCli([`--root=${root}`]);
  assert.notEqual(build.code, 0, 'build must fail on an unresolvable module');
  assert.ok(build.stderr.includes('_common.99_missing'), `stderr must name the module: ${build.stderr}`);
  await assert.rejects(readFile(artifactPath(root), 'utf-8'), 'no artifact may be written on failure');
});
