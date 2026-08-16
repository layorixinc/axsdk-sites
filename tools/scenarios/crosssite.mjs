#!/usr/bin/env node
// Cross-site, cross-domain live scenario for the AXSDK arrival-delivery fix.
//
// Drives ONE session through a journey that criss-crosses all three sites
// (bluemoonsoft / thumbtack service-quote / amazon shopping), covering every DIRECTED site pair,
// so each leg forces a cross-origin navigation that the SDK's "complete-on-arrival" cross-nav must
// survive (no "discarded because the active site changed", no "command unavailable").
//
// Runs on the shipping CDP extension via tools/harness/cdp-session.mjs: the driver provisions the
// CDP profile (port 9334, override with --port=<n>) with this workspace's stores — no `ax sync`
// prereq, no extension reload step. Run: `node tools/scenarios/crosssite.mjs [--port=9334]`.
//
// Per leg it asserts: (1) NO forbidden cross-nav error in any tool output or reply text, (2) the
// tab reached the leg's target domain, (3) at least one tool completed. Quote legs (interactive)
// carry full contact fields so collect_request finishes and the flow actually navigates to
// thumbtack + runs search_service; a "고마워 그만할게" reset (end_conversation) clears the paused
// refine step before the next leg so it is not swallowed by continue_current.

import { pathToFileURL } from 'node:url';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { openCdpSession } from '../harness/cdp-session.mjs';

const FORBIDDEN = /discarded because the active site changed|command unavailable|cannot resume|active site changed/i;
const LOG = join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'crosssite.log');

function log(line) {
  const stamp = new Date().toISOString().slice(11, 19);
  const msg = `[${stamp}] ${line}`;
  console.log(msg);
  try { appendFileSync(LOG, msg + '\n'); } catch { /* best-effort */ }
}

// Full-contact quote request so collect_request finishes in one turn and the flow navigates to
// thumbtack (search_service = the cross-domain proof). Reserved/fake PII only.
function quoteMsg(serviceKo, needKo, phoneTail) {
  return `샌프란시스코 94103에서 ${serviceKo} 견적 받아줘. ${needKo} 이름은 길동, 성은 홍, `
    + `이메일은 thumbtack-test@example.com, 전화번호는 415-555-01${phoneTail} 이야.`;
}

const LEGS = [
  // starts on amazon (previous "계란 사줘" leg ended there)
  { label: 'amazon → thumbtack (quote: house cleaning)', target: 'thumbtack.com', timeout: 260000, reset: true,
    msg: quoteMsg('집 청소', '다음 주에 아파트 전체 청소가 필요해요.', '42') },
  { label: 'thumbtack → bluemoonsoft (docuray)', target: 'bluemoonsoft.com', timeout: 160000,
    msg: '블루문소프트 다큐레이 보여줘' },
  { label: 'bluemoonsoft → amazon (shop: wireless mouse)', target: 'amazon.', timeout: 260000, reset: true,
    msg: '무선 마우스 사줘' },
  { label: 'amazon → bluemoonsoft (news)', target: 'bluemoonsoft.com', timeout: 160000,
    msg: '블루문소프트 새소식 보여줘' },
  { label: 'bluemoonsoft → thumbtack (quote: lawn mowing)', target: 'thumbtack.com', timeout: 260000, reset: true,
    msg: quoteMsg('잔디 깎기', '앞마당 잔디를 깎아야 해요.', '43') },
  { label: 'thumbtack → amazon (shop: airpods)', target: 'amazon.', timeout: 260000, reset: true,
    msg: 'airpods 사줘' },
];

// The turn's tool trace + reply, scanned for the forbidden cross-nav errors. Tool output rides at
// state.output and the driver surfaces it (JSON-parsed) on toolCalls; the reply is turn.text.
function summarizeTurn(turn) {
  const tools = [];
  let forbidden = null;
  for (const t of turn?.toolCalls || []) {
    const blob = JSON.stringify(t.output ?? '');
    tools.push(`${t.name}(${t.status || '?'})`);
    if (!forbidden && FORBIDDEN.test(blob)) forbidden = `${t.name}: ${blob.slice(0, 160)}`;
  }
  const text = turn?.text || '';
  if (!forbidden && FORBIDDEN.test(text)) forbidden = `text: ${text.slice(0, 160)}`;
  return { tools, forbidden, text };
}

/**
 * What a leg's outcome MEANS. Pure, so the rule is unit-testable rather than buried in the loop.
 *
 * A leg that never reached the other site is a **failure**, not a shade of success. This runner exists to prove
 * that each leg forces a cross-origin navigation and the SDK's complete-on-arrival survives it; a leg that
 * stayed put produced no such proof. The previous edition scored that `PARTIAL(no-cross)` and left it out of the
 * failure count, so a journey where NOT ONE leg crossed still exited 0 — the runner could report success for
 * exactly the situation it was written to catch.
 */
