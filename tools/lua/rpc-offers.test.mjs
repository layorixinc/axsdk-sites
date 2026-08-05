import assert from 'node:assert/strict';
import test from 'node:test';

import { loadLuaModules } from './harness.mjs';

// The last three `kind: remote` tools. They stayed durable for one reason: the comparison a user browses
// has to survive from the turn that BUILT it to the turn that pages or filters it, and the runtime's
// `state: session` is keyed by (session, TOOL) — so `rank` cannot hand anything to `present`.
//
// Flow state can. `inputSelector` is an allowlist (FLOWS.md §4), so a deterministic node reads the
// comparison at zero prompt cost while no model node ever selects it. What travels is a SCALAR, because
// an empty Lua table encodes as `{}` and a tool schema expecting an array then rejects it.
//
// The ranking, folding, windowing and refinement logic is NOT reimplemented here: `54_comparison.lua` and
// `55_offers.lua` are already loaded as runtime modules. This adapter only moves the snapshot in and out
// of flow state, which is the whole of what was missing.

const MODULES = [
  '_common/scripts/00_base.lua',
  '_common/scripts/44_pagination.lua',
  '_common/scripts/45_offer_view.lua',
  '_common/scripts/46_candidate_browser.lua',
  '_common/scripts/50_commerce_core.lua',
  '_common/scripts/51_relevance.lua',
  '_common/scripts/52_identity.lua',
  '_common/scripts/53_verify.lua',
  '_common/scripts/54_comparison.lua',
  '_common/scripts/55_offers.lua',
  '_common/rpc/73_rpc_offers.lua',
];

/** A runtime with `json`, which is what carries the snapshot as one scalar. */
function runtime() {
  const lua = loadLuaModules(MODULES);
  lua.expose({
    json: {
      encode: (value) => JSON.stringify(value),
      decode: (text) => JSON.parse(text),
    },
  });
  return lua;
}

const OFFERS = [
  {
    site: 'amazon', product_id: 'B1', id: 'B1', name: 'Logitech M185 Mouse',
    price: 12.99, currency: 'USD', price_base: 12.99, base_currency: 'USD',
    shipping_cost: 0, shipping_base: 0, total_base: 12.99, cost_complete: true,
  },
  {
    site: 'walmart', product_id: 'W2', id: 'W2', name: 'Logitech M185 Wireless Mouse',
    price: 11.5, currency: 'USD', price_base: 11.5, base_currency: 'USD',
    shipping_cost: 0, shipping_base: 0, total_base: 11.5, cost_complete: true,
  },
  {
    site: 'ssg', product_id: 'S3', id: 'S3', name: '로지텍 M185 무선마우스',
    price: 14000, currency: 'KRW', price_base: 9.6, base_currency: 'USD',
    shipping_cost: 0, shipping_base: 0, total_base: 9.6, cost_complete: true,
  },
];

test('ranking hands back the comparison as one scalar', () => {
  // A table would arrive as a JSON object where the schema expects an array, and flow state validated by
  // a tool schema is exactly where that bites. One string, split by the consumer.
  const lua = runtime();
  const ranked = lua.call('AX_RPC_OFFERS.rank', { verified_offers: OFFERS });
  lua.close();

  assert.equal(typeof ranked.comparison_state, 'string');
  assert.ok(ranked.comparison_state.length > 0);
  assert.ok(ranked.comparison_id, 'the listing must be identified');
  assert.match(ranked.question ?? '', /M185/);
});

test('a later turn pages the comparison the earlier turn built', () => {
  // The reason these three could not be ported. `rank` runs in one turn, `present` in the next, and the
  // runtime gives them separate session scopes — so the only channel is what the flow carries between
  // them. Two separate Lua states here, deliberately: nothing may survive in a module global.
  const first = runtime();
  const ranked = first.call('AX_RPC_OFFERS.rank', { verified_offers: OFFERS });
  first.close();

  const later = runtime();
  const paged = later.call('AX_RPC_OFFERS.present', {
    comparison_state: ranked.comparison_state,
    comparison_id: ranked.comparison_id,
    view_page: 1,
  });
  later.close();

  assert.equal(paged.error, undefined, `paging failed: ${paged.error}`);
  assert.equal(paged.comparison_id, ranked.comparison_id, 'paging keeps the same listing');
  assert.match(paged.question ?? '', /M185/);
});

