#!/usr/bin/env node
// Live regression for automatic memory capture (planner-integrated, always-first):
//  A) memory saved alongside a task; B) memory-only request saved; C) flow-answer (continue_current) auto-saved;
//  D) memory REUSED by a task (quote w/o contact proceeds); E) persists across a session reset;
//  F) a changed value updates the key; G) an explicit forget deletes the key.
//
// Runs on the shipping CDP extension via tools/harness/cdp-session.mjs: the driver provisions the
// CDP profile (port 9334) with this workspace's stores, so no `ax sync` prereq. Memory documents
// live in the shared `axsdk:memory` store as `g/<key>` markdown entries; a seeded write only
// reaches the session runtime after `session.reset()` (the worker reads the store when it spawns),
// which is also what keeps every check clear of paused flow nodes.
import { pathToFileURL } from 'node:url';
import { openCdpSession } from '../harness/cdp-session.mjs';

const tools = (r) => (r?.toolCalls || []).map((t) => `${t.name}(${t.status})`);
const memVals = (m) => Object.values(m || {}).join(' | ');
// Seed the GLOBAL memory scope the way AX_set_memory stores it: one `g/<key>` document per field.
const seedDocs = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [`g/${k}`, String(v)]));
// A clean slate: no memory, no messages, a fresh backend session.
const freshSession = async (session) => { await session.writeMemory({}); await session.reset(); };
// Seed memory, then reset so the respawned session runtime rehydrates it.
const seedMem = async (session, obj) => { await session.writeMemory(seedDocs(obj)); await session.reset(); };

async function send(session, label, msg, timeoutMs = 150000) {
  const res = await session.send(msg, { timeoutMs }).catch((e) => ({ text: 'ERR ' + (e && e.message), parts: [], toolCalls: [] }));
  const mem = await session.readMemory().catch(() => ({}));
  console.log(`\n[${label}] ${msg}`);
  console.log('  tools:', tools(res).join(' -> ') || '(none)');
  console.log('  reply:', (res?.text || '').replace(/\s+/g, ' ').slice(0, 180));
  console.log('  memory:', JSON.stringify(mem));
  return { res, mem, reply: (res?.text || '').replace(/\s+/g, ' ') };
}

async function main() {
  const session = await openCdpSession();
  await session.open('https://www.amazon.com/');
  const checks = [];

  await freshSession(session);
  const a = await send(session, 'A task+memory', '샌프란시스코 94103에서 청소 견적 줘. 내 전화번호 415-555-0199 기억해줘.');
  checks.push(['A phone saved', /415.?555.?0199/.test(memVals(a.mem))]);

  await freshSession(session);
  const b = await send(session, 'B memory-only', '내 이메일 hong@test.com 기억해줘.');
  checks.push(['B email saved', /hong@test\.com/i.test(memVals(b.mem))]);

  // C) A contact given as an ANSWER to the quote flow is NOT saved on its own, and IS saved when the user asks.
  //
  // This case used to assert the opposite — that answering a quote auto-remembers the contact — and it
  // contradicted the shipped rule it was supposed to defend. The planner states it: "A value-providing answer is
  // NOT saved merely because it is reusable", and the examples add "contact STAYS in this quote requestText and is
  // not automatically saved". The deterministic capture enforces the same boundary: no explicit clause, no
  // capture. So the negative half is the one that matters, and it is checked first.
  await freshSession(session);
  await send(session, 'C1 start quote (no contact)', '샌프란시스코 94103에서 집 청소 견적 받아줘. 다음 주에 아파트 전체 청소 필요해.');
  const c2 = await send(session, 'C2 answer with contact, no clause', '이름은 홍길동, 이메일은 gildong@test.com, 전화번호는 415-555-0155 이야.');
  const cv = memVals(c2.mem);
  checks.push(['C answering a flow does NOT save the contact', !/415.?555.?0155/.test(cv) && !/gildong@test\.com/i.test(cv)]);
  const c3 = await send(session, 'C3 same answer WITH a clause', '이메일 gildong@test.com 기억해줘.');
  checks.push(['C the same value IS saved when asked', /gildong@test\.com/i.test(memVals(c3.mem))]);

  // D) memory PRESENT is reused by a task flow: a quote with NO contact in the message must
  //    fill contact+zip from <memory> and proceed (verify_request passes) instead of re-asking.
  await seedMem(session, { full_name: '홍길동', first_name: '길동', last_name: '홍', email: 'thumbtack-test@example.com', phone: '415-555-0188', zip_code: '94103' });
  const d = await send(session, 'D reuse memory in quote (no contact in msg)', '샌프란시스코 청소 견적 받아줘. 다음 주에 아파트 전체 청소가 필요해.');
  checks.push(['D quote reused memory (verify_request passed, no contact re-ask)', tools(d.res).some((t) => /verify_request\(completed\)/.test(t))]);

  // E) memory persists across a session reset (reset keeps the shared memory store; only an
  //    explicit clear wipes it).
  await freshSession(session);
  const e1 = await send(session, 'E1 remember phone', '내 전화번호 415-555-0166 기억해줘.');
  checks.push(['E1 phone saved', /415.?555.?0166/.test(memVals(e1.mem))]);
  await session.reset();
  const eMem = await session.readMemory().catch(() => ({}));
  console.log('\n[E after reset] memory:', JSON.stringify(eMem));
  checks.push(['E phone persists across reset', /415.?555.?0166/.test(memVals(eMem))]);

  // F) a changed value UPDATES the same key (latest wins; the stale value is gone).
  await freshSession(session);
  await send(session, 'F1 phone A', '전화번호 415-555-0111 기억해줘.');
  const f2 = await send(session, 'F2 change phone', '아니, 전화번호는 415-555-0222 로 바꿔서 기억해줘.');
  const fv = memVals(f2.mem);
  checks.push(['F phone updated to latest (no stale value)', /415.?555.?0222/.test(fv) && !/415.?555.?0111/.test(fv)]);

  // G) an explicit forget request deletes the key.
  await freshSession(session);
  const g1 = await send(session, 'G1 save email', '내 이메일 forget@test.com 기억해줘.');
  checks.push(['G1 email saved', /forget@test\.com/i.test(memVals(g1.mem))]);
  const g2 = await send(session, 'G2 forget email', '내 이메일 기억한 거 잊어줘.');
  checks.push(['G email forgotten', !/forget@test\.com/i.test(memVals(g2.mem))]);

  console.log('\n=== RESULT ===');
  let pass = 0; for (const [n, ok] of checks) { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}`); if (ok) pass++; }
  console.log(`MEMTEST: ${pass}/${checks.length} PASS`);
  try { await session.close(); } catch { /* one-shot */ }
  process.exitCode = pass === checks.length ? 0 : 1;
}
// Only when this file IS the entry point. Without the guard, a unit test importing a pure function from
// here started the whole live journey — measured, a five-assertion test file took 174 seconds and drove three
// real sites. The same idiom as `shopping.mjs`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('FATAL', e && e.stack || e); process.exitCode = 1; });
}
