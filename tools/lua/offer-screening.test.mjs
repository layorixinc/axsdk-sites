import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { COMMERCE_LAYER, loadLuaModules } from './harness.mjs';

const lua = loadLuaModules([
  '_common/scripts/00_base.lua',
  '_common/scripts/44_pagination.lua',
  '_common/scripts/45_offer_view.lua',
  ...COMMERCE_LAYER,
]);
after(() => lua.close());

// Code cannot tell a mouse from a mouse pad, or a word-only model such as "DGX Spark" from a missing model
// field. Every structurally readable row reaches this bounded surface; one model call decides which rows
// ARE the product. The mechanics here only number rows, apply that verdict, and report removals.

function worker(site, candidates, extra = {}) {
  return { key: site, status: 'completed', value: { store_result: { site, candidates, ...extra } } };
}

function row(id, name, price = 10000) {
  return {
    product_id: id, id, name, price, currency: 'KRW', shipping_cost: 0,
    url: `https://shop.test/products/${id}`,
  };
}

const RESULTS = [
  worker('ssg', [
    row('s1', '로지텍 M185 무선마우스 그레이', 19400),
    row('s2', '로지텍 M185 마우스용 스킨 커버', 3900),
    row('s3', '로지텍 M185 정품 실버', 21000),
  ]),
  worker('coupang', [
    row('c1', '로지텍 무선마우스, M185, Gray', 10690),
    row('c2', 'M185 마우스 받침대 손목보호', 4500),
  ]),
];

function build(args = {}) {
  return lua.call('AX_build_offer_screening', { store_results: RESULTS, identity_model: 'M185', ...args });
}

function keptOf(applied) {
  // An empty Lua table arrives as {} — the documented array/object ambiguity, not a result shape.
  return applied.store_results.flatMap((entry) => {
    const candidates = entry.value?.store_result?.candidates;
    return Array.isArray(candidates) ? candidates : [];
  });
}

function apply(args) {
  return lua.call('AX_apply_offer_screening', { store_results: RESULTS, ...args });
}


test('a selected store whose fan-out child never answered becomes an explicit unsearched outcome', () => {
  // Shipping-CDP broad discovery passed twice, then one run searched 11st only and the comparison window
  // silently omitted Walmart. A missing flow.map child is a platform/session outcome, never evidence that
  // the store had no products. Complete the requested frontier before any screening or rendering.
  const completed = lua.call('AX_complete_store_results', {
    stores: [{ site: 'ssg' }, { site: 'walmart' }],
    store_results: [worker('ssg', [row('s1', '로지텍 M185 무선마우스')])],
  });

  assert.equal(completed.next, 'done');
  assert.equal(completed.store_results.length, 2);
  const missing = completed.store_results.find((entry) => entry.key === 'walmart');
  assert.equal(missing.status, 'failed');
  assert.equal(missing.value.site, 'walmart');
  assert.equal(missing.value.error, 'unsearched');

  const screened = lua.call('AX_build_offer_screening', {
    store_results: completed.store_results,
    identity_model: 'M185',
  });
  assert.ok(screened.store_outcomes.some((outcome) => outcome.site === 'walmart'
    && outcome.status === 'unsearched'));
});
// ── the list the model judges ────────────────────────────────────────────────

test('every candidate is numbered once, across all stores', () => {
  const built = build();
  assert.equal(built.next, 'judge');
  assert.equal(built.screening_count, 5);
  for (const marker of ['1.', '2.', '3.', '4.', '5.']) {
    assert.ok(built.screening_text.includes(marker), `row ${marker} must be listed`);
  }
  assert.ok(built.screening_text.includes('ssg'));
  assert.ok(built.screening_text.includes('coupang'));
  assert.ok(built.screening_text.includes('스킨 커버'), 'the row to be rejected must be visible to judge it');
});

