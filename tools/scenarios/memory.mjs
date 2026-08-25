#!/usr/bin/env node
// Live regression for automatic memory capture (planner-integrated, always-first):
//  A) memory saved alongside a task; B) memory-only request saved; C) a flow answer saves only with an explicit clause;
//  D) memory rehydrated into a task's deterministic recall; E) persists across a session reset;
//  F) a changed value updates the key; G) an explicit forget deletes the key; H–L) every read/category reply is consumer text.
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
const hasMemoryKey = (mem, key) => Object.hasOwn(mem || {}, `g/${key}`);
const INTERNAL_MEMORY_OUTPUT = /\b(?:memory_result|operation|next|ok)\b|command_unresolved|memory_op_unavailable|table:/i;
const consumerReply = (reply, expected) => {
  const text = String(reply || '').trim();
  return text !== '' && !INTERNAL_MEMORY_OUTPUT.test(text) && !/^[\[{]/.test(text)
    && (!expected || expected.test(text));
};
const successfulDeletionReply = (reply) => consumerReply(reply, /삭제|removed|forgot/i)
  && !/완료하지 못|failed|nothing was saved or deleted/i.test(String(reply || ''));
// Seed the GLOBAL memory scope the way AX_set_memory stores it: one `g/<key>` document per field.
const seedDocs = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [`g/${k}`, String(v)]));
const resetSession = async (session) => {
  try {
    await session.reset();
  } catch (error) {
    console.log(`  reset retry: ${error?.message || error}`);
    await session.reset();
  }
};
// A clean slate: no memory, no messages, a fresh backend session.
const freshSession = async (session) => { await session.writeMemory({}); await resetSession(session); };
// Seed memory, then reset so the respawned session runtime rehydrates it.
const seedMem = async (session, obj) => { await session.writeMemory(seedDocs(obj)); await resetSession(session); };

async function send(session, label, msg, timeoutMs = 150000) {
  const res = await session.send(msg, { timeoutMs }).catch((e) => ({ text: 'ERR ' + (e && e.message), parts: [], toolCalls: [] }));
  const mem = await session.readMemory().catch(() => ({}));
  console.log(`\n[${label}] ${msg}`);
  console.log('  tools:', tools(res).join(' -> ') || '(none)');
  console.log('  reply:', (res?.text || '').replace(/\s+/g, ' ').slice(0, 180));
  console.log('  memory:', JSON.stringify(mem));
  return { res, mem, reply: (res?.text || '').replace(/\s+/g, ' ') };
}
const openSession = async () => {
  try {
    return await openCdpSession();
  } catch (error) {
    console.log(`  open retry: ${error?.message || error}`);
    return openCdpSession();
  }
};


