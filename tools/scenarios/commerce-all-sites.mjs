#!/usr/bin/env node
// Read-only extension scenario for every representative commerce adapter named in
// AXSDK_CHROME_EXTENSION_AGENTIC_TASKS.md. Runs on the shipping CDP extension via
// tools/harness/cdp-session.mjs (contract C3), through the FLOW ENGINE: one real user turn per
// query batch, the way tools/scenarios/multi-store-total-cost.mjs already runs. The durable
// AX_search_store_product path this runner used to drive raises on the CDP runtime
// (nav.clear_beforeunload, then dom.get_attr -> no_element) and is being removed.
//
// This runner PUBLISHES the index; it never intercepts it. Under the CDP harness the index arrives
// as part of the stored workspace (`axsdk:sites` `state.index`), written by the driver's bring-up.
// The publication is asserted EXPLICITLY below — the session's workspace digest must be the local
// working copy's, and the current page must resolve to the expected site through that index. (The
// earlier page-level CDP Fetch interception never fired, cleared the index, reported every adapter
// as `loading_adapter`, and left the dev profile without an index for whatever ran next.)
//
// Shape of the sweep: sites that share a query wording share ONE send — the comparison flow's task
// map fans `shopping_search_one_store` out per store inside that turn (`maxItems: 10`), and every
// worker's `store_result` carries its own `site`, so classification stays per site. The full sweep
// is two sends (five global stores in English, five Korean stores in Korean), budgeted like
// multi-store at 120s per store: a 20-minute turn ceiling plus bring-up and three resets.
import { pathToFileURL } from 'node:url';
import { SITE_HOME } from '../harness/cdp.mjs';
import { siteLabels } from './multi-store-total-cost.mjs';
import { loadWorkspace } from '../../../axsdk-sdk-js/packages/axsdk-extension-cdp/scripts/workspace.mjs';

export const allSites = [
  { site: 'amazon', region: 'global', query: 'Logitech M185' },
  { site: 'walmart', region: 'global', query: 'Logitech M185' },
  { site: 'ebay', region: 'global', query: 'Logitech M185' },
  { site: 'aliexpress', region: 'global', query: 'Logitech M185' },
  { site: 'etsy', region: 'global', query: 'Logitech M185' },
  { site: 'coupang', region: 'korean', query: '로지텍 M185' },
  { site: 'naver-shopping', region: 'korean', query: '로지텍 M185' },
  { site: 'gmarket', region: 'korean', query: '로지텍 M185' },
  { site: '11st', region: 'korean', query: '로지텍 M185' },
  { site: 'ssg', region: 'korean', query: '로지텍 M185' },
];

// Outcomes that mean the adapter ANSWERED. A wall the user must clear is one kind; a grid whose cards
// carry no price is another (Walmart renders 'Options from $X' with no current price and ships empty
// price fields in its payload); a grid the reader saw and found empty is a third — the RPC reader
// (61_rpc_storefront) and the normalizer (56_store_io) both report that affirmatively as `no_results`,
// which the durable adapter never did. Only an unclassified empty result is a reader defect.
export const recognizedAccessOutcomes = new Set([
  'access_denied',
  'captcha_required',
  'login_required',
  'security_verification_required',
  'price_unavailable',
  'no_results',
]);

export function parseSiteFilter(argv) {
  const siteFilterArg = argv.find(argument => argument.startsWith('--sites='));
  if (!siteFilterArg) return null;
  return new Set(siteFilterArg.slice('--sites='.length).split(',').map(value => value.trim()).filter(Boolean));
}

export function selectSites(all, requested) {
  const sites = requested ? all.filter(item => requested.has(item.site)) : all;
  if (sites.length === 0 || requested && sites.length !== requested.size) {
    throw new Error(`--sites must contain known slugs: ${all.map(item => item.site).join(',')}`);
  }
  return sites;
}

/**
 * The comparison frontier is at most three user-selected stores (AGENTS.md §4), so a batch may ask for
 * three. Sites that share a query wording share a send until that cap; order is preserved within and
 * across batches.
 *
 * Grouping by wording alone put five stores in one request. Measured: it never answered, and the runner
 * died on its own 600s bound after every structural check had passed — the flow was only ever going to
 * compare three of the five, so there was no per-site answer coming for the other two and a longer bound
 * would only have waited longer for it.
 */
export const MAX_SITES_PER_BATCH = 3;

