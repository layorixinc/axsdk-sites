#!/usr/bin/env node
// Production-flow live scenario for an explicitly selected representative-store comparison cycle.
// Runs on the shipping CDP extension via tools/harness/cdp-session.mjs (contract C3): the driver
// brings the profile up on THIS working copy, so the local index and all Lua/flows arrive through the
// stored workspace — there is no page-level Fetch interception and no build step any more.
// The scenario never opens checkout and never places an order; --cancel keeps a read-only run.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from '../harness/cdp.mjs';

export const siteLabels = {
  amazon: 'Amazon',
  walmart: 'Walmart',
  ebay: 'eBay',
  aliexpress: 'AliExpress',
  etsy: 'Etsy',
  coupang: '쿠팡',
  'naver-shopping': '네이버쇼핑',
  gmarket: 'G마켓',
  '11st': '11번가',
  ssg: 'SSG.COM',
};

export function parseScenarioArgs(argv) {
  const args = new Set(argv);
  // --no-build is accepted for invocation compatibility; the CDP harness reads the workspace from
  // source, so there is nothing to build (or skip building).
  const noBuild = args.has('--no-build');
  const cancelOnly = args.has('--cancel');
  const discoveryMode = args.has('--discover');
  const productChoiceArg = argv.find(value => value.startsWith('--product-choice='));
  const productChoice = productChoiceArg ? productChoiceArg.slice('--product-choice='.length) : '1';
  const storesArg = argv.find(value => value.startsWith('--stores='));
  const requestedSites = storesArg
    ? storesArg.slice('--stores='.length).split(',').map(value => value.trim()).filter(Boolean)
    : ['amazon', 'ebay'];
  const productQuery = discoveryMode ? '로지텍 무선 마우스' : 'Logitech M185';
  const requestText = `${productQuery}를 ${requestedSites.map(site => siteLabels[site] || site).join(', ')}에서 배송비 포함 총액으로 비교해줘`;
  return { noBuild, cancelOnly, discoveryMode, productChoice, requestedSites, productQuery, requestText };
}

export function decode(value) {
  let current = value;
  for (let index = 0; index < 3 && typeof current === 'string'; index += 1) {
    try { current = JSON.parse(current); } catch { break; }
  }
  return current;
}

/** Last tool call whose name is `suffix` or ends in `.suffix` (the trace can carry both spellings). */
export function findToolCall(toolCalls, suffix) {
  const calls = toolCalls || [];
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const name = calls[index]?.name;
    if (name === suffix || name?.endsWith(`.${suffix}`)) return calls[index];
  }
  return undefined;
}

/** Decoded output of the last matching tool call, or null (replaces the legacy chat-store scan). */
export function lastToolOutput(toolCalls, suffix) {
  const call = findToolCall(toolCalls, suffix);
  return call === undefined ? null : decode(call.output) ?? null;
}

