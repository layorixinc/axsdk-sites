#!/usr/bin/env node
// Live regression for checkout-from-anywhere (routes into the checkout flow -> run_checkout, the RPC
// implementation in _common.68_rpc_checkout; no order):
//  1) idle;  2) from another site (cross-nav to amazon);  3) mid-flow interrupt.
// Runs on the shipping CDP extension via tools/harness/cdp-session.mjs (contract C3). The flow
// reaches a checkout REVIEW page and stops — no place-order selector exists anywhere in this file.
import { FLOW_TOOLS, turnFault } from './turn-fault.mjs';
import { pathToFileURL } from 'node:url';

export const toolLabels = calls => (calls || []).map(call => `${call.name}(${call.status})`);
export const hitCheckout = calls => toolLabels(calls).some(label => /checkout|open_site/i.test(label));
export const checkoutCasePassed = (calls, url) => hitCheckout(calls) && /amazon\./.test(String(url || ''));
export function tally(checks) {
  let pass = 0;
  for (const [, ok] of checks) if (ok) pass += 1;
  return { pass, total: checks.length, allPassed: pass === checks.length };
}

/**
 * Runs one case and records its outcome, whatever happens.
 *
 * Measured live: `reset()` timed out at 60 s inside this runner's `try`, the throw left `main`, and the run
 * printed NO verdict at all — three checks silently became no checks. A step that fails must cost ONE check and
 * let the others report, the same rule the commerce sweep learned when dying on the first batch hid every later
 * batch's cost. The reason travels with the check so the report says what broke.
 */
export async function recordCase(checks, name, run) {
  try {
    checks.push([name, (await run()) === true]);
  } catch (error) {
    checks.push([name, false, String(error?.message ?? error)]);
  }
}

async function send(session, label, msg, timeoutMs = 150000, expects = FLOW_TOOLS.checkout) {
  const res = await session.send(msg, { timeoutMs }).catch(e => ({ text: 'ERR ' + (e && e.message), parts: [], toolCalls: [] }));
  const url = await session.status().then(s => s.url).catch(() => '?');
  console.log(`\n[${label}] ${msg}`);
  console.log('  tools:', toolLabels(res.toolCalls).join(' -> ') || '(none)');
  console.log('  reply:', (res.text || '').replace(/\s+/g, ' ').slice(0, 180));
  console.log('  url:', url);
  // A lost session, a turn that reached no node, or a planner misroute is not a checkout defect. Printing
  // it as one is how an afternoon goes to the wrong repo (`turn-fault.mjs`).
  const fault = turnFault({ toolCalls: res.toolCalls, failure: /^ERR /.test(res.text ?? '') ? res.text : null }, { expects });
  if (fault) console.log(`  fault: ${fault.kind} — ${fault.detail}`);
  return { res, url, reply: (res.text || '').replace(/\s+/g, ' '), fault };
}

async function main() {
  // Lazy: unit tests import this module's pure exports without loading the CDP driver.
  const { openCdpSession } = await import('../harness/cdp-session.mjs');
  const session = await openCdpSession();
  const checks = [];
  // Each case is recorded whatever it does. A `reset()` that times out — measured twice live — used to throw
  // out of here and take the verdict with it, so three checks became none.
  try {
    // 1) idle on amazon. reset() before the send: a leftover paused comparison window would read the
    // next message as its own turn (a bare number is a SELECTION — the cart-approval turn).
    await recordCase(checks, '1 idle -> checkout node ran', async () => {
      await session.open('https://www.amazon.com/');
      await session.reset();
      const c1 = await send(session, '1 idle checkout', '체크아웃 해줘');
      return checkoutCasePassed(c1.res.toolCalls, c1.url);
    });

    // 2) from bluemoonsoft (cross-domain)
    await recordCase(checks, '2 other-site -> cross-nav to amazon + checkout', async () => {
      await session.open('http://bluemoonsoft.com/');
      await session.reset();
      const c2 = await send(session, '2 checkout from bluemoonsoft', '장바구니 결제 진행해줘');
      return checkoutCasePassed(c2.res.toolCalls, c2.url);
    });

    // 3) mid-flow interrupt: start a quote (asks), then checkout. reset() only before 3a — the 3b
    // interrupt must land in the MIDDLE of the quote flow, so there is no reset between 3a and 3b.
    await recordCase(checks, '3 mid-flow checkout force-routes (not quote answer)', async () => {
      await session.open('https://www.amazon.com/');
      await session.reset();
      await send(session, '3a start quote', '샌프란시스코 청소 견적 줘');
      const c3 = await send(session, '3b checkout mid-flow', '체크아웃 해줘');
      return checkoutCasePassed(c3.res.toolCalls, c3.url);
    });
  } finally {
    await session.close().catch(() => {});
  }

  console.log('\n=== RESULT ===');
  for (const [name, ok, why] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${why ? ` — ${why}` : ''}`);
  }
  const { pass, total, allPassed } = tally(checks);
  console.log(`COTEST: ${pass}/${total} PASS`);
  process.exitCode = allPassed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('FATAL', e && e.stack || e); process.exitCode = 1; });
}
