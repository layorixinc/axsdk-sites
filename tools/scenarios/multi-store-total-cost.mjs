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

/** Complete exploration snapshot from the node trace; tool output may be cut at the chat-store limit. */
export function explorationSnapshot(turn) {
  const parts = Array.isArray(turn?.parts) ? turn.parts : [];
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part?.type !== 'step-start' || part.debug?.node !== 'present_exploration') continue;
    const snapshot = decode(part.debug?.localState?.exploration_state);
    if (snapshot !== null && typeof snapshot === 'object' && Array.isArray(snapshot.groups)) return snapshot;
  }
  return null;
}

export function discoveryChoiceSurface(turn) {
  const call = findToolCall(turn?.toolCalls, 'present_product_exploration');
  const output = decode(call?.output);
  const question = String(
    output !== null && typeof output === 'object' ? output.question || turn?.text || '' : turn?.text || '',
  );
  const forbidden = /identity_confidence|source_sites|source_refs|sample[_ ]prices?|exploration_state/i;
  const renderedSnapshot = explorationSnapshot(turn);
  return call?.status === 'completed'
    && (output?.next === 'ask' || renderedSnapshot !== null)
    && /(?:^|\n)\s*1\.\s+\S/m.test(question)
    && /관측 판매처|observed stores?/i.test(question)
    && !forbidden.test(question);
}

/** A filter/sort turn must issue and render a new exploration snapshot without repeating live discovery. */
export function refinedExplorationSurface(turn, previousId) {
  const refined = findToolCall(turn?.toolCalls, 'shopping_refine_product_exploration');
  const presented = findToolCall(turn?.toolCalls, 'present_product_exploration');
  const output = decode(presented?.output);
  const snapshot = explorationSnapshot(turn);
  const currentId = output !== null && typeof output === 'object'
    ? output.exploration_id || snapshot?.exploration_id
    : snapshot?.exploration_id;
  return refined?.status === 'completed'
    && presented?.status === 'completed'
    && (output?.next === 'ask' || snapshot !== null)
    && typeof currentId === 'string'
    && currentId !== previousId
    && discoveryChoiceSurface(turn)
    && !findToolCall(turn?.toolCalls, 'shopping_discover_products');
}

