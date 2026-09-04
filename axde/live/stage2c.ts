/**
 * Stage 2c live gate: a working copy's flows, Lua and runtime modules in a real profile's stores,
 * and out again.
 *
 * Offline tests reach the decisions and the receipt; they cannot reach the thing that matters — that
 * the bytes are in `chrome.storage.local` where the extension reads them, under the keys and shapes
 * core rehydrates. A wrong envelope shape is rehydrated as an EMPTY store and reports nothing, which
 * is exactly the failure a fake cannot have.
 *
 * What this gate deliberately does NOT claim: that a turn works. A client flow document is compiled
 * when a session opens and nothing here opens one, so delivery is proven and consumption is stage
 * 2d's.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  connectCdp, evaluate, probeDebugger,
} from '../../../axsdk-sdk-js/packages/axsdk-extension-cdp/scripts/browser-session.mjs';

const AXDE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITES_ROOT = resolve(AXDE, '..');
const EXTENSION_ID = 'ihdaghiiieaomningbeokfdkcpnpihpb';

type Run = { code: number; out: string };

let profileRoot = '';

async function axde(...args: string[]): Promise<Run> {
  const child = Bun.spawn([process.execPath, 'axde/src/cli.ts', ...args], {
    cwd: SITES_ROOT,
    env: { ...process.env, AXSDK_PROFILE_ROOT: profileRoot },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, out: `${stdout}${stderr}`.trim() };
}

const checks: string[] = [];

function ok(what: string, condition: unknown, evidence: string) {
  if (!condition) throw new Error(`${what}\n  observed: ${evidence}`);
  checks.push(what);
  console.log(`  ok  ${what}`);
}

async function expectOk(...args: string[]): Promise<string> {
  const { code, out } = await axde(...args);
  if (code !== 0) throw new Error(`axde ${args.join(' ')} exited ${code}\n  observed: ${out}`);
  return out;
}

const recordedPort = () => JSON.parse(
  readFileSync(join(profileRoot, 'packdev', 'axde-profile.json'), 'utf8'),
).port as number;

/**
 * The stores, read through a channel that shares nothing with the writer: a fresh CDP connection to
 * the launched browser and its own options page.
 */
async function readStores(port: number) {
  const version = await probeDebugger(port);
  if (!version) throw new Error(`no browser on :${port}`);
  const cdp = await connectCdp(version.webSocketDebuggerUrl);
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
    return await evaluate(cdp, sessionId, `(async () => {
      const keys = ['axsdk:sites', 'axsdk:flows', 'axsdk:lua', 'axsdk:lua-modules', 'axsdk:widgets'];
      const held = await chrome.storage.local.get(keys);
      const present = keys.filter((key) => typeof held[key] === 'string');
      const flows = held['axsdk:flows'] ? Object.keys(JSON.parse(held['axsdk:flows']).state.flows) : [];
      const lua = held['axsdk:lua'] ? JSON.parse(held['axsdk:lua']).state.lua : {};
      const modules = held['axsdk:lua-modules']
        ? Object.values(JSON.parse(held['axsdk:lua-modules']).state.lua)
          .flatMap((slot) => Object.keys(JSON.parse(slot)))
        : [];
      const sites = held['axsdk:sites'] ? JSON.parse(held['axsdk:sites']).state : undefined;
      return {
        present,
        flowLayers: flows.sort(),
        luaLayers: Object.keys(lua).sort(),
        commonLua: (lua[':'] ?? '').slice(0, 4000),
        siteLua: (lua[':dev'] ?? '').slice(0, 2000),
        modules: modules.sort(),
        indexSource: sites?.index?.source ?? null,
        sitemapBytes: (sites?.sites?.dev?.sitemapMd ?? '').length,
      };
    })()`) as any;
  } finally {
    cdp.close();
  }
}