test('a compact per-store outcome survives when candidate payloads are too large for the trace', () => {
  const built = build();
  assert.deepEqual(built.store_outcomes, [
    {
      site: 'ssg',
      status: 'candidates',
      candidate_count: 3,
      sample: {
        site: 'ssg',
        product_id: 's1',
        name: '로지텍 M185 무선마우스 그레이',
        price: 19400,
        currency: 'KRW',
        url: 'https://shop.test/products/s1',
      },
    },
    {
      site: 'coupang',
      status: 'candidates',
      candidate_count: 2,
      sample: {
        site: 'coupang',
        product_id: 'c1',
        name: '로지텍 무선마우스, M185, Gray',
        price: 10690,
        currency: 'KRW',
        url: 'https://shop.test/products/c1',
      },
    },
  ]);
});

test('the compact outcome preserves a classified store failure', () => {
  const built = lua.call('AX_build_offer_screening', {
    store_results: [{
      key: 'walmart',
      status: 'completed',
      value: { store_result: { site: 'walmart', status: 'access_denied', error: 'access_denied' } },
    }],
  });

  assert.deepEqual(built.store_outcomes, [{
    site: 'walmart', status: 'access_denied', error: 'access_denied', candidate_count: 0,
  }]);
});

test('the numbering is backed by ids so a verdict cannot drift onto another row', () => {
  const built = build();
  const ids = built.screening_ids.split('|');
  assert.equal(ids.length, built.screening_count);
  assert.equal(ids[0], 'ssg:s1');
  assert.equal(ids[1], 'coupang:c1');
  assert.equal(ids[4], 'ssg:s3');
});

test('stores take turns so a long first store cannot starve the rest', () => {
  const many = (site, count) => worker(site, Array.from({ length: count }, (_, i) => row(`${site}${i}`, `${site} row ${i}`)));
  const built = lua.call('AX_build_offer_screening', { store_results: [many('a', 6), many('b', 6)] });
  const ids = built.screening_ids.split('|');
  assert.equal(ids[0].split(':')[0], 'a');
  assert.equal(ids[1].split(':')[0], 'b', 'the second row must come from the second store');
});

test('the all-store list gives every store its full bounded relevance budget', () => {
  const many = (site) => worker(site, Array.from({ length: 8 }, (_, i) => row(`${site}${i}`, `${site} row ${i}`)));
  const built = lua.call('AX_build_offer_screening', {
    store_results: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map(many),
  });
  const ids = built.screening_ids.split('|');
  assert.equal(built.screening_count, 60,
    'ten supported stores need six judged rows each; a 30-row cap silently halves every store');
  for (const site of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) {
    assert.equal(ids.filter((id) => id.startsWith(`${site}:`)).length, 6, `${site} lost screening rows`);
  }
});

test('retired code-match metadata cannot label the LLM relevance surfaces', () => {
  const candidate = { ...row('stale', 'NVIDIA DGX Spark'), match_level: 'partial' };
  const built = lua.call('AX_build_offer_screening', {
    store_results: [worker('ebay', [candidate])],
  });
  assert.doesNotMatch(built.screening_text, /유사|partial/i);

  const ranked = lua.call('AX_rank_store_offers', {
    verified_offers: [{ ...candidate, identity_id: 'dgx-spark' }],
    identity_id: 'dgx-spark',
  });
  assert.doesNotMatch(ranked.comparison_text, /유사|partial/i);
});

test('nothing to judge is not a question for the model', () => {
  const built = lua.call('AX_build_offer_screening', {
    store_results: [{ key: 'ssg', status: 'failed', error: 'security_verification_required' }],
  });
  assert.equal(built.next, 'empty');
  assert.equal(built.screening_count, 0);
});

// ── applying the verdict ─────────────────────────────────────────────────────