test('a refinement that changes WHICH offers are listed reissues the listing', () => {
  // Any change to the membership of the window invalidates every number the user was just shown. The
  // durable version reissued `comparison_id` for that reason and the port keeps it: a stale number must
  // fail resolution rather than select a different product.
  const first = runtime();
  const ranked = first.call('AX_RPC_OFFERS.rank', { verified_offers: OFFERS });
  first.close();

  const later = runtime();
  // Only the KRW row converts under ten dollars, so this drops rows rather than reordering them.
  const refined = later.call('AX_RPC_OFFERS.refine', {
    comparison_state: ranked.comparison_state,
    comparison_id: ranked.comparison_id,
    refine_request: '10달러 이하',
  });
  later.close();

  assert.equal(refined.error, undefined, `refine failed: ${refined.error}`);
  assert.notEqual(refined.comparison_id, ranked.comparison_id, 'a changed listing must be a new listing');
  assert.equal(typeof refined.comparison_state, 'string');
});

test('a refinement that changes nothing keeps the listing', () => {
  // The default sort is already cheapest-first, so asking for it again lists the same offers in the same
  // order. Reissuing there would invalidate numbers the user can still see on screen.
  const first = runtime();
  const ranked = first.call('AX_RPC_OFFERS.rank', { verified_offers: OFFERS });
  first.close();

  const later = runtime();
  const same = later.call('AX_RPC_OFFERS.refine', {
    comparison_state: ranked.comparison_state,
    comparison_id: ranked.comparison_id,
    refine_request: '싼 순으로',
  });
  later.close();

  assert.equal(same.error, undefined, `refine failed: ${same.error}`);
  assert.equal(same.comparison_id, ranked.comparison_id);
});

test('a comparison from a different listing is refused, not silently re-rendered', () => {
  // The number the user typed belongs to a listing. Answering from another one hands them a product they
  // never saw, which is the failure a comparison id exists to make impossible.
  const first = runtime();
  const ranked = first.call('AX_RPC_OFFERS.rank', { verified_offers: OFFERS });
  first.close();

  const later = runtime();
  const wrong = later.call('AX_RPC_OFFERS.present', {
    comparison_state: ranked.comparison_state,
    comparison_id: 'cmp-somethingelse',
  });
  later.close();

  assert.equal(wrong.error, 'stale_comparison');
});

test('garbage in flow state is an error, never a fabricated empty listing', () => {
  // Flow state is text and text can arrive truncated. An unreadable snapshot must say so; rendering an
  // empty window would tell the user their search found nothing.
  const lua = runtime();
  const broken = lua.call('AX_RPC_OFFERS.present', { comparison_state: '{not json', comparison_id: 'cmp-1' });
  const missing = lua.call('AX_RPC_OFFERS.present', { comparison_id: 'cmp-1' });
  lua.close();

  assert.equal(broken.error, 'comparison_unreadable');
  assert.equal(missing.error, 'comparison_unreadable');
});

test('a runtime without json refuses rather than dropping the comparison', () => {
  // The snapshot cannot travel without an encoder. Answering as though the listing were empty would be a
  // claim about prices nobody compared.
  const bare = loadLuaModules(MODULES);
  const result = bare.call('AX_RPC_OFFERS.rank', { verified_offers: OFFERS });
  bare.close();

  assert.equal(result.error, 'json_unavailable');
});

