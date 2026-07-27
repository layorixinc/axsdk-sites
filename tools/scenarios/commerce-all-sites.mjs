#!/usr/bin/env node
// Read-only extension scenario for every representative commerce adapter named in
// AXSDK_CHROME_EXTENSION_AGENTIC_TASKS.md. Stored Lua/flows are authoritative; the local index makes
// not-yet-pushed site directories discoverable across domain navigations.
//
// The index is PUBLISHED into the extension's sites store (the same path `ax sync` uses), not served by
// intercepting the GitHub URL from this tab. The interception stopped being seen — the extension no
// longer fetches the index from the page — so every run cleared the index, served nothing in its place,
// and reported all ten adapters as `loading_adapter`; it also left the dev profile without an index for
// whatever ran next.
import {
  SITE_HOME,
  resolveOptions,
  ensureChrome,
  attachActive,
  navigate,
  syncSitesIndex,
  syncStore,
  run,
  currentUrl,
  callInAxContext,
  waitForLuaRuntime,
} from '../harness/cdp.mjs';

const noBuild = process.argv.includes('--no-build');
const siteFilterArg = process.argv.find(argument => argument.startsWith('--sites='));
const requestedSites = siteFilterArg
  ? new Set(siteFilterArg.slice('--sites='.length).split(',').map(value => value.trim()).filter(Boolean))
  : null;
