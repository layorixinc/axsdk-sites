#!/usr/bin/env node
// Live verification for the rewritten request_service_quote.collect_request flow.
// Launches Chrome with the AXSDK extension (or reuses an already-running debug instance), waits for
// the app to initialize, injects the local _common/flows.yaml into the flows store as the ONLY
// clientFlows (stored global layer; remote _common + site stored layers disabled), then sends chat
// messages and reads the chat store to observe planner -> collect_request -> (ask/resolve) -> done.
// Drives the REAL backend flow engine through the debug `_AXSDK` core instance. No git push needed.
//
// Usage:
//   node _common/scripts/test_collect_request_flow.mjs                 # launch/reuse on :9225
//   node _common/scripts/test_collect_request_flow.mjs --only=S2 --keep-open
//   node _common/scripts/test_collect_request_flow.mjs --cdp=http://127.0.0.1:9225   # reuse only
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const FLOWS_FILE = resolve(__dirname, '..', 'flows.yaml');
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`${k}=`)); return a ? a.slice(k.length + 1) : d; };
const has = k => process.argv.includes(k);
const EXT = process.env.AXSDK_EXTENSION_ID || 'dldlgmekahifbogjphgglkhibclglmpf';
const PORT = Number(arg('--port', process.env.CDP_PORT || 9225));
const CDP = arg('--cdp', process.env.CDP_URL || '');           // if set, reuse only (never launch)
const ENDPOINT = CDP || `http://127.0.0.1:${PORT}`;
const CHROME = arg('--chrome', process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const PROFILE = arg('--profile', process.env.CHROME_PROFILE || `${process.env.LOCALAPPDATA || ''}/AXSDKSitesChromeDevProfile`);
const EXT_DIST = arg('--ext-dist', process.env.AXSDK_EXT_DIST || resolve(repoRoot, '..', 'axsdk-sdk-js', 'packages', 'axsdk-extension', 'dist'));
const ONLY = arg('--only', '');
const KEEP_OPEN = has('--keep-open');
const HOME = 'https://www.thumbtack.com/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJson(url, init) { const res = await fetch(url, init); if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`); return res.json(); }
async function endpointReady(ep) { try { await fetchJson(`${ep}/json/version`); return true; } catch { return false; } }
async function waitForEndpoint(ep, ms = 20000) { const dl = Date.now() + ms; while (Date.now() < dl) { if (await endpointReady(ep)) return; await sleep(300); } throw new Error(`CDP endpoint not ready: ${ep}`); }
function killDevProfileChrome() {
  return new Promise(r => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "name='chrome.exe'" | Where-Object { $_.CommandLine -like '*AXSDKSitesChromeDevProfile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
      { stdio: 'ignore' });
    ps.on('exit', () => r()); ps.on('error', () => r());
  });
}
function launchChrome() {
  const child = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${PROFILE}`,
    `--load-extension=${EXT_DIST}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-first-run', '--no-default-browser-check', '--disable-popup-blocking',
    HOME,
  ], { stdio: 'ignore', detached: false });
  child.on('error', e => console.error('chrome spawn error', e?.message || e));
  return child;
}
async function pickThumbtackPage(ep) {
  const list = await fetchJson(`${ep}/json/list`);
  const pages = list.filter(t => t.type === 'page');
  return pages.find(p => String(p.url || '').includes('thumbtack.com')) || null;
}
async function ensureThumbtackPage(ep) {
  let p = await pickThumbtackPage(ep);
  if (p) return p;
  const q = encodeURIComponent(HOME);
  try { await fetchJson(`${ep}/json/new?${q}`, { method: 'PUT' }); } catch { try { await fetchJson(`${ep}/json/new?${q}`); } catch {} }
  for (let i = 0; i < 40; i++) { p = await pickThumbtackPage(ep); if (p) return p; await sleep(500); }
  throw new Error('no thumbtack.com page target');
}

class CdpClient {
  constructor(ws) {
    this.nextId = 1; this.pending = new Map(); this.listeners = new Map();
    this.socket = new WebSocket(ws);
    this.ready = new Promise((res, rej) => { this.socket.addEventListener('open', res, { once: true }); this.socket.addEventListener('error', rej, { once: true }); });
    this.socket.addEventListener('message', e => this.onMessage(e));
  }
  onMessage(e) {
    const m = JSON.parse(String(e.data));
    if (m.id) { const cb = this.pending.get(m.id); if (!cb) return; this.pending.delete(m.id); m.error ? cb.reject(new Error(`${m.error.message}: ${JSON.stringify(m.error.data || {})}`)) : cb.resolve(m.result || {}); return; }
    const ls = this.listeners.get(m.method); if (ls) for (const l of [...ls]) l(m.params || {});
  }
  on(method, l) { const s = this.listeners.get(method) || new Set(); s.add(l); this.listeners.set(method, s); return () => s.delete(l); }
  async send(method, params = {}) { await this.ready; const id = this.nextId++; const p = new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej })); this.socket.send(JSON.stringify({ id, method, params })); return p; }
  close() { this.socket.close(); }
}

