#!/usr/bin/env node
// Reads the live extension flows store on the running dev Chrome and diffs the ':' (global) entry
// against the local _common/flows.yaml. Confirms the local file is what the flow engine ran.
//   node _common/scripts/verify_flows_store.mjs [--cdp=http://127.0.0.1:9225]
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLOWS_FILE = resolve(__dirname, '..', 'flows.yaml');
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`${k}=`)); return a ? a.slice(k.length + 1) : d; };
const EXT = process.env.AXSDK_EXTENSION_ID || 'dldlgmekahifbogjphgglkhibclglmpf';
const PORT = Number(arg('--port', process.env.CDP_PORT || 9225));
const ENDPOINT = arg('--cdp', process.env.CDP_URL || `http://127.0.0.1:${PORT}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = s => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

async function fetchJson(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); }
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
  off(); throw new Error(`AXSDK Assistant context not found for ${EXT}`);
}
async function callAx(page, fn) {
  const ctx = await findAxContext(page);
  const r = await page.send('Runtime.callFunctionOn', { functionDeclaration: fn, executionContextId: ctx.id, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval error');
  return r.result?.value;
}

const READ = `function(){const a=globalThis._AXSDK;const fs=a.getFlowsStore().getState();const f=fs.flows||{};const doc=f[':'];return{clientFlows:a.config.clientFlows,storedKeys:Object.keys(f),hasColon:typeof doc==='string',len:typeof doc==='string'?doc.length:null,content:typeof doc==='string'?doc:null};}`;

async function main() {
  const local = readFileSync(FLOWS_FILE, 'utf8');
  const list = await fetchJson(`${ENDPOINT}/json/list`);
  const tab = list.filter(t => t.type === 'page').find(p => String(p.url || '').includes('thumbtack.com'));
  if (!tab) throw new Error('no thumbtack.com page open on ' + ENDPOINT);
  const page = new CdpClient(tab.webSocketDebuggerUrl);
  await page.ready;
  const r = await callAx(page, READ);
  page.close();

  const stored = r.content || '';
  const norm = s => s.replace(/\r\n/g, '\n');
  const eq = norm(stored) === norm(local);
  console.log('endpoint        :', ENDPOINT);
  console.log('clientFlows     :', JSON.stringify(r.clientFlows));
  console.log('stored keys     :', JSON.stringify(r.storedKeys));
  console.log("has ':' entry   :", r.hasColon);
  console.log('local  len/sha  :', local.length, sha(norm(local)));
  console.log('stored len/sha  :', stored.length, sha(norm(stored)));
  console.log('BYTE-EQUAL      :', eq);
  const markers = ['minimax/minimax-m3', 'you do not set zip_status itself', 'resolve_failed', 'request_service_quote'];
  for (const m of markers) console.log(`marker [${m}] : local=${local.includes(m)} stored=${stored.includes(m)}`);
  process.exitCode = (eq && r.clientFlows && r.clientFlows.remoteSites === false && r.clientFlows.stored === true) ? 0 : 1;
}
main().catch(e => { console.error('FAIL', e?.stack || e?.message || e); process.exitCode = 1; });