test('ranking answers in the branch vocabulary its node routes', () => {
  // The node routes `done | partial | empty | error`. The adapter answered `ask`, which no branch names,
  // so `invalidNext` sent the whole turn to the error terminal — live, after the entire comparison had
  // been built: both stores searched, screening judged, offers verified, a `comparison_id` issued, and
  // then "요청을 처리하는 중 문제가 발생했습니다".
  //
  // The rule is already settled: a command picks its own `next` and the adapter passes it through. This
  // one overwrote it with a constant.
  const lua = runtime();
  const ranked = lua.call('AX_RPC_OFFERS.rank', { verified_offers: OFFERS });
  lua.close();

  assert.ok(
    ['done', 'partial', 'empty'].includes(ranked.next),
    `\`${ranked.next}\` is not a branch the node routes`,
  );
});

test('the presenter renders the window and keeps it up until the user answers', () => {
  // Render, PAUSE on the window, and hold it. An unanswered turn must not page, select, or re-issue the
  // listing — the user is still reading the one on screen.
  const first = runtime();
  const ranked = first.call('AX_RPC_OFFERS.rank', { verified_offers: OFFERS });
  const shown = first.call('AX_RPC_OFFERS.present', {
    comparison_state: ranked.comparison_state,
    comparison_id: ranked.comparison_id,
  });
  first.close();

  assert.equal(shown.next, 'ask', 'the first pass pauses on the window');
  assert.match(shown.question ?? '', /M185/);
  assert.equal(shown.choice_stage, 'asked', 'the pass must record that it has asked');

  const later = runtime();
  const waiting = later.call('AX_RPC_OFFERS.present', {
    comparison_state: ranked.comparison_state,
    comparison_id: ranked.comparison_id,
    choice_stage: 'asked',
  });
  later.close();

  assert.equal(waiting.next, 'ask', 'with no answer the same window stands');
  assert.match(waiting.question ?? '', /M185/);
});

test('a chosen number resolves from the snapshot, not from a separate list', () => {
  // The pick is the last step before a cart mutation, and it was reading `offers` from its own state
  // field: live, `offers: Invalid input: expected array, received null`, because an empty list is carried
  // as absent now and the listing itself lives in the snapshot. One channel for the comparison or the two
  // can disagree about WHICH offers were numbered — and a wrong number here adds the wrong product.
  const first = runtime();
  const ranked = first.call('AX_RPC_OFFERS.rank', { verified_offers: OFFERS });
  first.close();

  const later = runtime();
  const picked = later.call('AX_RPC_OFFERS.resolve', {
    identity_id: 'identity-1',
    identity_status: 'locked',
    comparison_state: ranked.comparison_state,
    comparison_id: ranked.comparison_id,
    choice_comparison_id: ranked.comparison_id,
    choice_index: 1,
    choice_stage: 'asked',
  });
  later.close();

  assert.equal(picked.error, undefined, `resolve failed: ${picked.error}`);
  assert.ok(picked.selected_offer, 'the pick must name an offer');
});

test('a number from a listing the user is no longer reading is refused', () => {
  // The comparison id is what makes a number mean something. Resolving against a different listing hands
  // the user a product they never saw, one turn before the cart.
  const first = runtime();
  const ranked = first.call('AX_RPC_OFFERS.rank', { verified_offers: OFFERS });
  first.close();

  const later = runtime();
  const wrong = later.call('AX_RPC_OFFERS.resolve', {
    comparison_state: ranked.comparison_state,
    comparison_id: ranked.comparison_id,
    choice_comparison_id: 'cmp-somethingelse',
    choice_index: 1,
  });
  later.close();

  assert.ok(wrong.error, 'a stale number must not resolve');
  assert.equal(wrong.selected_offer, undefined);
});

