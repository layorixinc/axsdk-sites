#!/usr/bin/env node
// Production-flow live scenario for one Amazon + eBay total-cost comparison cycle.
// A CDP Fetch override serves the LOCAL index.md only to the dedicated dev tab so a newly added,
// not-yet-pushed site can be resolved while all Lua and flows still come from ax sync's stored layers.
// The scenario never opens checkout and never places an order.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  repoRoot,
  resolveOptions,
  ensureChrome,
  attachActive,
  navigate,
  syncStore,
  sendMessage,
  currentUrl,
  callInAxContext,
} from '../harness/cdp.mjs';

const args = new Set(process.argv.slice(2));
const noBuild = args.has('--no-build');
const cancelOnly = args.has('--cancel');
const requestText = 'Logitech M185를 아마존과 이베이에서 배송비 포함 총액으로 비교해줘';
const localIndexUrl = 'https://raw.githubusercontent.com/layorixinc/axsdk-sites/main/index.md';

function decode(value) {
  let current = value;
  for (let index = 0; index < 3 && typeof current === 'string'; index += 1) {
    try { current = JSON.parse(current); } catch { break; }
  }
  return current;
}

function toolParts(turn) {
  return (turn?.parts || []).filter(part => part.type === 'tool');
}

function findTool(turn, suffix) {
  return toolParts(turn).find(part => part.tool === suffix || part.tool?.endsWith(`.${suffix}`));
}

