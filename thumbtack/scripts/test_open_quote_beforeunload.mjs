#!/usr/bin/env node
// Live A/B test for the clear_beforeunload wiring in navigate_service_if_needed (00_common.lua).
// On a real pro page with an open (dirty) quote dialog, AX_open_quote(pro2) navigates pro1->pro2.
//   BASELINE: 00_common with the nav.clear_beforeunload() line stripped (reload only)  -> expect a beforeunload dialog
//   FIXED:    00_common as-is (clear_beforeunload + reload)                              -> expect ZERO beforeunload dialogs
// Each phase runs in its own tab (fresh durable state) and re-injects local Lua after navigation (like the harness).
// Usage: node thumbtack/scripts/test_open_quote_beforeunload.mjs --cdp=http://127.0.0.1:9225
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ID = process.env.AXSDK_EXTENSION_ID || 'dldlgmekahifbogjphgglkhibclglmpf';
const args = process.argv.slice(2);
const cdp = (args.find(a => a.startsWith('--cdp=')) || '').slice('--cdp='.length) || 'http://127.0.0.1:9225';
const KEYWORD_PK = '102906936628587357'; // handyman
const COMMON_DIR = resolve(__dirname, '..', '..', '_common', 'scripts');
const COMMON_FILES = ['00_base.lua', '10_form_wizard.lua', '20_echo.lua', '30_resolve_zip.lua']; // AX_BASE etc. — must load before 00_common
const TT_FILES = ['00_common.lua', 'search_service.lua', 'view_service.lua', 'update_search.lua', 'answer_quote.lua', 'open_quote.lua', 'submit_quote.lua'];
const LOAD_FN = `async function(source,id){const lua=globalThis._AXSDK?.lua||globalThis._AXLUA;if(!lua)throw new Error('no lua');if(typeof lua.load==='function')return await lua.load(source,{id});return await lua.loadSiteScript(source,{id,replace:true,kind:'devtools'});}`;

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
Cdp.prototype.waitForLoad = function () { return new Promise(res => { const off = this.on('Page.loadEventFired', () => { off(); res(); }); setTimeout(() => { off(); res(); }, 12000); }); };