async function findAxContext(page, timeoutMs = 25000) {
  const contexts = [];
  const off = page.on('Runtime.executionContextCreated', e => contexts.push(e.context));
  await page.send('Runtime.disable').catch(() => null);
  await page.send('Runtime.enable');
  const dl = Date.now() + timeoutMs;
  while (Date.now() < dl) {
    const c = contexts.find(c => c.name === 'AXSDK Assistant' && c.origin === `chrome-extension://${EXT}`);
    if (c) { off(); return c; }
    await sleep(120);
  }
  off(); throw new Error(`AXSDK Assistant context not found for ${EXT}`);
}
async function callAx(page, fn, args = []) {
  const ctx = await findAxContext(page);
  const r = await page.send('Runtime.callFunctionOn', { functionDeclaration: fn, arguments: args.map(value => ({ value })), executionContextId: ctx.id, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || JSON.stringify(r.exceptionDetails));
  return r.result?.value;
}

const APPREADY = `function(){const a=globalThis._AXSDK;const as=a?.getAppStore?a.getAppStore().getState():{};return{hasAX:!!a,appReady:!!as.appInfoReady,hasSend:typeof a?.sendMessage==='function',hasChat:typeof a?.getChatStore==='function',hasFlows:typeof a?.getFlowsStore==='function'};}`;
// stored-global = my doc; clear other stored keys (site overrides) so nothing clobbers it; open chat.
const SETUP = `function(yaml){const a=globalThis._AXSDK;a.config.clientFlows={remoteSites:false,stored:true};const fs=a.getFlowsStore();for(const k of Object.keys(fs.getState().flows)){if(k!==':')fs.getState().deleteFlows(k);}const fr=fs.getState().setFlows(':',yaml);try{a.getChatStore().getState().setIsOpen(true);}catch(e){}return{setFlows:fr,storedKeys:Object.keys(fs.getState().flows),clientFlows:a.config.clientFlows};}`;
const RESET = `function(mem){const a=globalThis._AXSDK;const cs=a.getChatStore().getState();try{cs.setSession&&cs.setSession(undefined);}catch(e){}try{cs.setMessages&&cs.setMessages([]);}catch(e){}try{cs.setQuestions&&cs.setQuestions(null);}catch(e){}try{cs.setSessionClosed&&cs.setSessionClosed(false);}catch(e){}try{a.getErrorStore&&a.getErrorStore().getState().clearErrors&&a.getErrorStore().getState().clearErrors();}catch(e){}try{a.getMemoryStore().getState().setMemory(':',mem||'');}catch(e){}const ns=a.getChatStore().getState();return{messageCount:(ns.messages||[]).length,session:ns.session?.id||null};}`;
const SEND = `function(text){globalThis._AXSDK.sendMessage(text);return {sent:true,via:'api'};}`;
const POLL = `function(){const a=globalThis._AXSDK;const cs=a.getChatStore().getState();const as=a.getAppStore?a.getAppStore().getState():{};const es=a.getErrorStore?a.getErrorStore().getState():{};const T=(v,n)=>{try{if(v==null)return undefined;const s=typeof v==='string'?v:JSON.stringify(v);return s.length>n?s.slice(0,n)+'\\u2026':s;}catch(e){return String(v);}};const D=o=>{try{return JSON.parse(o);}catch(e){return o;}};const msgs=(cs.messages||[]).slice(-3).map(m=>({role:m.role,text:T(m.text||m.content,300),parts:(m.parts||[]).map(p=>p.type==='tool'?{tool:p.tool||p.toolName,status:p.state?.status||p.status,out:D(p.state&&p.state.output)}:{type:p.type,txt:T(p.text||p.question,220)})}));return{appReady:!!as.appInfoReady,loading:cs.isLoading,sessionId:cs.session?.id||null,sessionStatus:cs.session?.status,errors:(es.errors||[]).slice(0,3).map(e=>T(e.message||e.error||e,200)),deferred:(cs.deferredCalls||[]).map(d=>T(d.command||d.tool||d,80)),questionCount:(cs.questions||[]).length,questions:(cs.questions||[]).map(q=>T(q.text||q.question||q,260)),messageCount:(cs.messages||[]).length,messages:msgs};}`;

const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1);

async function pollTurn(page, maxMs = 90000) {
  const dl = Date.now() + maxMs; let idle = 0, sawBusy = false, last = null, start = Date.now();
  while (Date.now() < dl) {
    await sleep(1200);
    const s = await callAx(page, POLL).catch(e => ({ error: String(e?.message || e) }));
    last = s;
    const running = (s?.messages || []).some(m => (m.parts || []).some(p => p.status === 'running'));
    const busy = s?.sessionStatus === 'busy' || running || s?.loading === true || (s?.deferred?.length ?? 0) > 0;
    if (busy) sawBusy = true;
    console.log(`  [${el()}s] status=${s?.sessionStatus} run=${running} load=${s?.loading} msgs=${s?.messageCount} q=${s?.questionCount} defer=${s?.deferred?.length || 0} err=${s?.errors?.length || 0}`);
    const seq = (s?.messages || []).at(-1)?.parts?.filter(p => p.tool)?.map(p => p.tool.split('.').pop() + '=' + (p.status === 'error' ? 'ERR' : (p.out?.next ?? p.status))) || [];
    if (seq.length) console.log('    tools:', seq.join(' '));
    if (s?.questionCount > 0) return s;
    if (s?.errors?.length) return s;
    if (sawBusy && !busy) { idle += 1; if (idle >= 2) return s; } else idle = 0;
    if (!sawBusy && Date.now() - start > 25000) return s;
  }
  return last;
}