test('only the rows the model kept survive', () => {
  // 3 and 4 are the skin cover and the wrist rest; the model keeps the three actual mice.
  const applied = apply({ screening_ids: build().screening_ids, keep: '1 2 5' });
  const names = keptOf(applied).map((candidate) => candidate.product_id);
  assert.deepEqual(names.sort(), ['c1', 's1', 's3']);
  assert.equal(applied.screened_out, 2);
  assert.equal(applied.next, 'done');
});

test('a kept row is handed on unchanged', () => {
  const applied = apply({ screening_ids: build().screening_ids, keep: '2' });
  const kept = keptOf(applied)[0];
  assert.equal(kept.product_id, 'c1');
  assert.equal(kept.price, 10690);
  assert.equal(kept.name, '로지텍 무선마우스, M185, Gray');
});

test('however the model separates the numbers, they are read', () => {
  const ids = build().screening_ids;
  for (const keep of ['1,5', '1 | 5', '#1 #5', '1\n5']) {
    const applied = apply({ screening_ids: ids, keep });
    assert.deepEqual(keptOf(applied).map((c) => c.product_id).sort(), ['s1', 's3'], `keep=${JSON.stringify(keep)}`);
  }
});

test('a number that names no row is ignored rather than shifting the verdict', () => {
  const applied = apply({ screening_ids: build().screening_ids, keep: '1 99 zero 0' });
  assert.deepEqual(keptOf(applied).map((c) => c.product_id), ['s1']);
});

test('the comparison cap is applied after the verdict, not before it', () => {
  // Six plausible rows per store reach the model; only the three it kept reach the comparison.
  const wide = worker('ssg', Array.from({ length: 6 }, (_, i) => row(`w${i}`, `로지텍 M185 ${i}`)));
  const built = lua.call('AX_build_offer_screening', { store_results: [wide] });
  const applied = lua.call('AX_apply_offer_screening', {
    store_results: [wide], screening_ids: built.screening_ids, keep: '1 2 3 4 5 6',
  });
  assert.equal(applied.store_results[0].value.store_result.candidates.length, 3);
  assert.equal(applied.capped_out, 3);
});

test('judging everything irrelevant is an answer, not a crash', () => {
  const applied = apply({ screening_ids: build().screening_ids, keep: '' });
  assert.equal(applied.next, 'empty');
  assert.equal(applied.screened_out, 5);
});

test('a model that never answered cannot authorize relevance', () => {
  // The LLM is the only semantic relevance judge. An absent verdict is not "keep everything": that would
  // silently replace the requested judgement with a code-path default and could rank accessories.
  const applied = lua.call('AX_apply_offer_screening', {
    store_results: RESULTS,
    screening_ids: build().screening_ids,
  });
  assert.equal(applied.next, 'error');
  assert.equal(applied.error, 'relevance_judgement_unavailable');
  assert.equal(applied.store_results, undefined);
});

test('a store that failed stays a failure, not a rejection', () => {
  const results = [...RESULTS, { key: 'naver-shopping', status: 'failed', error: 'security_verification_required' }];
  const built = lua.call('AX_build_offer_screening', { store_results: results });
  const applied = lua.call('AX_apply_offer_screening', { store_results: results, screening_ids: built.screening_ids, keep: '1' });
  const failed = applied.store_results.find((entry) => entry.key === 'naver-shopping');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'security_verification_required');
});

test('post-screening outcomes stay compact and attribute every searched store', () => {
  const applied = apply({ screening_ids: build().screening_ids, keep: '1' });
  const summary = lua.call('AX_summarize_store_outcomes', { store_results: applied.store_results });

  assert.deepEqual(summary.store_outcomes.map(({ site, status, candidate_count }) => ({
    site, status, candidate_count,
  })), [
    { site: 'ssg', status: 'candidates', candidate_count: 1 },
    { site: 'coupang', status: 'no_relevant_offers', candidate_count: 0 },
  ]);
  assert.equal(summary.store_outcomes[0].sample.product_id, 's1');
  assert.equal(summary.store_outcomes[1].sample, undefined);
});