export function sitesFromWindow(text, requestedSites) {
  const window = String(text || '');
  return (requestedSites || []).filter((site) => window.includes(`[${site}]`) || window.includes(`(${site})`));
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
    const prefillOutput = lastToolOutput(compare.toolCalls, 'shopping_prefill_total_cost_request');
    const prefilledSites = Object.values(prefillOutput?.stores ?? {}).map((item) => item?.site).filter(Boolean);
    check(checks, 'deterministic preflight keeps every requested store', requestedSites.every((site) => prefilledSites.includes(site)), prefilledSites.join(','));
    if (discoveryMode) {
      const explorationOutput = lastToolOutput(compare.toolCalls, 'shopping_build_product_exploration');
      const explorationState = explorationSnapshot(compare) ?? (() => {
        try { return JSON.parse(explorationOutput?.exploration_state || ''); } catch { return null; }
      })();
      const productGroups = Array.isArray(explorationState?.groups) ? explorationState.groups : [];
      const discoveryReply = String(compare.text || '');
      const numberedGroups = (discoveryReply.match(/(?:^|\n)\s*\d+\.\s+/g) || []).length;
      check(checks, 'broad request discovers grounded product groups',
        productGroups.length > 0 || numberedGroups > 0, `groups=${productGroups.length || numberedGroups}`);
      check(checks, 'consumer sees a safe numbered product list', discoveryChoiceSurface(compare),
        discoveryReply.replace(/\s+/g, ' ').slice(0, 300));
      const sourceMetadataValid = productGroups.length > 0
        ? productGroups.every(group => {
            const sourceSites = Array.isArray(group.source_sites) ? group.source_sites : [];
            const sourceRefs = Array.isArray(group.source_refs) ? group.source_refs : [];
            return Number(group.source_site_count) === new Set(sourceSites).size
              && sourceSites.every(site => requestedSites.includes(site))
              && sourceRefs.every(ref => sourceSites.includes(ref.site));
          })
        : requestedSites.some(site => discoveryReply.includes(site));
      check(checks, 'product exploration provenance names live sites', sourceMetadataValid,
        productGroups.length > 0
          ? productGroups.map(group => `${group.group_id}:${group.source_site_count}/${group.source_sites?.join(',') || '-'}`).join(' ')
          : requestedSites.filter(site => discoveryReply.includes(site)).join(','));
      check(checks, 'product identity is approved before store ranking',
        Boolean(findToolCall(compare.toolCalls, 'present_product_exploration'))
          && !findToolCall(compare.toolCalls, 'shopping_rank_store_offers'));
      check(checks, 'discovery cannot mutate a cart', !findToolCall(compare.toolCalls, 'shopping_add_selected_store_offer'));
      console.log(`DISCOVER  ${discoveryReply.replace(/\s+/g, ' ').slice(0, 500)}`);
      const initialExplorationId = explorationState?.exploration_id ?? explorationOutput?.exploration_id;
      const refined = await session.send('이름순으로 보여줘', { timeoutMs: 120000 });
      check(checks, 'filter and sort stay inside the exploration snapshot',
        refinedExplorationSurface(refined, initialExplorationId),
        String(refined.text || '').replace(/\s+/g, ' ').slice(0, 240));
      check(checks, 'exploration refinement cannot mutate a cart',
        !findToolCall(refined.toolCalls, 'shopping_add_selected_store_offer'));
      console.log(`REFINE   ${String(refined.text || '').replace(/\s+/g, ' ').slice(0, 500)}`);
      compare = await session.send(productChoice, { timeoutMs: Math.max(300000, requestedSites.length * 120000) });
      check(checks, 'current exploration number locks before comparison',
        Boolean(findToolCall(compare.toolCalls, 'shopping_resolve_product_exploration'))
          && Boolean(findToolCall(compare.toolCalls, 'shopping_verify_product_offers')));
    }
    const workerResults = (compare.toolCalls || [])
      .filter(call => call.name === 'shopping_search_one_store')
      .map(call => decode(call.output)?.store_result)
      .filter(Boolean);
    const stores = new Set(workerResults.map(result => result.site).filter(Boolean));
    const rankOutput = lastToolOutput(compare.toolCalls, 'shopping_rank_store_offers');
    const offers = Array.isArray(rankOutput?.offers) ? rankOutput.offers : [];
    const reply = String(compare.text || '');
    const windowSites = new Set(sitesFromWindow(reply, requestedSites));
    const compactOutput = lastToolOutput(compare.toolCalls, 'shopping_summarize_store_outcomes');
    const compactOutcomes = Array.isArray(compactOutput?.store_outcomes) ? compactOutput.store_outcomes : [];
    const compactSites = new Set(compactOutcomes.map((outcome) => outcome.site).filter(Boolean));
    const unsearchedSites = new Set(compactOutcomes
      .filter((outcome) => outcome.status === 'unsearched')
      .map((outcome) => outcome.site));
    const offerSites = new Set([
      ...offers.map(offer => offer.site),
      ...windowSites,
    ]);
    const failureSites = new Set((rankOutput?.failures || []).map(failure => failure.site).filter(Boolean));
    const outcomeSites = new Set([...stores, ...offerSites, ...failureSites, ...compactSites]);
    console.log(`STORES    compact=${compactOutcomes.map((outcome) => `${outcome.site}:${outcome.status}`).join(',') || '-'} window=${[...windowSites].join(',') || '-'} workers=${[...stores].join(',') || '-'}`);
    const numberedCount = offers.length || (reply.match(/(?:^|\n)\d+\.\s+\[/g) || []).length;

    check(checks, 'every selected store has a classified outcome', requestedSites.every(site => outcomeSites.has(site)), [...outcomeSites].join(','));
    check(checks, 'fan-out executes every selected store', requestedSites.every(site => !unsearchedSites.has(site)), [...unsearchedSites].join(','));
    const nonCandidateSites = compactOutcomes
      .filter((outcome) => outcome.status !== 'candidates')
      .map((outcome) => outcome.site);
    check(checks, 'comparison window names every non-candidate store', nonCandidateSites.every(site => windowSites.has(site)), [...windowSites].join(','));
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

    if (discoveryMode) {
      const firstIdentity = lastToolOutput(compare.toolCalls, 'shopping_resolve_product_exploration')?.identity_id;
      const restored = await session.send('다른 모델 보여줘', { timeoutMs: 120000 });
      check(checks, 'locked comparison restores the pre-lock exploration',
        Boolean(findToolCall(restored.toolCalls, 'shopping_invalidate_identity_selection'))
          && Boolean(findToolCall(restored.toolCalls, 'present_product_exploration'))
          && discoveryChoiceSurface(restored),
        String(restored.text || '').replace(/\s+/g, ' ').slice(0, 240));
      check(checks, 'returning to exploration cannot mutate a cart',
        !findToolCall(restored.toolCalls, 'shopping_add_selected_store_offer'));

      const switched = await session.send('2번', {
        timeoutMs: Math.max(300000, requestedSites.length * 120000),
      });
      const secondIdentity = lastToolOutput(switched.toolCalls, 'shopping_resolve_product_exploration')?.identity_id;
      check(checks, 'a different exploration number issues a new locked identity',
        Boolean(secondIdentity) && secondIdentity !== firstIdentity
          && Boolean(findToolCall(switched.toolCalls, 'shopping_verify_product_offers')),
        `${firstIdentity || '-'} -> ${secondIdentity || '-'}`);
      check(checks, 'identity replacement still requires a later offer approval',
        !findToolCall(switched.toolCalls, 'shopping_add_selected_store_offer'));
      compare = switched;
    }

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
