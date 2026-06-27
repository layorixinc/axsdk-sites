#!/usr/bin/env node
// Live test for the site-agnostic AX_resolve_zip command (_common/scripts/30_resolve_zip.lua).
// Proves the command works on an EXTERNAL, non-provider site (default https://www.google.com/):
// it loads ONLY 00_base.lua + 30_resolve_zip.lua (NO thumbtack scripts), then exercises the full
// resolution ladder. This mirrors a request_service_quote flow that starts on google.com and must
// resolve a ZIP before navigating to a provider site.
//   node _common/scripts/test_resolve_zip.mjs --cdp=http://127.0.0.1:9225 [--url=https://www.google.com/]
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_FILE = resolve(__dirname, '00_base.lua');
const CMD_FILE = resolve(__dirname, '30_resolve_zip.lua');
const EXT_ID = process.env.AXSDK_EXTENSION_ID || 'dldlgmekahifbogjphgglkhibclglmpf';
const argv = process.argv.slice(2);
const cdp = (argv.find(a => a.startsWith('--cdp=')) || '').slice('--cdp='.length) || 'http://127.0.0.1:9225';
const url = (argv.find(a => a.startsWith('--url=')) || '').slice('--url='.length) || 'https://www.google.com/';

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

async function openPage(target) {
  const enc = encodeURIComponent(target);
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
  off(); throw new Error('AXSDK Assistant context not found (extension not active on this host?)');
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
const LOAD_FN = `async function(source,id){const lua=globalThis._AXSDK?.lua||globalThis._AXLUA;if(!lua)throw new Error('no lua');if(typeof lua.load==='function')return await lua.load(source,{id});return await lua.loadSiteScript(source,{id,replace:true,kind:'devtools'});}`;

async function loadFile(page, file, id, inline = false) {
  const source = inline ? file : await readFile(file, 'utf8');
  const ctx = await axContext(page);
  const loaded = await callInCtx(page, ctx, LOAD_FN, [source, id]);
  if (!loaded?.ok && loaded?.status !== 'loaded') throw new Error(`load failed (${id}): ${JSON.stringify(loaded)}`);
}
// Calls AX_resolve_zip; retries while the durable net.fetch reports pending or a transient error.
// Definitive results (zip_code, errors) are returned as-is; only pending/transient states retry.
async function resolveZip(page, args, { retries = 6 } = {}) {
  let out;
  for (let i = 0; i < retries; i++) {
    const ctx = await axContext(page);
    out = await callInCtx(page, ctx, `async function(args){const lua=globalThis._AXSDK?.lua||globalThis._AXLUA;const res=await lua.run('AX_resolve_zip',args,{timeoutMs:8000});let v=null;if(res?.result){try{v=JSON.parse(res.result);}catch{v=res.result;}}return {status:res?.status,value:v};}`, [args]);
    const v = out.value;
    // Durable net.fetch can suspend (status='pending'/empty result) or hit a transient network
    // error (reason='fetch_error'); re-run replays the durable step. Definitive results
    // (zip_code, missing_zip_or_address, zip_not_found) are NOT retried.
    const transient = out.status !== 'completed' || !v || v.pending === true
      || v.error === 'pending' || v.reason === 'fetch_error';
    if (!transient) break;
    if (i < retries - 1) await sleep(1500);
  }
  return out;
}

async function main() {
  console.log(`AX_resolve_zip external-site test — host=${url} cdp=${cdp}`);
  const page = await openPage(url);
  await sleep(2000); await waitForLua(page);
  // Load ONLY the base layer + the resolve_zip command — no site (thumbtack) scripts.
  await loadFile(page, BASE_FILE, `base-${Date.now()}`);
  await loadFile(page, CMD_FILE, `resolve-zip-${Date.now()}`);
  // Structural probe INSIDE the Lua VM: AX_resolve_zip / AX_THUMBTACK are Lua globals (not JS
  // globals), so they must be inspected via the runtime, not `typeof` in the extension context.
  await loadFile(page, "function AX__probe() return { has_cmd = type(AX_resolve_zip) == 'function', has_tt = AX_THUMBTACK ~= nil } end", `probe-${Date.now()}`, true);
  const ctxP = await axContext(page);
  const probe = await callInCtx(page, ctxP, `async function(){const lua=globalThis._AXSDK?.lua||globalThis._AXLUA;const res=await lua.run('AX__probe',{},{timeoutMs:5000});let v=null;if(res?.result){try{v=JSON.parse(res.result);}catch{v=res.result;}}return v;}`, []);
  const hasCmd = probe?.has_cmd === true;
  const hasTT = probe?.has_tt === true;
  console.log(`(Lua VM) AX_resolve_zip is function: ${hasCmd}   AX_THUMBTACK present: ${hasTT}`);

  let ok = true;
  const check = (label, cond, detail) => { ok = ok && !!cond; console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${cond ? '' : '  <- ' + JSON.stringify(detail)}`); };

  const isProvider = /thumbtack\.com|amazon\.com|bluemoonsoft\.com/i.test(url);
  check('AX_resolve_zip available (loaded from _common)', hasCmd === true, { hasCmd });
  // Isolation is only meaningful off-provider: on a provider host the extension legitimately
  // auto-loads that site's scripts (AX_THUMBTACK), and that load races this probe.
  if (isProvider) console.log(`INFO provider host — AX_THUMBTACK present=${hasTT} (site scripts auto-load; expected)`);
  else check('standalone: no AX_THUMBTACK on external host', hasTT === false, { hasTT });

  // 1. explicit zip_code — deterministic, no network.
  let r = await resolveZip(page, { zip_code: '94101' });
  check('explicit zip_code -> 94101 (source=zip_code)',
    r.status === 'completed' && r.value?.zip_code === '94101' && r.value?.source === 'zip_code', r.value);

  // 2. embedded ZIP in address — deterministic, no network.
  r = await resolveZip(page, { address: 'Austin, TX 78701' });
  check('embedded "Austin, TX 78701" -> 78701 (source=address_text)',
    r.status === 'completed' && r.value?.zip_code === '78701' && r.value?.source === 'address_text', r.value);

  // 3. missing input — deterministic error.
  r = await resolveZip(page, {});
  check('empty args -> error=missing_zip_or_address',
    r.status === 'completed' && r.value?.error === 'missing_zip_or_address', r.value);

  // 4. full street address — NETWORK. Forward-geocoded to a point, then reverse-resolved to its
  //    ZCTA (geocode_zcta); the Census street geocoder is a fallback. Either is a valid SF ZIP.
  const full = await resolveZip(page, { address: '1 Dr Carlton B Goodlett Pl, San Francisco, CA' });
  check('full address -> valid SF ZIP (geocode_zcta | census fallback)',
    full.status === 'completed' && /^941\d\d$/.test(String(full.value?.zip_code || ''))
      && (full.value?.source === 'geocode_zcta' || full.value?.source === 'census_geocoder'), full.value);

  // 5. city-only — NETWORK. The cleaning-quote path: a user types a city ("San Francisco") and the
  //    flow resolves a representative ZIP via forward geocode + Census ZCTA — the exact case the old
  //    Zippopotam/Census-street path failed on (or mis-resolved to South SF). Primary fix target.
  const city = await resolveZip(page, { address: 'San Francisco, CA' });
  check('city-only "San Francisco, CA" -> valid SF ZIP 941xx (geocode_zcta)',
    city.status === 'completed' && /^941\d\d$/.test(String(city.value?.zip_code || ''))
      && (city.value?.source === 'geocode_zcta' || city.value?.source === 'census_geocoder'), city.value);

  // Prove the forward-geocode + ZCTA path is the PRIMARY resolver: at least one live lookup
  // resolved via it (Census street geocoder is only reached when the geocode path yields nothing).
  check('geocode+ZCTA is primary (>=1 network case via geocode_zcta)',
    [full, city].some(x => x.value?.source === 'geocode_zcta'),
    { full: full.value?.source, city: city.value?.source });

  console.log(ok ? '\nALL PASS — AX_resolve_zip works standalone on an external site' : '\nSOME FAILED');
  process.exitCode = ok ? 0 : 1;
  page.sock.close();
}
main().catch(e => { console.error('FAIL', e.stack || e.message || e); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 200));
