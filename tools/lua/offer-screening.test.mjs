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

// Token rules cannot tell a mouse from a mouse pad: "로지텍 M185 마우스용 스킨" contains every word of the
// query and passes every anchor. So the deterministic pass now decides only RECALL — what could plausibly
// be the product, up to six per store — and one model call decides which of those rows actually ARE the
// product. The mechanics here never judge relevance; they number the rows, apply the verdict, and make
// what was removed visible.

function worker(site, candidates, extra = {}) {
  return { key: site, status: 'completed', value: { store_result: { site, candidates, ...extra } } };
}

function row(id, name, price = 10000) {
  return {
    product_id: id, id, name, price, currency: 'KRW', shipping_cost: 0,
    match_level: 'exact', url: `https://shop.test/products/${id}`,
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

test('the list is bounded, because it is the only thing that enters a prompt', () => {
  const many = (site) => worker(site, Array.from({ length: 8 }, (_, i) => row(`${site}${i}`, `${site} row ${i}`)));
  const built = lua.call('AX_build_offer_screening', {
    store_results: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map(many),
  });
  assert.ok(built.screening_count <= 30, `too many rows: ${built.screening_count}`);
  assert.equal(built.screening_ids.split('|').length, built.screening_count);
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

test('a model that never answered must not empty the comparison', () => {
  // The screening node can stall or error. Losing the verdict costs precision; losing the offers costs
  // the whole turn, so an absent verdict keeps everything and says so.
  const applied = lua.call('AX_apply_offer_screening', { store_results: RESULTS, screening_ids: build().screening_ids });
  assert.equal(applied.next, 'done');
  assert.equal(applied.screening_skipped, true);
  assert.equal(keptOf(applied).length, 5);
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

// ── the user is told what was removed ────────────────────────────────────────

test('rows the model removed are counted in the window', () => {
  const ranked = lua.call('AX_rank_store_offers', {
    identity_id: 'id-1',
    failures: [],
    screened_out: 2,
    verified_offers: [{
      site: 'ssg', product_id: 's1', name: '로지텍 M185 무선마우스', price: 19400, currency: 'KRW',
      shipping_cost: 0, base_currency: 'USD', total_base: 13.2, total_for_quantity: 19400, cost_complete: true,
      identity_id: 'id-1', match_level: 'exact',
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
