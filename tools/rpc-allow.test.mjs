import assert from 'node:assert/strict';
import test from 'node:test';

import { BATCHABLE, auditRpcAllow, OPS, COMPOSED } from './rpc-allow.mjs';

// `rpc.allow` is the only thing standing between a read-only node and a click. The runtime enforces it
// per op, which means a mistake surfaces as one refused op in the middle of a live run — the most
// expensive place to find it. Both mistakes the platform guide warns about are mechanical, so they
// belong in CI:
//
//   1. Listing a wait HELPER. `dom.wait_for_selector` is not a wire op; the prelude polls `dom.exists`.
//      Allowing the helper and not the poll passes review and fails on the page.
//   2. Granting an op the script never calls. Least privilege is not a style rule here: a node that can
//      click is a node that can buy something.

const tool = (lua, allow) => ({
  flowTools: { probe: { execute: { kind: 'runtime', implementation: 'lua', entry: 'run', rpc: { allow }, lua } } },
});

test('a script calling an op it was not granted is an error', () => {
  const issues = auditRpcAllow(tool('function run() return { x = dom.get_text("h1") } end', ['dom.exists']));
  assert.deepEqual(issues.map((issue) => [issue.code, issue.op]), [
    ['op_not_allowed', 'dom.get_text'],
    ['unused_grant', 'dom.exists'],
  ]);
});

test('a wait helper in allow names the op it actually polls', () => {
  const issues = auditRpcAllow(tool('function run() return { ok = dom.wait_for_selector("h1", 2000) } end', ['dom.wait_for_selector']));
  const composed = issues.find((issue) => issue.code === 'composed_helper_in_allow');
  assert.equal(composed.op, 'dom.wait_for_selector');
  assert.equal(composed.polls, 'dom.exists');
  assert.ok(issues.some((issue) => issue.code === 'op_not_allowed' && issue.op === 'dom.exists'),
    'the polled op is what the grant has to name');
});

test('calling a wait helper with its polled op granted is clean', () => {
  assert.deepEqual(auditRpcAllow(tool('function run() return { ok = dom.wait_for_selector("h1", 2000) } end', ['dom.exists'])), []);
});

test('a grant the script never uses is reported', () => {
  const issues = auditRpcAllow(tool('function run() return { x = dom.get_text("h1") } end', ['dom.get_text', 'dom.click']));
  assert.deepEqual(issues.map((issue) => [issue.code, issue.op]), [['unused_grant', 'dom.click']]);
});

test('a grant that is not an op at all is reported', () => {
  const issues = auditRpcAllow(tool('function run() return {} end', ['dom.get_textt']));
  assert.deepEqual(issues.map((issue) => [issue.code, issue.op]), [['unknown_op', 'dom.get_textt']]);
});

test('a tool with no rpc block is not audited', () => {
  const pure = { flowTools: { calc: { execute: { kind: 'runtime', implementation: 'lua', lua: 'function run() return {} end' } } } };
  assert.deepEqual(auditRpcAllow(pure), []);
});

test('the op vocabulary matches what the server reports', () => {
  // Pinned from a live `GET /axsdk/v2/lua/ops` (version sha256:0bb4bf33418e), then extended by the
  // platform's 12th reply with `dom.click_text` and `dom.read_many`. D10: the vocabulary is a server fact,
  // not a document fact — this list is a mirror and the live check is what re-validates it.
  assert.equal(OPS.length, 18);
  assert.ok(OPS.includes('dom.click_text'));
  assert.ok(OPS.includes('dom.read_many'));
  assert.deepEqual(COMPOSED['dom.wait_for_selector'], 'dom.exists');
  assert.deepEqual(COMPOSED['nav.wait_for_navigation'], 'dom.get_location_href');
  for (const polled of Object.values(COMPOSED)) assert.ok(OPS.includes(polled), `${polled} must be a real op`);
});

test('a batch carries reads only', () => {
  // A round trip that could hide a side effect could not promise order or atomicity, so the runtime refuses
  // a write inside `dom.read_many`. Mirroring that here keeps a script from being written against a
  // permissiveness the platform does not have.
  for (const op of ['dom.exists', 'dom.get_text', 'dom.query_all']) assert.ok(BATCHABLE.has(op), op);
  for (const op of ['dom.click', 'dom.set_value', 'nav.navigate', 'dom.submit_form', 'page.eval']) {
    assert.ok(!BATCHABLE.has(op), `${op} must never be batchable`);
  }
  for (const op of BATCHABLE) assert.ok(OPS.includes(op), `${op} must be a real op`);
});

test('every issue names the tool it came from', () => {
  const issues = auditRpcAllow(tool('function run() return { x = dom.click("a") } end', []));
  assert.equal(issues[0].tool, 'probe');
});

// A tool that declares `modules:` keeps almost none of its code in `execute.lua` — the ops it calls live
// in the module files. Auditing only the inline script reported every grant as unused on the authored
// document while the built one looked clean, which is the audit lying in the direction that matters
// least: it would have taught us to delete grants the script needs.

const withModules = (allow) => ({
  flowTools: {
    probe: {
      execute: {
        kind: 'runtime', implementation: 'lua', entry: 'run',
        modules: ['site.reader'], rpc: { allow },
        lua: 'function run(args) return READER.read(args) end',
      },
    },
  },
});
const READER = { 'site.reader': 'READER = { read = function() return dom.get_text("h1") end }\n' };

test('ops a declared module calls count as required', () => {
  assert.deepEqual(auditRpcAllow(withModules(['dom.get_text']), { moduleSources: READER }), []);
});

test('a module calling an ungranted op is still an error', () => {
  const issues = auditRpcAllow(withModules([]), { moduleSources: READER });
  assert.deepEqual(issues.map((issue) => [issue.code, issue.op]), [['op_not_allowed', 'dom.get_text']]);
});

test('a declared module with no source available is reported, not assumed empty', () => {
  // Silently auditing a tool whose modules we cannot read would mark every real grant unused.
  const issues = auditRpcAllow(withModules(['dom.get_text']), { moduleSources: {} });
  assert.deepEqual(issues.map((issue) => [issue.code, issue.op]), [['module_source_missing', 'site.reader']]);
});
