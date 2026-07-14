#!/usr/bin/env node
// Live regression for checkout-from-anywhere (routes into the checkout flow -> AX_checkout, no order):
//  1) idle;  2) from another site (cross-nav to amazon);  3) mid-flow interrupt.
import { resolveOptions, ensureChrome, attachActive, navigate, sendMessage, currentUrl, callInAxContext } from '../harness/cdp.mjs';

const freshSession = (p, o) => callInAxContext(p, o, `function(){ const s=globalThis._AXSDK||globalThis.AXSDK; if(s.resetSession)s.resetSession(); return true; }`).catch(()=>{});
async function waitReady(p, o, ms=40000){ const t=Date.now(); while(Date.now()-t<ms){ if(await callInAxContext(p,o,`function(){const s=globalThis._AXSDK||globalThis.AXSDK;return !!(s&&typeof s.sendMessage==='function');}`).catch(()=>false)) return; await new Promise(r=>setTimeout(r,300)); } }
const tools = r => (r?.parts||[]).filter(p=>p.type==='tool').map(p=>`${p.tool}(${p.status})`);
const hitCheckout = r => tools(r).some(t => /checkout|open_site/i.test(t));

async function send(session, page, options, label, msg, timeoutMs=150000) {
  const res = await sendMessage(session, msg, { timeoutMs }).catch(e=>({reply:'ERR '+(e&&e.message)}));
  const url = await currentUrl(session).catch(()=>'?');
  console.log(`\n[${label}] ${msg}`);
  console.log('  tools:', tools(res).join(' -> ')||'(none)');
  console.log('  reply:', (res?.reply||'').replace(/\s+/g,' ').slice(0,180));
  console.log('  url:', url);
  return { res, url, reply: (res?.reply||'').replace(/\s+/g,' ') };
}

async function main() {
  const options = resolveOptions({});
  const { cdpUrl } = await ensureChrome(options, { launch: false });
  const { page } = await attachActive(cdpUrl, options, {});
  const session = { page, options, cdpUrl };
  const checks = [];

  // 1) idle on amazon
  await navigate(page, 'https://www.amazon.com/'); await waitReady(page, options); await freshSession(page, options);
  const c1 = await send(session, page, options, '1 idle checkout', '체크아웃 해줘');
  checks.push(['1 idle -> checkout node ran', hitCheckout(c1.res) && /amazon\./.test(c1.url)]);

  // 2) from bluemoonsoft (cross-domain)
  await navigate(page, 'http://bluemoonsoft.com/'); await waitReady(page, options); await freshSession(page, options);
  const c2 = await send(session, page, options, '2 checkout from bluemoonsoft', '장바구니 결제 진행해줘');
  checks.push(['2 other-site -> cross-nav to amazon + checkout', hitCheckout(c2.res) && /amazon\./.test(c2.url)]);

  // 3) mid-flow interrupt: start a quote (asks), then checkout
  await navigate(page, 'https://www.amazon.com/'); await waitReady(page, options); await freshSession(page, options);
  await send(session, page, options, '3a start quote', '샌프란시스코 청소 견적 줘');
  const c3 = await send(session, page, options, '3b checkout mid-flow', '체크아웃 해줘');
  checks.push(['3 mid-flow checkout force-routes (not quote answer)', hitCheckout(c3.res) && /amazon\./.test(c3.url)]);

  console.log('\n=== RESULT ===');
  let pass=0; for(const [n,ok] of checks){ console.log(`  ${ok?'PASS':'FAIL'}  ${n}`); if(ok)pass++; }
  console.log(`COTEST: ${pass}/${checks.length} PASS`);
  try{ page.close(); }catch{}
  process.exitCode = pass===checks.length?0:1;
}
main().catch(e=>{console.error('FATAL',e&&e.stack||e);process.exitCode=1;});
