#!/usr/bin/env node
// Runs the SDK's Q1 experiment: does `clientLuaModules` reach the runtime?
//
// Their wire format is `[{ name, source }]`, read from `luaStore` (`axsdk:lua`), where each entry's VALUE
// is expected to be JSON `{ "<module>": "<source>" }`. Our `ax sync` writes RAW LUA to the same key —
// that is the whole stored-Lua feature (`stored-lua:` script ids, `fromStore: 11`). Two consumers, one
// key, two incompatible encodings, and their loader skips values that are not JSON. So before running
// anything we check WHAT is in the store; if it is raw Lua, their overlay could never have been observed
// here regardless of the wire format.
//
// Then the experiment itself, overlaying a module the runtime already loads with a source that answers a
// marker. If the marker comes back, the overlay is applied; if the real answer comes back, it is not.
// `inspect` reports; `overlay` installs; `restore` puts the saved value back.

import {
  CdpClient, DEFAULTS, callInAxContext, listTargets, pickPageTarget,
} from './harness/cdp.mjs';
import { readFile, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((entry) => entry.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const command = args.find((entry) => !entry.startsWith('--')) ?? 'inspect';
const port = Number(flag('port', DEFAULTS.port));
const extensionId = flag('extension-id', DEFAULTS.extensionId);
const backup = flag('backup', 'tools/.lua-store-backup.json');

// Which store key carries the overlay. Clobbering ':' — the common raw-Lua bundle — killed the assistant
// outright: the turn produced zero parts and nothing ran. So the experiment leaves that layer alone and
// uses the site key, which their loader reads too ("사이트 레이어가 같은 이름의 공통 모듈을 덮고").
const storeKey = flag('key', ':thumbtack');
const MODULE = '_common.71_rpc_zip';
// Answers a value no geocoder would produce, so the source of the answer is never in doubt.
const OVERRIDE = `AX_RPC_ZIP = AX_RPC_ZIP or {}
function AX_RPC_ZIP.resolve(args)
  return { next = "collect", zip_code = "00001", zip_source = "client_lua_module_overlay" }
end`;

const targets = await listTargets(`http://127.0.0.1:${port}`);
const target = pickPageTarget(targets, flag('match', undefined));
if (!target) throw new Error('no page target; run `node tools/ax.mjs open <site>` first');
const page = new CdpClient(target.webSocketDebuggerUrl);
await page.ready;

const inContext = (source, params = []) => callInAxContext(page, { extensionId }, source, params);

try {
  if (command === 'inspect') {
    const report = await inContext(`async function (key) {
      const got = await chrome.storage.local.get(key);
      const raw = got?.[key];
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const lua = parsed?.state?.lua ?? {};
      const out = {};
      for (const [storeKey, value] of Object.entries(lua)) {
        let encoding = 'raw-lua';
        try {
          const inner = JSON.parse(value);
          encoding = inner && typeof inner === 'object' && !Array.isArray(inner) ? 'json-modules' : 'json-other';
        } catch { /* not JSON: raw Lua, which is what stored-Lua wants */ }
        out[storeKey] = { encoding, bytes: String(value).length };
      }
      return out;
    }`, ['axsdk:lua']);
    console.log(JSON.stringify(report, null, 1));
  } else if (command === 'overlay') {
    const saved = await inContext(`async function (key) {
      const got = await chrome.storage.local.get(key);
      return got?.[key] ?? null;
    }`, ['axsdk:lua']);
    if (saved === null) throw new Error('no axsdk:lua in the store; run `node tools/ax.mjs sync <site>` first');
    await writeFile(backup, typeof saved === 'string' ? saved : JSON.stringify(saved), 'utf8');

    const result = await inContext(`async function (key, moduleName, source, which) {
      const got = await chrome.storage.local.get(key);
      const parsed = typeof got?.[key] === 'string' ? JSON.parse(got[key]) : got?.[key];
      const lua = { ...(parsed?.state?.lua ?? {}) };
      // Their format: the store VALUE is JSON mapping module name to source.
      lua[which] = JSON.stringify({ [moduleName]: source });
      await chrome.storage.local.set({ [key]: JSON.stringify({ state: { lua }, version: 0 }) });
      return { overlaidKey: which, keys: Object.keys(lua) };
    }`, ['axsdk:lua', MODULE, OVERRIDE, storeKey]);
    console.log(JSON.stringify(result));
    console.log(`backup written to ${backup}; run \`restore\` (or \`ax sync\`) afterwards`);
  } else if (command === 'restore') {
    const saved = await readFile(backup, 'utf8');
    const result = await inContext(`async function (key, value) {
      await chrome.storage.local.set({ [key]: value });
      return { restored: true, bytes: value.length };
    }`, ['axsdk:lua', saved]);
    console.log(JSON.stringify(result));
  } else {
    throw new Error(`unknown command "${command}" (inspect | overlay | restore)`);
  }
} finally {
  await page.close();
}
