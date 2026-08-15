// Unit tests for commerce-all-sites.mjs pure logic (node --test): the classified-outcome
// accounting (access walls, price_unavailable and the RPC reader's explicit no_results are
// answers; an unclassified empty result is a reader defect), candidate normalization, batching
// by query, per-site collection out of a shared flow turn, the read-only guard, and --sites
// selection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allSites,
  batchRequestText,
  classifyStoreResult,
  collectStoreResults,
  findCartMutations,
  groupByQuery,
  isNormalizedCandidates,
  parseSiteFilter,
  selectSites,
  tallySiteOutcomes,
} from './commerce-all-sites.mjs';

test('live candidates classify as an answered outcome', () => {
  const { outcome, responseValid } = classifyStoreResult({
    site: 'amazon',
    candidates: [{ site: 'amazon', product_id: 'B01', name: 'M185', price: 12.99, currency: 'USD', url: 'https://a/' }],
  });
  assert.equal(outcome, 'candidates');
  assert.equal(responseValid, true);
});

test('access walls, price_unavailable and no_results count as classified answers', () => {
  for (const error of ['access_denied', 'captcha_required', 'security_verification_required', 'price_unavailable', 'no_results']) {
    const { outcome, responseValid } = classifyStoreResult({ site: 'walmart', error });
    assert.equal(outcome, error);
    assert.equal(responseValid, true, `${error} must count as classified`);
  }
  const wall = classifyStoreResult({ site: 'coupang', login_required: true });
  assert.equal(wall.outcome, 'login_required');
  assert.equal(wall.responseValid, true);
});

test('the RPC store_result shape classifies: absent candidates, status + error both set', () => {
  // 61_rpc_storefront strips an EMPTY candidate list to nil before it crosses the flow schema,
  // and a wall carries the site-chosen reason in both `status` and `error`.
  const walled = classifyStoreResult({
    site: 'naver-shopping',
    status: 'security_verification_required',
    error: 'security_verification_required',
    url: 'https://search.shopping.naver.com/',
  });
  assert.equal(walled.outcome, 'security_verification_required');
  assert.equal(walled.responseValid, true);
  assert.deepEqual(walled.candidates, []);
});

test('an unclassified empty result is a reader defect, not an answer', () => {
  const empty = classifyStoreResult({ site: 'ebay' });
  assert.equal(empty.outcome, 'unknown');
  assert.equal(empty.responseValid, false);
  const stray = classifyStoreResult({ site: 'ebay', error: 'flaky_widget' });
  assert.equal(stray.outcome, 'flaky_widget');
  assert.equal(stray.responseValid, false);
});

test('candidate contract normalization checks every field and the owning site', () => {
  const good = [{ site: 'etsy', product_id: 'p1', name: 'mouse', price: 10, currency: 'USD', url: 'https://e/' }];
  assert.equal(isNormalizedCandidates('etsy', good), true);
  assert.equal(isNormalizedCandidates('etsy', []), true); // nothing to normalize
  assert.equal(isNormalizedCandidates('amazon', good), false); // wrong owner
  assert.equal(isNormalizedCandidates('etsy', [{ ...good[0], price: '10' }]), false); // price must be a number
  assert.equal(isNormalizedCandidates('etsy', [{ ...good[0], url: undefined }]), false);
});

test('site selection: null runs all ten; a subset filters; unknown slugs throw', () => {
  assert.equal(selectSites(allSites, null).length, 10);
  assert.deepEqual(selectSites(allSites, new Set(['amazon', 'ssg'])).map(item => item.site), ['amazon', 'ssg']);
  assert.throws(() => selectSites(allSites, new Set(['amazon', 'bestbuy'])), /--sites must contain known slugs/);
  assert.throws(() => selectSites(allSites, new Set()), /--sites must contain known slugs/);
});

test('parseSiteFilter reads --sites= and trims empties', () => {
  assert.equal(parseSiteFilter([]), null);
  assert.deepEqual([...parseSiteFilter(['--sites=amazon, ebay,'])], ['amazon', 'ebay']);
});

test('batching groups sites by query, up to the comparison frontier', () => {
  // Sites that share a wording share a send until the three-store frontier, so ten sites are four
  // batches, not two. Order is preserved within and across them.
  const batches = groupByQuery(allSites);
  assert.equal(batches.length, 4);
  assert.deepEqual(batches.map(batch => batch.query),
    ['Logitech M185', 'Logitech M185', '로지텍 M185', '로지텍 M185']);
  assert.deepEqual(batches[0].sites.map(item => item.site), ['amazon', 'walmart', 'ebay']);
  assert.deepEqual(batches[1].sites.map(item => item.site), ['aliexpress', 'etsy']);
  assert.deepEqual(batches[2].sites.map(item => item.site), ['coupang', 'naver-shopping', 'gmarket']);
  assert.deepEqual(batches[3].sites.map(item => item.site), ['11st', 'ssg']);
  // A cross-region subset still splits by query: the request wording is per batch.
  const subset = groupByQuery(selectSites(allSites, new Set(['amazon', 'ssg'])));
  assert.equal(subset.length, 2);
  assert.deepEqual(subset.map(batch => batch.sites.length), [1, 1]);
});