export function groupByQuery(sites) {
  const batches = [];
  const open = new Map();
  for (const item of sites) {
    let batch = open.get(item.query);
    if (batch === undefined || batch.sites.length >= MAX_SITES_PER_BATCH) {
      batch = { query: item.query, sites: [] };
      open.set(item.query, batch);
      batches.push(batch);
    }
    batch.sites.push(item);
  }
  return batches;
}

/** The proven multi-store comparison wording, with this batch's query and store labels. */
export function batchRequestText(batch) {
  const labels = batch.sites.map(item => siteLabels[item.site] || item.site).join(', ');
  return `${batch.query}를 ${labels}에서 배송비 포함 총액으로 비교해줘`;
}

export function decode(value) {
  let current = value;
  for (let index = 0; index < 3 && typeof current === 'string'; index += 1) {
    try { current = JSON.parse(current); } catch { break; }
  }
  return current;
}

/** The classified-outcome accounting: candidates answer; recognized walls and no_results answer;
 *  'unknown' does not. Fits the RPC store_result shape: an empty candidate list crosses as ABSENT
 *  (61_rpc_storefront strips it before the flow schema), and a wall sets both status and error. */
export function classifyStoreResult(value) {
  const payload = value && typeof value === 'object' ? value : {};
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const error = payload.login_required ? 'login_required' : payload.error;
  const outcome = candidates.length > 0 ? 'candidates' : error || 'unknown';
  const responseValid = candidates.length > 0 || recognizedAccessOutcomes.has(outcome);
  return { candidates, outcome, responseValid };
}

export function isNormalizedCandidates(site, candidates) {
  return candidates.length === 0 || candidates.every(candidate =>
    candidate.site === site
    && typeof candidate.product_id === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.price === 'number'
    && typeof candidate.currency === 'string'
    && typeof candidate.url === 'string');
}

// Every tool whose output publishes a `store_result` for one store, in pipeline order: the raw
// reader, the page accumulator, then the normalizer. Last write wins per site, so the tally sees
// the same result the ranking sees.
const STORE_RESULT_TOOLS = ['shopping_search_one_store', 'shopping_collect_store_page', 'shopping_normalize_store_result'];

const nameMatches = (name, suffix) => name === suffix || typeof name === 'string' && name.endsWith(`.${suffix}`);

/** Per-site results out of one shared flow turn, keyed by `store_result.site` (the worker's own
 *  attribution). An output that decodes to no site — an errored worker, an unrelated tool — is
 *  dropped here and surfaces in the tally as `unsearched`. */
export function collectStoreResults(toolCalls) {
  const bySite = new Map();
  for (const call of toolCalls || []) {
    if (!STORE_RESULT_TOOLS.some(tool => nameMatches(call?.name, tool))) continue;
    const result = decode(call.output)?.store_result;
    const site = result?.site;
    if (typeof site === 'string' && site !== '') bySite.set(site, result);
  }
  return bySite;
}

/** The read-only guard: the sweep must never reach a cart or checkout mutation on any path. */
export const CART_MUTATION_PATTERN = /add_selected_store_offer|add_to_cart|checkout|place_order/i;

export function findCartMutations(toolCalls) {
  return (toolCalls || []).filter(call => CART_MUTATION_PATTERN.test(call?.name || ''));
}

/** Per-site outcome accounting. A site the turn never attributed a store_result to is `unsearched`
 *  — not 'unknown', because nothing answered at all — and fails both answer checks; its empty
 *  candidate list has nothing to violate the normalization contract. */
export function tallySiteOutcomes(sites, resultsBySite) {
  return sites.map(item => {
    const result = resultsBySite.get(item.site);
    if (!result) {
      return {
        site: item.site, region: item.region, url: '?',
        outcome: 'unsearched', responseValid: false, normalized: true,
        candidates: 0, first: null, raw: null,
      };
    }
    const { candidates, outcome, responseValid } = classifyStoreResult(result);
    return {
      site: item.site,
      region: item.region,
      url: typeof result.url === 'string' && result.url !== '' ? result.url : '?',
      outcome,
      responseValid,
      normalized: isNormalizedCandidates(item.site, candidates),
      candidates: candidates.length,
      first: candidates[0] || null,
      raw: result,
    };
  });
}

