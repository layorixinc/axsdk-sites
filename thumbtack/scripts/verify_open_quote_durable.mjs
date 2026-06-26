#!/usr/bin/env node
// LIVE durable-path verification for AX_open_quote (the flow's real path: open_quote navigates from a
// NON-pro page -> suspend (nav.navigate is a durable step) -> page reload -> extension auto-resumes the
// persisted call against PRODUCTION open_quote.lua (stable owner hash => resume matches) -> dialog opens.
// Uses ONLY production-loaded scripts (no manual lua.load), so it exercises exactly what the planner-
// driven request_service_quote flow does. Usage:
//   node thumbtack/scripts/verify_open_quote_durable.mjs --cdp=http://127.0.0.1:9225
const EXT_ID = process.env.AXSDK_EXTENSION_ID || 'dldlgmekahifbogjphgglkhibclglmpf';
const args = process.argv.slice(2);
const cdp = (args.find(a => a.startsWith('--cdp=')) || '').slice('--cdp='.length) || 'http://127.0.0.1:9225';
const KEYWORD_PK = '102906936628587357';
const START_URL = `https://www.thumbtack.com/instant-results/?keyword_pk=${KEYWORD_PK}&zip_code=94101`;
const TARGET_URL = 'https://www.thumbtack.com/ca/corte-madera/handyman/carlos-handyman/service/434157323831386115';
const TARGET_SID = '434157323831386115';
const ACTIVE = '[data-test="request-flow-step--active"]';
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
async function evalPage(page, expr) {
  const r = await page.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.value;
}
// Wait until a production command is loaded in the Assistant ctx; returns ctxId.
async function waitForCommand(page, command, ms = 35000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const ctx = await axContext(page);
      const has = await callInCtx(page, ctx, `async function(cmd){const lua=globalThis._AXSDK?.lua||globalThis._AXLUA;if(!lua||typeof lua.run!=='function')return false;let st=null;try{st=await lua.status();}catch{}const cmds=(st?.commands||[]).map(c=>c.command||c);return cmds.includes(cmd);}`, [command]);
      if (has) return ctx;
    } catch {}
    await sleep(1000);
  }
  throw new Error(`command ${command} not loaded in time`);
}

async function main() {
  const page = await openPage(START_URL);
  await sleep(2500);

  // 1) Confirm production AX_open_quote is loaded on the START page (NOT the target pro).
  let ctx;
  try { ctx = await waitForCommand(page, 'AX_open_quote', 35000); }
  catch (e) { console.log('SKIP: AX_open_quote not production-loaded on start page —', e.message); page.sock.close(); process.exitCode = 2; return; }

  const before = await callInCtx(page, ctx, `async function(){const lua=globalThis._AXSDK?.lua||globalThis._AXLUA;const r=await lua.run('AX_detect_page',{},{timeoutMs:6000});let v=null;try{v=JSON.parse(r.result);}catch{}return {page:v?.page,sid:v?.service_id};}`);
  console.log(`start page: page=${before?.page} service_id=${before?.sid || ''}  (target=${TARGET_SID})`);
  const startedOnTarget = before?.page === 'pro_profile' && before?.sid === TARGET_SID;
  if (startedOnTarget) { console.log('SKIP: already on target pro (no nav to exercise)'); page.sock.close(); process.exitCode = 2; return; }

  // 2) Fire AX_open_quote at the TARGET pro from the non-pro page. nav.navigate is a durable step:
  //    it suspends, persists the call, navigates. Our eval may be interrupted by the navigation.
  console.log(`firing AX_open_quote{url:${TARGET_SID}} from ${before?.page} ...`);
  const t0 = Date.now();
  try {
    const res = await callInCtx(page, ctx, `async function(url,sid){const lua=globalThis._AXSDK?.lua||globalThis._AXLUA;const r=await lua.run('AX_open_quote',{url:url,service_id:sid},{timeoutMs:60000});return {status:r?.status,result:(r?.result||'').slice(0,160)};}`, [TARGET_URL, TARGET_SID]);
    console.log(`  lua.run returned: ${JSON.stringify(res)}`);
  } catch (e) {
    console.log(`  lua.run interrupted (expected on durable nav): ${String(e.message).slice(0, 80)}`);
  }

  // 3) Wait for the durable navigation to land on the target pro (same tab navigates).
  let landed = false;
  const navDeadline = Date.now() + 30000;
  while (Date.now() < navDeadline) {
    const href = await evalPage(page, 'location.href').catch(() => '');
    if (href && href.includes(`/service/${TARGET_SID}`)) { landed = true; break; }
    await sleep(1000);
  }
  console.log(`durable nav -> target pro: ${landed ? 'YES' : 'NO'}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // 4) Wait for the auto-resumed AX_open_quote to open the request-flow dialog (DOM end-state).
  let dialog = false;
  const dlgDeadline = Date.now() + 30000;
  while (Date.now() < dlgDeadline) {
    const present = await evalPage(page, `!!document.querySelector('${ACTIVE}')`).catch(() => false);
    if (present) { dialog = true; break; }
    await sleep(1000);
  }
  const totalS = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`resume opened request-flow dialog: ${dialog ? 'YES' : 'NO'}  (total ${totalS}s)`);

  const ok = landed && dialog;
  console.log(ok ? '\nPASS: durable open_quote (suspend->reload->resume->dialog) verified live' : '\nFAIL: durable path did not complete');
  process.exitCode = ok ? 0 : 1;
  page.sock.close();
}
main().catch(e => { console.error('FAIL', e.stack || e.message || e); process.exitCode = 1; });
