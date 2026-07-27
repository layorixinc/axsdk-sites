import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { loadLuaModules } from './harness.mjs';

const lua = loadLuaModules([
  'tools/lua/fixtures/session_state_stub.lua',
  '_common/scripts/00_base.lua',
  '_common/scripts/44_pagination.lua',
  '_common/scripts/45_offer_view.lua',
  '_common/scripts/50_commerce.lua',
]);
after(() => lua.close());

function offer(overrides = {}) {
  return {
    site: 'amazon',
    product_id: `p${Math.random().toString(36).slice(2, 8)}`,
    name: 'Logitech M185 Wireless Mouse',
    price: 13.95,
    currency: 'USD',
    shipping_cost: 0,
    base_currency: 'USD',
    total_base: 13.95,
    total_for_quantity: 13.95,
    cost_complete: true,
    identity_id: 'id-1',
    ...overrides,
  };
}

function rank(offers, failures = []) {
  return lua.call('AX_rank_store_offers', { verified_offers: offers, failures, identity_id: 'id-1' });
}

// ── store outcome is first-class, not something only the log knows ────────────
// A store that was searched and produced nothing must be visible to the user with what to do about it;
// silently missing stores are indistinguishable from "this store has no such product".

test('every failure code maps to an action the user can take', () => {
  const cases = [
    ['security_verification_required', /보안 확인/],
    ['captcha_required', /보안 확인|캡차/],
    ['login_required', /로그인/],
    ['access_denied', /차단|접근/],
    ['no_results', /결과 없음|없음/],
    ['store_search_failed', /실패/],
  ];
  for (const [code, expected] of cases) {
    const status = lua.call('AX_COMMERCE.store_status', [{ site: 'naver-shopping', error: code }], []);
    assert.match(status.text, expected, `${code} -> ${status.text}`);
    assert.match(status.text, /naver-shopping|네이버/);
  }
});

test('an unknown code still names the store instead of vanishing', () => {
  const status = lua.call('AX_COMMERCE.store_status', [{ site: 'gmarket', error: 'weird_new_code' }], []);
  assert.match(status.text, /gmarket/);
  assert.match(status.text, /weird_new_code/);
});

test('the summary counts stores that produced offers', () => {
  const status = lua.call('AX_COMMERCE.store_status',
    [{ site: 'naver-shopping', error: 'security_verification_required' }],
    [offer({ site: 'amazon' }), offer({ site: 'ssg' }), offer({ site: 'amazon' })]);

  assert.equal(status.ok_count, 2);
  assert.equal(status.failed_count, 1);
  assert.match(status.text, /2/);
});

test('no failures produces no status noise', () => {
  const status = lua.call('AX_COMMERCE.store_status', [], [offer()]);
  assert.equal(status.text, '');
});

test('the comparison window carries the store status', () => {
  const ranked = rank(
    [offer({ site: 'amazon' }), offer({ site: 'ssg', product_id: 's1' })],
    [{ site: 'naver-shopping', error: 'security_verification_required' }],
  );

  assert.match(ranked.comparison_text, /보안 확인/);
  assert.match(ranked.store_status, /보안 확인/);
  assert.equal(ranked.next, 'partial');
});

// ── incomplete totals are folded out of the default view ─────────────────────
// The whole task is "total cost". A row whose shipping is unknown cannot answer it, and it used to take
// a slot in a five-row window.

test('rows without a known total are folded out by default and counted', () => {
  const ranked = rank([
    offer({ site: 'amazon', product_id: 'a1' }),
    offer({ site: 'ssg', product_id: 's1', currency: 'KRW', total_base: 12, total_for_quantity: 17000 }),
    offer({ site: 'aliexpress', product_id: 'x1', shipping_cost: null, cost_complete: false, total_base: null, known_cost_base: 15 }),
    offer({ site: 'aliexpress', product_id: 'x2', shipping_cost: null, cost_complete: false, total_base: null, known_cost_base: 16 }),
  ]);

  assert.equal(ranked.view_total, 2, 'only offers with a known total are listed');
  assert.equal(ranked.incomplete_count, 2);
  assert.match(ranked.comparison_text, /미확인 2/);
  assert.equal(ranked.offers.length, 2);
  assert.equal(ranked.all_offers.length, 4, 'the folded rows must remain reachable');
});

test('the user can unfold them in their own words', () => {
  const ranked = rank([
    offer({ site: 'amazon', product_id: 'a1' }),
    offer({ site: 'aliexpress', product_id: 'x1', shipping_cost: null, cost_complete: false, total_base: null }),
  ]);
  assert.equal(ranked.view_total, 1);

  const unfolded = lua.call('AX_refine_store_offers', {
    comparison_id: ranked.comparison_id,
    offers: ranked.offers,
    all_offers: ranked.all_offers,
    view_page: 1,
    refine_request: '배송비 미확인도 포함해서 보여줘',
  });

  assert.equal(unfolded.view_total, 2);
  assert.notEqual(unfolded.comparison_id, ranked.comparison_id, 'the listing changed, so the numbers must too');
});