test('the node that pauses is the node that reads the answer', () => {
  // Live, twice: the user typed "취소" and the offer was ADDED TO CART, because the model gate re-sent the
  // previous turn's "3번". It never saw the new message — `currentUserText: active_node_only` gives it the
  // text of the turn IT was active for, and the flow now pauses at the presenter. The Thumbtack shortlist
  // hit this exact failure and answered it by having no model node in the loop at all.
  //
  // A cancel that buys something is the worst shape this bug can take, so interpretation lives where the
  // pause is.
  const ranked = (() => {
    const lua = runtime();
    const out = lua.call('AX_RPC_OFFERS.rank', { verified_offers: OFFERS });
    lua.close();
    return out;
  })();

  const answer = (requestText) => {
    const lua = runtime();
    const out = lua.call('AX_RPC_OFFERS.present', {
      comparison_state: ranked.comparison_state,
      comparison_id: ranked.comparison_id,
      choice_stage: 'asked',
      requestText,
    });
    lua.close();
    return out;
  };

  assert.equal(answer('취소').next, 'cancel', 'a cancel must stop, never select');
  assert.equal(answer('그만할래').next, 'cancel');

  const picked = answer('3번');
  assert.equal(picked.next, 'select');
  assert.equal(picked.choice_index, 3);
  assert.equal(picked.choice_comparison_id, ranked.comparison_id, 'a pick must name the listing it came from');

  assert.equal(answer('다음').next, 'page');
  assert.equal(answer('무료배송만').next, 'refine');
  assert.equal(answer('무료배송만').refine_request, '무료배송만');

  // No reply at all is not an instruction. Guessing here would page or select on a turn the user did not
  // answer, and the previous listing stands.
  assert.equal(answer('').next, 'ask');
});

test('a store that failed is still named in the windows after the first', () => {
  // Store outcomes are part of the answer: one line naming every store that failed and what the user must
  // do. The snapshot did not carry `failures`, so the line survived only the turn that BUILT the listing —
  // page once and the comparison starts looking like every store answered.
  const first = runtime();
  const ranked = first.call('AX_RPC_OFFERS.rank', {
    verified_offers: OFFERS,
    failures: [{ site: 'naver-shopping', error: 'captcha' }],
  });
  first.close();

  assert.match(ranked.question ?? '', /naver|네이버/i, 'the turn that builds it names the failure');

  const later = runtime();
  const paged = later.call('AX_RPC_OFFERS.present', {
    comparison_state: ranked.comparison_state,
    comparison_id: ranked.comparison_id,
  });
  later.close();

  assert.match(paged.question ?? '', /naver|네이버/i, 'and so must every window after it');
});

test('a run where every store answered publishes no failures list at all', () => {
  // An empty Lua table encodes as a JSON OBJECT, and `failures: { type: [array, "null"] }` rejects it.
  // Live: every store answered, so the list was empty, and the NEXT tool died with `failures: Invalid
  // input` — after the search, the screening and the verification had all run. The list must be ABSENT,
  // and the boundary that publishes it is the one that has to leave it out.
  const lua = loadLuaModules(MODULES);
  lua.expose({ json: { encode: (value) => JSON.stringify(value), decode: (text) => JSON.parse(text) } });
  const verified = lua.call('AX_verify_product_offers', {
    identity_id: 'identity-1',
    store_results: [{ key: '11st', status: 'completed', value: { store_result: { site: '11st', status: 'candidates', candidates: OFFERS } } }],
  });
  lua.close();

  assert.equal(verified.failures, undefined, 'no failures means no list, not an empty one');
});

/** More offers than one window holds, so paging has somewhere to go. */
const MANY = Array.from({ length: 8 }, (unused, index) => ({
  site: index % 2 === 0 ? 'amazon' : 'walmart',
  product_id: `P${index}`, id: `P${index}`,
  name: `Logitech M185 Mouse variant ${index}`,
  price: 10 + index, currency: 'USD', price_base: 10 + index, base_currency: 'USD',
  shipping_cost: 0, shipping_base: 0, total_base: 10 + index, cost_complete: true,
}));

