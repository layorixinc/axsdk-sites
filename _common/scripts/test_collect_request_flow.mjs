#!/usr/bin/env node
// Live verification for the rewritten request_service_quote.collect_request flow.
// Launches Chrome with the AXSDK extension (or reuses an already-running debug instance), waits for
// the app to initialize, injects the local _common/flows.yaml into the flows store as the ONLY
// clientFlows (stored global layer; remote _common + site stored layers disabled), then sends chat
// messages and reads the chat store to observe planner -> collect_request -> (ask/resolve) -> done.
// Drives the REAL backend flow engine through the debug `_AXSDK` core instance. No git push needed.
//
// Usage:
//   node _common/scripts/test_collect_request_flow.mjs                 # launch/reuse on :9224
//   node _common/scripts/test_collect_request_flow.mjs --only=S2 --keep-open
//   node _common/scripts/test_collect_request_flow.mjs --cdp=http://127.0.0.1:9224   # reuse only
import assert from 'node:assert/strict';
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
const PORT = Number(arg('--port', process.env.CDP_PORT || 9224));
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
const TABLE_WIDGETS = `function(){const found=[];const roots=[document];const seen=new Set();while(roots.length){const root=roots.shift();if(!root||seen.has(root))continue;seen.add(root);for(const table of root.querySelectorAll?.('[data-ax-widget="table"]')||[]){found.push({caption:table.querySelector('caption')?.textContent?.trim()||'',headers:Array.from(table.querySelectorAll('th'),el=>el.textContent?.trim()||''),rows:table.querySelectorAll('tbody tr').length,actions:table.querySelectorAll('[data-ax-widget-cell-action="true"]').length});}for(const el of root.querySelectorAll?.('*')||[]){if(el.shadowRoot)roots.push(el.shadowRoot);}}return found;}`;

const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1);

async function pollTurn(page, maxMs = 90000) {
  const dl = Date.now() + maxMs; let idle = 0, last = null;
  while (Date.now() < dl) {
    await sleep(1200);
    const s = await callAx(page, POLL).catch(e => ({ error: String(e?.message || e) }));
    last = s;
    const running = (s?.messages || []).some(m => (m.parts || []).some(p => p.status === 'running'));
    const busy = s?.sessionStatus === 'busy' || running || s?.loading === true || (s?.deferred?.length ?? 0) > 0;
    const finished = (s?.messages || []).at(-1)?.parts?.some(p => p.type === 'step-finish') === true;
    console.log(`  [${el()}s] status=${s?.sessionStatus} run=${running} load=${s?.loading} msgs=${s?.messageCount} q=${s?.questionCount} defer=${s?.deferred?.length || 0} err=${s?.errors?.length || 0}`);
    const seq = (s?.messages || []).at(-1)?.parts?.filter(p => p.tool)?.map(p => p.tool.split('.').pop() + '=' + (p.status === 'error' ? 'ERR' : (p.out?.next ?? p.status))) || [];
    if (seq.length) console.log('    tools:', seq.join(' '));
    if (s?.errors?.length) return s;
    if (!busy && finished) { idle += 1; if (idle >= 2) return s; } else idle = 0;
  }
  return last;
}

function completedTools(state, leaf) {
  return (state?.messages || []).at(-1)?.parts?.filter(
    part => part.tool?.split('.').pop() === leaf && part.status === 'completed',
  ) || [];
}

function collectOutputs(state) {
  return completedTools(state, 'collect_request').map(part => part.out);
}

function replyText(state) {
  return (state?.messages || []).at(-1)?.parts?.filter(part => part.type === 'text').map(part => part.txt).join('\n') || '';
}

async function waitForTableWidget(page, caption, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const widgets = await callAx(page, TABLE_WIDGETS);
    const match = widgets.find(widget => widget.caption === caption);
    if (match) return match;
    await sleep(250);
  } while (Date.now() < deadline);
  return null;
}

function assertCleanOutputs(outputs) {
  assert.doesNotMatch(JSON.stringify(outputs), /:"(?:null|none|unknown|n\/a)"/i);
}

function verifyS2(turn, state) {
  assert.deepEqual(state.errors, []);
  const outputs = collectOutputs(state);
  assertCleanOutputs(outputs);
  if (turn === 0) {
    assert.equal(outputs.length, 1);
    assert.match(outputs[0].question, /서비스|작업|견적/);
    assert.match(replyText(state), /[가-힣]/);
    return;
  }
  assert.equal(outputs.length, 4);
  assert.equal(outputs[0].service_query, 'lawn mowing');
  assert.match(outputs[0].user_requirements, /one-time/i);
  assert.equal(outputs[1].address, 'San Francisco, CA');
  assert.match(outputs[2].zip_code, /^[0-9]{5}$/);
  assert.match(outputs[3].question, /이름|이메일|전화/);
  assert.equal(completedTools(state, 'search_service').length, 0);
}