test('a comparison where nothing has a known total still shows the rows', () => {
  const ranked = rank([
    offer({ site: 'aliexpress', product_id: 'x1', shipping_cost: null, cost_complete: false, total_base: null }),
    offer({ site: 'aliexpress', product_id: 'x2', shipping_cost: null, cost_complete: false, total_base: null }),
  ]);

  assert.equal(ranked.view_total, 2, 'folding everything away would leave the user nothing to choose from');
  assert.equal(ranked.next, 'done');
});

test('parse_refine understands the unfold request without guessing a filter', () => {
  const parsed = lua.call('AX_OFFER_VIEW.parse_refine', '미확인 포함');
  assert.equal(parsed.unparsed, false);
  assert.equal(parsed.filters.include_incomplete, true);
});

test('the store status stays on the window while the user browses', () => {
  const ranked = rank(
    Array.from({ length: 7 }, (_, index) => offer({ site: index % 2 === 0 ? 'amazon' : 'ssg', product_id: `p${index}`, total_base: 10 + index })),
    [{ site: 'naver-shopping', error: 'security_verification_required' }],
  );
  assert.match(ranked.comparison_text, /보안 확인/);

  const paged = lua.call('AX_refine_store_offers', {
    comparison_id: ranked.comparison_id,
    offers: ranked.offers,
    all_offers: ranked.all_offers,
    failures: ranked.failures,
    view_page: 1,
    page_command: 'next',
  });

  assert.equal(paged.view_page, 2);
  assert.match(paged.question, /보안 확인/, 'paging must not drop the store status');
  assert.match(paged.store_status, /보안 확인/);
});

test('a filtered window keeps reporting the failed stores', () => {
  const ranked = rank(
    [offer({ site: 'amazon', product_id: 'a1', shipping_cost: 0 }), offer({ site: 'ssg', product_id: 's1', shipping_cost: 3000 })],
    [{ site: 'coupang', error: 'access_denied' }],
  );
  const filtered = lua.call('AX_refine_store_offers', {
    comparison_id: ranked.comparison_id,
    offers: ranked.offers,
    all_offers: ranked.all_offers,
    failures: ranked.failures,
    view_page: 1,
    refine_request: '무료배송만',
  });

  assert.equal(filtered.view_total, 1);
  assert.match(filtered.question, /차단|접근/);
});

test('the store count describes the search, not the current window', () => {
  // Folding a row away must not make a store look like it never answered: the same search reported
  // "4곳 중 2곳" folded and "5곳 중 3곳" unfolded before the count was taken from the whole listing.
  const ranked = rank(
    [
      offer({ site: 'ssg', product_id: 'r1' }),
      offer({ site: 'amazon', product_id: 'r2' }),
      offer({ site: 'aliexpress', product_id: 'r3', shipping_cost: null, cost_complete: false, total_base: null }),
    ],
    [{ site: 'naver-shopping', error: 'security_verification_required' }],
  );
  assert.equal(ranked.view_total, 2, 'the unknown-total row is folded');
  assert.equal(ranked.stores_with_offers, 3, 'aliexpress answered even though its row is folded');
  assert.match(ranked.comparison_text, /4곳 중 3곳/);

  const unfolded = lua.call('AX_refine_store_offers', {
    comparison_id: ranked.comparison_id,
    offers: ranked.offers,
    all_offers: ranked.all_offers,
    failures: ranked.failures,
    view_page: 1,
    refine_request: '미확인 포함',
  });
  assert.equal(unfolded.view_total, 3);
  assert.match(unfolded.question, /4곳 중 3곳/, 'the same search must report the same store counts');
});

test('a structured failure never leaks a Lua table into the user text', () => {
  // A live run printed "네이버쇼핑(naver-shopping): table: 0x2af" because the worker's failure carried an
  // object instead of a code string. Whatever shape arrives, the user must read a cause.
  const shapes = [
    { site: 'naver-shopping', error: { error: 'security_verification_required' } },
    { site: 'naver-shopping', error: { code: 'captcha_required' } },
    { site: 'naver-shopping', error: { message: '사이트가 응답하지 않음' } },
    { site: 'naver-shopping', error: {}, status: 'failed' },
    { site: 'naver-shopping', error: {} },
  ];
  for (const failure of shapes) {
    const status = lua.call('AX_COMMERCE.store_status', [failure], []);
    assert.doesNotMatch(status.text, /table:/, `leaked a table for ${JSON.stringify(failure)}`);
    assert.match(status.text, /네이버쇼핑/);
    assert.ok(status.text.split(':').slice(1).join(':').trim().length > 1, 'the line must name a cause');
  }

  assert.match(lua.call('AX_COMMERCE.store_status', [shapes[0]], []).text, /보안 확인/);
  assert.match(lua.call('AX_COMMERCE.store_status', [shapes[2]], []).text, /응답하지 않음/);
});

