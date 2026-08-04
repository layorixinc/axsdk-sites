#!/usr/bin/env node
// Offline smoke test for _common/scripts/10_form_wizard.lua (AX_WIZARD) decision core.
// Loads 00_base.lua + 10_form_wizard.lua + an inline smoke command and exercises the PURE
// (DOM-free) decision functions with synthetic inputs. Runs on the home page (no DOM needed).
// Usage:  node thumbtack/scripts/test_form_wizard.mjs --cdp=http://127.0.0.1:9225
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ID = process.env.AXSDK_EXTENSION_ID || 'dldlgmekahifbogjphgglkhibclglmpf';
const args = process.argv.slice(2);
const cdp = (args.find(a => a.startsWith('--cdp=')) || '').slice('--cdp='.length) || 'http://127.0.0.1:9225';
const COMMON = resolve(__dirname, '..', '..', '_common', 'scripts');

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
async function loadSource(page, source, id) {
  const ctx = await axContext(page);
  const loaded = await callInCtx(page, ctx, `async function(source,id){const lua=globalThis._AXSDK?.lua||globalThis._AXLUA;if(!lua)throw new Error('no lua');if(typeof lua.load==='function')return await lua.load(source,{id});return await lua.loadSiteScript(source,{id,replace:true,kind:'devtools'});}`, [source, id]);
  if (!loaded?.ok && loaded?.status !== 'loaded') throw new Error('load failed: ' + JSON.stringify(loaded));
}
async function runSmoke(page) {
  const ctx = await axContext(page);
  return callInCtx(page, ctx, `async function(){const lua=globalThis._AXSDK?.lua||globalThis._AXLUA;const res=await lua.run('AX_wizard_smoke',{},{timeoutMs:8000});let v=null;if(res?.result){try{v=JSON.parse(res.result);}catch{v=res.result;}}return {status:res?.status,value:v};}`);
}

const SMOKE_LUA = `
function AX_wizard_smoke(args)
  local W = AX_WIZARD
  local radio = { { text = "Home", control = "radio", group = "g1" }, { text = "Business", control = "radio", group = "g1" } }
  local checks = { { text = "None", control = "checkbox", group = "g2" }, { text = "Extra", control = "checkbox", group = "g2" } }
  return {
    loaded = type(W) == "table",
    cv_multi = W.choice_values({ selections = { "a", "  ", "b" } }),
    cv_single = W.choice_values({ value = "x" }),
    cv_empty_len = #W.choice_values({}),
    text_value = W.text_value({ details = "hi" }),
    auto_on = W.auto_enabled({ auto = true }),
    auto_off = W.auto_enabled({}),
    req = W.requirement_text({ user_requirements = "No pets", details = "standard" }),
    req_empty = W.requirement_text({}),
    score_home = W.option_score({ text = "Home" }, ""),
    score_business = W.option_score({ text = "Business" }, ""),
    score_match = W.option_score({ text = "No pets" }, "no pets"),
    score_empty = W.option_score({ text = "" }, "x"),
    auto_radio = W.auto_choice_values(radio, ""),
    auto_check = W.auto_choice_values(checks, ""),
    skip_radio = W.can_auto_skip({ { control = "radio" } }, 0),
    skip_check0 = W.can_auto_skip({ { control = "checkbox" } }, 0),
    skip_check2 = W.can_auto_skip({ { control = "checkbox" } }, 2),
    adv_next = W.classify_advance({ "Back", "Next" }),
    adv_skip = W.classify_advance({ "Skip" }),
    adv_send = W.classify_advance({ "Send" }),
    adv_getquotes = W.classify_advance({ "Get quotes" }),
    adv_table = W.classify_advance({ { text = "Next" } })
  }
end
`;

function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ': ' + JSON.stringify(detail) : ''}`);
  return ok;
}
const eqArr = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

async function main() {
  const page = await openPage('https://www.thumbtack.com/');
  await sleep(2000);
  await waitForLua(page);
  await loadSource(page, await readFile(resolve(COMMON, '00_base.lua'), 'utf8'), `base-${Date.now()}`);
  await loadSource(page, await readFile(resolve(COMMON, '10_form_wizard.lua'), 'utf8'), `wizard-${Date.now()}`);
  await loadSource(page, SMOKE_LUA, `wizard-smoke-${Date.now()}`);

  const r = await runSmoke(page);
  if (r?.status !== 'completed') { console.error('FAIL  smoke run status:', r?.status, JSON.stringify(r)); process.exitCode = 1; page.sock.close(); return; }
  const v = r.value || {};
  console.log('smoke value:', JSON.stringify(v));

  let ok = true;
  ok &= check('loads (AX_WIZARD)', v.loaded === true);
  ok &= check('choice_values multi (drops blanks)', eqArr(v.cv_multi, ['a', 'b']), v.cv_multi);
  ok &= check('choice_values single', eqArr(v.cv_single, ['x']), v.cv_single);
  ok &= check('choice_values empty', v.cv_empty_len === 0);
  ok &= check('text_value', v.text_value === 'hi', v.text_value);
  ok &= check('auto_enabled on/off', v.auto_on === true && v.auto_off === false);
  ok &= check('requirement_text', v.req === 'no pets standard', v.req);
  ok &= check('requirement_text empty', v.req_empty === '');
  ok &= check('option_score home (+8)', v.score_home === 8, v.score_home);
  ok &= check('option_score business (-2)', v.score_business === -2, v.score_business);
  ok &= check('option_score requirement match (>=100)', typeof v.score_match === 'number' && v.score_match >= 100, v.score_match);
  ok &= check('option_score empty (-1)', v.score_empty === -1, v.score_empty);
  ok &= check('auto_choice radio -> best (Home)', eqArr(v.auto_radio, ['Home']), v.auto_radio);
  ok &= check('auto_choice checkbox -> None', eqArr(v.auto_check, ['None']), v.auto_check);
  ok &= check('can_auto_skip radio -> false', v.skip_radio === false);
  ok &= check('can_auto_skip checkbox/0 -> true', v.skip_check0 === true);
  ok &= check('can_auto_skip checkbox/2 -> false', v.skip_check2 === false);
  ok &= check('classify_advance Next -> advance', v.adv_next?.kind === 'advance' && v.adv_next?.can_advance === true && v.adv_next?.reached_submit_step === false, v.adv_next);
  ok &= check('classify_advance Skip -> skip+allow', v.adv_skip?.kind === 'skip' && v.adv_skip?.allow_without_answer === true, v.adv_skip);
  ok &= check('classify_advance Send -> STOP', v.adv_send?.kind === 'none' && v.adv_send?.can_advance === false && v.adv_send?.reached_submit_step === true, v.adv_send);
  ok &= check('classify_advance Get quotes -> submit', v.adv_getquotes?.reached_submit_step === true, v.adv_getquotes);
  ok &= check('classify_advance table form -> advance', v.adv_table?.kind === 'advance', v.adv_table);

  console.log(ok ? '\nALL PASS' : '\nSOME FAILED');
  process.exitCode = ok ? 0 : 1;
  page.sock.close();
}
main().catch(e => { console.error('FAIL', e.stack || e.message || e); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 200));
