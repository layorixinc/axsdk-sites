#!/usr/bin/env node
// Standalone live smoke test for _common/scripts/00_base.lua (AX_BASE).
// Loads ONLY 00_base.lua + a tiny inline smoke command into the AXSDK Lua runtime, navigates to a
// Thumbtack pro page (so selector-first reads have real DOM), and asserts AX_BASE primitives work.
// Usage:  node thumbtack/scripts/test_base.mjs --cdp=http://127.0.0.1:9225
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ID = process.env.AXSDK_EXTENSION_ID || 'dldlgmekahifbogjphgglkhibclglmpf';
const args = process.argv.slice(2);
const cdp = (args.find(a => a.startsWith('--cdp=')) || '').slice('--cdp='.length) || 'http://127.0.0.1:9225';
const PRO_URL = 'https://www.thumbtack.com/ca/corte-madera/handyman/carlos-handyman/service/434157323831386115';
const BASE_PATH = resolve(__dirname, '..', '..', '_common', 'scripts', '00_base.lua');

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
async function loadSource(page, source, id) {
  const ctx = await axContext(page);
  const loaded = await callInCtx(page, ctx, `async function(source,id){const lua=globalThis._AXSDK?.lua||globalThis._AXLUA;if(!lua)throw new Error('no lua');if(typeof lua.load==='function')return await lua.load(source,{id});return await lua.loadSiteScript(source,{id,replace:true,kind:'devtools'});}`, [source, id]);
  if (!loaded?.ok && loaded?.status !== 'loaded') throw new Error('load failed: ' + JSON.stringify(loaded));
}
async function navigate(page, url) { const loaded = page.waitForLoad(); await page.send('Page.navigate', { url }); await loaded; await sleep(2500); }
// Poll the AXSDK Assistant context until the Lua runtime global is populated (context is created
// before _AXSDK.lua is assigned, and a fresh nav re-inits it), so loads don't hit "no lua".
async function waitForLua(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ctx = await axContext(page);
    const ready = await callInCtx(page, ctx, `async function(){return !!(globalThis._AXSDK?.lua||globalThis._AXLUA);}`);
    if (ready) return;
    await sleep(400);
  }
  throw new Error('AX Lua runtime not ready');
}
async function runSmoke(page) {
  const ctx = await axContext(page);
  const r = await callInCtx(page, ctx, `async function(){const lua=globalThis._AXSDK?.lua||globalThis._AXLUA;const res=await lua.run('AX_base_smoke',{},{timeoutMs:8000});let v=null;if(res?.result){try{v=JSON.parse(res.result);}catch{v=res.result;}}return {status:res?.status,value:v};}`);
  return r;
}

const SMOKE_LUA = `
function AX_base_smoke(args)
  local B = AX_BASE
  local fields = B.read_fields({
    name = { { selector = "h1" } },
    rating = { { selector = '[data-test="review-summary"]', parse = B.parse_rating } },
    missing = { { selector = '[data-test="definitely-not-present-xyz"]' } }
  })
  return {
    loaded = type(B) == "table",
    clean = B.clean_text("  a   b  "),
    non_empty_nil = B.non_empty("   ") == nil,
    normalize = B.normalize_text("  Hello   World "),
    truncate = B.truncate_text("abcdef", 4),
    dedupe = B.dedupe_adjacent("FooFoo"),
    rating = B.parse_rating("4.7 stars"),
    reviews = B.parse_review_count("Great (1,234) reviews"),
    number = B.parse_number_text("1,234.5 things"),
    zip_extract = B.extract_zip("Austin, TX 78701"),
    url_enc = B.url_encode("San Francisco"),
    qparam = B.url_query_param("https://x/?a=1&zip_code=94101", "zip_code"),
    sel_name = B.selector_for_name('q"x'),
    live_name = B.read_field({ { selector = "h1" } }),
    live_rating = B.read_field({ { selector = '[data-test="review-summary"]', parse = B.parse_rating } }),
    live_services = B.read_text_array('[data-test="specialties-section__interested-item"]', 20),
    fields_name = fields.values.name,
    fields_missing_nil = fields.values.missing == nil,
    fields_partial = fields.partial,
    zip_embedded = B.resolve_zip({ address = "Austin, TX 78701" })
  }
end
`;

function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ': ' + detail : ''}`);
  return ok;
}

async function main() {
  // Open home first so the AXSDK runtime initializes on a light page, then hard-nav to the pro page
  // (full reload re-inits the runtime) and wait for it again before loading scripts.
  const page = await openPage('https://www.thumbtack.com/');
  await sleep(2500);
  await waitForLua(page);
  await navigate(page, PRO_URL);
  await waitForLua(page);
  const baseSrc = await readFile(BASE_PATH, 'utf8');
  await loadSource(page, baseSrc, `base-${Date.now()}`);
  await loadSource(page, SMOKE_LUA, `base-smoke-${Date.now()}`);

  const r = await runSmoke(page);
  if (r?.status !== 'completed') { console.error('FAIL  smoke run status:', r?.status, JSON.stringify(r)); process.exitCode = 1; page.sock.close(); return; }
  const v = r.value || {};
  console.log('smoke value:', JSON.stringify(v));

  let ok = true;
  ok &= check('loads (AX_BASE table)', v.loaded === true);
  ok &= check('clean_text', v.clean === 'a b', v.clean);
  ok &= check('non_empty("")->nil', v.non_empty_nil === true);
  ok &= check('normalize_text', v.normalize === 'hello world', v.normalize);
  ok &= check('truncate_text', typeof v.truncate === 'string' && v.truncate.length <= 4, v.truncate);
  ok &= check('dedupe_adjacent', v.dedupe === 'Foo', v.dedupe);
  ok &= check('parse_rating', v.rating === 4.7, v.rating);
  ok &= check('parse_review_count', v.reviews === 1234, v.reviews);
  ok &= check('parse_number_text', v.number === 1234.5, v.number);
  ok &= check('extract_zip', v.zip_extract === '78701', v.zip_extract);
  ok &= check('url_encode', v.url_enc === 'San%20Francisco', v.url_enc);
  ok &= check('url_query_param', v.qparam === '94101', v.qparam);
  ok &= check('selector_for_name (escaped)', v.sel_name === '[name="q\\"x"]', v.sel_name);
  ok &= check('read_field h1 (live)', typeof v.live_name === 'string' && v.live_name.length > 0, v.live_name);
  ok &= check('read_field rating (live, nil-or-number)', v.live_rating === null || v.live_rating === undefined || (typeof v.live_rating === 'number' && v.live_rating <= 5), v.live_rating);
  ok &= check('read_text_array services (live, array)', Array.isArray(v.live_services), `len=${Array.isArray(v.live_services) ? v.live_services.length : 'n/a'}`);
  ok &= check('read_fields name', v.fields_name === v.live_name, v.fields_name);
  ok &= check('read_fields missing->nil', v.fields_missing_nil === true);
  ok &= check('read_fields partial=true', v.fields_partial === true);
  ok &= check('resolve_zip embedded', v.zip_embedded && v.zip_embedded.zip_code === '78701' && v.zip_embedded.source === 'address_text', JSON.stringify(v.zip_embedded));

  console.log(ok ? '\nALL PASS' : '\nSOME FAILED');
  process.exitCode = ok ? 0 : 1;
  page.sock.close();
}
main().catch(e => { console.error('FAIL', e.stack || e.message || e); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 200));
