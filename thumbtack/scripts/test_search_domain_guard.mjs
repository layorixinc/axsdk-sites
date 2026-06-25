#!/usr/bin/env node
// Standalone live test for AX_search_service's off-domain guard. Loads 00_base + 00_common +
// search_service (+ a tiny probe) into the AXSDK Lua runtime, starts on an EXTERNAL page
// (google.com by default), and asserts AX_search_service first navigates to the Thumbtack home
// page before searching. Usage:
//   node thumbtack/scripts/test_search_domain_guard.mjs --cdp=http://127.0.0.1:9225 [--url=https://www.google.com/]
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ID = process.env.AXSDK_EXTENSION_ID || 'dldlgmekahifbogjphgglkhibclglmpf';
const argv = process.argv.slice(2);
const cdp = (argv.find(a => a.startsWith('--cdp=')) || '').slice('--cdp='.length) || 'http://127.0.0.1:9225';
const startUrl = (argv.find(a => a.startsWith('--url=')) || '').slice('--url='.length) || 'https://www.google.com/';

const LUA_FILES = [
  resolve(__dirname, '..', '..', '_common', 'scripts', '00_base.lua'),
  resolve(__dirname, '00_common.lua'),
  resolve(__dirname, 'search_service.lua'),
];
// Probe exposes the domain predicate + current URL so the test can assert classification directly.
const PROBE_SRC = 'function AX__probe(args) local M = AX_THUMBTACK return { is_tt = M.is_thumbtack_domain(), url = M.current_url() } end';

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
const LOAD_FN = `async function(source,id){const lua=globalThis._AXSDK?.lua||globalThis._AXLUA;if(!lua)throw new Error('no lua');if(typeof lua.load==='function')return await lua.load(source,{id});return await lua.loadSiteScript(source,{id,replace:true,kind:'devtools'});}`;
async function loadScripts(page) {
  const ctx = await axContext(page);
  const stamp = Date.now();
  for (const f of LUA_FILES) {
    const src = await readFile(f, 'utf8');
    const id = `dg-${f.split(/[\\/]/).pop()}-${stamp}`;
    const loaded = await callInCtx(page, ctx, LOAD_FN, [src, id]);
    if (!loaded?.ok && loaded?.status !== 'loaded') throw new Error(`load failed ${id}: ${JSON.stringify(loaded)}`);
  }
  const probe = await callInCtx(page, ctx, LOAD_FN, [PROBE_SRC, `dg-probe-${stamp}`]);
  if (!probe?.ok && probe?.status !== 'loaded') throw new Error(`probe load failed: ${JSON.stringify(probe)}`);
}
async function runLua(page, cmd, argsObj) {
  const ctx = await axContext(page);
  return await callInCtx(page, ctx,
    `async function(cmd, argsJson){const lua=globalThis._AXSDK?.lua||globalThis._AXLUA;const res=await lua.run(cmd, JSON.parse(argsJson), {timeoutMs:8000});let v=null;if(res?.result){try{v=JSON.parse(res.result);}catch{v=res.result;}}return {status:res?.status,value:v};}`,
    [cmd, JSON.stringify(argsObj)]);
}
async function pageUrl(page) { try { const r = await page.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }); return String(r.result?.value || ''); } catch { return ''; } }
async function waitForUrl(page, sub, timeoutMs) { const d = Date.now() + timeoutMs; let u = await pageUrl(page); while (Date.now() < d && !u.includes(sub)) { await sleep(400); u = await pageUrl(page); } return u; }

function check(name, cond, detail) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`); return !!cond; }

async function main() {
  const page = await openPage(startUrl);
  let ok = true;
  try {
    await sleep(2000);
    await loadScripts(page);

    // 1. The external start page is classified as off-domain.
    const p1 = await runLua(page, 'AX__probe', {});
    ok = check('external host -> is_thumbtack_domain=false', p1.value && p1.value.is_tt === false, p1.value) && ok;

    // 2. Off-domain AX_search_service fires the home navigation. Either it returns the navigating
    //    guard signature, or its AXSDK context is torn down by the navigation it just triggered
    //    (callFunctionOn rejects) — both prove the guard fired.
    let s1 = null, s1err = null;
    try { s1 = await runLua(page, 'AX_search_service', { query: 'handyman', zip_code: '94101' }); }
    catch (e) { s1err = String((e && e.message) || e); }
    const navByReturn = !!(s1 && s1.value && s1.value.status === 'navigating'
      && s1.value.zip_code === undefined && Array.isArray(s1.value.candidates) && s1.value.candidates.length === 0);
    const navByTeardown = /navigated|closed|context|destroyed/i.test(s1err || '');
    ok = check('off-domain AX_search_service fires home navigation (guard signature or context-navigated)',
      navByReturn || navByTeardown, s1 ? s1.value : { error: s1err }) && ok;

    // 3. The guard actually navigated the browser to the Thumbtack home page. From an external host
    //    the ONLY path that lands on thumbtack.com is the domain guard (resolve_zip/start_search
    //    never navigate to the home URL), so this uniquely proves it.
    const landed = await waitForUrl(page, 'thumbtack.com', 15000);
    ok = check('guard navigated to thumbtack.com', /thumbtack\.com/.test(landed), { url: landed }) && ok;

    // 4. After landing the context is wiped (full reload) -> reload scripts; now on-domain so the
    //    guard will NOT fire and the normal search funnel runs.
    await sleep(1500);
    await loadScripts(page);
    const p2 = await runLua(page, 'AX__probe', {});
    ok = check('on thumbtack home -> is_thumbtack_domain=true (guard will NOT fire)', p2.value && p2.value.is_tt === true, p2.value) && ok;

    console.log(ok ? '\nALL PASS — AX_search_service navigates to Thumbtack home when started off-domain' : '\nSOME FAILED');
    process.exitCode = ok ? 0 : 1;
  } finally {
    try { page.sock.close(); } catch {}
  }
}
main().catch(e => { console.error('FAIL', e.stack || e.message || e); process.exitCode = 1; });
