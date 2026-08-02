import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parse } from 'yaml';

import { buildRpcFlows } from './build-rpc-flows.mjs';

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
