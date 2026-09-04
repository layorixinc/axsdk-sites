/**
 * Stage 2d live gate: the workspace REPLACES the sources embedded in the artifact.
 *
 * The offline suites pin each composition point; only a real session can show what actually left the
 * profile. What this gate exists to catch is the shape measured on 2026-09-04, before the switch: a
 * 75 B workspace layer travelling inside a 139,101 B document, because a 136 KiB packaged baseline —
 * five days older than the workspace — was merged underneath it.
 *
 * It reads the payload store the AXSDK DevTools console draws, from a realm that did not write it.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  connectCdp, evaluate, probeDebugger, startSessionOn,
} from '../../../axsdk-sdk-js/packages/axsdk-extension-cdp/scripts/browser-session.mjs';

const AXDE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITES_ROOT = resolve(AXDE, '..');
const EXTENSION_ID = 'ihdaghiiieaomningbeokfdkcpnpihpb';
const MARKER = 'axde-marker-2d';

let profileRoot = '';
let workspace = '';
const checks: string[] = [];

function ok(what: string, condition: unknown, evidence: string) {
  if (!condition) throw new Error(`${what}\n  observed: ${evidence}`);
  checks.push(what);
  console.log(`  ok  ${what}`);
}

async function axde(...args: string[]) {
  const child = Bun.spawn([process.execPath, 'axde/src/cli.ts', ...args], {
    cwd: SITES_ROOT,
    env: { ...process.env, AXSDK_PROFILE_ROOT: profileRoot },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, out: `${out}${err}`.trim() };
}

async function expectOk(...args: string[]) {
  const { code, out } = await axde(...args);
  if (code !== 0) throw new Error(`axde ${args.join(' ')} exited ${code}\n  observed: ${out}`);
  return out;
}

/** A workspace whose flow layer is unmistakably ours, and tiny. */
function buildWorkspace(base: string) {
  const dir = join(base, 'ws');
  for (const child of ['_common/scripts', '_common/rpc', 'dev/scripts']) {
    mkdirSync(join(dir, child), { recursive: true });
  }
  copyFileSync(join(AXDE, 'workspace/index.md'), join(dir, 'index.md'));
  copyFileSync(join(AXDE, 'workspace/_common/scripts/00_dev.lua'), join(dir, '_common/scripts/00_dev.lua'));
  copyFileSync(join(AXDE, 'workspace/_common/rpc/10_dev.lua'), join(dir, '_common/rpc/10_dev.lua'));
  copyFileSync(join(AXDE, 'workspace/dev/scripts/00_site.lua'), join(dir, 'dev/scripts/00_site.lua'));
  writeFileSync(join(dir, '_common/flows.yaml'), `axdeWorkspaceMarker: ${MARKER}\ncontexts: {}\n`);
  return dir;
}

async function openSessionAndReadPayload(port: number) {
  const cdp = await connectCdp((await probeDebugger(port))!.webSocketDebuggerUrl);
  try {
    const url = `chrome-extension://${EXTENSION_ID}/options/options.html`;
    const { targetInfos } = await cdp.send('Target.getTargets');
    const open = (targetInfos ?? []).find((one: any) => one.type === 'page' && String(one.url).startsWith(url));
    const targetId = open?.targetId ?? (await cdp.send('Target.createTarget', { url })).targetId;
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await evaluate(cdp, sessionId, 'typeof chrome?.storage').catch(() => undefined) === 'object') break;
      await new Promise((done) => setTimeout(done, 250));
    }
    const started = await startSessionOn(cdp, sessionId, 'https://example.com/');
    await new Promise((done) => setTimeout(done, 12_000));
    const key = `s${started?.groupId}:axsdk:outbound-session`;
    return await evaluate(cdp, sessionId, `(async () => {
      const raw = (await chrome.storage.local.get(${JSON.stringify(key)}))[${JSON.stringify(key)}];
      if (typeof raw !== 'string') return { present: false };
      const payload = JSON.parse(raw).payload;
      const flows = String(payload.clientFlows ?? '');
      return {
        present: true,
        layers: payload.clientFlowsLayers ?? [],
        flowsBytes: payload.bytes?.clientFlows ?? 0,
        hasMarker: flows.includes(${JSON.stringify(MARKER)}),
        hasProductFlow: flows.includes('shopping_multi_store_total_cost'),
        hasAppExtends: flows.includes('extends: app'),
        modules: payload.clientLuaModules ?? [],
      };
    })()`) as any;
  } finally {
    cdp.close();
  }
}

async function main() {
  const base = mkdtempSync(join(tmpdir(), 'axde-stage2d-'));
  profileRoot = join(base, 'profiles');
  mkdirSync(profileRoot, { recursive: true });
  workspace = buildWorkspace(base);
  let port = 0;
  try {
    console.log('profile new + ext install (replace mode is the default)');
    await expectOk('profile', 'new', 'repdev');
    port = JSON.parse(readFileSync(join(profileRoot, 'repdev', 'axde-profile.json'), 'utf8')).port;
    const installed = await expectOk('ext', 'install', 'repdev');
    ok('install says which sources the profile will use',
      /sources workspace only/.test(installed), installed);

    const up = await expectOk('up', 'repdev', '--workspace', workspace);
    ok('the receipt names the baseline as replaced', /baseline\s+package:: replaced/.test(up), up);

    await expectOk('launch', 'repdev', '--url', 'https://example.com/');
    const payload = await openSessionAndReadPayload(port);
    ok('a payload was captured', payload.present === true, JSON.stringify(payload));
    ok('exactly ONE layer composed the document, and it is the workspace',
      payload.layers.length === 1 && payload.layers[0].label === 'store::',
      JSON.stringify(payload.layers));
    ok('the document is the workspace\'s', payload.hasMarker === true, String(payload.flowsBytes));
    // The whole point of the stage.
    ok('the packaged product document is NOT in it', payload.hasProductFlow === false,
      `${payload.flowsBytes} B`);
    ok('and it is small, because nothing else is underneath', payload.flowsBytes < 2_000,
      `${payload.flowsBytes} B`);
    ok('only the workspace runtime module is sent',
      payload.modules.length === 1 && payload.modules[0] === '_common.10_dev',
      JSON.stringify(payload.modules));

    // The row a YAML-shaped fix would miss: two Lua bundles used to load, packaged first.
    const status = await expectOk('ext', 'status', 'repdev');
    ok('status still reads the profile', /installed\s+true/.test(status), status);

    const merged = await expectOk('ext', 'install', 'repdev', '--merge');
    ok('--merge opts back into the packaged baseline',
      /sources package \+ workspace/.test(merged), merged);
    const mergedUp = await expectOk('up', 'repdev', '--workspace', workspace);
    ok('and then the receipt names the baseline it merged, with its date',
      /baseline\s+package:: [\d.]+ KiB\s+digest [0-9a-f]{12}\s+\d{4}-\d{2}-\d{2}/.test(mergedUp), mergedUp);

    console.log(`\nAXDE STAGE 2D LIVE PASS — ${checks.length} checks`);
  } finally {
    if (port && await probeDebugger(port)) await axde('stop', 'repdev').catch(() => undefined);
    rmSync(base, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`\nAXDE STAGE 2D LIVE FAIL after ${checks.length} checks`);
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  });
}

export { main };