function check(checks, name, condition, evidence = '') {
  const ok = Boolean(condition);
  checks.push({ name, ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${evidence ? ` — ${evidence}` : ''}`);
  return ok;
}

async function main() {
  // --no-build is accepted for invocation compatibility; the CDP harness reads the workspace from
  // source, so there is no build step to skip.
  const requestedSites = parseSiteFilter(process.argv.slice(2));
  const sites = selectSites(allSites, requestedSites);
  const batches = groupByQuery(sites);
  const checks = [];
  const reports = [];
  // Lazy: unit tests import this module's pure exports without loading the CDP driver.
  const { openCdpSession } = await import('../harness/cdp-session.mjs');
  const session = await openCdpSession({ url: SITE_HOME.amazon });

  try {
    // Explicit publication assertion (do not let it become implicit): the digest the session was
    // brought up on must be the digest of THIS working copy, and the extension must resolve the
    // page to its site through the delivered index.
    const local = await loadWorkspace(session.workspace.root);
    const opened = await session.open(SITE_HOME.amazon);
    check(checks, 'the local sites index is published to the extension',
      session.workspace.digest === local.digest && session.workspace.digest.length > 0 && opened.site === 'amazon',
      `digest=${session.workspace.digest} local=${local.digest} site=${opened.site}`);

    const { scriptIds } = await session.status();
    check(checks, 'all Lua comes from the stored working copy',
      scriptIds.some(id => String(id).startsWith('stored-lua:'))
        && !scriptIds.some(id => String(id).includes('/scripts/')),
      scriptIds.join(','));
    check(checks, 'all ten commerce bundles are stored', allSites.every(item => session.workspace.domains.includes(item.site)), session.workspace.domains.join(','));

    for (const batch of batches) {
      const label = batch.sites.map(item => item.site).join(',');
      // reset() before every send: a paused comparison window — a previous batch's, or whatever the
      // daily driver left behind — would read this batch's request as an answer to ITS question.
      const fresh = await session.reset();
      check(checks, `batch [${label}]: fresh flow session created`, Boolean(fresh), `remaining=${fresh?.remaining ?? '?'}`);

      const turn = await session.send(batchRequestText(batch), { timeoutMs: Math.max(300000, batch.sites.length * 120000) });
      const toolNames = (turn.toolCalls || []).map(call => call.name).join('|');

      const mutations = findCartMutations(turn.toolCalls);
      check(checks, `batch [${label}]: comparison stayed read-only`, mutations.length === 0, mutations.map(call => call.name).join(','));

      const resultsBySite = collectStoreResults(turn.toolCalls);
      for (const report of tallySiteOutcomes(batch.sites, resultsBySite)) {
        check(checks, `${report.site}: site adapter answered through the flow engine`, report.outcome !== 'unsearched', `url=${report.url} outcome=${report.outcome}${report.outcome === 'unsearched' ? ` tools=${toolNames}` : ''}`);
        check(checks, `${report.site}: live adapter returns a classified result`, report.responseValid, `${report.outcome} candidates=${report.candidates}${report.outcome === 'unknown' ? ` raw=${JSON.stringify(report.raw)}` : ''}`);
        check(checks, `${report.site}: candidate contract is normalized`, report.normalized, report.first ? `${report.first.currency} ${report.first.price}` : report.outcome);
        reports.push(report);
      }
    }

    if (!requestedSites) {
      check(checks, 'at least one global storefront returned live candidates', reports.some(item => item.region === 'global' && item.candidates > 0), reports.filter(item => item.region === 'global').map(item => `${item.site}:${item.outcome}`).join(','));
      check(checks, 'at least one Korean storefront returned live candidates', reports.some(item => item.region === 'korean' && item.candidates > 0), reports.filter(item => item.region === 'korean').map(item => `${item.site}:${item.outcome}`).join(','));
    }

    // Leave nothing paused: the last batch ends on the comparison's own question, and the next
    // bare number typed into the adopted session would be a SELECTION. A final reset clears the
    // window, the session state, and the journalled deferred calls.
    const cleared = await session.reset().catch(() => null);
    check(checks, 'no paused comparison window is left behind', Boolean(cleared), `remaining=${cleared?.remaining ?? '?'}`);
  } finally {
    await session.close().catch(() => {});
  }

  console.log('\nSITE OUTCOMES');
  for (const report of reports) console.log(`${report.site.padEnd(15)} ${report.outcome.padEnd(32)} candidates=${report.candidates}`);
  const passed = checks.filter(item => item.ok).length;
  console.log(`\nALL-SITE COMMERCE LIVE: ${passed}/${checks.length} PASS`);
  if (passed !== checks.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('FATAL', error?.stack || error);
    process.exitCode = 1;
  });
}
