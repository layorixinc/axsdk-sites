#!/usr/bin/env node
// Direct live test for AX_update_search (a rebuilt command not auto-covered by the multi-quote
// harness when a query has only radio/checkbox filters). Loads the full common+thumbtack stack,
// navigates to a results page, reads service_options via AX_search_service, then calls
// AX_update_search with a real option value and asserts it succeeds + returns candidates.
// Usage:  node thumbtack/scripts/test_update_search.mjs --cdp=http://127.0.0.1:9225
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const commonDir = resolve(repoRoot, '_common', 'scripts');
const scriptDir = resolve(repoRoot, 'thumbtack', 'scripts');
const COMMON_FILES = ['00_base.lua', '10_form_wizard.lua', '30_resolve_zip.lua'];
const LUA_FILES = ['00_common.lua', 'search_service.lua', 'view_service.lua', 'update_search.lua', 'answer_quote.lua', 'open_quote.lua', 'submit_quote.lua'];
const EXT_ID = process.env.AXSDK_EXTENSION_ID || 'dldlgmekahifbogjphgglkhibclglmpf';
const args = process.argv.slice(2);
const cdp = (args.find(a => a.startsWith('--cdp=')) || '').slice('--cdp='.length) || 'http://127.0.0.1:9225';
const QUERY = 'handyman';
const ZIP = '94101';

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
async function waitForLua(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ctx = await axContext(page);
    if (await callInCtx(page, ctx, `async function(){return !!(globalThis._AXSDK?.lua||globalThis._AXLUA);}`)) return;
    await sleep(400);
  }
  throw new Error('AX Lua runtime not ready');
}
async function loadAll(page) {
  const ctx = await axContext(page);
  for (const [dir, file] of [...COMMON_FILES.map(f => [commonDir, f]), ...LUA_FILES.map(f => [scriptDir, f])]) {
    const source = await readFile(resolve(dir, file), 'utf8');
    const loaded = await callInCtx(page, ctx, `async function(source,id){const lua=globalThis._AXSDK?.lua||globalThis._AXLUA;if(!lua)throw new Error('no lua');if(typeof lua.load==='function')return await lua.load(source,{id});return await lua.loadSiteScript(source,{id,replace:true,kind:'devtools'});}`, [source, `ut-${file}-${Date.now()}`]);
    if (!loaded?.ok && loaded?.status !== 'loaded') throw new Error(`load failed ${file}: ${JSON.stringify(loaded)}`);
  }
}
async function runCmd(page, command, cmdArgs) {
  const ctx = await axContext(page);
  return callInCtx(page, ctx, `async function(command,args){const lua=globalThis._AXSDK?.lua||globalThis._AXLUA;const res=await lua.run(command,args,{timeoutMs:20000});let v=null;if(res?.result){try{v=JSON.parse(res.result);}catch{v=res.result;}}return {status:res?.status,value:v};}`, [command, cmdArgs]);
}

async function main() {
  const page = await openPage('https://www.thumbtack.com/');
  await sleep(2000); await waitForLua(page);
  await navigate(page, `https://www.thumbtack.com/instant-results/?keyword_pk=102906936628587357&zip_code=${ZIP}`);
  await waitForLua(page); await loadAll(page);

  // Two-phase: first search may report navigating; retry once after settle.
  let search = await runCmd(page, 'AX_search_service', { query: QUERY, zip_code: ZIP });
  if (!(search.value?.candidates?.length)) { await sleep(1500); search = await runCmd(page, 'AX_search_service', { query: QUERY, zip_code: ZIP }); }
  const opts = search.value?.service_options || [];
  console.log('search status:', search.value?.status, 'candidates:', search.value?.candidates?.length, 'option_groups:', opts.length);

  // Pick a real option value: first group with a non-selected choice.
  let pick = null;
  for (const g of opts) {
    const choices = g.choices || [];
    for (const c of choices) {
      const text = typeof c === 'string' ? c : (c.text || c.label);
      if (text) { pick = { value: text, option: g.title || g.group }; break; }
    }
    if (pick) break;
  }
  if (!pick) { console.error('FAIL: no option value found in service_options', JSON.stringify(opts).slice(0, 400)); process.exitCode = 1; page.sock.close(); return; }
  console.log('update_search pick:', JSON.stringify(pick));

  const upd = await runCmd(page, 'AX_update_search', { value: pick.value, option: pick.option });
  console.log('update_search result:', JSON.stringify(upd.value).slice(0, 400));

  const v = upd.value || {};
  let ok = true;
  ok &= (upd.status === 'completed') ? 1 : (console.log('FAIL status', upd.status), 0);
  ok &= v.ok === true ? 1 : (console.log('FAIL not ok:', v.error || v.reason), 0);
  ok &= Array.isArray(v.candidates) ? 1 : (console.log('FAIL no candidates array'), 0);
  console.log(ok ? `\nPASS AX_update_search ok=${v.ok} updated=${JSON.stringify(v.updated)} candidates=${v.candidates?.length}` : '\nFAILED');
  process.exitCode = ok ? 0 : 1;
  page.sock.close();
}
main().catch(e => { console.error('FAIL', e.stack || e.message || e); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 200));