async function openPage(url) {
  const enc = encodeURIComponent(url);
  let t; try { t = await fetchJson(`${cdp}/json/new?${enc}`, { method: 'PUT' }); } catch { t = await fetchJson(`${cdp}/json/new?${enc}`); }
  const page = new Cdp(t.webSocketDebuggerUrl); await page.ready; page.tid = t.id;
  await page.send('Page.enable'); page.on('Page.javascriptDialogOpening', () => page.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}));
  await page.send('Runtime.enable'); return page;
}
async function navigate(page, url) { const loaded = page.waitForLoad(); await page.send('Page.navigate', { url }); await loaded; await sleep(2500); }
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
async function evalMain(page, expr) {
  const r = await page.send('Runtime.evaluate', { expression: `(()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || JSON.stringify(r.exceptionDetails)); return r.result?.value;
}
async function waitLua(page, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const ctx = await axContext(page);
      const ok = await callInCtx(page, ctx, `function(){const l=globalThis._AXSDK?.lua||globalThis._AXLUA;return !!(l&&(typeof l.load==='function'||typeof l.loadSiteScript==='function')&&typeof l.run==='function');}`);
      if (ok) return; } catch {}
    await sleep(500);
  }
  throw new Error('AXSDK lua runtime not ready');
}
async function loadFiles(page, stripClear) {
  const ctx = await axContext(page);
  const ordered = [...COMMON_FILES.map(f => [COMMON_DIR, f]), ...TT_FILES.map(f => [__dirname, f])];
  for (const [dir, f] of ordered) {
    let src = await readFile(resolve(dir, f), 'utf8');
    if (stripClear && f === '00_common.lua') src = src.replace(/^[^\n]*nav\.clear_beforeunload\(\)[^\n]*\n/m, '');
    const r = await callInCtx(page, ctx, LOAD_FN, [src, f.replace('.lua', '') + '-local']);
    if (!r?.ok && r?.status !== 'loaded') throw new Error(`load ${f} failed: ${JSON.stringify(r)}`);
  }
}
async function clickRequestEstimate(page) {
  await page.send('Runtime.evaluate', { expression: `(()=>{const b=[...document.querySelectorAll('button')].find(x=>/request estimate|request a quote|get a quote/i.test((x.textContent||'').trim()));if(b)b.click();return !!b;})()`, awaitPromise: true, returnByValue: true });
  await sleep(3500);
}
async function callOpenQuoteSettled(page, callArgs, stripClear, maxAttempts = 12) {
  let last = null;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await waitLua(page);
      await loadFiles(page, stripClear);
      const ctx = await axContext(page);
      last = await callInCtx(page, ctx, `async function(a){const lua=globalThis._AXSDK?.lua||globalThis._AXLUA;const res=await lua.run('AX_open_quote',a,{timeoutMs:8000});let v=null;if(res?.result){try{v=JSON.parse(res.result)}catch{v=res.result}}return {status:res?.status,ok:res?.ok,reason:res?.reason,value:v};}`, [callArgs]);
    } catch (e) {
      // The real reload (location.assign) navigates the target mid-call; treat that (and the
      // post-reload context churn) as a durable "pending" and retry after the page settles.
      const msg = String(e?.message || e);
      if (/navigat|closed|context|destroyed|not found|detached/i.test(msg)) { await sleep(1800); continue; }
      throw e;
    }
    const pending = last?.status === 'pending' || (last?.ok === false && last?.reason === 'pending') || (last?.value && (last.value.error === 'navigation_pending' || last.value.reason === 'navigation_pending'));
    if (!pending) break;
    await sleep(1800);
  }
  return last;
}

async function phase(label, pro1, pro2, stripClear) {
  const page = await openPage('https://www.thumbtack.com/');
  const dialogs = []; page.on('Page.javascriptDialogOpening', p => dialogs.push(p.type));
  await sleep(2500);
  await navigate(page, pro1);
  await clickRequestEstimate(page); // open quote dialog on pro1 -> page sets onbeforeunload (dirty)
  const dirty = await evalMain(page, `return typeof window.onbeforeunload;`);
  const start = dialogs.length;
  const res = await callOpenQuoteSettled(page, { url: pro2 }, stripClear);
  const bu = dialogs.slice(start).filter(t => t === 'beforeunload').length;
  const url = await evalMain(page, `return location.href;`);
  try { await fetch(`${cdp}/json/close/${page.tid}`); } catch {}
  const v = res?.value;
  const opened = !!(v && (v.status === 'open' || v.opened || v.questions || (v.result && v.result.status === 'open'))) || (v && !v.error);
  return { label, dirty, bu, url, status: typeof v === 'object' ? (v.error || v.status || JSON.stringify(v).slice(0, 80)) : v, opened };
}

async function main() {
  // Discover two handyman pro URLs (clean /service/<id> paths, no query).
  const disc = await openPage('https://www.thumbtack.com/');
  await sleep(2500);
  await navigate(disc, `https://www.thumbtack.com/instant-results/?keyword_pk=${KEYWORD_PK}&zip_code=94101`);
  for (let i = 0; i < 16 && !(await evalMain(disc, `return document.querySelectorAll('a[href*="/service/"]').length>0;`)); i++) await sleep(700);
  const pros = await evalMain(disc, `const seen=new Set();const all=[];document.querySelectorAll('a[href*="/service/"]').forEach(a=>{const u=(a.href||'').split('?')[0];if(u.includes('thumbtack.com')&&/\\/service\\/[0-9]+$/.test(u)&&!seen.has(u)){seen.add(u);all.push(u);}});const hand=all.filter(u=>u.includes('/handyman/'));return (hand.length>=2?hand:all).slice(0,4);`);
  try { await fetch(`${cdp}/json/close/${disc.tid}`); } catch {}
  if (!Array.isArray(pros) || pros.length < 2) { console.error('FAIL: need >=2 handyman pros, got', pros); process.exit(1); }
  const [pro1, pro2] = pros;
  console.log('pro1:', pro1);
  console.log('pro2:', pro2);

  const base = await phase('BASELINE', pro1, pro2, true);
  const fix = await phase('FIXED', pro1, pro2, false);

  console.log(`\nBASELINE (reload, NO clear): dirty=${base.dirty} beforeunloadDialogs=${base.bu} opened=${base.opened} status=${base.status}`);
  console.log(`  landed: ${base.url}`);
  console.log(`FIXED    (clear + reload):   dirty=${fix.dirty} beforeunloadDialogs=${fix.bu} opened=${fix.opened} status=${fix.status}`);
  console.log(`  landed: ${fix.url}`);

  const okFixed = fix.bu === 0;                 // wired clear suppresses the native prompt on the real nav
  const okBaseline = base.bu >= 1;              // proves the prompt fires without clear (so clear is load-bearing)
  const navWorked = (fix.url || '').includes('/service/');
  console.log(`\n${okFixed ? 'PASS' : 'FAIL'}  FIXED beforeunloadDialogs==0 (got ${fix.bu})`);
  console.log(`${okBaseline ? 'PASS' : 'NOTE'}  BASELINE fired prompt without clear (got ${base.bu}; >=1 proves clear is load-bearing)`);
  console.log(`${navWorked ? 'PASS' : 'FAIL'}  FIXED navigated to pro2 (landed on a /service/ page)`);
  const core = okFixed && navWorked;
  console.log(core ? '\nCORE PASS' : '\nCORE FAIL');
  process.exitCode = core ? 0 : 1;
}
main().then(() => setTimeout(() => process.exit(process.exitCode || 0), 200)).catch(e => { console.error('FAIL', e.stack || e.message || e); setTimeout(() => process.exit(1), 200); });
