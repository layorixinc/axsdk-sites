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
  'no_relevant_offers',
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

/**
 * This runner measures the multi-store flow. A singleton wording routes to `shopping_single_site`,
 * whose tools and contract are intentionally different; accepting it would report `unsearched`
 * about a flow the runner never attempted to inspect.
 */
export function assertRunnableBatches(batches) {
  const singletonSites = batches
    .filter((batch) => batch.sites.length < 2)
    .flatMap((batch) => batch.sites.map((item) => item.site));
  if (singletonSites.length > 0) {
    throw new Error(
      `Each query batch needs at least two stores; singleton batches: ${singletonSites.join(', ')}. `
      + 'Add another store with the same query wording.',
    );
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
  // A store the WINDOW attributed has offers we saw and candidate objects the truncated trace could not
  // carry; and a reader that filtered a full page says so in its status. In both cases the status is the
  // only thing left to read, and reading it is the difference between naming the outcome and blaming the
  // store for our own read. `unknown` stays for a result with nothing to go on at all.
  const claimed = typeof payload.status === 'string' && payload.status !== '' ? payload.status : undefined;
  const outcome = candidates.length > 0 ? 'candidates' : error || claimed || 'unknown';
  const responseValid = candidates.length > 0
    || outcome === 'candidates'
    || recognizedAccessOutcomes.has(outcome);
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

// Every tool whose output attributes a result to one store. Large candidate arrays may be truncated;
// the dedicated post-screening summary carries one bounded sample per store in its own parseable result.
const STORE_RESULT_TOOLS = [
  'shopping_search_one_store', 'shopping_collect_store_page', 'shopping_normalize_store_result',
  'shopping_apply_offer_screening',
];
const COMPACT_OUTCOME_TOOLS = ['shopping_summarize_store_outcomes', 'shopping_build_offer_screening'];

const nameMatches = (name, suffix) => name === suffix || typeof name === 'string' && name.endsWith(`.${suffix}`);

/**
 * Per-site results out of one shared flow turn, keyed by the worker's own attribution.
 *
 * Two shapes, because the fan-out has two. Measured live: amazon, ebay and aliexpress all came back
 * `unsearched` while their traces showed `shopping_search_one_store` three times over, because the
 * screening step publishes
 *   {"store_results":[{"key":"amazon","status":"completed","value":{"store_result":{"site":"amazon",…}}}]}
 * and reading only the top level found nothing. §13 records the same trap for the discovery fan-out:
 * the normalizer WRAPS the store answer.
 *
 * `key` names the store even when the worker's value carries nothing usable, because a store that could
 * not be reached has to say WHICH store — otherwise it becomes an unsearched hole instead of the fact it
 * reported. An entry with neither a key nor a site is dropped: absent attribution stays absent.
 */
export function collectStoreResults(toolCalls) {
  const bySite = new Map();
  const attribute = (result, fallbackSite) => {
    const site = typeof result?.site === 'string' && result.site !== '' ? result.site : fallbackSite;
    if (typeof site !== 'string' || site === '') return;
    bySite.set(site, result && typeof result === 'object' ? { ...result, site } : { site });
  };
  for (const call of toolCalls || []) {
    const output = decode(call.output);
    if (COMPACT_OUTCOME_TOOLS.some(tool => nameMatches(call?.name, tool))) {
      for (const outcome of Array.isArray(output?.store_outcomes) ? output.store_outcomes : []) {
        const sample = outcome?.sample;
        attribute({
          ...outcome,
          candidates: sample && typeof sample === 'object' ? [sample] : [],
        });
      }
      continue;
    }
    if (!STORE_RESULT_TOOLS.some(tool => nameMatches(call?.name, tool))) continue;
    attribute(output?.store_result);
    for (const entry of Array.isArray(output?.store_results) ? output.store_results : []) {
      attribute(decode(entry?.value)?.store_result, typeof entry?.key === 'string' ? entry.key : undefined);
    }
  }
  return bySite;
}

/**
 * Store outcomes as the comparison WINDOW states them.
 *
 * The tool trace cannot carry them: every large output in the chat store is cut at 4120 characters and
 * ends "... [N chars trimmed]", so `JSON.parse` fails on all of them. Measured on a three-store turn —
 * only walmart's outcome parsed, at 111 characters, which is exactly why walmart was the one store the
 * trace could attribute while amazon and ebay both had offers in the window. Scraping a truncated payload
 * could recover a site NAME but never its candidate count, and reporting `candidates: 0` from a payload
 * nobody could read would be a claim about listings nobody saw.
 *
 * The window is complete by design (§13: store outcomes are part of the answer) and states both signals:
 * every offer line is tagged `[slug]`, and the store-status line names each store that failed as
 * `label(slug): reason`. Offers are the stronger evidence, so a store with both keeps `candidates`.
 */
const OFFER_LINE = /^\s*\d+\.\s*\[([a-z0-9-]+)\]/gmu;
const STORE_STATUS = /\(([a-z0-9-]+)\)\s*:\s*([a-z0-9_]+)/gu;

export function readWindowOutcomes(windowText) {
  const seen = new Map();
  const text = typeof windowText === 'string' ? windowText : '';
  for (const match of text.matchAll(STORE_STATUS)) seen.set(match[1], match[2]);
  // Second, so an offer overrides a failure the same store reported for another page.
  for (const match of text.matchAll(OFFER_LINE)) seen.set(match[1], 'candidates');
  return seen;
}

/** The trace's parsed result wins where it exists; the window fills in what truncation hid. */
export function mergeWindowOutcomes(fromTrace, fromWindow) {
  const merged = new Map(fromTrace);
  for (const [site, outcome] of fromWindow) {
    if (merged.has(site)) continue;
    merged.set(site, outcome === 'candidates'
      ? { site, status: 'candidates', candidates: [], from_window: true }
      : { site, status: outcome, error: outcome, from_window: true });
  }
  return merged;
}

/** The read-only guard: the sweep must never reach a cart or checkout mutation on any path. */
export const CART_MUTATION_PATTERN = /add_selected_store_offer|add_to_cart|checkout|place_order/i;

export function findCartMutations(toolCalls) {
  return (toolCalls || []).filter(call => CART_MUTATION_PATTERN.test(call?.name || ''));
}

/**
 * What the run actually cost, per batch and at its worst.
 *
 * The bound was `max(300000, sites * 120000)` and had never been measured. Same code, consecutive runs:
 * ten stores attributed in ~85 s, then a batch lost to its own 360 s ceiling. §13's own finding is that
 * latency here is LLM-dominated and swings roughly 4x for the SAME request, so one run cannot justify a
 * bound — and tuning the multiplier until a run goes green is how a number nobody measured becomes a
 * number everybody trusts.
 *
 * A timed-out batch is carried as a timeout, never as a duration: it measured the ceiling, not the turn,
 * and averaging it in would drag the estimate toward whatever ceiling happened to be set. `null` for the
 * worst when nothing was measured, because 0 would read as "instant".
 */
export function summariseTimings(entries) {
  const rows = Array.isArray(entries) ? entries : [];
  const measured = rows.filter((row) => typeof row?.elapsedMs === 'number');
  const timeouts = rows.filter((row) => typeof row?.timedOutAfterMs === 'number');
  const retries = rows.filter((row) => typeof row?.retriedAfter === 'string' && row.retriedAfter !== '');
  let worst = null;
  let worstPerSite = null;
  for (const row of measured) {
    if (worst === null || row.elapsedMs > worst.elapsedMs) worst = row;
    const perSite = row.elapsedMs / Math.max(1, Number(row.sites) || 1);
    if (worstPerSite === null || perSite > worstPerSite.perSite) worstPerSite = { perSite, row };
  }
  return {
    batches: rows.length,
    measuredBatches: measured.length,
    timedOut: timeouts.length,
    totalMs: measured.reduce((sum, row) => sum + row.elapsedMs, 0),
    worstMs: worst === null ? null : worst.elapsedMs,
    worstLabel: worst === null ? null : worst.label,
    worstPerSiteMs: worstPerSite === null ? null : Math.round(worstPerSite.perSite),
    // A timeout carries `send`'s account of WHERE the turn stopped, when it has one. "Timed out after
    // 360s" is the sentence that cost a repeat run to act on; the node that stopped answering is the
    // one fact that makes a hang actionable, and the summary is where it gets read. Absent stays absent —
    // a hang with nothing to say must not be given an invented node.
    // A batch that reached no node measured nothing about any adapter, so it is retried once — and the
    // retry is REPORTED, never laundered. Measured: 1 turn in 48 live turns reached no node, and neither
    // targeted probe reproduced it, so hiding it would erase the only samples anyone has. A retried
    // measurement is a real one and counts; a retry that also failed is a timeout like any other.
    retried: retries.length,
    note: [
      ...timeouts.map((row) => {
        const where = typeof row.stoppedOn === 'string' && row.stoppedOn.trim() !== ''
          ? ` — ${row.stoppedOn.trim()}` : '';
        return `${row.label}: timed out after ${row.timedOutAfterMs}ms${where}`;
      }),
      ...retries.map((row) => `${row.label}: retried after ${row.retriedAfter}`),
    ].join('; '),
  };
}

/**
 * Per-site outcome accounting. A site the turn never attributed a store_result to is `unsearched` — not
 * `unknown`, because nothing answered at all — and fails both answer checks.
 *
 * `normalized` is three-valued on purpose. A store the WINDOW attributed proved that it answered, but the
 * truncated trace could not hand over its candidate objects, so there is nothing to check the contract
 * against: `null` says unverified. Returning `true` there passed the check on an empty list — vacuously,
 * for four of ten stores in a live run — and a check that cannot fail is not a check.
 */
export function tallySiteOutcomes(sites, resultsBySite) {
  return sites.map(item => {
    const result = resultsBySite.get(item.site);
    if (!result) {
      return {
        site: item.site, region: item.region, url: '?',
        outcome: 'unsearched', responseValid: false, normalized: null, fromWindow: false,
        candidates: 0, first: null, raw: null,
      };
    }
    const { candidates, outcome, responseValid } = classifyStoreResult(result);
    const fromWindow = result.from_window === true;
    return {
      site: item.site,
      region: item.region,
      url: typeof result.url === 'string' && result.url !== '' ? result.url : '?',
      outcome,
      responseValid,
      normalized: fromWindow ? null : isNormalizedCandidates(item.site, candidates),
      fromWindow,
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
  assertRunnableBatches(batches);
  const checks = [];
  const reports = [];
  const timings = [];
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

      // A batch that exceeds its bound is recorded and the sweep CONTINUES. Dying on the first one hid
      // every later batch's cost, which is exactly the distribution a bound has to be built from.
      const bound = Math.max(300000, batch.sites.length * 120000);
      let turn;
      // A turn that reached NO node measured nothing about any adapter, so it is the one failure worth one
      // retry: without it a session-level fault is read as ten adapter failures. A turn that stalled MID-way
      // is not retried — it produced evidence, and re-running it would throw that evidence away. Measured:
      // 1 of 48 live turns reached no node, and neither targeted probe could reproduce it, so the retry is
      // always REPORTED and the run still says a batch needed one.
      let retriedAfter;
      for (let attempt = 1; ; attempt += 1) {
        try {
          turn = await session.send(batchRequestText(batch), { timeoutMs: bound });
          timings.push({ label, sites: batch.sites.length, elapsedMs: turn.elapsedMs, retriedAfter });
          console.log(`TIME  batch [${label}]: ${(turn.elapsedMs / 1000).toFixed(1)}s for ${batch.sites.length} store(s)`
            + (retriedAfter === undefined ? '' : ` (after a ${retriedAfter} retry)`));
          break;
        } catch (error) {
          if (error.stage === 'no-node' && attempt === 1) {
            retriedAfter = 'no-node';
            check(checks, `batch [${label}]: answered without a retry`, false, `${error.message}`);
            await session.reset().catch(() => null);
            continue;
          }
          timings.push({
            label, sites: batch.sites.length, timedOutAfterMs: bound, stoppedOn: error.message, retriedAfter,
          });
          check(checks, `batch [${label}]: answered within its bound`, false, `${error.message}`);
          break;
        }
      }
      if (turn === undefined) continue;
      const toolNames = (turn.toolCalls || []).map(call => call.name).join('|');

      const mutations = findCartMutations(turn.toolCalls);
      check(checks, `batch [${label}]: comparison stayed read-only`, mutations.length === 0, mutations.map(call => call.name).join(','));

      // The trace is truncated at 4120 characters per output, so it can only attribute the stores whose
      // outcome was short enough to survive. The window states all of them.
      const resultsBySite = mergeWindowOutcomes(
        collectStoreResults(turn.toolCalls),
        readWindowOutcomes(turn.text),
      );
      for (const report of tallySiteOutcomes(batch.sites, resultsBySite)) {
        check(checks, `${report.site}: site adapter answered through the flow engine`, report.outcome !== 'unsearched', `url=${report.url} outcome=${report.outcome}${report.outcome === 'unsearched' ? ` tools=${toolNames}` : ''}`);
        check(checks, `${report.site}: live adapter returns a classified result`, report.responseValid, `${report.outcome} candidates=${report.candidates}${report.outcome === 'unknown' ? ` raw=${JSON.stringify(report.raw)}` : ''}`);
        // Three-valued: null is "the window proved it answered, the truncated trace carried no candidates
        // to check". Printing PASS there would claim a verification nobody performed.
        if (report.normalized === null) {
          console.log(`SKIP  ${report.site}: candidate contract not verified — ${report.fromWindow ? 'trace truncated, attributed from the window' : report.outcome}`);
        } else {
          check(checks, `${report.site}: candidate contract is normalized`, report.normalized, report.first ? `${report.first.currency} ${report.first.price}` : report.outcome);
        }
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

  // The distribution a bound has to be built from. Several runs of this, not one, decide the multiplier.
  const timing = summariseTimings(timings);
  console.log('\nTIMING');
  for (const row of timings) {
    console.log(row.elapsedMs === undefined
      ? `${row.label.padEnd(34)} TIMED OUT after ${(row.timedOutAfterMs / 1000).toFixed(0)}s`
      : `${row.label.padEnd(34)} ${(row.elapsedMs / 1000).toFixed(1)}s / ${row.sites} store(s) = ${(row.elapsedMs / row.sites / 1000).toFixed(1)}s each`);
  }
  console.log(timing.worstMs === null
    ? 'nothing measured'
    : `worst batch ${(timing.worstMs / 1000).toFixed(1)}s (${timing.worstLabel}) · worst per store ${(timing.worstPerSiteMs / 1000).toFixed(1)}s`
      + ` · total ${(timing.totalMs / 1000).toFixed(1)}s · timed out ${timing.timedOut} · retried ${timing.retried}`);
  if (timing.note) console.log(`note: ${timing.note}`);
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