test('"다음" turns the page, and the second window holds different rows', () => {
  // Paging is a branch of the presenter now, so the whole trip is: read the reply, hand `page_command` to
  // the refiner, and render what comes back. A window that answers "page" but returns the same rows is
  // indistinguishable from one that ignored the request.
  const build = runtime();
  const ranked = build.call('AX_RPC_OFFERS.rank', { verified_offers: MANY });
  build.close();

  const first = runtime();
  const window1 = first.call('AX_RPC_OFFERS.present', { comparison_state: ranked.comparison_state });
  first.close();
  assert.equal(window1.view_pages > 1, true, `the fixture must span pages, got ${window1.view_pages}`);

  const reading = runtime();
  const asked = reading.call('AX_RPC_OFFERS.present', {
    comparison_state: ranked.comparison_state,
    choice_stage: 'asked',
    requestText: '다음',
  });
  reading.close();
  assert.equal(asked.next, 'page');
  assert.equal(asked.page_command, 'next');

  const turning = runtime();
  const window2 = turning.call('AX_RPC_OFFERS.refine', {
    comparison_state: ranked.comparison_state,
    comparison_id: ranked.comparison_id,
    page_command: asked.page_command,
    view_page: window1.view_page,
  });
  turning.close();

  assert.equal(window2.next, 'ask');
  assert.equal(window2.view_page, 2, 'the second page must actually be the second page');
  assert.notEqual(window2.question, window1.question, 'a page that renders the same rows never moved');
  assert.equal(window2.comparison_id, ranked.comparison_id, 'paging keeps the listing, so the numbers keep meaning');
});

test('a filter narrows the listing and reissues it', () => {
  // Changing WHICH offers are listed changes what the numbers mean, so the listing is reissued. The whole
  // trip runs through the presenter now: read the words, hand them to the refiner, render what comes back.
  const build = runtime();
  const ranked = build.call('AX_RPC_OFFERS.rank', {
    verified_offers: [
      { ...MANY[0], shipping_cost: 0, shipping_base: 0 },
      { ...MANY[1], shipping_cost: 5, shipping_base: 5, total_base: 16 },
    ],
  });
  build.close();

  const reading = runtime();
  const asked = reading.call('AX_RPC_OFFERS.present', {
    comparison_state: ranked.comparison_state,
    choice_stage: 'asked',
    requestText: '무료배송만',
  });
  reading.close();
  assert.equal(asked.next, 'refine');
  assert.equal(asked.refine_request, '무료배송만');

  const filtering = runtime();
  const narrowed = filtering.call('AX_RPC_OFFERS.refine', {
    comparison_state: ranked.comparison_state,
    comparison_id: ranked.comparison_id,
    refine_request: asked.refine_request,
  });
  filtering.close();

  assert.equal(narrowed.next, 'ask');
  assert.equal(narrowed.view_total, 1, 'the paid-shipping offer must be gone');
  assert.notEqual(narrowed.comparison_id, ranked.comparison_id, 'different offers means a different listing');
});

test('a refusal keeps the listing and says why, in the window', () => {
  // "3만원 이하" against a USD-only listing is a claim about prices that were never compared, so the filter
  // is REFUSED. The previous listing has to STAND — reporting "0건" would be a lie, and routing to an error
  // would take away the comparison the user is reading over a request they can simply rephrase.
  const build = runtime();
  // Every offer priced in USD: there is no rate to infer, so "3만원" is a threshold against prices that
  // were never compared. (OFFERS carries a KRW row, which would make the filter legitimately applicable.)
  const ranked = build.call('AX_RPC_OFFERS.rank', { verified_offers: MANY.slice(0, 3) });
  build.close();

  const refusing = runtime();
  const refused = refusing.call('AX_RPC_OFFERS.refine', {
    comparison_state: ranked.comparison_state,
    comparison_id: ranked.comparison_id,
    refine_request: '3만원 이하만 보여줘',
  });
  refusing.close();

  assert.equal(refused.next, 'ask', 'a refusal is not the loss of the comparison');
  assert.equal(refused.view_total, 3, 'every offer still stands');
  // The window is the only surface the user reads, so a reason that is not in it never arrives.
  assert.match(refused.question ?? '', /통화/, 'the refusal must explain itself where the user is looking');
});

