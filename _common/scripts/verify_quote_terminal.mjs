#!/usr/bin/env node
// Live verification that the request_service_quote terminal output contains ONLY the quote
// outcomes — never the searched-pro list / search-results JSON. Reuses a running dev Chrome with
// the AXSDK extension, injects the local _common/flows.yaml as the only clientFlows (stored global),
// sends ONE explicit-ZIP one-shot request (skips resolve_zip network), drives the REAL flow engine
// to the quotes_done terminal, then reads the FULL (untruncated) final assistant message and asserts
// it has no appended search-results JSON.
//
// Usage: node _common/scripts/verify_quote_terminal.mjs            # reuse :9225
//        node _common/scripts/verify_quote_terminal.mjs --cdp=http://127.0.0.1:9225
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLOWS_FILE = resolve(__dirname, '..', 'flows.yaml');
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`${k}=`)); return a ? a.slice(k.length + 1) : d; };
const EXT = process.env.AXSDK_EXTENSION_ID || 'dldlgmekahifbogjphgglkhibclglmpf';
const PORT = Number(arg('--port', process.env.CDP_PORT || 9225));
const ENDPOINT = arg('--cdp', process.env.CDP_URL || `http://127.0.0.1:${PORT}`);
const MESSAGE = arg('--msg', '핸디맨으로 작은 집 수리 견적 받아줘. 샌프란시스코 94103, 2시간 미만 일회성.');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1);

async function fetchJson(url, init) { const res = await fetch(url, init); if (!res.ok) throw new Error(`${res.status} ${res.statusText}`); return res.json(); }
async function pickPage(ep) { const list = await fetchJson(`${ep}/json/list`); return list.filter(t => t.type === 'page').find(p => String(p.url || '').includes('thumbtack.com')) || null; }

class CdpClient {
  constructor(ws) { this.nextId = 1; this.pending = new Map(); this.listeners = new Map(); this.socket = new WebSocket(ws); this.ready = new Promise((res, rej) => { this.socket.addEventListener('open', res, { once: true }); this.socket.addEventListener('error', rej, { once: true }); }); this.socket.addEventListener('message', e => this.onMessage(e)); }
  onMessage(e) { const m = JSON.parse(String(e.data)); if (m.id) { const cb = this.pending.get(m.id); if (!cb) return; this.pending.delete(m.id); m.error ? cb.reject(new Error(m.error.message)) : cb.resolve(m.result || {}); return; } const ls = this.listeners.get(m.method); if (ls) for (const l of [...ls]) l(m.params || {}); }
  on(method, l) { const s = this.listeners.get(method) || new Set(); s.add(l); this.listeners.set(method, s); return () => s.delete(l); }
  async send(method, params = {}) { await this.ready; const id = this.nextId++; const p = new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej })); this.socket.send(JSON.stringify({ id, method, params })); return p; }
  close() { this.socket.close(); }
}

