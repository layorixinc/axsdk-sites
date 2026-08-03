import assert from 'node:assert/strict';
import test from 'node:test';

import { packageHash, packageHashes, diffPackage } from './rpc-package.mjs';

// A package push replaces a whole app: flow document, sitemap, every module. The only way to know the
// server is serving what we built is to compare hashes, and the only way to trust that comparison is to
// compute them the way the server does. Confirmed against a live push (revision 14):
//
//   flowDocument               sha256:5f8e2756cae7
//   sitemap                    sha256:4325298a0077   == sha256(index.md)[0..12]
//   _common.16_rpc_storefront  sha256:6946a067c56d
//
// so the format is `sha256:` + the first 12 hex characters of sha256 over the UTF-8 bytes.

test('the hash format is the one the server reports', () => {
  assert.equal(packageHash('AXSDK'), 'sha256:341cacb5e27b');
  assert.equal(packageHash(''), 'sha256:e3b0c44298fc');
  assert.match(packageHash('anything'), /^sha256:[0-9a-f]{12}$/);
});

const LOCAL = {
  flowDocument: 'version: 1\n',
  sitemap: '# sites\n',
  luaModules: { 'site.reader': 'READER = {}\n', 'site.base': 'BASE = {}\n' },
};
const remoteOf = (local) => ({ revision: 7, hash: packageHashes(local) });

test('hashes cover every part the push replaces', () => {
  const hashes = packageHashes(LOCAL);
  assert.deepEqual(Object.keys(hashes).sort(), ['flowDocument', 'luaModules', 'sitemap']);
  assert.deepEqual(Object.keys(hashes.luaModules).sort(), ['site.base', 'site.reader']);
});

test('a package that matches reports nothing', () => {
  assert.deepEqual(diffPackage(LOCAL, remoteOf(LOCAL)), []);
});

test('a stale document is named, not just "different"', () => {
  const remote = remoteOf({ ...LOCAL, flowDocument: 'version: 2\n' });
  assert.deepEqual(diffPackage(LOCAL, remote).map((issue) => issue.code), ['flow_document_stale']);
});

test('a stale sitemap is reported separately from the document', () => {
  const remote = remoteOf({ ...LOCAL, sitemap: '# other\n' });
  assert.deepEqual(diffPackage(LOCAL, remote).map((issue) => issue.code), ['sitemap_stale']);
});

test('a module the server never received is missing, not stale', () => {
  // The difference matters: stale means the push landed and is old, missing means the document names a
  // module the runtime cannot resolve — which fails inside a turn, not at push time.
  const remote = remoteOf({ ...LOCAL, luaModules: { 'site.base': LOCAL.luaModules['site.base'] } });
  assert.deepEqual(diffPackage(LOCAL, remote).map((issue) => [issue.code, issue.name]), [['module_missing', 'site.reader']]);
});

test('a module only the server has is reported as left over', () => {
  const remote = remoteOf({ ...LOCAL, luaModules: { ...LOCAL.luaModules, 'site.gone': 'GONE = {}\n' } });
  assert.deepEqual(diffPackage(LOCAL, remote).map((issue) => [issue.code, issue.name]), [['module_orphan', 'site.gone']]);
});

test('a changed module names itself', () => {
  const remote = remoteOf({ ...LOCAL, luaModules: { ...LOCAL.luaModules, 'site.reader': 'READER = { v = 2 }\n' } });
  assert.deepEqual(diffPackage(LOCAL, remote).map((issue) => [issue.code, issue.name]), [['module_stale', 'site.reader']]);
});

test('an app that was never pushed to is every part missing, not clean', () => {
  // revision 0 with no hashes must not read as agreement. This is the state a fresh app is in, and it is
  // exactly when a run silently uses nothing.
  const issues = diffPackage(LOCAL, { revision: 0 });
  assert.deepEqual(issues.map((issue) => issue.code).sort(),
    ['flow_document_stale', 'module_missing', 'module_missing', 'sitemap_stale']);
});

test('verification can be scoped to the parts this workspace owns', () => {
  // Proven composition: the app document belongs to the platform (ours is an `extends: app` overlay and
  // is rejected as an app document), the modules belong to us, and the overlay carries the flows. So a
  // real app serves a document we did not build — comparing it would report a permanent, meaningless
  // mismatch and train everyone to ignore the check.
  const remote = { revision: 9, hash: { ...packageHashes(LOCAL), flowDocument: packageHash('someone else\n') } };

  assert.deepEqual(diffPackage(LOCAL, remote).map((issue) => issue.code), ['flow_document_stale']);
  assert.deepEqual(diffPackage(LOCAL, remote, { compare: ['luaModules'] }), []);
});

test('a scoped verification still catches a stale module', () => {
  const remote = { revision: 9, hash: packageHashes({ ...LOCAL, luaModules: { ...LOCAL.luaModules, 'site.reader': 'READER = { v: 2 }\n' } }) };
  assert.deepEqual(diffPackage(LOCAL, remote, { compare: ['luaModules'] }).map((issue) => [issue.code, issue.name]),
    [['module_stale', 'site.reader']]);
});