function check(checks, name, value, evidence = '') {
  const ok = Boolean(value);
  checks.push({ name, ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${evidence ? ` — ${evidence}` : ''}`);
  return ok;
}

async function main() {
  const { cancelOnly, discoveryMode, productChoice, requestedSites, requestText } = parseScenarioArgs(process.argv.slice(2));
  const checks = [];
  // Lazy: unit tests import this module's pure exports without loading the CDP driver.
  const { openCdpSession } = await import('../harness/cdp-session.mjs');
  const session = await openCdpSession();
  try {
    const indexMd = await readFile(join(repoRoot, 'index.md'), 'utf8');
    console.log(`WORKSPACE digest=${session.workspace.digest} domains=${session.workspace.domains.length}`);

    // The local index now arrives as part of the stored workspace; the extension proving it can
    // resolve amazon through it is the delivery evidence (no Fetch override exists to assert on).
    const opened = await session.open('https://www.amazon.com/');
    check(checks, 'local published-site index is active',
      requestedSites.every(site => indexMd.includes(`[${site}]`) && session.workspace.domains.includes(site))
        && opened.site === 'amazon',
      `site=${opened.site} digest=${session.workspace.digest}`);

    const { scriptIds } = await session.status();
    check(checks, 'stored common Lua is active',
      scriptIds.some(id => String(id).startsWith('stored-lua:'))
        && !scriptIds.some(id => String(id).includes('/scripts/')),
      scriptIds.join(','));

    // reset() before the send: a leftover paused comparison window would read the FIRST bare number
    // below as a SELECTION — the cart-approval turn. This also applies to --cancel runs.
    const fresh = await session.reset();
    check(checks, 'fresh flow session created', Boolean(fresh), `remaining=${fresh?.remaining ?? '?'}`);

    let compare = await session.send(requestText, { timeoutMs: Math.max(300000, requestedSites.length * 120000) });
    if (discoveryMode) {
      const optionOutput = lastToolOutput(compare.toolCalls, 'shopping_build_product_options');
      const productOptions = Array.isArray(optionOutput?.product_options) ? optionOutput.product_options : [];
      const discoveryReply = String(compare.text || '');
      const numberedOptions = (discoveryReply.match(/(?:^|\n)\s*\d+\.\s+/g) || []).length;
      check(checks, 'broad request discovers grounded product options', productOptions.length > 0 || numberedOptions > 0, `options=${productOptions.length || numberedOptions}`);
      const sourceMetadataValid = productOptions.length > 0
        ? productOptions.every(option => {
            const sourceSites = Array.isArray(option.source_sites) ? option.source_sites : [];
            const sourceRefs = Array.isArray(option.source_refs) ? option.source_refs : [];
            return Number(option.source_site_count) === new Set(sourceSites).size
              && sourceSites.every(site => requestedSites.includes(site))
              && sourceRefs.every(ref => sourceSites.includes(ref.site));
          })
        : requestedSites.some(site => discoveryReply.includes(site));
      check(checks, 'product option provenance names live sites', sourceMetadataValid, productOptions.length > 0
        ? productOptions.map(option => `${option.option_id}:${option.source_site_count}/${option.source_sites?.join(',') || '-'}`).join(' ')
        : requestedSites.filter(site => discoveryReply.includes(site)).join(','));
      const claimedSourceCounts = [...String(compare.text || '').matchAll(/\b(\d+)\s+source\s+sites?\b/gi)]
        .map(match => Number(match[1]));
      check(checks, 'product option prose does not inflate source sites', claimedSourceCounts.every(count => count <= requestedSites.length), claimedSourceCounts.join(','));
      check(checks, 'product identity is approved before store ranking', Boolean(findToolCall(compare.toolCalls, 'choose_product')) && !findToolCall(compare.toolCalls, 'shopping_rank_store_offers'));
      check(checks, 'discovery cannot mutate a cart', !findToolCall(compare.toolCalls, 'shopping_add_selected_store_offer'));
      console.log(`DISCOVER  ${String(compare.text || '').replace(/\s+/g, ' ').slice(0, 500)}`);
      compare = await session.send(productChoice, { timeoutMs: Math.max(300000, requestedSites.length * 120000) });
      check(checks, 'current product option locks before comparison', Boolean(findToolCall(compare.toolCalls, 'shopping_resolve_product_option')) && Boolean(findToolCall(compare.toolCalls, 'shopping_verify_product_offers')));
    }
    const workerResults = (compare.toolCalls || [])
      .filter(call => call.name === 'shopping_search_one_store')
      .map(call => decode(call.output)?.store_result)
      .filter(Boolean);
    const stores = new Set(workerResults.map(result => result.site).filter(Boolean));
    const rankOutput = lastToolOutput(compare.toolCalls, 'shopping_rank_store_offers');
    const offers = Array.isArray(rankOutput?.offers) ? rankOutput.offers : [];
    const reply = String(compare.text || '');
    const offerSites = new Set([
      ...offers.map(offer => offer.site),
      ...(requestedSites.filter(site => reply.includes(`[${site}]`))),
    ]);
    const failureSites = new Set((rankOutput?.failures || []).map(failure => failure.site).filter(Boolean));
    const outcomeSites = new Set([...stores, ...offerSites, ...failureSites]);
    const numberedCount = offers.length || (reply.match(/(?:^|\n)\d+\.\s+\[/g) || []).length;

    check(checks, 'agentic task map searched every selected store', requestedSites.every(site => outcomeSites.has(site)), [...outcomeSites].join(','));
    check(checks, 'live adapter results produce ranked offers', offerSites.size >= 1, [...offerSites].join(','));
    check(checks, 'comparison is bounded and numbered', numberedCount >= 1 && numberedCount <= 6, `offers=${numberedCount}`);
    // The gate named `choose_offer`, a model node that no longer exists: the comparison loop is
    // deterministic now, because an `action_unit` here re-sent the previous turn's "3번" when the user
    // typed "취소" and the offer went into a real cart. What has to hold is the BEHAVIOUR — the window
    // paused on its own question, and nothing was added — so that is what is checked, plus the pause
    // itself, which the old assertion could not see.
    const presented = findToolCall(compare.toolCalls, 'present_store_offers');
    check(checks, 'comparison asks before mutation', Boolean(presented)
      && decode(presented?.output)?.next === 'ask'
      && /numbered offer|offer number|번호|cancel/i.test(reply)
      && !findToolCall(compare.toolCalls, 'shopping_add_selected_store_offer'));
    console.log(`COMPARE  ${String(compare.text || '').replace(/\s+/g, ' ').slice(0, 500)}`);

    if (cancelOnly) {
      const cancelled = await session.send('취소', { timeoutMs: 120000 });
      check(checks, 'cancel leaves every cart untouched', !findToolCall(cancelled.toolCalls, 'shopping_add_selected_store_offer') && String(cancelled.text || '').trim().length > 0, String(cancelled.text || '').slice(0, 160));
    } else {
      const invalid = await session.send('99', { timeoutMs: 120000 });
      check(checks, 'out-of-range choice cannot mutate', !findToolCall(invalid.toolCalls, 'shopping_add_selected_store_offer'));
      check(checks, 'invalid choice is re-prompted', /invalid|유효|번호|number|다시/i.test(invalid.text || ''), String(invalid.text || '').slice(0, 160));

      const selected = await session.send('1', { timeoutMs: 300000 });
      const addCall = findToolCall(selected.toolCalls, 'shopping_add_selected_store_offer');
      const addOutput = decode(addCall?.output);
      const url = await session.status().then(s => s.url).catch(() => '');
      check(checks, 'valid current rank reaches guarded cart mutation', Boolean(findToolCall(selected.toolCalls, 'shopping_resolve_store_offer')) && Boolean(addCall));
      check(checks, 'selected offer is confirmed in a cart', addOutput?.cart_status === 'added', JSON.stringify(addOutput));
      check(checks, 'checkout and order remain untouched', !/checkout|buy\/spc|placeorder|order-confirmation/i.test(url) && !(selected.toolCalls || []).some(call => /checkout|place_order/i.test(call.name || '')), url);
      console.log(`SELECT  ${String(selected.text || '').replace(/\s+/g, ' ').slice(0, 500)}`);
    }
  } finally {
    await session.close().catch(() => {});
  }

  const passed = checks.filter(item => item.ok).length;
  console.log(`\nMULTI-STORE LIVE: ${passed}/${checks.length} PASS`);
  if (passed !== checks.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('FATAL', error?.stack || error);
    process.exitCode = 1;
  });
}