async function main() {
  const session = await openSession();
  try {
  await session.open('https://www.amazon.com/');
  const checks = [];

  await freshSession(session);
  const a = await send(session, 'A task+memory', '샌프란시스코 94103에서 청소 견적 줘. 내 전화번호 415-555-0199 기억해줘.');
  checks.push(['A phone saved', /415.?555.?0199/.test(memVals(a.mem))]);

  await freshSession(session);
  const b = await send(session, 'B memory-only', '내 이메일 hong@test.com 기억해줘.');
  checks.push(['B email saved', /hong@test\.com/i.test(memVals(b.mem))]);
  checks.push(['B reply is a consumer confirmation', consumerReply(b.reply, /기억|remember/i)]);

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
  await freshSession(session);
  const cv = memVals(c2.mem);
  checks.push(['C answering a flow does NOT save the contact', !/415.?555.?0155/.test(cv) && !/gildong@test\.com/i.test(cv)]);
  const c3 = await send(session, 'C3 same answer WITH a clause', '이메일 gildong@test.com 기억해줘.');
  checks.push(['C the same value IS saved when asked', /gildong@test\.com/i.test(memVals(c3.mem))]);
  checks.push(['C memory reply is a consumer confirmation', consumerReply(c3.reply, /기억|remember/i)]);
  // D) memory PRESENT is reused by a task flow: the deterministic recall must carry every saved contact
  // field. Do not couple this memory assertion to the downstream collection model: across eight clean-session
  // measurements the identical recall reached verify three times, cancelled four times, and re-asked for
  // contact once. Those are quote-collection outcomes, not evidence about whether memory rehydrated.
  await seedMem(session, { full_name: '홍길동', first_name: '길동', last_name: '홍', email: 'thumbtack-test@example.com', phone: '415-555-0188', zip_code: '94103' });
  const d = await send(session, 'D reuse memory in quote (no contact in msg)', '샌프란시스코 청소 견적 받아줘. 다음 주에 아파트 전체 청소가 필요해.');
  const dRecall = JSON.stringify((d.res.toolCalls || [])
    .find((call) => call.name === 'recall_saved_contact')?.output || {});
  checks.push(['D quote received every saved contact',
    ['홍길동', '길동', '홍', 'thumbtack-test@example.com', '415-555-0188', '94103']
      .every((value) => dRecall.includes(value))]);

  // E) memory persists across a session reset (reset keeps the shared memory store; only an
  //    explicit clear wipes it).
  await freshSession(session);
  const e1 = await send(session, 'E1 remember phone', '내 전화번호 415-555-0166 기억해줘.');
  checks.push(['E1 phone saved', /415.?555.?0166/.test(memVals(e1.mem))]);
  checks.push(['E reply is a consumer confirmation', consumerReply(e1.reply, /기억|remember/i)]);
  await resetSession(session);
  const eMem = await session.readMemory().catch(() => ({}));
  console.log('\n[E after reset] memory:', JSON.stringify(eMem));
  checks.push(['E phone persists across reset', /415.?555.?0166/.test(memVals(eMem))]);

  // F) a changed value UPDATES the same key (latest wins; the stale value is gone).
  await freshSession(session);
  await send(session, 'F1 phone A', '전화번호 415-555-0111 기억해줘.');
  const f2 = await send(session, 'F2 change phone', '아니, 전화번호는 415-555-0222 로 바꿔서 기억해줘.');
  const fv = memVals(f2.mem);
  checks.push(['F phone updated to latest (no stale value)', /415.?555.?0222/.test(fv) && !/415.?555.?0111/.test(fv)]);
  checks.push(['F update reply is a consumer confirmation', consumerReply(f2.reply, /기억|remember/i)]);

  // G) an explicit forget request deletes the key.
  await freshSession(session);
  const g1 = await send(session, 'G1 save email', '내 이메일 forget@test.com 기억해줘.');
  checks.push(['G1 email saved', /forget@test\.com/i.test(memVals(g1.mem))]);
  checks.push(['G1 reply is a consumer confirmation', consumerReply(g1.reply, /기억|remember/i)]);
  const g2 = await send(session, 'G2 forget email', '내 이메일 기억한 거 잊어줘.');
  checks.push(['G email forgotten', !/forget@test\.com/i.test(memVals(g2.mem))]);
  checks.push(['G delete reply confirms success', successfulDeletionReply(g2.reply)]);

  // H–J) the three read surfaces are consumer text too: list, exact read, and topic search. These used to
  // hand the nested op envelope to the terminal model, the same defect measured on writes above.
  await seedMem(session, { email: 'memory-reader@example.test', phone: '415-555-0177' });
  const h = await send(session, 'H list saved fields', '기억한 내용 보여줘.');
  checks.push(['H list names saved fields', /이메일|email/i.test(h.reply) && /전화번호|phone/i.test(h.reply)]);
  checks.push(['H list reply hides wire fields', consumerReply(h.reply)]);

  const i = await send(session, 'I read exact email', '내 이메일로 기억한 값이 뭐야?');
  checks.push(['I exact read returns the complete value as consumer text',
    consumerReply(i.reply, /memory-reader@example\.test/i)]);

  await seedMem(session, { project_alpha: '# Alpha\nlaunch checklist' });
  const j = await send(session, 'J search saved topic', '프로젝트 알파 관련 기억을 찾아줘.');
  checks.push(['J search returns grounded consumer text',
    consumerReply(j.reply, /project_alpha|launch checklist|# Alpha/i)]);

  // K–L) category deletion's no-match and cancellation responses must stay deterministic. The search
  // result stays internal, a no-match deletes nothing, and cancellation preserves every candidate.
  await freshSession(session);
  const k = await send(session, 'K category delete no match', '주소 관련 기억을 지워줘.');
  checks.push(['K category no-match deletes nothing', Object.keys(k.mem || {}).length === 0]);
  checks.push(['K category no-match is consumer text', consumerReply(k.reply, /찾지 못|no matching/i)]);

  await seedMem(session, { address: 'Seoul', shipping_address: 'Busan' });
  const l1 = await send(session, 'L1 category delete candidates', '주소 관련 기억을 지워줘.');
  checks.push(['L category chooser names every exact candidate',
    /address/.test(l1.reply) && /shipping_address/.test(l1.reply)]);
  const l2 = await send(session, 'L2 cancel category delete', '취소');
  checks.push(['L category cancellation preserves every candidate',
    hasMemoryKey(l2.mem, 'address') && hasMemoryKey(l2.mem, 'shipping_address')]);
  checks.push(['L category cancellation is consumer text', consumerReply(l2.reply, /취소|cancelled/i)]);


  console.log('\n=== RESULT ===');
  let pass = 0; for (const [n, ok] of checks) { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}`); if (ok) pass++; }
  console.log(`MEMTEST: ${pass}/${checks.length} PASS`);
  process.exitCode = pass === checks.length ? 0 : 1;
  } finally {
    try { await session.close(); } catch { /* one-shot */ }
  }
}
// Only when this file IS the entry point. Without the guard, a unit test importing a pure function from
// here started the whole live journey — measured, a five-assertion test file took 174 seconds and drove three
// real sites. The same idiom as `shopping.mjs`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('FATAL', e && e.stack || e); process.exitCode = 1; });
}
