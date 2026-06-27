#!/usr/bin/env node
// Direct live test for answer_quote.lua's args.answers branch (append_answer_updates ->
// dom.click(value.selector, { navigates = false })). The auto-flow takes a different path
// (update_request_flow_step -> advance_click), so this exercises the otherwise-cold line that
// fix A touched. Loads the full thumbtack Lua stack, opens a real Request-flow dialog on a pro,
// then calls AX_answer_quote with an explicit `answers` selector and asserts the option click
// applied (reason="clicked", ok=true).
// Usage: node thumbtack/scripts/test_answer_click.mjs --cdp=http://127.0.0.1:9225
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const commonDir = resolve(repoRoot, '_common', 'scripts');
const scriptDir = resolve(repoRoot, 'thumbtack', 'scripts');
const COMMON_FILES = ['00_base.lua', '10_form_wizard.lua', '20_echo.lua', '30_resolve_zip.lua'];
const LUA_FILES = ['00_common.lua', 'search_service.lua', 'view_service.lua', 'update_search.lua', 'answer_quote.lua', 'detect_page.lua', 'open_quote.lua', 'submit_quote.lua'];
const EXT_ID = process.env.AXSDK_EXTENSION_ID || 'dldlgmekahifbogjphgglkhibclglmpf';
const args = process.argv.slice(2);
const cdp = (args.find(a => a.startsWith('--cdp=')) || '').slice('--cdp='.length) || 'http://127.0.0.1:9225';
const PRO_URL = 'https://www.thumbtack.com/ca/corte-madera/handyman/carlos-handyman/service/434157323831386115';
const OPTION_SELECTOR = '[data-test="request-flow-step--active"] label:has(input[type="radio"]), [data-test="request-flow-step--active"] label:has(input[type="checkbox"])';

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
async function loadAll(page) {
  const ctx = await axContext(page);
  const ordered = [...COMMON_FILES.map(f => [commonDir, f]), ...LUA_FILES.map(f => [scriptDir, f])];
  for (const [dir, file] of ordered) {
    const src = await readFile(resolve(dir, file), 'utf8');
    const loaded = await callInCtx(page, ctx, `async function(source,id){const lua=globalThis._AXSDK?.lua||globalThis._AXLUA;if(!lua)throw new Error('no lua');if(typeof lua.load==='function')return await lua.load(source,{id});return await lua.loadSiteScript(source,{id,replace:true,kind:'devtools'});}`, [src, `ttac-${file}-${Date.now()}`]);
    if (!loaded?.ok && loaded?.status !== 'loaded') throw new Error(`load failed ${file}: ${JSON.stringify(loaded)}`);
  }
}
async function runLua(page, command, a) {
  const ctx = await axContext(page);
  return callInCtx(page, ctx, `async function(cmd,args){const lua=globalThis._AXSDK?.lua||globalThis._AXLUA;const res=await lua.run(cmd,args,{timeoutMs:15000});let v=null;if(res?.result){try{v=JSON.parse(res.result);}catch{v=res.result;}}return {status:res?.status,value:v};}`, [command, a]);
}
async function evalPage(page, expr) { const r = await page.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.value; }

async function openDialog(page) {
  await evalPage(page, `(()=>{const b=[...document.querySelectorAll('button')].find(x=>/request estimate|request a quote|get a quote/i.test((x.textContent||'').trim()));if(b)b.click();return !!b;})()`);
  for (let i = 0; i < 20; i++) { if (await evalPage(page, `!!document.querySelector('[data-test="request-flow-step--active"]')`)) return true; await sleep(500); }
  return false;
}
async function optionCount(page) {
  return await evalPage(page, `(()=>{const a=document.querySelector('[data-test="request-flow-step--active"]');if(!a)return 0;return a.querySelectorAll('label:has(input[type=\"radio\"]), label:has(input[type=\"checkbox\"])').length;})()`) || 0;
}

async function main() {
  const page = await openPage('about:blank');
  await navigate(page, PRO_URL);
  await loadAll(page);
  const opened = await openDialog(page);
  if (!opened) { console.error('FAIL: request-flow dialog did not open'); process.exitCode = 1; page.sock.close(); return; }
  const opts = await optionCount(page);
  console.log('active-step option labels:', opts);
  if (!opts) { console.error('FAIL: active step has no radio/checkbox option to click'); process.exitCode = 1; page.sock.close(); return; }

  const res = await runLua(page, 'AX_answer_quote', { answers: { opt: { selector: OPTION_SELECTOR } } });
  const applied = (res?.value?.applied) || [];
  const entry = applied.find(e => e.kind === 'answer');
  console.log('status:', res?.status, '| applied answer entry:', JSON.stringify(entry));
  const ok = res?.status === 'completed' && entry && entry.ok === true && entry.reason === 'clicked';
  console.log(ok ? '\nPASS: args.answers path (answer_quote.lua:18, navigates=false) clicked the option' : '\nFAIL: answer click path did not click');
  process.exitCode = ok ? 0 : 1;
  page.sock.close();
}
main().catch(e => { console.error('FAIL', e.stack || e.message || e); process.exitCode = 1; });
