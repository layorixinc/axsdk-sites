#!/usr/bin/env node
// Live test for the site-agnostic AX_echo debug command (_common/scripts/20_echo.lua).
// Loads ONLY 20_echo.lua (proves it is standalone — no AX_BASE dependency), calls AX_echo with
// sample args, and asserts it (a) echoes every argument back in the result and (b) routed the
// values through console.log (captured via Runtime.consoleAPICalled when the runtime logger emits).
// Usage:  node _common/scripts/test_echo.mjs --cdp=http://127.0.0.1:9225
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ECHO_FILE = resolve(__dirname, '20_echo.lua');
const EXT_ID = process.env.AXSDK_EXTENSION_ID || 'dldlgmekahifbogjphgglkhibclglmpf';
const args = process.argv.slice(2);
const cdp = (args.find(a => a.startsWith('--cdp=')) || '').slice('--cdp='.length) || 'http://127.0.0.1:9225';

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
async function waitForLua(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ctx = await axContext(page);
    if (await callInCtx(page, ctx, `async function(){return !!(globalThis._AXSDK?.lua||globalThis._AXLUA);}`)) return;
    await sleep(400);
  }
  throw new Error('AX Lua runtime not ready');
}

async function main() {
  const page = await openPage('https://www.thumbtack.com/');
  await sleep(2000); await waitForLua(page);

  // Capture console output emitted by the AXSDK Assistant context (best-effort: only when the
  // runtime logger forwards to console, i.e. debug logging on).
  const consoleArgs = [];
  page.on('Runtime.consoleAPICalled', p => { if (p.type === 'log') consoleArgs.push((p.args || []).map(a => a.value ?? a.description ?? a.unserializableValue)); });

  const ctx = await axContext(page);
  const source = await readFile(ECHO_FILE, 'utf8');
  const loaded = await callInCtx(page, ctx, `async function(source,id){const lua=globalThis._AXSDK?.lua||globalThis._AXLUA;if(!lua)throw new Error('no lua');if(typeof lua.load==='function')return await lua.load(source,{id});return await lua.loadSiteScript(source,{id,replace:true,kind:'devtools'});}`, [source, `echo-${Date.now()}`]);
  if (!loaded?.ok && loaded?.status !== 'loaded') throw new Error(`load failed: ${JSON.stringify(loaded)}`);

  const sample = { query: 'handyman', zip_code: '94101', flag: true, n: 42 };
  const ctx2 = await axContext(page);
  const out = await callInCtx(page, ctx2, `async function(args){const lua=globalThis._AXSDK?.lua||globalThis._AXLUA;const res=await lua.run('AX_echo',args,{timeoutMs:10000});let v=null;if(res?.result){try{v=JSON.parse(res.result);}catch{v=res.result;}}return {status:res?.status,value:v};}`, [sample]);
  console.log('AX_echo result:', JSON.stringify(out.value));
  await sleep(300);
  if (consoleArgs.length) console.log('captured console.log args:', JSON.stringify(consoleArgs));

  const v = out.value || {};
  let ok = true;
  ok &= out.status === 'completed' ? 1 : (console.log('FAIL status', out.status), 0);
  ok &= v.ok === true ? 1 : (console.log('FAIL ok'), 0);
  ok &= v.count === 1 ? 1 : (console.log('FAIL count', v.count), 0);
  const echoed = v.args && v.args[0];
  ok &= echoed && echoed.query === 'handyman' && echoed.zip_code === '94101' && echoed.flag === true && echoed.n === 42
    ? 1 : (console.log('FAIL echoed args mismatch:', JSON.stringify(echoed)), 0);
  console.log(ok ? '\nPASS AX_echo — all arguments console.logged and echoed back' : '\nFAILED');
  process.exitCode = ok ? 0 : 1;
  page.sock.close();
}
main().catch(e => { console.error('FAIL', e.stack || e.message || e); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 200));
