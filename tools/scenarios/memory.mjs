#!/usr/bin/env node
// Live regression for automatic memory capture (planner-integrated, always-first):
//  A) memory saved alongside a task; B) memory-only request saved; C) flow-answer (continue_current) auto-saved;
//  D) memory REUSED by a task (quote w/o contact proceeds); E) persists across resetSession;
//  F) a changed value updates the key; G) an explicit forget deletes the key.
import { resolveOptions, ensureChrome, attachActive, navigate, sendMessage, callInAxContext } from '../harness/cdp.mjs';

const readMem = (p, o) => callInAxContext(p, o, `function(){ const s=globalThis._AXSDK||globalThis.AXSDK; try{return s.getMemoryStore().getState().memory||{};}catch{return{};} }`);
const freshSession = (p, o) => callInAxContext(p, o, `function(){ const s=globalThis._AXSDK||globalThis.AXSDK; try{s.getMemoryStore().getState().clearMemory();}catch{} if(s.resetSession)s.resetSession(); return true; }`).catch(()=>{});
async function waitReady(p, o, ms=40000){ const t=Date.now(); while(Date.now()-t<ms){ if(await callInAxContext(p,o,`function(){const s=globalThis._AXSDK||globalThis.AXSDK;return !!(s&&typeof s.sendMessage==='function');}`).catch(()=>false)) return; await new Promise(r=>setTimeout(r,300)); } }
const tools = r => (r?.parts||[]).filter(p=>p.type==='tool').map(p=>`${p.tool}(${p.status})`);
const memVals = m => Object.values(m||{}).join(' | ');
// seed the GLOBAL memory scope (':') the way AX_set_memory stores it (a JSON object), then reset the session.
const seedMem = (p, o, obj) => callInAxContext(p, o, `function(){ const s=globalThis._AXSDK||globalThis.AXSDK; const ms=s.getMemoryStore().getState(); ms.clearMemory(); ms.setMemory(':', ${JSON.stringify(JSON.stringify(obj))}); if(s.resetSession)s.resetSession(); return true; }`).catch(()=>{});
const resetOnly = (p, o) => callInAxContext(p, o, `function(){ const s=globalThis._AXSDK||globalThis.AXSDK; if(s.resetSession)s.resetSession(); return true; }`).catch(()=>{});

async function send(session, page, options, label, msg, timeoutMs=150000) {
  const res = await sendMessage(session, msg, { timeoutMs }).catch(e=>({reply:'ERR '+(e&&e.message)}));
  const mem = await readMem(page, options).catch(()=>({}));
  console.log(`\n[${label}] ${msg}`);
  console.log('  tools:', tools(res).join(' -> ')||'(none)');
  console.log('  reply:', (res?.reply||'').replace(/\s+/g,' ').slice(0,180));
  console.log('  memory:', JSON.stringify(mem));
  return { res, mem, reply: (res?.reply||'').replace(/\s+/g,' ') };
}

async function main() {
  const options = resolveOptions({});
  const { cdpUrl } = await ensureChrome(options, { launch: false });
  const { page } = await attachActive(cdpUrl, options, {});
  const session = { page, options, cdpUrl };
  await navigate(page, 'https://www.amazon.com/');
  await waitReady(page, options);
  const checks = [];

  await freshSession(page, options);
  const a = await send(session, page, options, 'A task+memory', '샌프란시스코 94103에서 청소 견적 줘. 내 전화번호 415-555-0199 기억해줘.');
  checks.push(['A phone saved', /415.?555.?0199/.test(memVals(a.mem))]);

  await freshSession(page, options);
  const b = await send(session, page, options, 'B memory-only', '내 이메일 hong@test.com 기억해줘.');
  checks.push(['B email saved', /hong@test\.com/i.test(memVals(b.mem))]);

  // C) contact given as an ANSWER to the quote flow (continue_current) must be auto-remembered.
  await freshSession(page, options);
  const c1 = await send(session, page, options, 'C1 start quote (no contact)', '샌프란시스코 94103에서 집 청소 견적 받아줘. 다음 주에 아파트 전체 청소 필요해.');
  const c2 = await send(session, page, options, 'C2 answer with contact', '이름은 홍길동, 이메일은 gildong@test.com, 전화번호는 415-555-0155 이야.');
  const cv = memVals(c2.mem);
  checks.push(['C phone saved from flow answer', /415.?555.?0155/.test(cv)]);
  checks.push(['C email saved from flow answer', /gildong@test\.com/i.test(cv)]);

  // D) memory PRESENT is reused by a task flow: a quote with NO contact in the message must
  //    fill contact+zip from <memory> and proceed (verify_request passes) instead of re-asking.
  await seedMem(page, options, { full_name: '홍길동', first_name: '길동', last_name: '홍', email: 'thumbtack-test@example.com', phone: '415-555-0188', zip_code: '94103' });
  await waitReady(page, options);
  const d = await send(session, page, options, 'D reuse memory in quote (no contact in msg)', '샌프란시스코 청소 견적 받아줘. 다음 주에 아파트 전체 청소가 필요해.');
  checks.push(['D quote reused memory (verify_request passed, no contact re-ask)', tools(d.res).some(t => /verify_request\(completed\)/.test(t))]);

  // E) memory persists across a session reset (resetSession keeps memory; only clearMemory wipes it).
  await freshSession(page, options);
  const e1 = await send(session, page, options, 'E1 remember phone', '내 전화번호 415-555-0166 기억해줘.');
  checks.push(['E1 phone saved', /415.?555.?0166/.test(memVals(e1.mem))]);
  await resetOnly(page, options);
  await waitReady(page, options);
  const eMem = await readMem(page, options).catch(() => ({}));
  console.log('\n[E after resetSession] memory:', JSON.stringify(eMem));
  checks.push(['E phone persists across resetSession', /415.?555.?0166/.test(memVals(eMem))]);

  // F) a changed value UPDATES the same key (latest wins; the stale value is gone).
  await freshSession(page, options);
  await send(session, page, options, 'F1 phone A', '전화번호 415-555-0111 기억해줘.');
  const f2 = await send(session, page, options, 'F2 change phone', '아니, 전화번호는 415-555-0222 로 바꿔서 기억해줘.');
  const fv = memVals(f2.mem);
  checks.push(['F phone updated to latest (no stale value)', /415.?555.?0222/.test(fv) && !/415.?555.?0111/.test(fv)]);

  // G) an explicit forget request deletes the key.
  await freshSession(page, options);
  const g1 = await send(session, page, options, 'G1 save email', '내 이메일 forget@test.com 기억해줘.');
  checks.push(['G1 email saved', /forget@test\.com/i.test(memVals(g1.mem))]);
  const g2 = await send(session, page, options, 'G2 forget email', '내 이메일 기억한 거 잊어줘.');
  checks.push(['G email forgotten', !/forget@test\.com/i.test(memVals(g2.mem))]);

  console.log('\n=== RESULT ===');
  let pass=0; for(const [n,ok] of checks){ console.log(`  ${ok?'PASS':'FAIL'}  ${n}`); if(ok)pass++; }
  console.log(`MEMTEST: ${pass}/${checks.length} PASS`);
  try{ page.close(); }catch{}
  process.exitCode = pass===checks.length?0:1;
}
main().catch(e=>{console.error('FATAL',e&&e.stack||e);process.exitCode=1;});
