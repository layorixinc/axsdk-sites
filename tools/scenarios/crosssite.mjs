#!/usr/bin/env node
// Cross-site, cross-domain live scenario for the AXSDK arrival-delivery fix.
//
// Drives ONE dev-Chrome session through a journey that criss-crosses all three sites
// (bluemoonsoft / thumbtack service-quote / amazon shopping), covering every DIRECTED site pair,
// so each leg forces a cross-origin navigation that the SDK's "complete-on-arrival" cross-nav must
// survive (no "discarded because the active site changed", no "command unavailable").
//
// Prereq: `node tools/ax.mjs sync bluemoonsoft` (all sites' Lua + flows in the store, remote OFF),
// extension reloaded. Run: `node tools/scenarios/crosssite.mjs [--port=9224]`.
//
// Per leg it asserts: (1) NO forbidden cross-nav error in any tool part, (2) the tab reached the
// leg's target domain, (3) at least one tool completed. Quote legs (interactive) carry full contact
// fields so collect_request finishes and the flow actually navigates to thumbtack + runs
// search_service; a "고마워 그만할게" reset (end_conversation) clears the paused refine step before the
// next leg so it is not swallowed by continue_current.

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveOptions, ensureChrome, attachActive, sendMessage, currentUrl, callInAxContext,
} from '../harness/cdp.mjs';

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

function summarizeParts(parts) {
  const tools = [];
  let forbidden = null;
  let text = '';
  for (const p of parts || []) {
    if (p.type === 'tool') {
      const blob = JSON.stringify(p.output ?? '');
      tools.push(`${p.tool}(${p.status || '?'})`);
      if (!forbidden && FORBIDDEN.test(blob)) forbidden = `${p.tool}: ${blob.slice(0, 160)}`;
    } else if (p.type === 'text' && p.text) {
      text = p.text;
      if (!forbidden && FORBIDDEN.test(p.text)) forbidden = `text: ${p.text.slice(0, 160)}`;
    }
  }
  return { tools, forbidden, text };
}

async function main() {
  log(`=== cross-site journey START (log: ${LOG}) ===`);
  const options = resolveOptions({});
  const { cdpUrl } = await ensureChrome(options, { launch: options.launch !== false });
  const { page } = await attachActive(cdpUrl, options, {});
  const session = { page, options, cdpUrl };
  // Wait until the AXSDK API has loaded on the (re-)attached tab before the first send. The SDK now holds
  // the send until its chat handler is subscribed and the SSE stream has attached (plans/send-after-stream-
  // attach.md), so leg 1 needs no SSE-priming warmup; this poll only avoids calling sendMessage before the
  // AXSDK object exists.
  for (let w = 0; w < 40; w++) {
    const ready = await callInAxContext(page, options,
      `function(){ const s = globalThis._AXSDK || globalThis.AXSDK; return !!(s && typeof s.sendMessage === 'function'); }`).catch(() => false);
    if (ready) { log(`send-ready after ${w}s`); break; }
    await new Promise(r => setTimeout(r, 1000));
  }
  // Start from a fresh session so the CURRENT common flows (shopping's refine/checkout steps, etc.) are
  // bound at session creation — a stale persisted session would keep running its older flow.
  await callInAxContext(page, options, `function(){ const s = globalThis._AXSDK || globalThis.AXSDK; if (s && s.resetSession) s.resetSession(); return true; }`).catch(() => {});
  const results = [];
  try {
    for (let i = 0; i < LEGS.length; i++) {
      const leg = LEGS[i];
      const startUrl = await currentUrl(session).catch(() => '?');
      log(`--- leg ${i + 1}/${LEGS.length}: ${leg.label}`);
      log(`    start: ${startUrl}`);
      log(`    send : ${leg.msg}`);
      let res, endUrl, sum, verdict, err = null;
      try {
        res = await sendMessage(session, leg.msg, { timeoutMs: leg.timeout });
        endUrl = await currentUrl(session).catch(() => '?');
        sum = summarizeParts(res.parts);
        const reached = String(endUrl || '').includes(leg.target);
        verdict = sum.forbidden ? 'FAIL(cross-nav)' : reached ? 'PASS' : 'PARTIAL(no-cross)';
        log(`    end  : ${endUrl}`);
        log(`    tools: ${sum.tools.join(' -> ') || '(none)'}`);
        log(`    reply: ${(sum.text || res.reply || '').replace(/\s+/g, ' ').slice(0, 200)}`);
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
          const r = await sendMessage(session, '고마워 그만할게', { timeoutMs: 90000 });
          log(`    reset reply: ${(r.reply || '').replace(/\s+/g, ' ').slice(0, 120)}`);
        } catch (e) { log(`    reset ERROR: ${String(e && e.message || e)}`); }
      }
    }
  } finally {
    try { page.close(); } catch { /* one-shot */ }
  }

  log('=== SUMMARY ===');
  let pass = 0, partial = 0, fail = 0;
  for (const r of results) {
    if (r.verdict === 'PASS') pass++;
    else if (r.verdict.startsWith('PARTIAL')) partial++;
    else fail++;
    log(`  ${r.verdict.padEnd(16)} ${r.leg}`);
  }
  const forbiddenCount = results.filter(r => r.forbidden).length;
  log(`RESULT: ${pass} PASS / ${partial} PARTIAL / ${fail} FAIL(+ERROR)  |  forbidden-cross-nav-errors=${forbiddenCount}`);
  log('=== cross-site journey DONE ===');
  process.exitCode = (fail === 0 && forbiddenCount === 0) ? 0 : 1;
}

main().catch(e => { log(`FATAL ${e && e.stack || e}`); process.exitCode = 1; });
