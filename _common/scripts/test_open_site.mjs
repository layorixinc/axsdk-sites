#!/usr/bin/env node
// Standalone live test for _common/scripts/00_navigate.lua. Loads ONLY 00_navigate.lua into the
// AXSDK Lua runtime (no site scripts), then exercises AX_open_site starting from an external,
// non-Thumbtack page:
//   - missing target / unknown site resolve in place with status="error" (no navigation)
//   - site="thumbtack" while off-site fires a durable navigation to thumbtack.com
//   - site="thumbtack" once on thumbtack is a no-op (status="ready")
// Usage: node _common/scripts/test_open_site.mjs --cdp=http://127.0.0.1:9225
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ID = process.env.AXSDK_EXTENSION_ID || 'dldlgmekahifbogjphgglkhibclglmpf';
const args = process.argv.slice(2);
const cdp = (args.find(a => a.startsWith('--cdp=')) || '').slice('--cdp='.length) || 'http://127.0.0.1:9225';
const START_URL = 'https://example.com/';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fetchJson = async (u, init) => { const r = await fetch(u, init); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };

class Cdp {
  constructor(ws) { this.id = 1; this.pending = new Map(); this.listeners = new Map(); this.sock = new WebSocket(ws);
    this.ready = new Promise((res, rej) => { this.sock.addEventListener('open', res, { once: true }); this.sock.addEventListener('error', rej, { once: true }); });
    this.sock.addEventListener('message', e => { const m = JSON.parse(String(e.data));
      if (m.id) { const cb = this.pending.get(m.id); if (!cb) return; this.pending.delete(m.id); m.error ? cb.rej(new Error(m.error.message)) : cb.res(m.result || {}); return; }
      const ls = this.listeners.get(m.method); if (ls) for (const l of [...ls]) l(m.params || {}); }); }
  on(method, fn) { const s = this.listeners.get(method) || new Set(); s.add(fn); this.listeners.set(method, s); return () => s.delete(fn); }
  async send(method, params = {}) { await this.ready; const id = this.id++; const p = new Promise((res, rej) => this.pending.set(id, { res, rej })); this.sock.send(JSON.stringify({ id, method, params })); return p; }
}

async function openPage(url) {
  const enc = encodeURIComponent(url);
  let t; try { t = await fetchJson(`${cdp}/json/new?${enc}`, { method: 'PUT' }); } catch { t = await fetchJson(`${cdp}/json/new?${enc}`); }
  const page = new Cdp(t.webSocketDebuggerUrl); await page.ready;
  await page.send('Page.enable'); page.on('Page.javascriptDialogOpening', () => page.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}));
  await page.send('Runtime.enable'); return page;
}
async function axContext(page) {
  const ctxs = []; const off = page.on('Runtime.executionContextCreated', e => ctxs.push(e.context));
  await page.send('Runtime.disable').catch(() => {}); await page.send('Runtime.enable');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const c = ctxs.find(c => c.name === 'AXSDK Assistant' && c.origin === `chrome-extension://${EXT_ID}`); if (c) { off(); return c.id; } await sleep(100); }
  off(); throw new Error('AXSDK Assistant context not found');
}
async function callInCtx(page, ctxId, fn, a = []) {
  const r = await page.send('Runtime.callFunctionOn', { functionDeclaration: fn, arguments: a.map(v => ({ value: v })), executionContextId: ctxId, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || JSON.stringify(r.exceptionDetails)); return r.result?.value;
}
// Load 00_navigate.lua, retrying while the runtime re-initializes after a navigation (a fresh page
// can report the AXSDK context before globalThis._AXSDK.lua is wired up).
async function loadNav(page, attempts = 10) {
  const src = await readFile(resolve(__dirname, '00_navigate.lua'), 'utf8');
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const ctx = await axContext(page);
      const loaded = await callInCtx(page, ctx, `async function(source,id){const lua=globalThis._AXSDK?.lua||globalThis._AXLUA;if(!lua)throw new Error('no lua');if(typeof lua.load==='function')return await lua.load(source,{id});return await lua.loadSiteScript(source,{id,replace:true,kind:'devtools'});}`, [src, `nav-${Date.now()}`]);
      if (!loaded?.ok && loaded?.status !== 'loaded') throw new Error('load failed: ' + JSON.stringify(loaded));
      return;
    } catch (e) { lastErr = e; await sleep(1500); }
  }
  throw lastErr;
}
async function openSite(page, a, timeoutMs = 8000) {
  const ctx = await axContext(page);
  try {
    return await callInCtx(page, ctx, `async function(a){const lua=globalThis._AXSDK?.lua||globalThis._AXLUA;const res=await lua.run('AX_open_site',a,{timeoutMs:${timeoutMs}});let v=null;if(res?.result){try{v=JSON.parse(res.result);}catch{v=res.result;}}return {status:res?.status,value:v};}`, [a]);
  } catch (e) { return { status: 'threw', value: null, err: String(e?.message || e) }; }
}
async function currentUrl(page) {
  const r = await page.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }).catch(() => null);
  return r?.result?.value || '';
}
async function waitForUrl(page, substr, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const u = await currentUrl(page); if (u.includes(substr)) return u; await sleep(300); }
  return '';
}

function checkErr(name, got, expectErr) { const v = got?.value || {}; const ok = v.status === 'error' && v.error === expectErr; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: status=${v.status} error=${v.error}`); return ok; }
function checkReady(name, got) { const v = got?.value || {}; const ok = v.status === 'ready'; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: status=${v.status} url=${v.url || ''}`); return ok; }
function checkTrue(name, ok, detail) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail || ''}`); return ok; }

async function main() {
  const page = await openPage(START_URL);
  let allOk = true;
  try {
    await sleep(1500); await loadNav(page);

    // Error cases resolve in place (no navigation).
    allOk &= checkErr('missing target -> error', await openSite(page, {}), 'missing_target');
    allOk &= checkErr('unknown site -> error', await openSite(page, { site: 'definitely-not-a-site' }), 'unknown_site');

    // Off-site: fires a durable navigation to thumbtack.com (return value ignored; assert via URL).
    await openSite(page, { site: 'thumbtack' });
    const landed = await waitForUrl(page, 'thumbtack.com', 15000);
    allOk &= checkTrue('off-site -> navigates to thumbtack', !!landed, `url=${landed}`);

    // On-site: no-op ready (reload the script since the navigation destroyed the Lua context).
    await sleep(2500); await loadNav(page);
    allOk &= checkReady('on thumbtack -> ready (no-op)', await openSite(page, { site: 'thumbtack' }));
  } finally {
    try { page.sock.close(); } catch {}
  }
  console.log(allOk ? '\nALL PASS' : '\nSOME FAILED');
  return allOk ? 0 : 1;
}
main().then(code => process.exit(code)).catch(e => { console.error('FAIL', e.stack || e.message || e); process.exit(1); });