test('the batch request names the query and every store by its proven label', () => {
  const [batch] = groupByQuery(selectSites(allSites, new Set(['amazon', 'walmart'])));
  const text = batchRequestText(batch);
  assert.ok(text.includes('Logitech M185'), text);
  assert.ok(text.includes('Amazon') && text.includes('Walmart'), text);
  assert.ok(text.includes('비교'), 'must be the proven multi-store comparison wording');
});

test('per-site collection: keyed by store_result.site, last output wins, suffix names accepted', () => {
  const calls = [
    // Raw reader output (string-encoded, as the trace delivers it).
    {
      name: 'shopping_search_one_store',
      status: 'completed',
      output: JSON.stringify({ store_result: { site: 'amazon', status: 'candidates', candidates: [{ site: 'amazon', product_id: 'B01', name: 'M185', price: '12.99', currency: 'usd', url: 'https://a/' }] } }),
    },
    // Normalizer output for the same site, under the prefixed spelling: it must replace the raw one.
    {
      name: 'sites.shopping_normalize_store_result',
      status: 'completed',
      output: { store_result: { site: 'amazon', status: 'candidates', candidates: [{ site: 'amazon', product_id: 'B01', name: 'M185', price: 12.99, currency: 'USD', url: 'https://a/' }] } },
    },
    { name: 'shopping_search_one_store', status: 'completed', output: { store_result: { site: 'walmart', status: 'price_unavailable', error: 'price_unavailable' } } },
    // Unrelated tools and un-attributable worker errors carry no store_result.site: ignored.
    { name: 'present_store_offers', status: 'completed', output: { next: 'ask' } },
    { name: 'shopping_search_one_store', status: 'error', output: 'lua runtime error: no_element' },
  ];
  const bySite = collectStoreResults(calls);
  assert.deepEqual([...bySite.keys()], ['amazon', 'walmart']);
  assert.equal(bySite.get('amazon').candidates[0].price, 12.99);
  assert.equal(bySite.get('amazon').candidates[0].currency, 'USD');
  assert.equal(bySite.get('walmart').error, 'price_unavailable');
});

test('the read-only guard flags every cart or checkout mutation and nothing else', () => {
  assert.deepEqual(findCartMutations([
    { name: 'shopping_search_one_store' },
    { name: 'shopping_rank_store_offers' },
    { name: 'present_store_offers' },
  ]), []);
  assert.deepEqual(
    findCartMutations([
      { name: 'sites.shopping_add_selected_store_offer' },
      { name: 'AX_add_to_cart' },
      { name: 'checkout' },
      { name: 'shopping_search_one_store' },
    ]).map(call => call.name),
    ['sites.shopping_add_selected_store_offer', 'AX_add_to_cart', 'checkout'],
  );
});

test('the tally: answered sites classify per site; a site the turn never searched is unsearched', () => {
  const sites = selectSites(allSites, new Set(['amazon', 'walmart', 'ebay']));
  const bySite = collectStoreResults([
    { name: 'shopping_search_one_store', output: { store_result: { site: 'amazon', status: 'candidates', url: 'https://www.amazon.com/s', candidates: [{ site: 'amazon', product_id: 'B01', name: 'M185', price: 12.99, currency: 'USD', url: 'https://a/' }] } } },
    { name: 'shopping_search_one_store', output: { store_result: { site: 'walmart', status: 'security_verification_required', error: 'security_verification_required', url: 'https://www.walmart.com/blocked' } } },
  ]);
  const [amazon, walmart, ebay] = tallySiteOutcomes(sites, bySite);

  assert.equal(amazon.site, 'amazon');
  assert.equal(amazon.region, 'global');
  assert.equal(amazon.outcome, 'candidates');
  assert.equal(amazon.responseValid, true);
  assert.equal(amazon.normalized, true);
  assert.equal(amazon.candidates, 1);
  assert.equal(amazon.first.product_id, 'B01');
  assert.equal(amazon.url, 'https://www.amazon.com/s');

  assert.equal(walmart.outcome, 'security_verification_required');
  assert.equal(walmart.responseValid, true);
  assert.equal(walmart.candidates, 0);
  assert.equal(walmart.first, null);

  assert.equal(ebay.outcome, 'unsearched');
  assert.equal(ebay.responseValid, false);
  assert.equal(ebay.normalized, true); // nothing to normalize; the two answer checks carry the failure
  assert.equal(ebay.candidates, 0);
  assert.equal(ebay.url, '?');
});