const SCENARIOS = [
  { id: 'S1', name: 'one-shot (service+requirements+city in message)', memory: '', turns: ['샌프란시스코에서 핸디맨으로 작은 집 한 번 청소 견적 받아줘. 48시간 내 일회성.'] },
  { id: 'S2', name: 'ask -> resume (vague, then answer)', memory: '', turns: ['견적 받아줘', '샌프란시스코에서 잔디 깎기 일회성으로 해줘'] },
  { id: 'S3', name: 'memory path (address from memory, no location in message)', memory: '# Service address\n- 123 Market St, San Francisco, CA', turns: ['핸디맨으로 집 청소 견적 받아줘. 작은 집, 일회성.'] },
  { id: 'S4', name: 'explicit ZIP (bypass resolve_zip)', memory: '', turns: ['핸디맨으로 작은 집 청소 견적 받아줘. 샌프란시스코 94103, 48시간 내 일회성.'] },
  { id: 'S5', name: 'full incl contact + explicit zip (happy path -> verify_request -> search)', memory: '', turns: ['샌프란시스코 94103에서 핸디맨으로 작은 집 청소 견적 받아줘. 48시간 내 일회성. 이름 Test, 성 User, 이메일 thumbtack-test@example.com, 전화 415-555-0100.'] },
  { id: 'S6', name: 'missing contact (gate must ask, never reach search)', memory: '', turns: ['샌프란시스코 94103에서 핸디맨으로 작은 집 청소 견적 받아줘. 48시간 내 일회성.'] },
];

async function main() {
  const yaml = await readFile(FLOWS_FILE, 'utf8');
  let launched = null;
  if (await endpointReady(ENDPOINT)) {
    console.log(`Reusing Chrome at ${ENDPOINT}`);
  } else if (CDP) {
    throw new Error(`--cdp endpoint not reachable: ${CDP}`);
  } else {
    console.log(`Launching Chrome on :${PORT} (profile ${PROFILE}, ext ${EXT_DIST})`);
    await killDevProfileChrome(); await sleep(800);
    launched = launchChrome();
    await waitForEndpoint(ENDPOINT, 25000);
  }
  const target = await ensureThumbtackPage(ENDPOINT);
  console.log(`page: ${String(target.url).slice(0, 60)}`);
  const page = new CdpClient(target.webSocketDebuggerUrl);
  await page.ready;
  await page.send('Page.enable').catch(() => null);
  page.on('Page.javascriptDialogOpening', () => page.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => null));
  await page.send('Runtime.enable');

  let ready = null;
  for (let i = 0; i < 50; i++) { ready = await callAx(page, APPREADY).catch(e => ({ err: String(e?.message || e) })); if (ready?.hasAX && ready?.appReady && ready?.hasSend && ready?.hasChat && ready?.hasFlows) break; await sleep(800); }
  console.log('APP READY:', JSON.stringify(ready));
  if (!(ready?.hasAX && ready?.hasSend && ready?.hasChat && ready?.hasFlows)) { console.error('FAIL: _AXSDK chat/flows API unavailable (debug off / not loaded).'); if (launched && !KEEP_OPEN) launched.kill(); page.close(); process.exitCode = 1; return; }
  if (!ready?.appReady) console.warn('WARN: appInfoReady false — backend may not respond.');

  const REMOTE_SETUP = `function(){const a=globalThis._AXSDK;a.config.clientFlows={remoteSites:true,stored:false};try{a.getChatStore().getState().setIsOpen(true);}catch(e){}return{clientFlows:a.config.clientFlows};}`;
  if (has('--remote')) console.log('REMOTE_SETUP:', JSON.stringify(await callAx(page, REMOTE_SETUP)));
  else console.log('SETUP:', JSON.stringify(await callAx(page, SETUP, [yaml])));

  for (const sc of SCENARIOS) {
    if (ONLY && sc.id !== ONLY) continue;
    console.log(`\n===== ${sc.id} ${sc.name} =====`);
    console.log('reset:', JSON.stringify(await callAx(page, RESET, [sc.memory])));
    for (const turn of sc.turns) {
      console.log(`\n>> USER: ${turn}`);
      console.log('send:', JSON.stringify(await callAx(page, SEND, [turn])));
      await sleep(800);
      const s = await pollTurn(page, 300000);
      console.log('<< STATE:', JSON.stringify(s, null, 1));
    }
  }
  console.log('\nDONE');
  if (launched && !KEEP_OPEN) launched.kill();
  page.close();
}
main().catch(e => { console.error('FATAL', e?.stack || e?.message || e); process.exitCode = 1; });