export function legVerdict(leg, turn = {}) {
  if (turn.error) return 'ERROR';
  if (turn.forbidden) return 'FAIL(cross-nav)';
  return String(leg?.endUrl || '').includes(leg?.target) ? 'PASS' : 'FAIL(no-cross: never reached the target)';
}

/** The run's verdict. Green needs every leg crossed, nothing forbidden, and at least one leg attempted. */
export function journeyOutcome(results) {
  const rows = Array.isArray(results) ? results : [];
  const passed = rows.filter((row) => row?.verdict === 'PASS').length;
  const failed = rows.length - passed;
  const forbidden = rows.filter((row) => row?.forbidden).length;
  return { total: rows.length, passed, failed, forbidden, ok: rows.length > 0 && failed === 0 && forbidden === 0 };
}

function portArg(argv) {
  const found = argv.find((a) => a.startsWith('--port='));
  return found ? Number(found.slice('--port='.length)) : undefined;
}

async function main() {
  log(`=== cross-site journey START (log: ${LOG}) ===`);
  const session = await openCdpSession({ port: portArg(process.argv.slice(2)) ?? 9334 });
  log(`session ready (backend ${session.sessionId}, workspace ${session.workspace.digest})`);
  // The journey's first leg leaves amazon, so start there deterministically instead of wherever
  // the last run left the session.
  const start = await session.open('https://www.amazon.com/');
  log(`start page: ${start.url} (site ${start.site || 'none'})`);
  // Start from a fresh conversation so the CURRENT common flows (shopping's refine/checkout steps,
  // etc.) are bound at session creation — a stale persisted session would keep running its older
  // flow, and a paused comparison window would read the next bare number as a SELECTION.
  await session.reset();
  const results = [];
  try {
    for (let i = 0; i < LEGS.length; i++) {
      const leg = LEGS[i];
      const startUrl = await session.status().then((s) => s.url).catch(() => '?');
      log(`--- leg ${i + 1}/${LEGS.length}: ${leg.label}`);
      log(`    start: ${startUrl}`);
      log(`    send : ${leg.msg}`);
      let res, endUrl, sum, verdict, err = null;
      try {
        res = await session.send(leg.msg, { timeoutMs: leg.timeout });
        endUrl = await session.status().then((s) => s.url).catch(() => '?');
        sum = summarizeTurn(res);
        // One rule, in `legVerdict`, so the loop cannot disagree with what the unit tests pin.
        verdict = legVerdict({ target: leg.target, endUrl }, sum);
        const reached = verdict === 'PASS';
        log(`    end  : ${endUrl}`);
        log(`    tools: ${sum.tools.join(' -> ') || '(none)'}`);
        log(`    reply: ${(sum.text || '').replace(/\s+/g, ' ').slice(0, 200)}`);
        if (sum.forbidden) log(`    !! FORBIDDEN: ${sum.forbidden}`);
        log(`    verdict: ${verdict}  (target=${leg.target}, reached=${reached})`);
      } catch (e) {
        err = String(e && e.message || e);
        verdict = 'ERROR';
        log(`    ERROR: ${err}`);
      }
      results.push({ leg: leg.label, target: leg.target, startUrl, endUrl, verdict,
        tools: sum?.tools || [], forbidden: sum?.forbidden || null, error: err });

      if (leg.reset) {
        log(`    reset: 고마워 그만할게 (end_conversation)`);
        try {
          const r = await session.send('고마워 그만할게', { timeoutMs: 90000 });
          log(`    reset reply: ${(r.text || '').replace(/\s+/g, ' ').slice(0, 120)}`);
        } catch (e) { log(`    reset ERROR: ${String(e && e.message || e)}`); }
      }
    }
  } finally {
    try { await session.close(); } catch { /* one-shot */ }
  }

  log('=== SUMMARY ===');
  for (const r of results) log(`  ${r.verdict.padEnd(34)} ${r.leg}`);
  // `journeyOutcome` owns the rule, and it has no PARTIAL: a leg that never reached the other site produced no
  // cross-navigation to survive, which is the one thing this runner exists to prove. Counting it as a shade of
  // success meant a journey where NOT ONE leg crossed still exited 0.
  const outcome = journeyOutcome(results);
  log(`RESULT: ${outcome.passed}/${outcome.total} legs crossed · failed ${outcome.failed}`
    + ` · forbidden-cross-nav-errors ${outcome.forbidden}`);
  log('=== cross-site journey DONE ===');
  process.exitCode = outcome.ok ? 0 : 1;
}

// Only when this file IS the entry point. Without the guard, a unit test importing a pure function from
// here started the whole live journey — measured, a five-assertion test file took 174 seconds and drove three
// real sites. The same idiom as `shopping.mjs`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { log(`FATAL ${e && e.stack || e}`); process.exitCode = 1; });
}