const allSites = [
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
const sites = requestedSites ? allSites.filter(item => requestedSites.has(item.site)) : allSites;
if (sites.length === 0 || requestedSites && sites.length !== requestedSites.size) {
  throw new Error(`--sites must contain known slugs: ${allSites.map(item => item.site).join(',')}`);
}
// Outcomes that mean the adapter ANSWERED. A wall the user must clear is one kind; a grid whose cards
// carry no price is another (Walmart renders 'Options from $X' with no current price and ships empty
// price fields in its payload). Both are facts the flow can report; only an unclassified empty result is
// a reader defect.
const recognizedAccessOutcomes = new Set([
  'access_denied',
  'captcha_required',
  'login_required',
  'security_verification_required',
  'price_unavailable',
]);

function decode(value) {
  let current = value;
  for (let index = 0; index < 3 && typeof current === 'string'; index += 1) {
    try { current = JSON.parse(current); } catch { break; }
  }
  return current;
}

function valueOf(result) {
  const decoded = decode(result?.value ?? result);
  return decoded?.value && typeof decoded.value === 'object' ? decoded.value : decoded;
}

function check(checks, name, condition, evidence = '') {
  const ok = Boolean(condition);
  checks.push({ name, ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${evidence ? ` — ${evidence}` : ''}`);
  return ok;
}

async function loadedSiteStatus(page, options) {
  return callInAxContext(page, options, `function(){
    const sdk = globalThis._AXSDK || globalThis.AXSDK;
    const sites = sdk?.getSitesStore?.().getState?.();
    const commands = (sdk?.lua || globalThis._AXLUA)?.listCommands?.() || [];
    const search = commands.find(item => item.command === 'AX_search_product');
    return {
      domain: sites?.currentSite?.domain || null,
      searchScriptId: search?.scriptId || null,
      indexMd: sites?.index?.indexMd || ''
    };
  }`);
}

async function waitForLoadedSite(page, options, site, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let status = null;
  while (Date.now() < deadline) {
    status = await loadedSiteStatus(page, options).catch(() => null);
    if (String(status?.searchScriptId || '').includes(`stored-lua:${site}`)) return status;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  return status || {};
}

async function runStoreSearch(session, args, maxTurns = 3) {
  let result = null;
  for (let turn = 0; turn < maxTurns; turn += 1) {
    result = await run(session, 'AX_search_store_product', args, { timeoutMs: 120000 });
    if (valueOf(result)?.pending !== true) return result;
  }
  return result;
}

async function main() {
  const checks = [];
  const reports = [];
  const options = resolveOptions({ site: 'amazon' });
  const { cdpUrl } = await ensureChrome(options, { launch: false });

  // Publish the local index the way `ax sync` does, before attaching: an unpublished site layer has no
  // assistant on its host, so every adapter would answer `loading_adapter`. This reloads the extension,
  // so the page handle must be taken afterwards.
  const published = await syncSitesIndex(cdpUrl, options, { destination: SITE_HOME.amazon });
  const { page } = await attachActive(cdpUrl, options, { allowBlank: true });
  const session = { page, options, cdpUrl };

  try {
    await navigate(page, SITE_HOME.amazon);
    await waitForLuaRuntime(page, options);
    check(checks, 'the local sites index is published to the extension', published.indexBytes > 0 && published.remoteSitesDisabled, `${published.indexBytes} bytes`);
    const synced = await syncStore(session, { site: 'amazon', build: !noBuild, reload: true });
    check(checks, 'all Lua comes from the stored working copy', synced.fromStore > 0 && synced.fromRemote === 0, `${synced.fromStore}/${synced.fromRemote}`);
    check(checks, 'all ten commerce bundles are stored', allSites.every(item => synced.luaStoreKeys.includes(`:${item.site}`)), synced.luaStoreKeys.join(','));

    for (const item of sites) {
      await navigate(page, SITE_HOME[item.site], { timeout: 30000 });
      await waitForLuaRuntime(page, options, 20000);
      const loaded = await waitForLoadedSite(page, options, item.site);
      const url = await currentUrl(session);
      const scriptMatches = String(loaded.searchScriptId || '').includes(`stored-lua:${item.site}`);

      const result = await runStoreSearch(session, {
        site: item.site,
        query: item.query,
        quantity: 1,
      });
      const value = valueOf(result) || {};
      const candidates = Array.isArray(value.candidates) ? value.candidates : [];
      const error = value.login_required ? 'login_required' : value.error;
      const outcome = candidates.length > 0 ? 'candidates' : error || 'unknown';
      const responseValid = candidates.length > 0 || recognizedAccessOutcomes.has(outcome);
      const normalized = candidates.length === 0 || candidates.every(candidate =>
        candidate.site === item.site
        && typeof candidate.product_id === 'string'
        && typeof candidate.name === 'string'
        && typeof candidate.price === 'number'
        && typeof candidate.currency === 'string'
        && typeof candidate.url === 'string');
      const adapterExecuted = scriptMatches && value.site === item.site && responseValid;
      check(checks, `${item.site}: stored adapter executed`, adapterExecuted, `url=${url} domain=${loaded.domain} script=${loaded.searchScriptId || ''} index=${loaded.indexMd?.includes(`[${item.site}]`) ? 'present' : 'missing'} ${outcome}`);
      check(checks, `${item.site}: live adapter returns a classified result`, responseValid, `${outcome} candidates=${candidates.length}${outcome === 'unknown' ? ` raw=${JSON.stringify(result)}` : ''}`);
      check(checks, `${item.site}: candidate contract is normalized`, normalized, candidates[0] ? `${candidates[0].currency} ${candidates[0].price}` : outcome);
      reports.push({ site: item.site, region: item.region, url, outcome, candidates: candidates.length, first: candidates[0] || null });
    }

    if (!requestedSites) {
      check(checks, 'at least one global storefront returned live candidates', reports.some(item => item.region === 'global' && item.candidates > 0), reports.filter(item => item.region === 'global').map(item => `${item.site}:${item.outcome}`).join(','));
      check(checks, 'at least one Korean storefront returned live candidates', reports.some(item => item.region === 'korean' && item.candidates > 0), reports.filter(item => item.region === 'korean').map(item => `${item.site}:${item.outcome}`).join(','));
    }
  } finally {
    page.close();
  }

  console.log('\nSITE OUTCOMES');
  for (const report of reports) console.log(`${report.site.padEnd(15)} ${report.outcome.padEnd(32)} candidates=${report.candidates}`);
  const passed = checks.filter(item => item.ok).length;
  console.log(`\nALL-SITE COMMERCE LIVE: ${passed}/${checks.length} PASS`);
  if (passed !== checks.length) process.exitCode = 1;
}

main().catch(error => {
  console.error('FATAL', error?.stack || error);
  process.exitCode = 1;
});
