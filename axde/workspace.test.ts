import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadWorkspace, storeEnvelopes, workspaceIndexEntries,
} from '../../axsdk-sdk-js/packages/axsdk-extension-cdp/scripts/workspace.mjs';
import {
  downWorkspace, inspectWorkspace, readPackagedBaseline, receipt, upWorkspace,
} from './src/ops/workspace.ts';

const AXDE = dirname(fileURLToPath(import.meta.url));
const SCAFFOLD = join(AXDE, 'workspace');

/**
 * `axde/workspace/` is axde's OWN workspace: the thing `/up` delivers by default, laid out exactly
 * like the product's but small. It is committed data rather than a template in code, so the test
 * that matters is that the SDK loader — the one thing that will refuse it in front of a developer —
 * accepts it.
 */
test('the scaffold loads clean, and its index resolves the host it declares', async () => {
  const workspace = await loadWorkspace(SCAFFOLD);
  assert.equal(workspace.root, resolve(SCAFFOLD).replace(/\\/g, '/'));
  // Core's grammar: the first http(s) link is the HOST, the site is the first non-http link's
  // target or that link's text. One line declares both.
  assert.deepEqual(workspaceIndexEntries(workspace.indexMd), [{ hostname: 'example.com', domain: 'dev' }]);
  assert.deepEqual(workspace.domains, ['dev']);
});

test('it carries one of every layer, so a delivery has something to prove on each path', async () => {
  const workspace = await loadWorkspace(SCAFFOLD);
  assert.ok(workspace.flows[':'] !== undefined, 'a common flow layer');
  assert.match(workspace.lua[':'], /AX_dev_echo/, 'the common Lua layer, merged by the loader');
  assert.match(workspace.lua[':dev'], /AX_dev_site/, 'a SITE Lua layer, keyed by domain');
  assert.ok(workspace.sitemaps.dev !== undefined, 'a sitemap, which seeds the site record');
  assert.deepEqual(Object.keys(workspace.modules[':']), ['_common.10_dev'], 'one runtime module');
});

