#!/usr/bin/env node
// Live test for the site-agnostic page reader (00_base.lua B.read_page + 40_read_page.lua
// AX_read_page). Loads ONLY those two scripts into the AXSDK Lua runtime, then exercises
// AX_read_page against synthetic HTML injected into a real (extension-injected) page so the
// assertions are deterministic and never depend on a live site's markup. One non-fatal smoke
// read of the real home page proves the integration path end-to-end.
//   node _common/scripts/test_read_page.mjs --cdp=http://127.0.0.1:9225
// No page snapshots or PII are committed: the fixtures below are wholly synthetic.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
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
async function loadFile(page, ctx, file) {
  const src = await readFile(resolve(__dirname, file), 'utf8');
  const loaded = await callInCtx(page, ctx, `async function(source,id){const lua=globalThis._AXSDK?.lua||globalThis._AXLUA;if(!lua)throw new Error('no lua');if(typeof lua.load==='function')return await lua.load(source,{id});return await lua.loadSiteScript(source,{id,replace:true,kind:'devtools'});}`, [src, `${file}-${Date.now()}`]);
  if (!loaded?.ok && loaded?.status !== 'loaded') throw new Error(`load failed (${file}): ` + JSON.stringify(loaded));
}
async function readPage(page, ctx, params) {
  const r = await callInCtx(page, ctx, `async function(cmd,argsJson){const lua=globalThis._AXSDK?.lua||globalThis._AXLUA;const res=await lua.run(cmd,JSON.parse(argsJson),{timeoutMs:15000});let v=null;if(res?.result){try{v=JSON.parse(res.result);}catch{v=res.result;}}return {status:res?.status,value:v};}`, ['AX_read_page', JSON.stringify(params || {})]);
  return r;
}

// Synthetic page: nav (chrome) + a prose article + an interactive form + footer (chrome).
const LONG = 'This is a meaningful sentence describing the deep clean service in clear detail. ';
const SYNTHETIC = `
  <nav><a href="/login">Log in</a> <a href="/signup">Sign up</a></nav>
  <article id="art">
    <h1>Deep Clean Service Overview</h1>
    <p>${LONG.repeat(8)}</p>
    <p>${LONG.repeat(8)}</p>
  </article>
  <form id="quote" aria-label="Request Flow Dialog">
    <h2>How many bedrooms?</h2>
    <label><input type="radio" name="bedrooms"> 1 bedroom</label>
    <label><input type="radio" name="bedrooms"> 2 bedrooms</label>
    <button type="button">Back</button>
    <button type="submit">Next</button>
  </form>
  <footer>Privacy Policy and Terms of Service</footer>
`;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}

async function main() {
  const page = await openPage('https://www.thumbtack.com/');
  await sleep(2500);
  const ctx = await axContext(page);
  await loadFile(page, ctx, '00_base.lua');
  await loadFile(page, ctx, '40_read_page.lua');

  // Smoke: real home page (integration path). Non-fatal; assert only that it returns usable text.
  const smoke = await readPage(page, ctx, { mode: 'auto', max_chars: 2000 });
  const sv = smoke?.value || {};
  check('smoke: real home read ok + non-empty', smoke?.status === 'completed' && sv.ok === true && (sv.length || 0) > 0,
    `status=${smoke?.status} ok=${sv.ok} len=${sv.length} mode=${sv.mode_used}`);

  // Inject deterministic synthetic content into the live (injected) document.
  await page.send('Runtime.evaluate', { expression: `(()=>{document.title='Synthetic Test Page';document.body.innerHTML=${JSON.stringify(SYNTHETIC)};return document.body.children.length;})()`, returnByValue: true });
  await sleep(200);

  // 1) article mode on body -> Readability isolates the article.
  const art = (await readPage(page, ctx, { mode: 'article' }))?.value || {};
  check('article: mode_used=article', art.mode_used === 'article', JSON.stringify({ m: art.mode_used, ex: art.extracted }));
  check('article: extracted=true', art.extracted === true);
  check('article: contains article heading', typeof art.markdown === 'string' && art.markdown.includes('Deep Clean Service Overview'));
  check('article: title non-empty', !!art.title);
  check('article: length>0', (art.length || 0) > 0);

  // 2) structure mode on the form -> keeps question, options, buttons.
  const struct = (await readPage(page, ctx, { scope: '#quote', mode: 'structure' }))?.value || {};
  check('structure: mode_used=structure', struct.mode_used === 'structure', JSON.stringify({ m: struct.mode_used }));
  check('structure: contains question', (struct.markdown || '').includes('How many bedrooms'));
  check('structure: contains option label', (struct.markdown || '').includes('1 bedroom'));
  check('structure: contains Next button', (struct.markdown || '').includes('Next'));

  // 3) auto on a form-only scope -> no article -> falls back to structure.
  const autoForm = (await readPage(page, ctx, { scope: '#quote', mode: 'auto' }))?.value || {};
  check('auto(form): falls back to structure', autoForm.mode_used === 'structure', JSON.stringify({ m: autoForm.mode_used }));

  // 4) auto on body (article present) -> article.
  const autoBody = (await readPage(page, ctx, { mode: 'auto' }))?.value || {};
  check('auto(body): chooses article', autoBody.mode_used === 'article', JSON.stringify({ m: autoBody.mode_used }));

  // 5) truncation.
  const trunc = (await readPage(page, ctx, { scope: 'body', mode: 'structure', max_chars: 40 }))?.value || {};
  check('truncate: truncated=true', trunc.truncated === true, JSON.stringify({ len: trunc.length }));
  check('truncate: marker present', (trunc.markdown || '').includes('[truncated]'));

  // 6) bogus scope -> scope_not_found.
  const miss = (await readPage(page, ctx, { scope: '#does-not-exist' }))?.value || {};
  check('scope_not_found: ok=false', miss.ok === false, JSON.stringify(miss));
  check('scope_not_found: error code', miss.error === 'scope_not_found');

  // 7) defaults: no args -> scope=body, usable mode, url present.
  const def = (await readPage(page, ctx, {}))?.value || {};
  check('default: ok + scope=body', def.ok === true && def.scope === 'body', JSON.stringify({ ok: def.ok, scope: def.scope }));
  check('default: mode is article|structure', def.mode_used === 'article' || def.mode_used === 'structure');
  check('default: url non-empty', !!def.url);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'SOME FAILED'}  (pass=${pass} fail=${fail})`);
  process.exitCode = fail === 0 ? 0 : 1;
  page.sock.close();
}
main().catch(e => { console.error('FAIL', e.stack || e.message || e); process.exitCode = 1; });