test('a listing priced in one currency shows its totals in that currency', () => {
  // `uniform_currency` already picks it when the listing is built. The snapshot did not carry it, and the
  // window the user actually reads is always rendered from a RESTORE — so a Korean shopper comparing
  // Korean stores in Korean got "총 USD 10.79" next to "상품가 KRW 12,900" and had to do the arithmetic
  // the feature exists to do.
  const won = [
    { site: 'ssg', product_id: 'S1', id: 'S1', name: '로지텍 M170 무선마우스', price: 12900, currency: 'KRW',
      price_base: 9.04, base_currency: 'USD', shipping_cost: 2500, shipping_base: 1.75, total_base: 10.79, cost_complete: true },
    { site: '11st', product_id: 'E1', id: 'E1', name: '로지텍 M170 정품', price: 16010, currency: 'KRW',
      price_base: 11.22, base_currency: 'USD', shipping_cost: 3000, shipping_base: 2.1, total_base: 13.32, cost_complete: true },
  ];

  const build = runtime();
  const ranked = build.call('AX_RPC_OFFERS.rank', { verified_offers: won });
  build.close();

  const later = runtime();
  const shown = later.call('AX_RPC_OFFERS.present', { comparison_state: ranked.comparison_state });
  later.close();

  assert.match(shown.question ?? '', /총 KRW/, 'the total belongs in the currency the prices are quoted in');
  assert.doesNotMatch(shown.question ?? '', /총 USD/);
});

test('a listing spanning currencies keeps the common base', () => {
  // Mixed prices have no shared currency to be honest in, so the comparison currency stands. Picking one
  // side's currency would make the other side's rows a conversion the user never asked for.
  const build = runtime();
  const ranked = build.call('AX_RPC_OFFERS.rank', { verified_offers: OFFERS });
  build.close();

  const later = runtime();
  const shown = later.call('AX_RPC_OFFERS.present', { comparison_state: ranked.comparison_state });
  later.close();

  assert.match(shown.question ?? '', /총 USD/);
});

/** A listing where some rows have a known total and some do not — which is the normal live shape. */
const MIXED_COMPLETENESS = [
  { site: 'ssg', product_id: 'S1', id: 'S1', name: '로지텍 M170 무선마우스', price: 12900, currency: 'KRW',
    price_base: 9.04, base_currency: 'USD', shipping_cost: 2500, shipping_base: 1.75, total_base: 10.79, cost_complete: true },
  { site: '11st', product_id: 'E1', id: 'E1', name: '로지텍 무선 마우스 M170', price: 18770, currency: 'KRW',
    price_base: 13.15, base_currency: 'USD', cost_complete: false },
  { site: '11st', product_id: 'E2', id: 'E2', name: '로지텍정품 M170 무선 광 마우스', price: 14740, currency: 'KRW',
    price_base: 10.33, base_currency: 'USD', cost_complete: false },
];

test('"미확인 포함" shows the rows the window folded away', () => {
  // Rows without a known total are folded out and counted, and the window says so — every live comparison
  // so far ended with "배송비/총액 미확인 3건은 접었습니다 — '미확인 포함'이라고 하면 함께 보여드려요".
  // An instruction the window prints is a promise; if the phrase does not reach the parser the window is
  // advertising a way out that does not exist.
  const build = runtime();
  const ranked = build.call('AX_RPC_OFFERS.rank', { verified_offers: MIXED_COMPLETENESS });
  build.close();

  const folded = runtime();
  const first = folded.call('AX_RPC_OFFERS.present', { comparison_state: ranked.comparison_state });
  folded.close();
  assert.equal(first.view_total, 1, 'only the row with a known total is listed');
  assert.match(first.question ?? '', /접었습니다/);

  const reading = runtime();
  const asked = reading.call('AX_RPC_OFFERS.present', {
    comparison_state: ranked.comparison_state,
    choice_stage: 'asked',
    requestText: '미확인 포함',
  });
  reading.close();
  assert.equal(asked.next, 'refine', 'the phrase is a refinement, not a new search');

  const unfolded = runtime();
  const all = unfolded.call('AX_RPC_OFFERS.refine', {
    comparison_state: ranked.comparison_state,
    comparison_id: ranked.comparison_id,
    refine_request: asked.refine_request,
  });
  unfolded.close();

  assert.equal(all.next, 'ask');
  assert.equal(all.view_total, 3, 'every row is listed once the user asks for them');
});