function check(checks, name, value, evidence = '') {
  const ok = Boolean(value);
  checks.push({ name, ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${evidence ? ` — ${evidence}` : ''}`);
  return ok;
}

async function installLocalIndexOverride(page, indexMd) {
  const body = Buffer.from(indexMd, 'utf8').toString('base64');
  await page.send('Network.enable');
  await page.send('Network.setCacheDisabled', { cacheDisabled: true });
  await page.send('Fetch.enable', {
    patterns: [{ urlPattern: localIndexUrl, requestStage: 'Request' }],
  });
  const off = page.on('Fetch.requestPaused', event => {
    const requestId = event.requestId;
    const url = event.request?.url || '';
    const response = url === localIndexUrl
      ? page.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'content-type', value: 'text/markdown; charset=utf-8' },
            { name: 'access-control-allow-origin', value: '*' },
            { name: 'cache-control', value: 'no-store' },
          ],
          body,
        })
      : page.send('Fetch.continueRequest', { requestId });
    response.catch(() => null);
  });
  return async () => {
    off();
    await page.send('Fetch.disable').catch(() => null);
    await page.send('Network.setCacheDisabled', { cacheDisabled: false }).catch(() => null);
  };
}

async function resetSession(page, options) {
  return callInAxContext(page, options, `function(){
    const sdk = globalThis._AXSDK || globalThis.AXSDK;
    if (!sdk || typeof sdk.resetSession !== 'function') return false;
    sdk.resetSession();
    return true;
  }`);
}

async function localIndexStatus(page, options) {
  return callInAxContext(page, options, `function(){
    const sdk = globalThis._AXSDK || globalThis.AXSDK;
    const state = sdk?.getSitesStore?.().getState?.();
    const indexMd = state?.index?.indexMd || '';
    const commands = (sdk?.lua || globalThis._AXLUA)?.listCommands?.() || [];
    return {
      currentSite: state?.currentSite?.domain || null,
      hasEbayIndex: indexMd.includes('[ebay]'),
      storedCommands: commands.filter(item => String(item.scriptId || '').startsWith('stored-lua:')).map(item => item.command),
    };
  }`);
}

async function main() {
  const checks = [];
  const options = resolveOptions({ site: 'amazon' });
  const { cdpUrl } = await ensureChrome(options, { launch: false });
  const { page } = await attachActive(cdpUrl, options, {});
  const session = { page, options, cdpUrl };
  const indexMd = await readFile(join(repoRoot, 'index.md'), 'utf8');
  const removeOverride = await installLocalIndexOverride(page, indexMd);

  try {
    await navigate(page, 'https://www.amazon.com/');
    await callInAxContext(page, options, `function(){
      const sdk = globalThis._AXSDK || globalThis.AXSDK;
      sdk?.getSitesStore?.().getState?.().clearIndex?.();
      return true;
    }`).catch(() => null);

    const synced = await syncStore(session, { site: 'amazon', build: !noBuild, reload: true });
    console.log(`SYNC  store=${synced.fromStore ?? 0} remote=${synced.fromRemote ?? 0}`);
    const indexStatus = await localIndexStatus(page, options);
    check(checks, 'local published-site index is active', indexStatus.hasEbayIndex, `site=${indexStatus.currentSite}`);
    check(checks, 'stored common Lua is active', synced.fromStore >= 8 && synced.fromRemote === 0, `${synced.fromStore}/${synced.fromRemote}`);
    check(checks, 'fresh flow session created', await resetSession(page, options));

    const compare = await sendMessage(session, requestText, { timeoutMs: 300000 });
    const workerResults = toolParts(compare)
      .filter(part => part.tool === 'shopping_search_one_store')
      .map(part => decode(part.output)?.store_result)
      .filter(Boolean);
    const stores = new Set(workerResults.map(result => result.site).filter(Boolean));
    const rankOutput = decode(findTool(compare, 'shopping_rank_store_offers')?.output);
    const offers = Array.isArray(rankOutput?.offers) ? rankOutput.offers : [];
    const reply = String(compare.reply || '');
    const offerSites = new Set([
      ...offers.map(offer => offer.site),
      ...(['amazon', 'ebay'].filter(site => reply.includes(`[${site}]`))),
    ]);
    const numberedCount = offers.length || (reply.match(/(?:^|\n)\d+\.\s+\[/g) || []).length;

    check(checks, 'agentic task map searched both stores', stores.has('amazon') && (stores.has('ebay') || offerSites.has('ebay')), [...new Set([...stores, ...offerSites])].join(','));
    check(checks, 'both live adapters produced ranked offers', offerSites.has('amazon') && offerSites.has('ebay'), [...offerSites].join(','));
    check(checks, 'comparison is bounded and numbered', numberedCount > 1 && numberedCount <= 6, `offers=${numberedCount}`);
    check(checks, 'comparison asks before mutation', Boolean(findTool(compare, 'choose_offer')) && !findTool(compare, 'shopping_add_selected_store_offer'));
    console.log(`COMPARE  ${String(compare.reply || '').replace(/\s+/g, ' ').slice(0, 500)}`);

    if (cancelOnly) {
      const cancelled = await sendMessage(session, '취소', { timeoutMs: 120000 });
      check(checks, 'cancel leaves every cart untouched', !findTool(cancelled, 'shopping_add_selected_store_offer') && String(cancelled.reply || '').trim().length > 0, String(cancelled.reply || '').slice(0, 160));
    } else {
      const invalid = await sendMessage(session, '99', { timeoutMs: 120000 });
      check(checks, 'out-of-range choice cannot mutate', !findTool(invalid, 'shopping_add_selected_store_offer'));
      check(checks, 'invalid choice is re-prompted', /invalid|유효|번호|number|다시/i.test(invalid.reply || ''), String(invalid.reply || '').slice(0, 160));

      const selected = await sendMessage(session, '1', { timeoutMs: 300000 });
      const addPart = findTool(selected, 'shopping_add_selected_store_offer');
      const addOutput = decode(addPart?.output);
      const url = await currentUrl(session).catch(() => '');
      check(checks, 'valid current rank reaches guarded cart mutation', Boolean(findTool(selected, 'shopping_resolve_store_offer')) && Boolean(addPart));
      check(checks, 'selected offer is confirmed in a cart', addOutput?.cart_status === 'added', JSON.stringify(addOutput));
      check(checks, 'checkout and order remain untouched', !/checkout|buy\/spc|placeorder|order-confirmation/i.test(url) && !toolParts(selected).some(part => /checkout|place_order/i.test(part.tool || '')), url);
      console.log(`SELECT  ${String(selected.reply || '').replace(/\s+/g, ' ').slice(0, 500)}`);
    }
  } finally {
    await removeOverride();
    page.close();
  }

  const passed = checks.filter(item => item.ok).length;
  console.log(`\nMULTI-STORE LIVE: ${passed}/${checks.length} PASS`);
  if (passed !== checks.length) process.exitCode = 1;
}

main().catch(error => {
  console.error('FATAL', error?.stack || error);
  process.exitCode = 1;
});