async function main() {
  profileRoot = join(mkdtempSync(join(tmpdir(), 'axde-stage2c-')), 'profiles');
  let port = 0;
  try {
    console.log('profile new + ext install');
    await expectOk('profile', 'new', 'packdev');
    port = recordedPort();
    await expectOk('ext', 'install', 'packdev');

    // What the workspace WOULD store, computed with no browser at all.
    const sources = await expectOk('sources');
    const digest = sources.match(/digest ([0-9a-f]{12})/)?.[1];
    ok('sources reports a digest and the layers, with no browser',
      digest !== undefined && /:dev\s+lua/.test(sources), sources);

    console.log('up');
    const first = await expectOk('up', 'packdev');
    ok('up writes and restarts the host', /stores\s+written · host restarted/.test(first), first);
    ok('and its receipt carries the same digest sources reported',
      first.includes(digest!), first);
    ok('the module store is named with the module IN it, not just a byte count',
      /_common\.10_dev/.test(first), first);
    ok('and it says what it did not check',
      /not run\s+check:flows/.test(first) && /session/.test(first), first);

    await expectOk('launch', 'packdev');
    const stored = await readStores(port);
    ok('all five stores are there', stored.present.length === 5, JSON.stringify(stored.present));
    ok('the flow layer arrived', stored.flowLayers.includes(':'), JSON.stringify(stored.flowLayers));
    ok('both Lua layers arrived, keyed by domain',
      stored.luaLayers.join(',') === ':,:dev', JSON.stringify(stored.luaLayers));
    ok('the common layer is MERGED by the loader, one vararg function per file',
      stored.commonLua.includes('AX_dev_echo') && stored.commonLua.includes('(function(...)'),
      stored.commonLua.slice(0, 200));
    ok('the site layer is the site\'s own file', stored.siteLua.includes('AX_dev_site'),
      stored.siteLua.slice(0, 200));
    ok('the runtime module is in the module store, by name',
      stored.modules.join(',') === '_common.10_dev', JSON.stringify(stored.modules));
    ok('the index is marked local, or core would clear it at start',
      stored.indexSource === 'local', String(stored.indexSource));
    ok('the site record carries the sitemap, which is what currentSitemap is read from',
      stored.sitemapBytes > 0, String(stored.sitemapBytes));

    const again = await expectOk('up', 'packdev');
    ok('a second up answers unchanged', /stores\s+unchanged/.test(again), again);
    ok('and restarts nothing — the comparison is scoped to what the workspace owns',
      !/host restarted/.test(again), again);

    const down = await expectOk('down', 'packdev');
    ok('down removes all five stores', /axsdk:lua-modules/.test(down) && /published sources return/.test(down), down);
    const cleared = await readStores(port);
    ok('and the profile really holds none of them', cleared.present.length === 0,
      JSON.stringify(cleared.present));

    const twice = await expectOk('down', 'packdev');
    ok('down on a profile that carries nothing says so', /nothing stored/.test(twice), twice);

    // The product workspace is the same command with one flag, and the case §13 warns about: a flow
    // layer over 256 KiB is SPLIT into slots, and core has to rejoin them before it applies one.
    const product = await expectOk('up', 'packdev', '--workspace', '.');
    ok('the product workspace delivers, and its generated module is current',
      /62_rpc_sites\.lua up-to-date/.test(product) && /stores\s+written/.test(product), product);
    ok('its flow layer is reported as SPLIT, not as one value',
      /flows [\d.]+ KiB \(\d+ slots\)/.test(product), product);
    const big = await readStores(port);
    ok('and the store really holds the slots, numbered from the base key',
      big.flowLayers.includes(':') && big.flowLayers.includes(':|2'), JSON.stringify(big.flowLayers));
    ok('every site layer arrived with it', big.luaLayers.length >= 10, String(big.luaLayers.length));
    ok('and the runtime modules are named in the module store',
      big.modules.includes('_common.62_rpc_sites') && big.modules.length >= 25,
      String(big.modules.length));
    await expectOk('down', 'packdev');

    const foreign = join(profileRoot, 'someone-elses');
    Bun.spawnSync(['cmd', '/c', 'mkdir', foreign.replaceAll('/', '\\')]);
    for (const verb of ['up', 'down']) {
      const refused = await axde(verb, 'someone-elses');
      ok(`${verb} on a foreign profile is refused BY NAME`,
        refused.code === 1 && /did not create "someone-elses"/.test(refused.out), refused.out);
    }

    console.log(`\nAXDE STAGE 2C LIVE PASS — ${checks.length} checks`);
  } finally {
    if (port && await probeDebugger(port)) await axde('stop', 'packdev').catch(() => undefined);
    rmSync(profileRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`\nAXDE STAGE 2C LIVE FAIL after ${checks.length} checks`);
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  });
}

export { main };