test('a failure without a usable site still reports the cause', () => {
  const status = lua.call('AX_COMMERCE.store_status', [{ error: 'store_search_failed' }], []);
  assert.doesNotMatch(status.text, /table:/);
  assert.match(status.text, /실패/);
});

test('a price filter the listing cannot convert is reported, not silently applied', () => {
  const ranked = rank([
    offer({ site: 'amazon', product_id: 'a1', price: 13.95, currency: 'USD', price_base: 13.95 }),
    offer({ site: 'amazon', product_id: 'a2', price: 41, currency: 'USD', price_base: 41, total_base: 41 }),
  ]);

  const refused = lua.call('AX_refine_store_offers', {
    comparison_id: ranked.comparison_id,
    offers: ranked.offers,
    all_offers: ranked.all_offers,
    view_page: 1,
    refine_request: '3만원 이하만',
  });

  assert.equal(refused.refine_error, 'price_currency_unknown');
  assert.equal(refused.comparison_id, ranked.comparison_id, 'the listing must survive a filter it cannot ground');
  assert.equal(refused.view_total, 2);
});

test('the same filter applies once the listing quotes that currency', () => {
  const ranked = rank([
    offer({ site: 'ssg', product_id: 's1', price: 19400, currency: 'KRW', price_base: 13.28, total_base: 13.28 }),
    offer({ site: 'ssg', product_id: 's2', price: 52000, currency: 'KRW', price_base: 35.6, total_base: 35.6 }),
    offer({ site: 'amazon', product_id: 'a1', price: 41, currency: 'USD', price_base: 41, total_base: 41 }),
  ]);

  const filtered = lua.call('AX_refine_store_offers', {
    comparison_id: ranked.comparison_id,
    offers: ranked.offers,
    all_offers: ranked.all_offers,
    view_page: 1,
    refine_request: '3만원 이하만',
  });

  assert.equal(filtered.refine_error ?? null, null);
  assert.deepEqual(filtered.offers.map((entry) => entry.product_id), ['s1']);
});

test('a refinement that did not apply says so in the window itself', () => {
  // The model relays the window verbatim, so a reason it has to add in its own words is a reason that
  // sometimes never reaches the user. Live: "3만원 이하만" on a USD-only listing silently redisplayed.
  const ranked = rank([
    offer({ site: 'amazon', product_id: 'a1', price: 13.95, currency: 'USD', price_base: 13.95 }),
    offer({ site: 'amazon', product_id: 'a2', price: 41, currency: 'USD', price_base: 41, total_base: 41 }),
  ]);

  const ungroundable = lua.call('AX_refine_store_offers', {
    comparison_id: ranked.comparison_id, offers: ranked.offers, all_offers: ranked.all_offers,
    view_page: 1, refine_request: '3만원 이하만',
  });
  assert.equal(ungroundable.refine_error, 'price_currency_unknown');
  assert.match(ungroundable.question, /원|KRW/, 'the window must name the currency problem');
  assert.match(ungroundable.question, /적용하지 못했|적용되지 않았/);

  const noMatch = lua.call('AX_refine_store_offers', {
    comparison_id: ranked.comparison_id, offers: ranked.offers, all_offers: ranked.all_offers,
    view_page: 1, refine_request: '평점 4.9 이상',
  });
  assert.equal(noMatch.refine_error, 'no_matches');
  assert.match(noMatch.question, /조건에 맞는|없어/);

  const unparsed = lua.call('AX_refine_store_offers', {
    comparison_id: ranked.comparison_id, offers: ranked.offers, all_offers: ranked.all_offers,
    view_page: 1, refine_request: '알아서 좋은 걸로',
  });
  assert.equal(unparsed.refine_error, 'unparsed');
  assert.match(unparsed.question, /이해하지 못했|알 수 없/);
});

test('an unreadable price tells the user what actually happened', () => {
  const status = lua.call('AX_COMMERCE.store_status', [{ site: 'walmart', error: 'price_unavailable' }], []);
  assert.match(status.text, /월마트/);
  assert.match(status.text, /가격/);
  assert.doesNotMatch(status.text, /price_unavailable/, 'the raw code is not an explanation');
});
