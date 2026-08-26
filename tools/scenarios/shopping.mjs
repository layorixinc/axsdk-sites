#!/usr/bin/env node
// Live regression for the enhanced shopping flow (refine after search + checkout confirmation).
//  1) "신발 사줘"        -> search, then refine_item ASKS which product (paused, no add yet)
//  2) "첫 번째로 해줘"    -> refine picks, add_to_cart, then checkout_confirm ASKS to checkout (no order)
//  3) "응 체크아웃 해줘"  -> checkout reached (checkout-anywhere force-routes to checkout flow: run_checkout; NO order placed)
// Runs on the shipping CDP extension via tools/harness/cdp-session.mjs (contract C3).
import { pathToFileURL } from 'node:url';

import { FLOW_TOOLS, turnFault } from './turn-fault.mjs';

/** A tool that RAN, whatever it answered. */
export const hasTool = (calls, name) => (calls || []).some(call => call.name === name);
// A tool that ran is not a tool that worked. Measured live: `shopping_add_to_cart` answered `error` while the
// terminal said both "장바구니에 담았습니다" and "shoes는 추가되지 않았습니다", and a name-only predicate called
// that a pass. The cart step is the one place in this flow where the distinction is the whole point.
export const toolSucceeded = (calls, name) => (calls || [])
  .some(call => call.name === name && call.status !== 'error' && call.status !== 'failed');

// Step predicates over { err, text, toolCalls } — pure, so the verdicts are unit-testable. Every tool name is
// the RPC name a live trace showed; the durable names this flow used before the port (`search_product`,
// `shopping.refine_item`, `add_to_cart`) no longer exist and matched nothing for as long as they stood here.
export const refineAsksAfterSearch = step => !step.err
  && hasTool(step.toolCalls, 'shopping_search_product')
  && hasTool(step.toolCalls, 'shopping_single_site.refine_item')
  && !hasTool(step.toolCalls, 'shopping_add_to_cart')
  && !hasTool(step.toolCalls, 'run_checkout')
  && step.text.length > 0;
export const addThenConfirmAsks = step => !step.err
  && toolSucceeded(step.toolCalls, 'shopping_add_to_cart')
  && hasTool(step.toolCalls, 'shopping_single_site.checkout_confirm')
  && /체크아웃|결제|checkout/i.test(step.text);
export const checkoutRunsNoOrder = step => {
  if (step.err || !(hasTool(step.toolCalls, 'run_checkout') || hasTool(step.toolCalls, 'do_checkout'))) return false;
  const text = String(step.text || '');
  return /주문.{0,20}(?:완료|처리|확정|접수)?되지 않았|주문.{0,20}(?:이루어지지|진행되지) 않았|주문.{0,20}(?:하지 않았|안 했|없습니다)|no order|order (?:has )?not been placed|did not place (?:an )?order|without placing (?:an )?order/i.test(text);
};

async function step(session, label, msg, timeoutMs = 180000, expects = FLOW_TOOLS.singleSite) {
  const t0 = Date.now();
  let res = null, err = null;
  try { res = await session.send(msg, { timeoutMs }); } catch (e) { err = String(e && e.message || e); }
  const text = (res?.text || '').replace(/\s+/g, ' ');
  const toolCalls = res?.toolCalls || [];
  console.log(`\n[${label}] send: ${msg}  (${Date.now() - t0}ms)${err ? ` ERR=${err}` : ''}`);
  console.log(`  tools: ${toolCalls.map(call => `${call.name}(${call.status})`).join(' -> ') || '(none)'}`);
  console.log(`  reply: ${text.slice(0, 240)}`);
  // A lost session, a turn that reached no node, or a planner misroute says nothing about the shopping
  // flow — printing it as a failed check sends the reader to the wrong file (`turn-fault.mjs`).
  const fault = turnFault({ toolCalls, failure: err }, { expects });
  if (fault) console.log(`  fault: ${fault.kind} — ${fault.detail}`);
  return { err, text, toolCalls, fault };
}

async function main() {
  // Lazy: unit tests import this module's pure exports without loading the CDP driver.
  const { openCdpSession } = await import('../harness/cdp-session.mjs');
  const session = await openCdpSession();
  const checks = [];
  try {
    await session.open('https://www.amazon.com/');
    // Fresh conversation, for two reasons: common flows bind at session creation (a stale session
    // runs the old flow), and a leftover paused window would read "첫 번째로 해줘"/a bare number as a
    // SELECTION — the cart-approval turn. Steps 2 and 3 deliberately continue THIS conversation, so
    // there is exactly one reset(), here.
    await session.reset();

    const s1 = await step(session, '1 search->refine', '신발 사줘');
    checks.push(['refine asks after search (no add yet)', refineAsksAfterSearch(s1)]);

    const s2 = await step(session, '2 pick->add->checkout?', '첫 번째로 해줘');
    checks.push(['add_to_cart then checkout-confirm asks', addThenConfirmAsks(s2)]);

    // Step 3 hands off to the CHECKOUT flow on purpose, so its expectation is not this runner's default:
    // a shared fault rule needs a per-STEP expectation wherever a scenario legitimately crosses flows.
    // Measured: with the runner default it reported `checkout_entry -> run_checkout` as a misroute.
    const s3 = await step(session, '3 approve->checkout', '응 체크아웃 해줘', 180000, FLOW_TOOLS.checkout);
    checks.push(['checkout runs (no order placed)', checkoutRunsNoOrder(s3)]);
    const endUrl = await session.status().then(s => s.url).catch(() => '?');
    console.log(`  endUrl: ${endUrl}`);
  } finally {
    await session.close().catch(() => {});
  }

  console.log('\n=== RESULT ===');
  let pass = 0;
  for (const [name, ok] of checks) { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`); if (ok) pass++; }
  console.log(`SHOPTEST: ${pass}/${checks.length} PASS`);
  process.exitCode = pass === checks.length ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('FATAL', e && e.stack || e); process.exitCode = 1; });
}