test('no batch asks for more stores than the flow will compare', () => {
  // The comparison frontier is at most THREE user-selected stores (AGENTS.md §4), so a five-store request
  // cannot produce a per-site answer for five sites — the flow compares three of them by design.
  // Measured live: the five-store global batch never answered and the runner died on its own 600s bound
  // (max(300000, 5 * 120000)), after the four structural checks had all passed. Raising the bound would
  // have waited longer for an answer the flow was never going to give.
  for (const batch of groupByQuery(allSites)) {
    assert.ok(batch.sites.length <= 3,
      `batch "${batch.query}" asks for ${batch.sites.length} stores; the frontier caps at 3`);
  }
});

test('every site is still covered exactly once across the batches', () => {
  // Splitting must not drop or duplicate a store: the sweep's whole point is per-site attribution.
  const seen = groupByQuery(allSites).flatMap((batch) => batch.sites.map((item) => item.site));
  assert.equal(seen.length, allSites.length);
  assert.equal(new Set(seen).size, allSites.length);
});

test('a split batch keeps its wording', () => {
  // Both halves of a query group must still ask the question that group exists for.
  const korean = groupByQuery(allSites).filter((batch) => batch.query === '로지텍 M185');
  assert.ok(korean.length >= 2, 'five Korean stores cannot fit one batch');
  for (const batch of korean) assert.equal(batch.query, '로지텍 M185');
});

// ── the fan-out publishes its results AGGREGATED, one level deeper ────────────
//
// Measured live: amazon, ebay and aliexpress all came back `unsearched` while their tool traces plainly
// showed `shopping_search_one_store` and `shopping_collect_store_page` three times over. The reason is
// in the trace's own shape — the screening step publishes every worker's answer together:
//   apply_screening -> {"next":"done","store_results":[
//                        {"key":"amazon","status":"completed","value":{"store_result":{"site":"amazon",…}}},
//                        …]}
// so the store's own reply sits at `value.store_result`, not at the top level. §13 records this trap for
// the discovery fan-out; reading one level too high found nothing and a classified failure like
// walmart's then also failed its own "returns a classified result" check.
test('a site is attributed from the aggregated fan-out, not only from a direct store_result', () => {
  const aggregated = [{
    name: 'shopping_apply_offer_screening',
    output: {
      next: 'done',
      store_results: [
        { key: 'amazon', status: 'completed', value: { store_result: { site: 'amazon', status: 'candidates', candidates: [{ site: 'amazon' }] } } },
        { key: 'walmart', status: 'completed', value: { store_result: { site: 'walmart', status: 'error', error: 'rpc_unavailable' } } },
      ],
    },
  }];

  const bySite = collectStoreResults(aggregated);

  assert.deepEqual([...bySite.keys()].sort(), ['amazon', 'walmart']);
  assert.equal(bySite.get('walmart').error, 'rpc_unavailable');
});

test('a direct store_result still attributes, and the later write wins', () => {
  // The per-store tools publish one level up, and they run BEFORE the aggregate. Whichever the flow
  // emitted last must be what the tally sees, so it matches the result the ranking used.
  const calls = [
    { name: 'shopping_search_one_store', output: { store_result: { site: 'ebay', status: 'error', error: 'no_results' } } },
    { name: 'shopping_apply_offer_screening', output: { store_results: [
      { key: 'ebay', status: 'completed', value: { store_result: { site: 'ebay', status: 'candidates', candidates: [{ site: 'ebay' }] } } },
    ] } },
  ];

  const bySite = collectStoreResults(calls);

  assert.equal(bySite.get('ebay').status, 'candidates');
});

test('a worker that failed outright is still attributed to its store', () => {
  // `key` names the store even when the worker's value carries nothing usable — a store that could not
  // be reached has to say WHICH store, or it becomes an unsearched hole instead of the fact it reported.
  const bySite = collectStoreResults([{
    name: 'shopping_apply_offer_screening',
    output: { store_results: [{ key: 'gmarket', status: 'error', value: null }] },
  }]);

  assert.deepEqual([...bySite.keys()], ['gmarket']);
  assert.equal(bySite.get('gmarket').site, 'gmarket');
});

test('an aggregate entry with no key and no site is dropped', () => {
  // Absent attribution must stay absent; inventing one would report a store the turn never touched.
  const bySite = collectStoreResults([{
    name: 'shopping_apply_offer_screening',
    output: { store_results: [{ status: 'completed', value: { store_result: { candidates: [] } } }] },
  }]);

  assert.equal(bySite.size, 0);
});
