import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parse } from 'yaml';

import { buildRpcFlows, discoverModules, emitWorkspace, moduleName } from './build-rpc-flows.mjs';

// Lua is authored as files — reviewed, unit tested, diffed. The runtime wants it inside the flow
// document (until the module registry ships), and hand-inlining thousands of lines into YAML would end
// all three. The builder is the seam: `modules:` names files, the build resolves them, and the emitted
// document is the only place Lua appears twice.

function workspace(files) {
  const root = mkdtempSync(join(tmpdir(), 'rpcbuild-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

const FLOWS = `
flowTools:
  read_page:
    description: Read the page.
    execute:
      kind: runtime
      implementation: lua
      modules: ["_common.helpers", "_common.reader"]
      rpc:
        allow: [dom.get_text]
      entry: run
      lua: |
        function run(args)
          return { next = "ok", value = READER.read() }
        end
    parameters:
      type: object
      properties: {}
`;

test('module sources are inlined ahead of the tool script, in declaration order', () => {
  const root = workspace({
    '_common/flows.yaml': FLOWS,
    '_common/scripts/helpers.lua': 'HELPERS = { trim = function(s) return s end }\n',
    '_common/scripts/reader.lua': 'READER = { read = function() return HELPERS.trim("x") end }\n',
  });
  const built = buildRpcFlows({ root, modulePaths: { '_common.helpers': '_common/scripts/helpers.lua', '_common.reader': '_common/scripts/reader.lua' } });
  const doc = parse(built['_common/flows.yaml']);
  const lua = doc.flowTools.read_page.execute.lua;

  assert.ok(lua.indexOf('HELPERS =') < lua.indexOf('READER ='), 'declaration order is evaluation order');
  assert.ok(lua.indexOf('READER =') < lua.indexOf('function run'), 'the tool script runs last');
  rmSync(root, { recursive: true, force: true });
});

test('the build-only key never reaches the emitted document', () => {
  const root = workspace({
    '_common/flows.yaml': FLOWS,
    '_common/scripts/helpers.lua': 'HELPERS = {}\n',
    '_common/scripts/reader.lua': 'READER = {}\n',
  });
  const built = buildRpcFlows({ root, modulePaths: { '_common.helpers': '_common/scripts/helpers.lua', '_common.reader': '_common/scripts/reader.lua' } });
  const doc = parse(built['_common/flows.yaml']);

  assert.equal(doc.flowTools.read_page.execute.modules, undefined,
    '`modules:` is ours, not the runtime schema — leaving it in would fail validation');
  assert.ok(doc.flowTools.read_page.execute.rpc, 'everything else survives untouched');
  rmSync(root, { recursive: true, force: true });
});

test('a module nobody can resolve fails the build', () => {
  const root = workspace({ '_common/flows.yaml': FLOWS, '_common/scripts/helpers.lua': 'HELPERS = {}\n' });
  assert.throws(
    () => buildRpcFlows({ root, modulePaths: { '_common.helpers': '_common/scripts/helpers.lua' } }),
    /_common\.reader/,
    'a typo must stop the build, not surface as a nil index at runtime',
  );
  rmSync(root, { recursive: true, force: true });
});

test('a tool with no modules is emitted unchanged', () => {
  const root = workspace({
    '_common/flows.yaml': `
flowTools:
  pure:
    execute:
      kind: runtime
      implementation: lua
      lua: |
        return { next = "ok" }
`,
  });
  const built = buildRpcFlows({ root, modulePaths: {} });
  const doc = parse(built['_common/flows.yaml']);
  assert.match(doc.flowTools.pure.execute.lua, /return \{ next = "ok" \}/);
  rmSync(root, { recursive: true, force: true });
});

test('the emitted document reports what it cost', () => {
  const root = workspace({
    '_common/flows.yaml': FLOWS,
    '_common/scripts/helpers.lua': 'HELPERS = {}\n',
    '_common/scripts/reader.lua': 'READER = {}\n',
  });
  const built = buildRpcFlows({ root, modulePaths: { '_common.helpers': '_common/scripts/helpers.lua', '_common.reader': '_common/scripts/reader.lua' } });

  // The document has a hard 256 KiB ceiling and inlining is what pushes against it. A build that does not
  // report its own size is a build that discovers the ceiling in production.
  assert.ok(built.__report.bytes > 0);
  assert.equal(built.__report.tools, 1);
  assert.deepEqual(built.__report.modules.sort(), ['_common.helpers', '_common.reader']);
});

// Inlining was always the stopgap: it spends the document's 256 KiB budget on Lua that the runtime can
// now hold separately. Registry delivery sends the NAMES and uploads the sources, so the document costs
// one line per module regardless of how big the layer grows. Both modes read the same `modules:`
// declaration, which is the whole reason the declaration was written that way.

test('registry delivery leaves the declaration in place and never inlines a source', () => {
  const root = workspace({
    '_common/flows.yaml': FLOWS,
    '_common/scripts/helpers.lua': 'HELPERS = { tag = "helper-source" }\n',
    '_common/scripts/reader.lua': 'READER = { read = function() return HELPERS.tag end }\n',
  });
  const paths = { '_common.helpers': '_common/scripts/helpers.lua', '_common.reader': '_common/scripts/reader.lua' };
  const built = buildRpcFlows({ root, modulePaths: paths, delivery: 'registry' });
  const tool = parse(built['_common/flows.yaml']).flowTools.read_page;

  assert.deepEqual(tool.execute.modules, ['_common.helpers', '_common.reader']);
  assert.ok(!tool.execute.lua.includes('helper-source'), 'the module source must not travel in the document');
  assert.match(tool.execute.lua, /function run\(args\)/, 'the tool script itself still travels');
});

test('registry delivery hands back the sources to upload, keyed by module name', () => {
  const root = workspace({
    '_common/flows.yaml': FLOWS,
    '_common/scripts/helpers.lua': 'HELPERS = { tag = "helper-source" }\n',
    '_common/scripts/reader.lua': 'READER = {}\n',
  });
  const paths = { '_common.helpers': '_common/scripts/helpers.lua', '_common.reader': '_common/scripts/reader.lua' };
  const built = buildRpcFlows({ root, modulePaths: paths, delivery: 'registry' });

  // A document that names modules nobody uploaded fails at the first turn, in the runtime, with no file
  // to point at. The build therefore produces both halves or neither.
  assert.deepEqual(Object.keys(built.__report.moduleSources).sort(), ['_common.helpers', '_common.reader']);
  assert.match(built.__report.moduleSources['_common.helpers'], /helper-source/);
});

test('registry delivery costs the document almost nothing', () => {
  const bulk = `BULK = "${'x'.repeat(20_000)}"\n`;
  const files = { '_common/flows.yaml': FLOWS, '_common/scripts/helpers.lua': bulk, '_common/scripts/reader.lua': 'READER = {}\n' };
  const paths = { '_common.helpers': '_common/scripts/helpers.lua', '_common.reader': '_common/scripts/reader.lua' };
  const inlined = buildRpcFlows({ root: workspace(files), modulePaths: paths });
  const registry = buildRpcFlows({ root: workspace(files), modulePaths: paths, delivery: 'registry' });

  assert.ok(inlined.__report.bytes > 20_000, 'inlining pays for the source');
  assert.ok(registry.__report.bytes < 1_000, `registry delivery should not, got ${registry.__report.bytes}`);
});

test('a module the registry would reject fails the build instead of the upload', () => {
  const root = workspace({
    '_common/flows.yaml': FLOWS,
    '_common/scripts/helpers.lua': `HELPERS = "${'x'.repeat(70 * 1024)}"\n`,
    '_common/scripts/reader.lua': 'READER = {}\n',
  });
  const paths = { '_common.helpers': '_common/scripts/helpers.lua', '_common.reader': '_common/scripts/reader.lua' };

  // Live: `400 lua module probe.size70 exceeds 65536 bytes`. Discovering that mid-upload leaves a session
  // holding some modules and not others, which reads as a missing function rather than a size problem.
  assert.throws(() => buildRpcFlows({ root, modulePaths: paths, delivery: 'registry' }), /_common\.helpers.*65536|65536.*_common\.helpers/);
});

test('an unresolvable module fails the build in either delivery mode', () => {
  const root = workspace({ '_common/flows.yaml': FLOWS, '_common/scripts/helpers.lua': 'HELPERS = {}\n' });
  const paths = { '_common.helpers': '_common/scripts/helpers.lua' };
  assert.throws(() => buildRpcFlows({ root, modulePaths: paths, delivery: 'registry' }), /_common\.reader/);
});

test('an emitted workspace can keep the module names instead of the sources', () => {
  // The two halves travel separately in the real composition: the flow document goes through the
  // clientFlows overlay (it is an `extends: app` overlay, not an app document — pushing it as one fails
  // with "actions must define at least one action"), while the modules go in the app package. A
  // workspace that can only be emitted with sources inlined cannot express that.
  const root = workspace({
    '_common/flows.yaml': FLOWS,
    '_common/scripts/helpers.lua': 'HELPERS = { tag = "helper-source" }\n',
    '_common/scripts/reader.lua': 'READER = {}\n',
    'index.md': '# sites\n',
  });
  const dest = join(mkdtempSync(join(tmpdir(), 'rpcemit-')), 'out');

  const report = emitWorkspace({ root, dest, delivery: 'registry' });

  const emitted = readFileSync(join(dest, '_common/flows.yaml'), 'utf8');
  assert.ok(!emitted.includes('helper-source'), 'the source must not travel in the emitted document');
  assert.match(emitted, /modules:/);
  assert.equal(report.moduleSources['_common.helpers'], 'HELPERS = { tag = "helper-source" }\n');
});

// `scripts/` is the browser layer and `rpc/` is the runtime layer, and they must not be the same pile.
// Putting the RPC reader beside the durable one added 41 KB to a bundle every page load parses and can
// never execute — and after the cutover the browser layer disappears while the runtime layer is all
// that is left. The directory says which is which, so nobody has to remember a filter.

test('a module under rpc/ is named like one under scripts/', () => {
  assert.equal(moduleName('_common/rpc/61_rpc_storefront.lua'), '_common.61_rpc_storefront');
  assert.equal(moduleName('_common/scripts/44_pagination.lua'), '_common.44_pagination');
});

test('discovery finds runtime modules in rpc/ as well as scripts/', () => {
  const root = workspace({
    '_common/scripts/00_base.lua': 'B = {}\n',
    '_common/rpc/61_reader.lua': 'READER = {}\n',
    '_common/flows.yaml': 'flowTools: {}\n',
  });
  const found = discoverModules(root);
  assert.equal(found['_common.61_reader'], '_common/rpc/61_reader.lua');
  assert.equal(found['_common.00_base'], '_common/scripts/00_base.lua');
});

test('a tool is refused when its inlined Lua passes the per-tool ceiling', () => {
  // The builder checked each MODULE against 64 KiB and the whole DOCUMENT against 256 KiB, and nothing
  // checked the thing the runtime actually rejects: the tool's concatenated `execute.lua`.
  //
  // Measured live on the playground — `flow document failed to compile: adapters.adapters
  // .rpc_storefront_search.execute.lua exceeds 65536 bytes`. Two modules of 38.3 and 27.0 KiB, each
  // legal alone, and the document under its ceiling. Every playground turn answered "플로우 설정을
  // 불러오지 못했습니다" and no gate here said a word.
  const root = mkdtempSync(join(tmpdir(), 'rpc-ceiling-'));
  try {
    mkdirSync(join(root, '_common', 'rpc'), { recursive: true });
    // Comment-only padding: it must NOT rescue the tool by accident — the builder strips comments, so
    // the body has to be genuine code to exceed the ceiling.
    const bulk = Array.from({ length: 2200 }, (unused, i) => `local pad_${i} = "${'x'.repeat(24)}"`).join('\n');
    writeFileSync(join(root, '_common', 'rpc', '90_bulk.lua'), `AX_BULK = AX_BULK or {}\n${bulk}\n`);
    writeFileSync(join(root, '_common', 'flows.yaml'), [
      'flowTools:',
      '  bulky:',
      '    execute:',
      '      kind: runtime',
      '      implementation: lua',
      '      modules: ["_common.90_bulk"]',
      '      entry: run',
      '      lua: |',
      '        function run() return { next = "done" } end',
      '',
    ].join('\n'));

    assert.throws(
      () => buildRpcFlows({ root, modulePaths: discoverModules(root) }),
      /bulky.*exceeds|exceeds.*65536/,
      'the build must refuse what the runtime will reject',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('inlining drops comments and blank lines, and keeps the code', () => {
  // Stripping is what buys the room: `61_rpc_storefront` is 38.3 KiB with 16.5 KiB of comments. Sources
  // stay authored with the reasoning that makes them reviewable; the wire form does not carry it.
  const root = mkdtempSync(join(tmpdir(), 'rpc-strip-'));
  try {
    mkdirSync(join(root, '_common', 'rpc'), { recursive: true });
    writeFileSync(join(root, '_common', 'rpc', '90_small.lua'), [
      '--- A doc comment that costs bytes on the wire.',
      'AX_SMALL = AX_SMALL or {}',
      '',
      'function AX_SMALL.answer()',
      '  -- an inline reason',
      '  return "the dash -- inside a string survives"',
      'end',
      '',
    ].join('\n'));
    writeFileSync(join(root, '_common', 'flows.yaml'), [
      'flowTools:',
      '  small:',
      '    execute:',
      '      kind: runtime',
      '      implementation: lua',
      '      modules: ["_common.90_small"]',
      '      entry: run',
      '      lua: |',
      '        function run() return AX_SMALL.answer() end',
      '',
    ].join('\n'));

    const built = buildRpcFlows({ root, modulePaths: discoverModules(root) });
    const emitted = parse(built['_common/flows.yaml']).flowTools.small.execute.lua;

    assert.doesNotMatch(emitted, /A doc comment that costs bytes/);
    assert.doesNotMatch(emitted, /an inline reason/);
    assert.match(emitted, /function AX_SMALL\.answer\(\)/);
    // A `--` inside a string is not a comment, and a stripper that cannot tell would change behaviour.
    assert.match(emitted, /the dash -- inside a string survives/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