async function findAxContext(page, timeoutMs = 25000) {
  const contexts = []; const off = page.on('Runtime.executionContextCreated', e => contexts.push(e.context));
  await page.send('Runtime.disable').catch(() => null); await page.send('Runtime.enable');
  const dl = Date.now() + timeoutMs;
  while (Date.now() < dl) { const c = contexts.find(c => c.name === 'AXSDK Assistant' && c.origin === `chrome-extension://${EXT}`); if (c) { off(); return c; } await sleep(120); }
  off(); throw new Error('AXSDK Assistant context not found');
}
async function callAx(page, fn, args = []) {
  const ctx = await findAxContext(page);
  const r = await page.send('Runtime.callFunctionOn', { functionDeclaration: fn, arguments: args.map(value => ({ value })), executionContextId: ctx.id, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || JSON.stringify(r.exceptionDetails));
  return r.result?.value;
}

const APPREADY = `function(){const a=globalThis._AXSDK;const as=a?.getAppStore?a.getAppStore().getState():{};return{hasAX:!!a,appReady:!!as.appInfoReady,hasSend:typeof a?.sendMessage==='function',hasChat:typeof a?.getChatStore==='function',hasFlows:typeof a?.getFlowsStore==='function'};}`;
const SETUP = `function(yaml){const a=globalThis._AXSDK;a.config.clientFlows={remoteSites:false,stored:true};const fs=a.getFlowsStore();for(const k of Object.keys(fs.getState().flows)){if(k!==':')fs.getState().deleteFlows(k);}const fr=fs.getState().setFlows(':',yaml);try{a.getChatStore().getState().setIsOpen(true);}catch(e){}return{setFlows:fr,storedKeys:Object.keys(fs.getState().flows)};}`;
const RESET = `function(){const a=globalThis._AXSDK;const cs=a.getChatStore().getState();try{cs.setSession&&cs.setSession(undefined);}catch(e){}try{cs.setMessages&&cs.setMessages([]);}catch(e){}try{cs.setQuestions&&cs.setQuestions(null);}catch(e){}try{cs.setSessionClosed&&cs.setSessionClosed(false);}catch(e){}try{a.getErrorStore&&a.getErrorStore().getState().clearErrors&&a.getErrorStore().getState().clearErrors();}catch(e){}try{a.getMemoryStore().getState().setMemory(':','');}catch(e){}return{ok:true};}`;
const SEND = `function(text){globalThis._AXSDK.sendMessage(text);return{sent:true};}`;
// Lightweight per-poll status (truncated) for progress.
const POLL = `function(){const a=globalThis._AXSDK;const cs=a.getChatStore().getState();const es=a.getErrorStore?a.getErrorStore().getState():{};const msgs=cs.messages||[];const running=msgs.some(m=>(m.parts||[]).some(p=>((p.state&&p.state.status)||p.status)==='running'));const last=msgs[msgs.length-1];const tools=((last&&last.parts)||[]).filter(p=>p.type==='tool').map(p=>(p.tool||p.toolName)+':'+((p.state&&p.state.status)||p.status||''));return{status:cs.sessionStatus,running:running,loading:cs.isLoading,msgs:msgs.length,q:(cs.questions||[]).length,err:(es.errors||[]).length,tools:tools.slice(-5)};}`;
// FULL untruncated last assistant message text.
const FULLREAD = `function(){const a=globalThis._AXSDK;const cs=a.getChatStore().getState();const msgs=cs.messages||[];if(!msgs.length)return{found:false};const last=msgs[msgs.length-1];let text=last.text||last.content||'';if(!text&&Array.isArray(last.parts)){text=last.parts.filter(p=>p.type==='text').map(p=>p.text||p.question||'').join('\\n');}return{found:true,len:String(text||'').length,text:String(text||'')};}`;

async function pollTurn(page, maxMs = 720000) {
  const dl = Date.now() + maxMs; let idle = 0, sawBusy = false, last = null, start = Date.now();
  while (Date.now() < dl) {
    await sleep(1500);
    const s = await callAx(page, POLL).catch(e => ({ error: String(e?.message || e) }));
    last = s;
    const busy = s?.status === 'busy' || s?.running === true || s?.loading === true;
    if (busy) sawBusy = true;
    console.log(`  [${el()}s] status=${s?.status} run=${s?.running} load=${s?.loading} msgs=${s?.msgs} q=${s?.q} err=${s?.err} tools=${(s?.tools || []).join(',')}`);
    if (s?.q > 0) return s;
    if (s?.err > 0) return s;
    if (sawBusy && !busy) { idle += 1; if (idle >= 3) return s; } else idle = 0;
    if (!sawBusy && Date.now() - start > 30000) return s;
  }
  return last;
}

function classify(text) {
  const t = String(text || '');
  // Quote-outcome markers the new terminal must contain.
  const hasQuote = /\[service_id\s+\d+\]/i.test(t) || /Submitted ->|Submit attempted|Reached final submit|Stopped before submit|FAILED to open/i.test(t) || /quote request/i.test(t);
  // Search-results-dump markers that must be ABSENT (the old appended pro-list JSON).
  const jsonKeys = ['"candidates"', '"total_count"', '"review_count"', '"price_text"', '"image_url"', '"response_time"'];
  const hitKeys = jsonKeys.filter(k => t.includes(k));
  // A JSON array of pro objects (multiple {...} with service_id) is the other tell.
  const proArray = /\[\s*\{[^]*"service_id"[^]*\}\s*,\s*\{[^]*"service_id"/.test(t);
  const hasSearchJson = hitKeys.length > 0 || proArray;
  // Submit/error-popover evidence the NEW flow must surface (it submits with reserved test data).
  const hasSubmit = /error popover|Submitted ->|Submit attempted|Reached final submit|valid phone|invalid|sign in|sign-in/i.test(t);
  return { hasQuote, hasSubmit, hasSearchJson, hitKeys, proArray };
}

async function main() {
  const yaml = await readFile(FLOWS_FILE, 'utf8');
  const target = await pickPage(ENDPOINT);
  if (!target) throw new Error('no thumbtack.com page on the CDP endpoint (open one first)');
  console.log(`page: ${String(target.url).slice(0, 70)}`);
  const page = new CdpClient(target.webSocketDebuggerUrl);
  await page.ready;
  await page.send('Page.enable').catch(() => null);
  page.on('Page.javascriptDialogOpening', () => page.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => null));
  await page.send('Runtime.enable');

  // Start the flow from a clean Thumbtack home page. Prior --keep-open runs may leave the tab on a
  // pro page; the flow's open_site is then a no-op (already on-domain) and search starts from a dirty
  // page, which the two-phase search cross-nav handles poorly in the flow-engine single-call path.
  console.log('navigating to home…');
  await page.send('Page.navigate', { url: 'https://www.thumbtack.com/' });
  await sleep(4000);

  let ready = null;
  for (let i = 0; i < 40; i++) { ready = await callAx(page, APPREADY).catch(e => ({ err: String(e?.message || e) })); if (ready?.hasAX && ready?.appReady && ready?.hasSend && ready?.hasChat && ready?.hasFlows) break; await sleep(800); }
  console.log('APP READY:', JSON.stringify(ready));
  if (!(ready?.hasAX && ready?.hasSend && ready?.hasChat && ready?.hasFlows)) { console.error('FAIL: _AXSDK chat/flows API unavailable'); page.close(); process.exitCode = 1; return; }

  console.log('SETUP:', JSON.stringify(await callAx(page, SETUP, [yaml])));
  console.log('RESET:', JSON.stringify(await callAx(page, RESET)));
  console.log(`\n>> USER: ${MESSAGE}`);
  // The first sendMessage after a fresh page-inject / prior-errored session sometimes no-ops
  // (backend SSE not yet connected). Retry RESET+SEND until a user message actually registers.
  let started = false;
  for (let attempt = 1; attempt <= 3 && !started; attempt++) {
    console.log(`send attempt ${attempt}:`, JSON.stringify(await callAx(page, SEND, [MESSAGE])));
    for (let i = 0; i < 8; i++) { await sleep(700); const p = await callAx(page, POLL).catch(() => ({})); if ((p.msgs || 0) > 0) { started = true; break; } }
    if (!started) { console.log(`  msgs=0 after attempt ${attempt} — resetting + re-sending`); await callAx(page, RESET).catch(() => null); }
  }
  if (!started) console.log('WARN: message never registered after 3 attempts');
  const s = await pollTurn(page);
  console.log('\nfinal status:', JSON.stringify(s));

  // The quotes_done terminal text can land a beat AFTER the flow goes idle — wait for it before reading.
  let full = await callAx(page, FULLREAD);
  for (let i = 0; i < 20 && !(full?.len > 0); i++) { await sleep(1500); full = await callAx(page, FULLREAD).catch(() => full); }
  console.log(`\n===== FINAL ASSISTANT MESSAGE (len=${full?.len}) =====`);
  console.log(full?.text || '(none)');
  console.log('===== END =====');

  const verdict = classify(full?.text);
  console.log('\nclassify:', JSON.stringify(verdict));
  const pass = full?.found && verdict.hasQuote && verdict.hasSubmit && !verdict.hasSearchJson;
  console.log(pass ? '\nPASS: terminal shows quote outcomes WITH submit/popover content, no search-results JSON' : '\nFAIL: ' + (!verdict.hasQuote ? 'no quote outcomes; ' : '') + (!verdict.hasSubmit ? 'no submit/popover content; ' : '') + (verdict.hasSearchJson ? 'search-results JSON present' : ''));
  process.exitCode = pass ? 0 : 1;
  page.close();
}
main().catch(e => { console.error('FATAL', e?.stack || e?.message || e); process.exitCode = 1; });