test('no-results text is rendered deterministically from structured store outcomes', () => {
  const results = [
    { key: 'naver-shopping', status: 'failed', error: 'access_denied' },
    worker('gmarket', [], { status: 'no_relevant_offers', error: 'no_relevant_offers' }),
  ];
  const summary = lua.call('AX_summarize_store_outcomes', {
    store_results: results,
    screened_out: 6,
  });

  assert.match(summary.store_outcome_response, /Naver Shopping.*접근이 제한/);
  assert.match(summary.store_outcome_response, /Gmarket.*요청한 상품과 일치하는 결과 없음/);
  assert.match(summary.store_outcome_response, /관련 없는 6건/);
  assert.match(summary.store_outcome_response, /장바구니와 주문은 변경하지 않았습니다/);
  assert.doesNotMatch(summary.store_outcome_response, /access_denied|no_relevant_offers|정확한 제조사 모델/);
});

// ── the user is told what was removed ────────────────────────────────────────

test('rows the model removed are counted in the window', () => {
  const ranked = lua.call('AX_rank_store_offers', {
    identity_id: 'id-1',
    failures: [],
    screened_out: 2,
    verified_offers: [{
      site: 'ssg', product_id: 's1', name: '로지텍 M185 무선마우스', price: 19400, currency: 'KRW',
      shipping_cost: 0, base_currency: 'USD', total_base: 13.2, total_for_quantity: 19400, cost_complete: true,
      identity_id: 'id-1',
    }],
  });
  assert.match(ranked.comparison_text, /관련 없는 2건/);
});

// ── a screened-out store must say so, and cross as absent ────────────────────
//
// The second producer of a status that contradicts its own payload. `apply_offer_screening` rewrites
// `candidates` and `total_count` for every worker and never touches `status`, so a store whose rows the
// model rejected keeps `status = "candidates"` beside nothing. Traced live on etsy: the reader answered 5,
// the normalizer kept 1, and the sweep read `candidates candidates=0` on a run where the verdict removed
// it — an outcome nobody can name, and the label `unknown` is reserved for a reader that could not say.
//
// And an empty `kept` is assigned directly, so it crosses as the JSON OBJECT `{}`. This repo has paid for
// that four times over (§13, "absent at EVERY boundary"): a schema that validates `candidates` as an array
// refuses it, and a store with nothing becomes a technical failure instead of a store with nothing.
test('a store whose every row was screened out reports that, not candidates', () => {
  const applied = lua.call('AX_apply_offer_screening', {
    store_results: [worker('etsy', [{ product_id: 'a', name: 'x', price: 1, currency: 'USD' }], { status: 'candidates' })],
    screening_ids: 'etsy:a',
    keep: '',
  });

  const store = applied.store_results[0].value.store_result;
  assert.equal(store.total_count, 0);
  assert.notEqual(store.status, 'candidates', 'a status may not contradict an empty payload');
  assert.ok(typeof store.error === 'string' && store.error !== '', 'the outcome has to be nameable');
});

test('an emptied candidate list crosses as absent, never as {}', () => {
  const applied = lua.call('AX_apply_offer_screening', {
    store_results: [worker('etsy', [{ product_id: 'a', name: 'x', price: 1, currency: 'USD' }], { status: 'candidates' })],
    screening_ids: 'etsy:a',
    keep: '',
  });

  assert.equal(applied.store_results[0].value.store_result.candidates, undefined);
});

test('a store that kept rows still reports candidates', () => {
  const applied = lua.call('AX_apply_offer_screening', {
    store_results: [worker('etsy', [{ product_id: 'a', name: 'x', price: 1, currency: 'USD' }], { status: 'candidates' })],
    screening_ids: 'etsy:a',
    keep: '1',
  });

  const store = applied.store_results[0].value.store_result;
  assert.equal(store.status, 'candidates');
  assert.equal(store.total_count, 1);
  assert.equal(store.error, undefined);
});
