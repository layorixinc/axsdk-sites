#!/usr/bin/env node
// Live test for nav.clear_beforeunload(). Loads a tiny Lua probe into the AXSDK runtime on a real
// Thumbtack pro page, then verifies the page MAIN-world beforeunload is cleared end-to-end:
//   Lua (ISOLATED) -> document 'axsdk:clear-beforeunload' -> page-content.js (MAIN bridge) -> window.onbeforeunload=null
// Usage: node thumbtack/scripts/test_clear_beforeunload.mjs --cdp=http://127.0.0.1:9225
const EXT_ID = process.env.AXSDK_EXTENSION_ID || 'dldlgmekahifbogjphgglkhibclglmpf';
const args = process.argv.slice(2);
const cdp = (args.find(a => a.startsWith('--cdp=')) || '').slice('--cdp='.length) || 'http://127.0.0.1:9225';
const PRO_URL = 'https://www.thumbtack.com/ca/corte-madera/handyman/carlos-handyman/service/434157323831386115';
const PROBE = `function AX_clear_bu()\n  return nav.clear_beforeunload()\nend`;

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
  const page = new Cdp(t.webSocketDebuggerUrl); await page.ready;
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
    try {
      const ctx = await axContext(page);
      const ok = await callInCtx(page, ctx, `function(){const l=globalThis._AXSDK?.lua||globalThis._AXLUA;return !!(l&&(typeof l.load==='function'||typeof l.loadSiteScript==='function')&&typeof l.run==='function');}`);
      if (ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error('AXSDK lua runtime not ready');
}
async function loadProbe(page) {
  const ctx = await axContext(page);
  const loaded = await callInCtx(page, ctx, `async function(source,id){const lua=globalThis._AXSDK?.lua||globalThis._AXLUA;if(!lua)throw new Error('no lua');if(typeof lua.load==='function')return await lua.load(source,{id});return await lua.loadSiteScript(source,{id,replace:true,kind:'devtools'});}`, [PROBE, `clearbu-${Date.now()}`]);
  if (!loaded?.ok && loaded?.status !== 'loaded') throw new Error('probe load failed: ' + JSON.stringify(loaded));
}
async function callClear(page) {
  const ctx = await axContext(page);
  return callInCtx(page, ctx, `async function(){const lua=globalThis._AXSDK?.lua||globalThis._AXLUA;const res=await lua.run('AX_clear_bu',{},{timeoutMs:5000});let v=null;if(res?.result){try{v=JSON.parse(res.result)}catch{v=res.result}}return {status:res?.status,value:v};}`);
}
async function clickRequestEstimate(page) {
  await page.send('Runtime.evaluate', { expression: `(()=>{const b=[...document.querySelectorAll('button')].find(x=>/request estimate|request a quote|get a quote/i.test((x.textContent||'').trim()));if(b)b.click();return !!b;})()`, awaitPromise: true, returnByValue: true });
  await sleep(3500);
}

async function main() {
  const dialogs = [];
  const page = await openPage('https://www.thumbtack.com/');
  page.on('Page.javascriptDialogOpening', p => dialogs.push(p.type));
  await sleep(2500);
  await navigate(page, PRO_URL); // proven path: lua runtime initializes after an in-tab navigation
  await waitLua(page);
  await loadProbe(page);
  let allOk = true;

  // A: property handler cleared in page MAIN world + returns {ok:true}
  const before = await evalMain(page, `window.__hitP=0; window.onbeforeunload=function(){window.__hitP++;return 'dirty';}; return typeof window.onbeforeunload;`);
  const res = await callClear(page);
  const cleared = await evalMain(page, `return window.onbeforeunload===null;`);
  const okA = res?.status === 'completed' && res?.value?.ok === true && before === 'function' && cleared === true;
  console.log(`${okA ? 'PASS' : 'FAIL'}  A property-clear: returned=${JSON.stringify(res?.value)} before=${before} clearedInMainWorld=${cleared}`);
  allOk = allOk && okA;

  // B: after clear, dispatching beforeunload does NOT run the (removed) property handler
  await evalMain(page, `window.__hitP=0; window.onbeforeunload=function(){window.__hitP++;return 'dirty';};`);
  await callClear(page);
  const hitP = await evalMain(page, `const ev=new Event('beforeunload',{cancelable:true});window.dispatchEvent(ev);return window.__hitP;`);
  const okB = hitP === 0;
  console.log(`${okB ? 'PASS' : 'FAIL'}  B property-suppressed: handler hits after clear=${hitP} (expect 0)`);
  allOk = allOk && okB;

  // C: addEventListener('beforeunload') coverage — impl only nulls the property, so this may NOT clear
  await evalMain(page, `window.__hitA=0; window.__buAdd=function(){window.__hitA++;}; window.addEventListener('beforeunload',window.__buAdd);`);
  await callClear(page);
  const hitA = await evalMain(page, `const ev=new Event('beforeunload',{cancelable:true});window.dispatchEvent(ev);return window.__hitA;`);
  await evalMain(page, `window.removeEventListener('beforeunload',window.__buAdd);`);
  console.log(`${hitA === 0 ? 'PASS' : 'NOTE'}  C addEventListener-coverage: handler hits after clear=${hitA} (0=also cleared; >0=NOT cleared — impl nulls only the onbeforeunload property)`);

  // D (info): does the real Thumbtack quote dialog set window.onbeforeunload as a property?
  await clickRequestEstimate(page);
  const ttType = await evalMain(page, `return typeof window.onbeforeunload;`);
  console.log(`INFO  D thumbtack-dialog: typeof window.onbeforeunload=${ttType} (function => property-based, clear helps; otherwise uses addEventListener / no native guard)`);

  // E (info): real navigation after clear — no beforeunload dialog should block it
  await evalMain(page, `window.onbeforeunload=function(){return 'dirty';};`);
  await callClear(page);
  const t0 = Date.now();
  await navigate(page, 'https://www.thumbtack.com/');
  const buDialogs = dialogs.filter(t => t === 'beforeunload').length;
  console.log(`INFO  E real-nav after clear: ${Date.now() - t0}ms, beforeunload dialogs observed=${buDialogs}`);

  console.log(allOk ? '\nCORE PASS' : '\nCORE FAIL');
  process.exitCode = allOk ? 0 : 1;
  page.sock.close();
}
main().then(() => process.exit(process.exitCode || 0)).catch(e => { console.error('FAIL', e.stack || e.message || e); process.exit(1); });
