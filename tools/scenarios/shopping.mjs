#!/usr/bin/env node
// Live regression for the enhanced shopping flow (refine after search + checkout confirmation).
//  1) "신발 사줘"        -> search, then refine_item ASKS which product (paused, no add yet)
//  2) "첫 번째로 해줘"    -> refine picks, add_to_cart, then checkout_confirm ASKS to checkout (no order)
//  3) "응 체크아웃 해줘"  -> checkout reached (checkout-anywhere force-routes to checkout flow: run_checkout; NO order placed)
import { resolveOptions, ensureChrome, attachActive, navigate, sendMessage, currentUrl, callInAxContext } from '../harness/cdp.mjs';

async function waitSendReady(page, options, ms = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await callInAxContext(page, options, `function(){ const s=globalThis._AXSDK||globalThis.AXSDK; return !!(s&&typeof s.sendMessage==='function'); }`).catch(() => false);
    if (ok) return Date.now() - t0;
    await new Promise(r => setTimeout(r, 300));
  }
  return -1;
}
const toolsOf = (res) => (res?.parts || []).filter(p => p.type === 'tool').map(p => `${p.tool}(${p.status})`);
const has = (res, name) => toolsOf(res).some(t => t.startsWith(name + '('));

async function step(session, label, msg, timeoutMs = 180000) {
  const t0 = Date.now();
  let res = null, err = null;
  try { res = await sendMessage(session, msg, { timeoutMs }); } catch (e) { err = String(e && e.message || e); }
  const reply = (res?.reply || '').replace(/\s+/g, ' ');
  const tools = toolsOf(res);
  console.log(`\n[${label}] send: ${msg}  (${Date.now() - t0}ms)${err ? ` ERR=${err}` : ''}`);
  console.log(`  tools: ${tools.join(' -> ') || '(none)'}`);
  console.log(`  reply: ${reply.slice(0, 240)}`);
  return { res, reply, tools, err };
}

async function main() {
  const options = resolveOptions({});
  const { cdpUrl } = await ensureChrome(options, { launch: false });
  const { page } = await attachActive(cdpUrl, options, {});
  const session = { page, options, cdpUrl };

  await navigate(page, 'https://www.amazon.com/');
  await waitSendReady(page, options);
  // Force a fresh session so the NEW common flows (refine_item/checkout) are sent at session creation.
  // (buildCommonClientFlows binds common flows at session creation; a stale session runs the old flow.)
  await callInAxContext(page, options, `function(){ const s=globalThis._AXSDK||globalThis.AXSDK; if(s&&s.resetSession) s.resetSession(); return true; }`).catch(() => {});

  const checks = [];
  const s1 = await step(session, '1 search->refine', '신발 사줘');
  const p1 = !s1.err && has(s1.res, 'search_product') && has(s1.res, 'shopping.refine_item') && !has(s1.res, 'add_to_cart') && !has(s1.res, 'checkout') && s1.reply.length > 0;
  checks.push(['refine asks after search (no add yet)', p1]);

  const s2 = await step(session, '2 pick->add->checkout?', '첫 번째로 해줘');
  const p2 = !s2.err && has(s2.res, 'add_to_cart') && has(s2.res, 'shopping.checkout_confirm') && /체크아웃|결제|checkout/i.test(s2.reply);
  checks.push(['add_to_cart then checkout-confirm asks', p2]);

  const s3 = await step(session, '3 approve->checkout', '응 체크아웃 해줘');
  const endUrl = await currentUrl(session).catch(() => '?');
  const p3 = !s3.err && (has(s3.res, 'run_checkout') || has(s3.res, 'do_checkout') || has(s3.res, 'checkout')) && /주문|order|체크아웃|checkout|결제/i.test(s3.reply);
  checks.push(['checkout runs (no order placed)', p3]);
  console.log(`  endUrl: ${endUrl}`);

  console.log('\n=== RESULT ===');
  let pass = 0;
  for (const [name, ok] of checks) { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`); if (ok) pass++; }
  console.log(`SHOPTEST: ${pass}/${checks.length} PASS`);
  try { page.close(); } catch { /* one-shot */ }
  process.exitCode = pass === checks.length ? 0 : 1;
}
main().catch(e => { console.error('FATAL', e && e.stack || e); process.exitCode = 1; });