async function verifyS5(turn, state, page) {
  assert.deepEqual(state.errors, []);
  const parts = (state?.messages || []).at(-1)?.parts || [];
  assert.equal(parts.filter(part => part.tool && part.status === 'error').length, 0);
  if (turn === 1) {
    assert.equal(completedTools(state, 'present_service_results')[0]?.out?.next, 'refine');
    assert.equal(completedTools(state, 'refine_search')[0]?.out?.next, 'done');

    const prepared = completedTools(state, 'prepare_refined_results_table')[0]?.out;
    assert.equal(prepared?.next, 'render');
    assert.match(prepared?.refined_results_table?.caption, /^Selected Thumbtack professionals \([1-9][0-9]*\)$/);
    assert.deepEqual(
      prepared?.refined_results_table?.columns?.map(column => column.label),
      ['Professional', 'Rating', 'Price', 'Why selected'],
    );
    assert.ok(prepared?.refined_results_table?.rows?.length > 0);
    assert.equal(prepared?.refined_results_table?.rows?.every(row => row.pro?.action?.type === 'link'), true);

    const rendered = completedTools(state, 'render_refined_results')[0]?.out;
    assert.equal(rendered?.next, 'present');
    const widgetMatch = rendered?.refined_results_widget?.match(/^```ax-widget\n([\s\S]+)\n```$/);
    assert.ok(widgetMatch, 'refined results must use one canonical ax-widget fence');
    const widgetPayload = JSON.parse(widgetMatch[1]);
    assert.equal(widgetPayload.template, 'table');
    assert.equal(widgetPayload.version, 1);
    assert.deepEqual(widgetPayload.data, prepared.refined_results_table);

    const presented = completedTools(state, 'present_refined_results')[0]?.out;
    assert.equal(presented?.next, 'ask');
    assert.equal(presented?.quote_confirm_stage, 'asked');
    assert.equal(presented?.question?.startsWith(`${rendered.refined_results_widget}\n\n`), true);
    assert.match(presented?.question, /선택된 전문가를 표로 정리했습니다/);
    assert.equal(completedTools(state, 'confirm_quote').length, 0);
    assert.equal(completedTools(state, 'open_quote').length, 0);
    assert.equal(completedTools(state, 'submit_quote').length, 0);

    const domTable = await waitForTableWidget(page, prepared.refined_results_table.caption);
    assert.ok(domTable, 'refined table widget must exist in the live AXSDK DOM');
    assert.deepEqual(domTable.headers, ['Professional', 'Rating', 'Price', 'Why selected']);
    assert.equal(domTable.rows, prepared.refined_results_table.rows.length);
    assert.equal(domTable.actions, prepared.refined_results_table.rows.length);
    return;
  }
  if (turn === 2) {
    assert.equal(completedTools(state, 'present_refined_results')[0]?.out?.next, 'confirm');
    assert.equal(completedTools(state, 'confirm_quote')[0]?.out?.next, 'refine');
    assert.equal(completedTools(state, 'refine_search')[0]?.out?.next, 'ask');
    assert.match(completedTools(state, 'refine_search')[0]?.out?.question, /평점|리뷰|가격|기준/);
    assert.equal(completedTools(state, 'open_quote').length, 0);
    assert.equal(completedTools(state, 'submit_quote').length, 0);
    return;
  }
  const outputs = collectOutputs(state);
  assertCleanOutputs(outputs);
  assert.equal(outputs.length, 4);
  assert.equal(outputs[0].service_query, 'handyman');
  assert.equal(outputs[1].zip_code, '94103');
  assert.deepEqual(
    [outputs[2].submit_first_name, outputs[2].submit_last_name, outputs[2].submit_email, outputs[2].submit_phone],
    ['Test', 'User', 'thumbtack-test@example.com', '415-555-0100'],
  );
  assert.equal(outputs[3].next, 'done');
  assert.equal(completedTools(state, 'verify_request')[0]?.out?.next, 'ok');
  assert.equal(completedTools(state, 'search_service').length, 1);

  const prepared = completedTools(state, 'prepare_service_results_table')[0]?.out;
  assert.equal(prepared?.next, 'render');
  assert.equal(prepared?.service_results_table?.caption, 'Thumbtack results for handyman (10)');
  assert.deepEqual(
    prepared?.service_results_table?.columns?.map(column => column.label),
    ['Professional', 'Rating', 'Reviews', 'Price', 'Response', 'Hires'],
  );
  assert.equal(prepared?.service_results_table?.rows?.length, 10);
  assert.equal(prepared?.service_results_table?.rows?.every(row => row.pro?.action?.type === 'link'), true);

  const rendered = completedTools(state, 'render_service_results')[0]?.out;
  assert.equal(rendered?.next, 'present');
  const widgetMatch = rendered?.service_results_widget?.match(/^```ax-widget\n([\s\S]+)\n```$/);
  assert.ok(widgetMatch, 'AX_render_widget must return one canonical ax-widget fence');
  const widgetPayload = JSON.parse(widgetMatch[1]);
  assert.equal(widgetPayload.template, 'table');
  assert.equal(widgetPayload.version, 1);
  assert.deepEqual(widgetPayload.data, prepared.service_results_table);

  const presented = completedTools(state, 'present_service_results')[0]?.out;
  assert.equal(presented?.next, 'ask');
  assert.equal(presented?.refine_stage, 'criteria');
  assert.equal(presented?.question?.startsWith(`${rendered.service_results_widget}\n\n`), true);
  assert.match(presented?.question, /검색 결과를 표로 정리했습니다/);
  assert.match(replyText(state), /^```ax-widget/);

  const domTable = await waitForTableWidget(page, prepared.service_results_table.caption);
  assert.ok(domTable, 'rendered table widget must exist in the live AXSDK DOM');
  assert.deepEqual(domTable.headers, ['Professional', 'Rating', 'Reviews', 'Price', 'Response', 'Hires']);
  assert.equal(domTable.rows, 10);
  assert.equal(domTable.actions, 10);
}

function verifyS6(_turn, state) {
  assert.deepEqual(state.errors, []);
  const outputs = collectOutputs(state);
  assertCleanOutputs(outputs);
  assert.equal(outputs.length, 3);
  assert.equal(outputs[0].service_query, 'handyman');
  assert.equal(outputs[1].zip_code, '94103');
  assert.match(outputs[2].question, /이름|이메일|전화/);
  assert.match(replyText(state), /[가-힣]/);
  assert.equal(completedTools(state, 'verify_request').length, 0);
  assert.equal(completedTools(state, 'search_service').length, 0);
}

const SCENARIOS = [
  { id: 'S1', name: 'one-shot (service+requirements+city in message)', memory: '', turns: ['샌프란시스코에서 핸디맨으로 작은 집 한 번 청소 견적 받아줘. 48시간 내 일회성.'] },
  { id: 'S2', name: 'ask -> resume through forced stages', memory: '', turns: ['견적 받아줘', '샌프란시스코에서 잔디 깎기 일회성으로 해줘'], verify: verifyS2 },
  { id: 'S3', name: 'memory is not implicitly read', memory: '# Service address\n- 123 Market St, San Francisco, CA', turns: ['핸디맨으로 집 청소 견적 받아줘. 작은 집, 일회성.'] },
  { id: 'S4', name: 'explicit ZIP (bypass resolve_zip)', memory: '', turns: ['핸디맨으로 작은 집 청소 견적 받아줘. 샌프란시스코 94103, 48시간 내 일회성.'] },
  { id: 'S5', name: 'search and refined shortlist both render table widgets', memory: '', turns: ['샌프란시스코 94103에서 핸디맨으로 작은 집 청소 견적 받아줘. 48시간 내 일회성. 이름 Test, 성 User, 이메일 thumbtack-test@example.com, 전화 415-555-0100.', '평점 높은 순으로 골라줘.', '아니, 다시 고를게.'], verify: verifyS5 },
  { id: 'S6', name: 'missing contact pauses before verification and search', memory: '', turns: ['샌프란시스코 94103에서 핸디맨으로 작은 집 청소 견적 받아줘. 48시간 내 일회성.'], verify: verifyS6 },
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

  try {
    for (const sc of SCENARIOS) {
      if (ONLY && sc.id !== ONLY) continue;
      console.log(`\n===== ${sc.id} ${sc.name} =====`);
      console.log('reset:', JSON.stringify(await callAx(page, RESET, [sc.memory])));
      for (const [turnIndex, turn] of sc.turns.entries()) {
        console.log(`\n>> USER: ${turn}`);
        console.log('send:', JSON.stringify(await callAx(page, SEND, [turn])));
        await sleep(800);
        const state = await pollTurn(page, 300000);
        console.log('<< STATE:', JSON.stringify(state, null, 1));
        await sc.verify?.(turnIndex, state, page);
        console.log(`PASS ${sc.id} turn ${turnIndex + 1}`);
      }
    }
    console.log('\nDONE');
  } finally {
    if (launched && !KEEP_OPEN) launched.kill();
    page.close();
  }
}
main().catch(e => { console.error('FATAL', e?.stack || e?.message || e); process.exitCode = 1; });
