// Unit tests for commerce-all-sites.mjs pure logic (node --test): the classified-outcome
// accounting (access walls, price_unavailable and the RPC reader's explicit no_results are
// answers; an unclassified empty result is a reader defect), candidate normalization, batching
// by query, per-site collection out of a shared flow turn, the read-only guard, and --sites
// selection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allSites,
  assertRunnableBatches,
  batchRequestText,
  classifyStoreResult,
  collectStoreResults,
  findCartMutations,
  groupByQuery,
  isNormalizedCandidates,
  mergeWindowOutcomes,
  parseSiteFilter,
  readWindowOutcomes,
  selectSites,
  summariseTimings,
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
  for (const error of ['access_denied', 'captcha_required', 'security_verification_required', 'price_unavailable', 'no_results', 'no_relevant_offers']) {
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

test('batching queues every store that shares a query in request order', () => {
  // `flow.map` is the bounded sequential queue. The five global stores share one English request and
  // the five Korean stores share one Korean request; no store is split out merely to satisfy an old cap.
  const batches = groupByQuery(allSites);
  assert.equal(batches.length, 2);
  assert.deepEqual(batches.map(batch => batch.query), ['Logitech M185', '로지텍 M185']);
  assert.deepEqual(batches[0].sites.map(item => item.site),
    ['amazon', 'walmart', 'ebay', 'aliexpress', 'etsy']);
  assert.deepEqual(batches[1].sites.map(item => item.site),
    ['coupang', 'naver-shopping', 'gmarket', '11st', 'ssg']);
  // A cross-region subset still splits by query: the request wording is per batch.
  const subset = groupByQuery(selectSites(allSites, new Set(['amazon', 'ssg'])));
  assert.equal(subset.length, 2);
  assert.deepEqual(subset.map(batch => batch.sites.length), [1, 1]);
});

test('a targeted run refuses singleton query batches instead of measuring the single-site flow', () => {
  assert.doesNotThrow(() => assertRunnableBatches(groupByQuery(allSites)));
  const singletons = groupByQuery(selectSites(allSites, new Set(['walmart', '11st'])));
  assert.throws(
    () => assertRunnableBatches(singletons),
    /needs at least two stores.*walmart.*11st/i,
  );
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

test('dedicated compact outcomes recover attribution and one normalized sample after trace truncation', () => {
  const bySite = collectStoreResults([{
    name: 'shopping_summarize_store_outcomes',
    status: 'completed',
    output: {
      store_outcomes: [
        {
          site: '11st',
          status: 'candidates',
          candidate_count: 6,
          sample: {
            site: '11st',
            product_id: '9170626560',
            name: '로지텍 M185',
            price: 17900,
            currency: 'KRW',
            url: 'https://www.11st.co.kr/products/9170626560',
          },
        },
        {
          site: 'walmart',
          status: 'access_denied',
          error: 'access_denied',
          candidate_count: 0,
        },
      ],
    },
  }]);

  assert.equal(bySite.get('11st').candidates.length, 1);
  assert.equal(bySite.get('11st').candidate_count, 6);
  assert.equal(isNormalizedCandidates('11st', bySite.get('11st').candidates), true);
  assert.equal(bySite.get('walmart').error, 'access_denied');
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
  // `null`, not `true`: nothing answered, so nothing was verified. `true` claimed a pass on an empty list,
  // which is the same vacuous check the window-attributed stores exposed. The two answer checks above
  // carry the failure.
  assert.equal(ebay.normalized, null);
  assert.equal(ebay.candidates, 0);
  assert.equal(ebay.url, '?');
});

test('every batch fits the complete supported-store queue', () => {
  for (const batch of groupByQuery(allSites)) {
    assert.ok(batch.sites.length <= 10,
      `batch "${batch.query}" asks for ${batch.sites.length} stores; the queue caps at 10`);
  }
});

test('every site is still covered exactly once across the batches', () => {
  // Splitting must not drop or duplicate a store: the sweep's whole point is per-site attribution.
  const seen = groupByQuery(allSites).flatMap((batch) => batch.sites.map((item) => item.site));
  assert.equal(seen.length, allSites.length);
  assert.equal(new Set(seen).size, allSites.length);
});

test('a query group stays in one ordered queue', () => {
  const korean = groupByQuery(allSites).filter((batch) => batch.query === '로지텍 M185');
  assert.equal(korean.length, 1);
  assert.deepEqual(korean[0].sites.map((item) => item.site),
    ['coupang', 'naver-shopping', 'gmarket', '11st', 'ssg']);
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

// ── the window is the complete source; the trace is truncated ─────────────────
//
// Measured live: every large tool output in the chat store is cut at 4120 characters and ends
// "... [8066 chars trimmed]", so `JSON.parse` fails on all of them. Only walmart's outcome was readable,
// at 111 characters, which is exactly why walmart was the one store the trace could attribute. Scraping a
// truncated payload could recover a site NAME but never its candidate count, and reporting `candidates: 0`
// from a payload we could not read would be a claim about listings nobody saw.
//
// The comparison window is complete by design — §13: store outcomes are part of the answer, and the
// renderer names every store that produced offers and every store that failed. That is the source.
test('offer lines attribute a store, and the store-status line attributes a failure', () => {
  const window = [
    '총 6개 중 1-5번 (1/2 페이지)',
    '사이트 3곳 중 2곳에서 결과를 받았습니다 · 월마트(walmart): rpc_unavailable',
    '1. [amazon] Logitech M185 고무 그립이 있는 컴팩트 … · 총 KRW 19,745 · 무료배송',
    '2. [amazon] Logitech M185 컴팩트 양손잡이용 … · 총 KRW 21,029 · 무료배송',
    '4. [ebay] Logitech M185 Wireless Optical Mouse … · 총 KRW 25,835 · 완전 새 상품',
  ].join('\n');

  const seen = readWindowOutcomes(window);

  assert.equal(seen.get('amazon'), 'candidates');
  assert.equal(seen.get('ebay'), 'candidates');
  assert.equal(seen.get('walmart'), 'rpc_unavailable');
});

test('a window naming no store attributes nothing', () => {
  // Absent stays absent: a turn that produced no window must not invent an outcome for anyone.
  assert.equal(readWindowOutcomes('요청을 처리하지 못했어요.').size, 0);
  assert.equal(readWindowOutcomes('').size, 0);
  assert.equal(readWindowOutcomes(undefined).size, 0);
});

test('a store that both failed and produced offers counts as having produced them', () => {
  // A store can appear in the status line for a page that failed and still have offers from another —
  // offers are the stronger evidence, so they win.
  const seen = readWindowOutcomes([
    '사이트 2곳 중 1곳에서 결과를 받았습니다 · 이베이(ebay): no_results',
    '1. [ebay] Something · 총 KRW 1,000',
  ].join('\n'));

  assert.equal(seen.get('ebay'), 'candidates');
});

test('the trace still wins when it could be read', () => {
  // The trace carries the full store_result; the window carries only the outcome. Where both exist the
  // trace is richer, so merging must not let a window label overwrite a parsed result.
  const fromTrace = collectStoreResults([{
    name: 'shopping_search_one_store',
    output: { store_result: { site: 'walmart', status: 'error', error: 'rpc_unavailable', url: 'https://x/' } },
  }]);

  const merged = mergeWindowOutcomes(fromTrace, readWindowOutcomes('· 월마트(walmart): rpc_unavailable'));

  assert.equal(merged.get('walmart').url, 'https://x/');
});

test('a window-attributed store with offers classifies as candidates', () => {
  // The window showed its offer lines, so the store answered — even though the truncated trace could not
  // hand over the candidate objects. Reporting `unknown` here would blame the store for our own read.
  const { outcome, responseValid } = classifyStoreResult({
    site: 'amazon', status: 'candidates', candidates: [], from_window: true,
  });

  assert.equal(outcome, 'candidates');
  assert.equal(responseValid, true);
});

test('a window-attributed failure is named, but is NOT a classified store answer', () => {
  // `rpc_unavailable` is OUR op channel failing to reach the store, not the store answering. Widening
  // `recognizedAccessOutcomes` to accept it would hide a real failure behind a green check — the whole
  // point of that set is that an access wall is a fact about the SITE. So the outcome is named (the sweep
  // can report which store and why) and the classified-answer check still fails, which is what the live
  // run already did for walmart.
  const { outcome, responseValid } = classifyStoreResult({
    site: 'walmart', status: 'rpc_unavailable', error: 'rpc_unavailable', from_window: true,
  });

  assert.equal(outcome, 'rpc_unavailable');
  assert.equal(responseValid, false);
});

test('a status is read when there are neither candidates nor an error', () => {
  // The etsy shape: 24 cards seen, relevance kept none. The reader now says no_results in its status, and
  // the classifier must not fall through to `unknown` — that label is for a reader that could not say.
  const { outcome, responseValid } = classifyStoreResult({
    site: 'etsy', status: 'no_results', candidates: [], cards_seen: 24, total_count: 0,
  });

  assert.equal(outcome, 'no_results');
  assert.equal(responseValid, true);
});

test('a result with nothing to go on is still unknown', () => {
  // The one case the label exists for: no candidates, no error, no status.
  assert.equal(classifyStoreResult({ site: 'x', candidates: [] }).outcome, 'unknown');
  assert.equal(classifyStoreResult({ site: 'x', candidates: [] }).responseValid, false);
});

test('a window-attributed store reports its contract as UNVERIFIED, not as passing', () => {
  // Live, after the window merge: etsy, coupang, 11st and ssg all read `outcome=candidates` with
  // `candidates=0`, because the window proved they answered while the truncated trace could not hand over
  // the candidate objects. The normalization check then passed on an empty list — vacuously. A check that
  // cannot fail is not a check, so a window-attributed store says so instead of claiming a pass.
  const [report] = tallySiteOutcomes(
    [{ site: 'etsy', region: 'global' }],
    new Map([['etsy', { site: 'etsy', status: 'candidates', candidates: [], from_window: true }]]),
  );

  assert.equal(report.outcome, 'candidates');
  assert.equal(report.normalized, null, 'null means unverified; true would claim we checked');
  assert.equal(report.fromWindow, true);
});

test('a store whose trace survived is verified for real', () => {
  const [report] = tallySiteOutcomes(
    [{ site: 'gmarket', region: 'korean' }],
    new Map([['gmarket', {
      site: 'gmarket', status: 'candidates', url: 'https://x/',
      candidates: [{ site: 'gmarket', product_id: '1', name: 'n', price: 13700, currency: 'KRW', url: 'https://x/1' }],
    }]]),
  );

  assert.equal(report.normalized, true);
  assert.equal(report.fromWindow, false);
  assert.equal(report.candidates, 1);
});

test('an unsearched store is still unverified and still fails', () => {
  const [report] = tallySiteOutcomes([{ site: 'ssg', region: 'korean' }], new Map());

  assert.equal(report.outcome, 'unsearched');
  assert.equal(report.responseValid, false);
});

// ── the bound has to come from a distribution ────────────────────────────────
//
// `max(300000, sites * 120000)` was never measured. Same code, consecutive runs: ten stores attributed in
// ~85 s, then a batch lost to its own 360 s ceiling. §13: latency here is LLM-dominated and swings ~4x for
// the SAME request, so one run cannot justify a bound and tuning the multiplier until a run goes green is
// how a number nobody measured becomes a number everybody trusts.
test('the timing summary reports each batch and the worst of them', () => {
  const summary = summariseTimings([
    { label: 'amazon,walmart,ebay', sites: 3, elapsedMs: 31_170 },
    { label: 'aliexpress,etsy', sites: 2, elapsedMs: 16_690 },
    { label: 'coupang,naver-shopping,gmarket', sites: 3, elapsedMs: 24_560 },
  ]);

  assert.equal(summary.batches, 3);
  assert.equal(summary.worstMs, 31_170);
  assert.equal(summary.worstLabel, 'amazon,walmart,ebay');
  assert.equal(summary.totalMs, 72_420);
  // Per store, so batches of different sizes are comparable — that is the number a bound is built from.
  // 31170/3 = 10390 beats 16690/2 = 8345 and 24560/3 = 8187.
  assert.equal(summary.worstPerSiteMs, 10_390);
});

test('a batch that timed out is carried as such, not as a duration', () => {
  // A timeout is the bound, not a measurement: averaging it in would drag the estimate toward whatever
  // ceiling happened to be set.
  const summary = summariseTimings([
    { label: 'a,b,c', sites: 3, elapsedMs: 31_000 },
    { label: 'd,e', sites: 2, timedOutAfterMs: 360_000 },
  ]);

  assert.equal(summary.batches, 2);
  assert.equal(summary.timedOut, 1);
  assert.equal(summary.worstMs, 31_000, 'the timeout is excluded from the worst measured turn');
  assert.ok(summary.note.includes('360000'), 'but it is reported');
});

test('no batches summarise to nothing, not to a zero', () => {
  const summary = summariseTimings([]);

  assert.equal(summary.batches, 0);
  assert.equal(summary.worstMs, null, 'null, not 0 — nothing was measured');
});

// A timeout in the summary that says only "after 360s" is the sentence that cost a repeat run to act on.
// `send` now names the node the turn stopped on, so the summary a reader scrolls to must carry it — the
// whole point of the diagnosis is that it survives to where someone reads it.
test('a timed-out batch reports where the turn stopped', () => {
  const summary = summariseTimings([
    { label: 'a,b', sites: 2, elapsedMs: 18_800 },
    {
      label: 'c,d,e',
      sites: 3,
      timedOutAfterMs: 360_000,
      stoppedOn: 'The turn ran 7 tool call(s), 6 completed; it stopped on shopping_judge_relevance (pending).',
    },
  ]);

  assert.equal(summary.timedOut, 1);
  assert.match(summary.note, /shopping_judge_relevance/, 'the note names the node that stopped answering');
  assert.match(summary.note, /360000/, 'and still says how long it waited');
});

// A hang with nothing to say must not invent a node.
test('a timed-out batch with no diagnosis still reports the timeout alone', () => {
  const summary = summariseTimings([{ label: 'c,d', sites: 2, timedOutAfterMs: 300_000 }]);
  assert.match(summary.note, /300000/);
  assert.doesNotMatch(summary.note, /stopped on/);
});

// The gate question. A batch whose turn never reached a node measured NOTHING, so its stores are not failing
// adapters — the sweep must retry it once and say so, rather than let a session-level failure be read as ten
// adapter failures. Measured: 1 turn in 48 live turns reached no node, and neither targeted probe (reset then
// send x14, ten accumulated flow turns) could reproduce it.
test('a batch that reached no node is retried and named, not counted as an adapter answer', () => {
  const summary = summariseTimings([
    { label: 'a,b', sites: 2, elapsedMs: 18_000 },
    { label: 'c,d', sites: 2, elapsedMs: 21_000, retriedAfter: 'no-node' },
  ]);

  assert.equal(summary.timedOut, 0, 'the retry answered, so nothing timed out');
  assert.equal(summary.retried, 1, 'but the run says a batch needed a retry');
  assert.match(summary.note, /no-node/, 'and names why');
  assert.equal(summary.worstMs, 21_000, 'the retried turn is a real measurement and counts');
});

// A retry that also fails is a timeout like any other, and must not be laundered into a measurement.
test('a batch that failed its retry is still a timeout', () => {
  const summary = summariseTimings([
    { label: 'c,d', sites: 2, timedOutAfterMs: 300_000, retriedAfter: 'no-node', stoppedOn: 'no node ran' },
  ]);

  assert.equal(summary.timedOut, 1);
  assert.equal(summary.retried, 1);
  assert.equal(summary.worstMs, null, 'nothing was measured');
});
