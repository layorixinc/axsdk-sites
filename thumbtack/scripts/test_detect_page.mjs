#!/usr/bin/env node
// Standalone live test for detect_page.lua. Loads ONLY detect_page.lua into the AXSDK Lua runtime
// (no other site scripts), navigates to each Thumbtack surface, and asserts AX_detect_page()
// classifies it correctly. Usage:
//   node thumbtack/scripts/test_detect_page.mjs --cdp=http://127.0.0.1:9225
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ID = process.env.AXSDK_EXTENSION_ID || 'dldlgmekahifbogjphgglkhibclglmpf';
const args = process.argv.slice(2);
const cdp = (args.find(a => a.startsWith('--cdp=')) || '').slice('--cdp='.length) || 'http://127.0.0.1:9225';
const KEYWORD_PK = '102906936628587357'; // handyman (from survey)
const PRO_URL = 'https://www.thumbtack.com/ca/corte-madera/handyman/carlos-handyman/service/434157323831386115';

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
async function navigate(page, url) { const loaded = page.waitForLoad(); await page.send('Page.navigate', { url }); await loaded; await sleep(2500); }
Cdp.prototype.waitForLoad = function () { return new Promise(res => { const off = this.on('Page.loadEventFired', () => { off(); res(); }); setTimeout(() => { off(); res(); }, 12000); }); };

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
async function loadDetect(page) {
  const ctx = await axContext(page);
  const src = await readFile(resolve(__dirname, 'detect_page.lua'), 'utf8');
  const loaded = await callInCtx(page, ctx, `async function(source,id){const lua=globalThis._AXSDK?.lua||globalThis._AXLUA;if(!lua)throw new Error('no lua');if(typeof lua.load==='function')return await lua.load(source,{id});return await lua.loadSiteScript(source,{id,replace:true,kind:'devtools'});}`, [src, `detect-${Date.now()}`]);
  if (!loaded?.ok && loaded?.status !== 'loaded') throw new Error('load failed: ' + JSON.stringify(loaded));
}
async function detect(page) {
  const ctx = await axContext(page);
  const r = await callInCtx(page, ctx, `async function(){const lua=globalThis._AXSDK?.lua||globalThis._AXLUA;const res=await lua.run('AX_detect_page',{},{timeoutMs:8000});let v=null;if(res?.result){try{v=JSON.parse(res.result);}catch{v=res.result;}}return {status:res?.status,value:v};}`);
  return r;
}
async function clickRequestEstimate(page) {
  await page.send('Runtime.evaluate', { expression: `(()=>{const b=[...document.querySelectorAll('button')].find(x=>/request estimate|request a quote|get a quote/i.test((x.textContent||'').trim()));if(b)b.click();return !!b;})()`, awaitPromise: true, returnByValue: true });
  await sleep(3500);
}

function check(name, got, expectPage) {
  const v = got?.value || {};
  const ok = got?.status === 'completed' && v.page === expectPage;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: page=${v.page} ready=${v.ready} service_id=${v.service_id || ''} zip=${v.zip_code || ''} keyword_pk=${v.keyword_pk || ''}`);
  return ok;
}

async function main() {
  const page = await openPage('https://www.thumbtack.com/');
  await sleep(2500); await loadDetect(page);
  let allOk = true;

  allOk &= check('home', await detect(page), 'home');

  await navigate(page, `https://www.thumbtack.com/instant-results/?keyword_pk=${KEYWORD_PK}&zip_code=94101`);
  await loadDetect(page); allOk &= check('instant_results', await detect(page), 'instant_results');

  await navigate(page, PRO_URL);
  await loadDetect(page); allOk &= check('pro_profile', await detect(page), 'pro_profile');

  await clickRequestEstimate(page); await loadDetect(page); allOk &= check('quote_dialog', await detect(page), 'quote_dialog');

  console.log(allOk ? '\nALL PASS' : '\nSOME FAILED');
  process.exitCode = allOk ? 0 : 1;
  page.sock.close();
}
main().catch(e => { console.error('FAIL', e.stack || e.message || e); process.exitCode = 1; });