test('the merge is the loader\'s: each file runs in its own vararg function', async () => {
  const workspace = await loadWorkspace(SCAFFOLD);
  // `npm run build:lua` writes dist/ for the published path; this layer is built at delivery time
  // from the working copy, which is why a stale dist cannot be delivered by accident.
  assert.match(workspace.lua[':'], /\(function\(\.\.\.\)/);
  assert.match(workspace.lua[':'], /-- Bundled from the local workspace/);
});

test('it becomes the five stores an extension reads, module store included', async () => {
  const envelopes = storeEnvelopes(await loadWorkspace(SCAFFOLD), { loadedAt: 0 });
  assert.deepEqual(Object.keys(envelopes).sort(), [
    'axsdk:flows', 'axsdk:lua', 'axsdk:lua-modules', 'axsdk:sites', 'axsdk:widgets',
  ]);
  const sites = JSON.parse(envelopes['axsdk:sites']);
  assert.equal(sites.state.index.source, 'local', 'core clears an index that is not local');
  assert.equal(sites.state.index.indexUrl, '');
  assert.ok(sites.state.sites.dev.sitemapMd.length > 0, 'the seeded record carries the sitemap');
  const modules = JSON.parse(JSON.parse(envelopes['axsdk:lua-modules']).state.lua[':']);
  assert.deepEqual(Object.keys(modules), ['_common.10_dev']);
});

test('the scaffold flow document is honest about what it is', async () => {
  const flows = (await loadWorkspace(SCAFFOLD)).flows[':'];
  // A document nobody has compiled is not evidence. Its own header has to say so, because the next
  // reader will otherwise take a delivered document for a working one.
  assert.match(flows, /not been compiled|uncompiled|stage 4/i);
});

// ---------------------------------------------------------------------------------------------
// The decisions: /up, /down and the receipt. The workspace itself is read from disk by
// `inspectWorkspace`; everything below runs against a fake browser, because what has to be pinned
// is the ORDER of the refusals and what the receipt claims.

const STORED = {
  remote_sites: false,
  storedFlowsEnabled: true,
  storedLuaEnabled: true,
  remoteSiteFlowsEnabled: false,
};

function fakeBrowser({ present = true, switches = STORED, wrote = 'written', removed } = {}) {
  const calls: string[] = [];
  return {
    calls,
    async open() { calls.push('open'); return { extensionId: 'ihdaghii', present, reused: false }; },
    async sourceSwitches() { calls.push('switches'); return switches; },
    async writeWorkspace(envelopes: Record<string, string>) {
      calls.push(`write:${Object.keys(envelopes).length}`);
      return wrote;
    },
    async readWorkspace() {
      calls.push('read');
      return { bytes: { 'axsdk:flows': 400, 'axsdk:lua': 1500 }, moduleNames: ['_common.10_dev'] };
    },
    async clearWorkspace() {
      calls.push('clear');
      return { removed: removed ?? ['axsdk:sites', 'axsdk:flows', 'axsdk:lua', 'axsdk:lua-modules', 'axsdk:widgets'] };
    },
    async finish() { calls.push('finish'); },
    async close() { calls.push('close'); },
  };
}

const at = { profile: 'packdev', port: 39701, dist: 'D:/dist', kind: 'axde' as const };

test('inspect reports the layers, the slots and the generated file it found', async () => {
  const inspected = await inspectWorkspace(SCAFFOLD);
  assert.equal(inspected.report.sites, 1);
  assert.equal(inspected.report.digest.length, 12);
  assert.deepEqual(inspected.slots.flows, { ':': 1 }, 'one slot until a layer outgrows 256 KiB');
  assert.deepEqual(inspected.slots.modules, { ':': 1 });
  // The scaffold has no generated site module, and absent is not stale.
  assert.equal(inspected.generated.state, 'absent');
});

test('the product workspace is inspected the same way, and its generated module is checked', async () => {
  const inspected = await inspectWorkspace(resolve(AXDE, '..'));
  assert.equal(inspected.generated.state, 'up-to-date', inspected.generated.reason ?? '');
  assert.ok(inspected.report.sites >= 10, `${inspected.report.sites} sites`);
  // The one layer this repo actually splits.
  assert.ok(inspected.slots.flows[':'] >= 1);
});

test('up writes the envelopes and reports what it read BACK, not what the write answered', async () => {
  const browser = fakeBrowser();
  const inspected = await inspectWorkspace(SCAFFOLD);
  const result = await upWorkspace(browser, { ...at, inspected });

  assert.equal(result.wrote, 'written');
  assert.deepEqual(result.readBack.moduleNames, ['_common.10_dev']);
  assert.deepEqual(browser.calls, ['open', 'switches', 'write:5', 'read', 'finish']);
  assert.ok(!browser.calls.includes('close'), 'a read must leave a browser it did not launch running');
});

test('unchanged is reported as unchanged — a write that did not happen is not a write', async () => {
  const browser = fakeBrowser({ wrote: 'unchanged' });
  const result = await upWorkspace(browser, { ...at, inspected: await inspectWorkspace(SCAFFOLD) });
  assert.equal(result.wrote, 'unchanged');
});

test('a foreign profile is refused BY NAME and no browser is touched', async () => {
  const browser = fakeBrowser();
  const inspected = await inspectWorkspace(SCAFFOLD);
  await assert.rejects(
    () => upWorkspace(browser, { ...at, kind: 'foreign', inspected }),
    /refused: axde did not create "packdev"/,
  );
  await assert.rejects(
    () => downWorkspace(browser, { ...at, kind: 'foreign' }),
    /refused: axde did not create "packdev"/,
  );
  assert.deepEqual(browser.calls, []);
});

test('a stale generated module is refused BEFORE a browser is opened, naming the build', async () => {
  const browser = fakeBrowser();
  const inspected = await inspectWorkspace(SCAFFOLD);
  const stale = { ...inspected, generated: { name: '62_rpc_sites.lua', state: 'stale' as const } };
  await assert.rejects(() => upWorkspace(browser, { ...at, inspected: stale }),
    /62_rpc_sites\.lua is stale.*build:rpc:sites/s);
  assert.deepEqual(browser.calls, [], 'nothing is delivered from a workspace known to be stale');
});

test('an absent extension is refused naming /install: the stores live in its origin', async () => {
  const browser = fakeBrowser({ present: false });
  const inspected = await inspectWorkspace(SCAFFOLD);
  await assert.rejects(() => upWorkspace(browser, { ...at, inspected }), /\/install/);
  assert.ok(browser.calls.includes('finish'), 'and the browser is still left as it was found');
});

test('a source switch in remote mode is refused, quoting the FIELD', async () => {
  const inspected = await inspectWorkspace(SCAFFOLD);
  const wrong = {
    remote_sites: true,
    storedFlowsEnabled: false,
    storedLuaEnabled: false,
    remoteSiteFlowsEnabled: true,
  };
  for (const [field, value] of Object.entries(wrong)) {
    const browser = fakeBrowser({ switches: { ...STORED, [field]: value } });
    await assert.rejects(
      () => upWorkspace(browser, { ...at, inspected }),
      new RegExp(`${field}.*\\/install`, 's'),
      field,
    );
    assert.ok(!browser.calls.some((call) => call.startsWith('write')), field);
  }
});

test('down clears the five stores and reports the ones that were actually removed', async () => {
  const browser = fakeBrowser();
  const result = await downWorkspace(browser, at);
  assert.deepEqual(result.removed, [
    'axsdk:sites', 'axsdk:flows', 'axsdk:lua', 'axsdk:lua-modules', 'axsdk:widgets',
  ]);
  assert.deepEqual(browser.calls, ['open', 'clear', 'finish']);
});

test('down on a profile that carries nothing says so instead of reporting a removal', async () => {
  const result = await downWorkspace(fakeBrowser({ removed: [] }), at);
  assert.deepEqual(result.removed, []);
});

test('the receipt states every layer, the read-back, and what was NOT checked', async () => {
  const inspected = await inspectWorkspace(SCAFFOLD);
  const lines = receipt({
    inspected,
    wrote: 'written',
    restarted: true,
    readBack: { bytes: { 'axsdk:flows': 400 }, moduleNames: ['_common.10_dev'] },
    checked: 'skipped',
  }).join('\n');

  assert.match(lines, /workspace .*workspace/);
  assert.match(lines, /digest [0-9a-f]{12}/);
  assert.match(lines, /^\s+:\s+.*lua/m, 'the common layer');
  assert.match(lines, /:dev/, 'the site layer');
  assert.match(lines, /written · host restarted/);
  assert.match(lines, /_common\.10_dev/, 'the module names, which a durable-layer check cannot see');
  assert.match(lines, /not run\s+check:flows/, 'a green delivery is not a green gate');
  assert.match(lines, /session/, 'and script ids need one, which this stage does not open');

  const checked = receipt({
    inspected, wrote: 'unchanged', restarted: false, readBack: { bytes: {}, moduleNames: [] }, checked: 'pass',
  }).join('\n');
  assert.match(checked, /unchanged/);
  assert.ok(!/host restarted/.test(checked), 'an unchanged write restarts nothing');
  assert.match(checked, /check:flows\s+pass/);
});

test('a long layer key still leaves a gap before its value', async () => {
  // Measured on the product workspace: a fixed 9-column key ran `:aliexpress` straight into `lua
  // 3.1 KiB`, and two facts with no space between them read as one.
  const inspected = await inspectWorkspace(resolve(AXDE, '..'));
  const lines = receipt({
    inspected, wrote: 'unchanged', restarted: false,
    readBack: { bytes: {}, moduleNames: [] }, checked: 'skipped',
  });
  for (const line of lines.filter((one) => /^\s+:/.test(one))) {
    assert.match(line, /^\s+:\S*\s{2,}\S/, line);
  }
});

/**
 * Replace mode. An axde profile uses the workspace INSTEAD of the sources embedded in the artifact:
 * measured 2026-09-04, a 75 B workspace layer went out inside a 139,101 B document because a
 * 136 KiB packaged baseline was merged underneath it, and that baseline was five days old.
 */
test('up REPORTS the mode instead of refusing it — a mode is not a misconfiguration', async () => {
  const inspected = await inspectWorkspace(SCAFFOLD);
  for (const packaged of [false, true]) {
    const browser = fakeBrowser({ switches: { ...STORED, packagedSourcesEnabled: packaged } });
    const result = await upWorkspace(browser, { ...at, inspected });
    assert.equal(result.packaged, packaged, String(packaged));
  }
});

test('the receipt names the baseline: replaced, or its size and DATE when it is merged', async () => {
  const inspected = await inspectWorkspace(SCAFFOLD);
  const replaced = receipt({
    inspected, wrote: 'written', restarted: true, packaged: false,
    readBack: { bytes: {}, moduleNames: [] }, checked: 'skipped',
  }).join('\n');
  assert.match(replaced, /baseline\s+package:: replaced/);

  const merged = receipt({
    inspected, wrote: 'written', restarted: true, packaged: true,
    baseline: { bytes: 136146, digest: '999ca95c5d67', generatedAt: '2026-08-30T11:43:45.164Z' },
    readBack: { bytes: {}, moduleNames: [] }, checked: 'skipped',
  }).join('\n');
  // The date is the point: a baseline five days older than the workspace is the fact a reader needs.
  assert.match(merged, /baseline\s+package:: 133\.0 KiB/);
  assert.match(merged, /999ca95c5d67/);
  assert.match(merged, /2026-08-30/);
});

test('a workspace with no flows says what the session will run instead', async () => {
  const inspected = await inspectWorkspace(SCAFFOLD);
  const noFlows = {
    ...inspected,
    report: {
      ...inspected.report,
      layers: inspected.report.layers.map((layer) => ({ ...layer, flows: 0 })),
    },
  };
  const lines = receipt({
    inspected: noFlows, wrote: 'written', restarted: true, packaged: false,
    readBack: { bytes: {}, moduleNames: [] }, checked: 'skipped',
  }).join('\n');
  // With no flows and no baseline there is no client document at all.
  assert.match(lines, /app document alone/);
});

test('the packaged baseline is read from the BUILD, and an unreadable one is none', async () => {
  const dist = resolve(AXDE, '..', '..', 'axsdk-sdk-js', 'packages', 'axsdk-extension-cdp', 'dist');
  const baseline = readPackagedBaseline(dist);
  // The build in use carries one; its digest is 12 hex and its size is the flow asset's.
  assert.ok(baseline !== undefined, 'the sibling build carries a manifest');
  assert.match(baseline.digest, /^[0-9a-f]{12}$/);
  assert.ok(baseline.bytes > 0, String(baseline.bytes));
  assert.match(baseline.generatedAt, /^\d{4}-\d{2}-\d{2}T/);

  // A directory with no manifest is reported as NONE, never as a zero-sized baseline.
  assert.equal(readPackagedBaseline(resolve(AXDE, 'workspace')), undefined);
});
