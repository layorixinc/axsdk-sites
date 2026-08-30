#!/usr/bin/env bun
// The multi-store total-cost gate, asserted against the RPC implementation the CDP extension ships:
// `_common/rpc/61_rpc_storefront.lua` (the reader) + `_common/rpc/62_rpc_sites.lua` (the GENERATED site
// data) + `_common/rpc/67_rpc_cart.lua` (the guarded cart), together with the pure commerce layer
// (`_common/scripts/50..56`) the flows declare — all driven through `tools/lua/rpc-stub.mjs`, which
// mirrors the real channel's semantics.
//
// This file used to prove the same facts against the durable stored-Lua stack (the monolithic durable
// storefront module plus the per-site adapter scripts), all of which is deleted. Every assertion the
// durable version carried is re-expressed here one-to-one.
//
// Re-basing it found THREE real defects on the shipped path that the durable tests had been hiding,
// because they exercised the other implementation. All three are now fixed, and each one is a reason to
// re-base a test BEFORE deleting the code it covered rather than after:
//
//   1. The guarded cart confirmed an UNRELATED cart. `cart_contains` took a `product_id` and never used
//      it, while amazon's generated `confirmation_selector` had grown `#sc-active-cart` — cart STRUCTURE,
//      true of any rendered cart. The id match now comes first, and on the cart page only the narrow
//      `confirmation_text_selectors` counts as per-add evidence.
//   2. eBay `return_terms` was unreadable. Measured live: eBay cards state NOTHING about returns
//      (`[class*=return]` matched 0 elements), and the durable reader had never used a selector either —
//      it scanned the card text for "free returns" / "무료 반품". That derivation moved to the RPC reader.
//   3. eBay revalidation refused a correct add. Its primary quote is the seller's currency and the
//      buyer's localized approximation sits beside it (`.x-price-approx__price` -> "KRW7,559.73",
//      measured on /itm/236940774206). ebay now declares its product-page keys and `price_error`
//      consults the approximation on a currency mismatch, still subject to the amount check.
import { COMMERCE_LAYER, loadLuaModules } from './lua/harness.mjs';
import { installRpcStub, makePage } from './lua/rpc-stub.mjs';

const lua = loadLuaModules([
  '_common/scripts/00_base.lua',
  '_common/scripts/44_pagination.lua',
  '_common/scripts/45_offer_view.lua',
  ...COMMERCE_LAYER,
  '_common/rpc/61_rpc_storefront.lua',
  '_common/rpc/62_rpc_sites.lua',
  '_common/rpc/67_rpc_cart.lua',
]);

lua.define('TEST_SITES = { get = function(site) return RPC_SITES[site] end }', 'site config probe');

// A selector regression once shipped silently, so the durable gate guarded the eBay adapter's
// `M.RESULT_SELECTOR` constant with a load-time throw. The equivalent fact now lives in the generated
// site data the RPC reader actually queries, so the guard moves there and stays a hard failure. The
// eBay card fixtures below are keyed by this exact string, so a drifted selector empties the grid and
// fails the parser tests loudly instead of matching a fixture written for the old one.
const ebaySite = lua.call('TEST_SITES.get', 'ebay');
if (!ebaySite || typeof ebaySite.result_selector !== 'string' || ebaySite.result_selector.trim() === '') {
  throw new Error('_common/rpc/62_rpc_sites.lua no longer declares ebay.result_selector — the RPC reader would query nothing');
}
const ebayResultSelector = ebaySite.result_selector;

let assertions = 0;
function assert(condition, message, context) {
  if (!condition) throw new Error(`${message}${context === undefined ? '' : ` :: ${JSON.stringify(context)}`}`);
  assertions += 1;
}

// The runtime's `net.fetch`, shaped exactly as the durable gate stubbed it: `{ ok, json }` (the durable
// transport supplies `json`; `_common/scripts/00_base.lua` `response_json` reads it). `null` means the
// FX service is failing. Returns a counter so a test can assert the lookup was frozen once per set.
function exposeNet(fxResponse) {
  const state = { fxCalls: 0 };
  lua.expose({
    net: {
      fetch(url) {
        state.fxCalls += 1;
        if (fxResponse === null) return { ok: false, url };
        return fxResponse || {
          ok: true,
          json: { base: 'USD', date: '2026-07-14', rates: { KRW: 1000, EUR: 0.8 } },
          url,
        };
      },
    },
  });
  return state;
}

// The pure commands ran with no `net` global in the durable gate. An empty table is the same fact:
// `fetch_fx_rates` finds no `net.fetch` either way and answers `fx_fetch_unavailable`.
function withoutNet() {
  lua.expose({ net: {} });
}

const clicksOf = (page) => page.ops.filter((entry) => entry.op === 'dom.click').map((entry) => entry.params.selector);
const navigationsOf = (page) => page.ops.filter((entry) => entry.op === 'nav.navigate');

const tests = [];
const lockedApproval = {
  identity_id: 'identity-m185',
  comparison_id: 'cmp-current',
  identity_approval: 'locked_product_identity',
  comparison_approval: 'current_comparison',
};

tests.push(['deterministic ranking includes shipping and FX', () => {
  withoutNet();
  const value = lua.call('AX_rank_store_offers', {
    quantity: 1,
    results: [
      { key: 'amazon', status: 'completed', value: { site: 'amazon', candidates: [
        { product_id: 'A1', name: 'Mouse', price: 20, currency: 'USD', shipping_cost: 0, shipping_currency: 'USD', cost_complete: true, total_base: 20, rating: 4.8, review_count: 50 },
      ] } },
      { key: 'ebay', status: 'completed', value: { site: 'ebay', candidates: [
        { product_id: 'E1', name: 'Mouse', price: 10000, currency: 'KRW', shipping_cost: 1000, shipping_currency: 'KRW', cost_complete: true, total_base: 11, rating: 4.7, review_count: 100 },
      ] } },
    ],
  });
  assert(value.next === 'done', 'ranking should complete', value);
  assert(value.offers.length === 2, 'two offers retained', value);
  assert(value.offers[0].site === 'ebay' && value.offers[0].total_base === 11, 'landed cost should rank eBay first', value.offers);
  assert(value.offers[0].rank === 1 && value.offers[1].rank === 2, 'stable ranks assigned', value.offers);
  assert(value.comparison_text.includes('번호로 선택') && value.comparison_text.includes("'취소'"),
    'the rendered window must tell the user how to choose and how to refuse', value.comparison_text);
  const presentation = lua.call('AX_present_store_offers', { comparison_id: value.comparison_id });
  assert(presentation.question === value.comparison_text, 'presentation must read the exact cached comparison instead of model-generated prose', presentation);
  const stalePresentation = lua.call('AX_present_store_offers', { comparison_id: 'cmp-stale' });
  assert(stalePresentation.error === 'stale_comparison', 'presentation must fail closed for an unknown comparison snapshot', stalePresentation);
}]);

tests.push(['complete cost ranks before lower incomplete estimate', () => {
  withoutNet();
  const value = lua.call('AX_rank_store_offers', {
    results: [
      { key: 'amazon', status: 'completed', value: { site: 'amazon', candidates: [
        { product_id: 'A1', name: 'Unknown shipping', price: 5, currency: 'USD', price_base: 5, cost_complete: false },
      ] } },
      { key: 'ebay', status: 'completed', value: { site: 'ebay', candidates: [
        { product_id: 'E1', name: 'Complete', price: 10, currency: 'USD', shipping_cost: 2, total_base: 12, cost_complete: true },
      ] } },
      { key: 'failed', status: 'failed', error: { code: 'captcha_required' } },
    ],
  });
  assert(value.next === 'partial', 'worker failure should remain partial', value);
  assert(value.offers[0].product_id === 'E1', 'complete total must rank first', value.offers);
  assert(value.failures.length === 1 && value.failures[0].site === 'failed', 'failure retained with key', value.failures);
}]);

tests.push(['approval resolver accepts only a current integer rank', () => {
  withoutNet();
  const offers = [
    { rank: 1, site: 'amazon', product_id: 'A1', name: 'Mouse', price: 20, currency: 'USD', total_base: 20, identity_id: lockedApproval.identity_id, comparison_id: lockedApproval.comparison_id },
  ];
  const unpresented = lua.call('AX_resolve_store_offer', { offers, choice_index: 1, choice_comparison_id: lockedApproval.comparison_id, ...lockedApproval });
  assert(unpresented.next === 'invalid' && unpresented.error === 'approval_turn_required', 'same-turn product choice cannot approve a cart offer', unpresented);
  const unversioned = lua.call('AX_resolve_store_offer', { offers, choice_index: 1, choice_stage: 'asked', ...lockedApproval });
  assert(unversioned.next === 'invalid' && unversioned.error === 'comparison_version_required', 'unversioned offer choice must fail closed', unversioned);

  const valid = lua.call('AX_resolve_store_offer', { offers, choice_index: 1, choice_stage: 'asked', choice_comparison_id: lockedApproval.comparison_id, ...lockedApproval });
  assert(valid.next === 'add' && valid.site === 'amazon' && valid.product_id === 'A1', 'valid rank resolves', valid);
  assert(valid.cart_approval === 'user_selected_compared_offer', 'scoped approval marker emitted', valid);
  const invalid = lua.call('AX_resolve_store_offer', { offers, choice_index: 2, choice_stage: 'asked', choice_comparison_id: lockedApproval.comparison_id, ...lockedApproval });
  assert(invalid.next === 'invalid', 'out-of-range choice rejected', invalid);
  assert(!invalid.product_id && !invalid.cart_approval, 'invalid choice cannot leak mutation fields', invalid);
}]);

tests.push(['rank cap and all tie-breaks are stable', () => {
  withoutNet();
  const candidates = [
    { product_id: 'Z9', name: 'Z', price: 10, total_base: 10, cost_complete: true, rating: 4.0, review_count: 1 },
    { product_id: 'A2', name: 'A2', price: 10, total_base: 10, cost_complete: true, rating: 4.8, review_count: 10 },
    { product_id: 'A1', name: 'A1', price: 10, total_base: 10, cost_complete: true, rating: 4.8, review_count: 10 },
    { product_id: 'A3', name: 'A3', price: 11, total_base: 11, cost_complete: true },
    { product_id: 'A4', name: 'A4', price: 12, total_base: 12, cost_complete: true },
    { product_id: 'A5', name: 'A5', price: 13, total_base: 13, cost_complete: true },
    { product_id: 'A6', name: 'A6', price: 14, total_base: 14, cost_complete: true },
    { product_id: 'A7', name: 'A7', price: 15, total_base: 15, cost_complete: true },
  ];
  const value = lua.call('AX_rank_store_offers', {
    results: [{ key: 'amazon', status: 'completed', value: { site: 'amazon', candidates } }],
  });
  assert(value.all_offers.length === 8, 'every ranked offer is retained for browsing', value.all_offers);
  assert(value.comparison_text.includes('총 8개 중 1-5번 (1/2 페이지)'), 'one window shows five of the eight and says so', value.comparison_text);
  assert(value.view_total === 8 && value.view_pages === 2, 'the window states where it sits in the list', value);
  assert(value.all_offers[0].product_id === 'A1' && value.all_offers[1].product_id === 'A2', 'rating, reviews, and lexical id break equal-cost ties', value.all_offers);
  assert(value.all_offers.every((offer, index) => offer.rank === index + 1), 'the ranked list must be numbered contiguously', value.all_offers);
}]);

tests.push(['cart dispatcher rejects missing scoped approval before navigation', () => {
  withoutNet();
  const page = makePage({
    href: 'https://www.ebay.com/itm/327230547159',
    dom: {
      body: [{ text: 'eBay item' }],
      'h1.x-item-title__mainTitle': [{ text: 'Logitech M185 Wireless Mouse' }],
      '#atcBtn_btn_1': [{ text: 'Add to cart' }],
    },
  });
  installRpcStub(lua, page);
  const rpc = lua.call('AX_RPC_CART.add_to_cart', { site: 'ebay', product_id: '327230547159' });
  assert(rpc.error === 'approval_required' && rpc.added === false, 'missing approval marker must fail closed', rpc);
  const dispatcher = lua.call('AX_add_store_product_to_cart', { site: 'ebay', product_id: '327230547159' });
  assert(dispatcher.error === 'approval_required' && dispatcher.added === false, 'the flow-facing dispatcher fails the same gate closed', dispatcher);
  assert(clicksOf(page).length === 0, 'approval failure must occur before any click', page.ops);
  assert(page.ops.length === 0, 'approval failure must cost no page op at all', page.ops);
}]);

tests.push(['Amazon ignores the hidden navbar sign-in form', () => {
  withoutNet();
  // The hidden navbar sign-in form is present on EVERY Amazon page. The RPC reader must classify by the
  // generated `login_selector` (`#authportal-main-section, #ap_email, #ap_password`); if that selector
  // list ever grows a part matching the navbar form, this page classifies as an auth wall and this fails.
  const searchPage = {
    body: [{ text: 'Amazon' }],
    'form[name="signIn"]': [{ text: '' }],
    '.s-no-results-result': [{ text: 'No results for Logitech M185' }],
  };
  const page = makePage({ href: 'https://www.amazon.com/', dom: searchPage, afterNavigate: searchPage });
  installRpcStub(lua, page);
  const value = lua.call('AX_RPC_STOREFRONT.run_store_search', { site: 'amazon', query: 'Logitech M185' });
  assert(value.store_result.login_required !== true, 'hidden navbar form must not be treated as an auth page', value.store_result);
  assert(value.store_result.status === 'no_results', 'an empty grid beside the navbar form is still an empty grid, not a wall', value.store_result);
}]);

tests.push(['Amazon existing cart must identify the requested ASIN', () => {
  withoutNet();
  // Measured shape: an active cart page listing OTHER items — the requested ASIN appears nowhere on it.
  const page = makePage({
    href: 'https://www.amazon.com/gp/cart/view.html',
    dom: {
      body: [{ text: 'Shopping Cart' }],
      '#sc-active-cart': [{ text: 'Shopping Cart' }],
      '.sc-list-item[data-asin]': [{ text: 'Some other product' }],
    },
  });
  installRpcStub(lua, page);
  const value = lua.call('AX_RPC_CART.add_to_cart', {
    site: 'amazon',
    product_id: 'B004YAVF8I',
    ...lockedApproval,
    cart_approval: 'user_selected_compared_offer',
  });
  assert(clicksOf(page).length === 0, 'unrelated Amazon cart evidence must not click from the wrong page', page.ops);
  // KNOWN RPC GAP — LEFT FAILING ON PURPOSE. Amazon's generated `confirmation_selector` includes
  // `#sc-active-cart`, so `AX_RPC_CART.cart_contains` answers true for any rendered cart page and the
  // add is reported confirmed without the ASIN ever being checked. The durable adapter verified the
  // cart listing against the requested ASIN. Fix belongs in `67_rpc_cart.lua` or amazon's declared
  // confirmation selectors, neither of which this gate may edit.
  assert(value.added !== true, 'an unrelated Amazon cart must not confirm the requested ASIN', value);
}]);

// ── the eBay reader, on the generated config ─────────────────────────────────
// Card content is the durable gate's measured fixture, unchanged. Field NAMES follow what the reader
// requests off the row (`fields_for`): the attribute row that the durable parser called
// `attributes_text` arrives as `shipping_text`, because ebay's `result_shipping_selector` is what reads
// it. Rows are keyed by the exact generated `result_selector`, so the fixture only matches when the
// reader queries the selector the site data actually declares.
const ebayCardRows = () => ({
  body: [{ text: 'eBay results' }],
  '.srp-river-results': [{ text: '' }],
  [ebayResultSelector]: [
    { url: 'https://ebay.com/itm/123456', title: 'Shop on eBay', price_text: '$20.00', text: 'Sponsored' },
    { url: 'https://www.ebay.com/itm/327230547159?x=1', title: 'Logitech M185 Wireless Mouse', price_text: 'KRW10,000.00', image_url: 'https://i.ebayimg.test/item.jpg', condition: 'Brand New', shipping_text: 'Buy It Now +Shipping KRW1,000.00 Free returns', seller_text: 'seller 99.8% positive (10K)', text: 'Logitech M185 Wireless Mouse Brand New KRW10,000.00 Buy It Now +Shipping KRW1,000.00 Free returns' },
    { url: 'https://www.ebay.com/itm/327230547158', title: 'Acer Wireless Mouse', price_text: 'KRW5,000.00', shipping_text: 'Free shipping', text: 'Acer Wireless Mouse KRW5,000.00 Free shipping' },
    { url: 'https://www.ebay.com/itm/327230547159?duplicate=1', title: 'Duplicate', price_text: 'KRW9,000.00', text: 'Duplicate' },
  ],
});

// The production pipeline: the RPC reader searches the store, then the pure normalizer prices and
// bounds what it read for the LLM relevance gate. Already on the result page, so no navigation fires.
function ebaySearch(rows, fxResponse) {
  const fx = exposeNet(fxResponse);
  const page = makePage({ href: 'https://www.ebay.com/sch/i.html?_nkw=Logitech+M185', dom: rows });
  installRpcStub(lua, page);
  const searched = lua.call('AX_RPC_STOREFRONT.run_store_search', { site: 'ebay', query: 'Logitech M185' });
  return { page, fx, searched };
}

tests.push(['eBay normalization preserves live rows for the LLM and prices paid shipping', () => {
  const { page, fx, searched } = ebaySearch(ebayCardRows());
  const value = lua.call('AX_normalize_store_product_result', {
    site: 'ebay', query: 'Logitech M185', quantity: 1, result: searched.store_result,
  });
  assert(page.ops.some((entry) => entry.op === 'dom.query_all' && entry.params.selector === ebayResultSelector),
    'the reader must query the generated ebay card selector verbatim', navigationsOf(page));
  assert(value.candidates.length === 3, 'only duplicate ids are removed before LLM screening', value);
  assert(value.candidates.some((row) => row.name === 'Shop on eBay'),
    'semantic junk stays visible to the LLM relevance judge', value);
  const candidate = value.candidates.find((row) => row.product_id === '327230547159');
  assert(candidate, 'the requested product row survives normalization', value);
  assert(candidate.shipping_cost === 1000 && candidate.shipping_currency === 'KRW', 'paid shipping parsed', candidate);
  assert(candidate.total_base === 11 && candidate.cost_complete === true, 'FX landed cost normalized', candidate);
  assert(fx.fxCalls === 1, 'one frozen FX lookup for the result set', fx);
}]);

tests.push(['eBay return evidence retained', () => {
  const { searched } = ebaySearch(ebayCardRows());
  const value = lua.call('AX_normalize_store_product_result', { site: 'ebay', query: 'Logitech M185', quantity: 1, result: searched.store_result });
  const candidate = value.candidates.find((row) => row.product_id === '327230547159') || {};
  // The shared RPC reader derives return evidence from the measured card text because eBay exposes no
  // stable return selector. The normalized candidate must retain that evidence after LLM-surface changes.
  assert(candidate.return_terms && /return/i.test(candidate.return_terms), 'return evidence retained', candidate);
}]);

tests.push(['eBay free shipping stays complete after FX normalization', () => {
  const rows = {
    body: [{ text: 'eBay results' }],
    '.srp-river-results': [{ text: '' }],
    [ebayResultSelector]: [
      { url: 'https://www.ebay.com/itm/327230547160', image_alt: 'Logitech M185 Wireless Mouse', price_text: 'KRW10,000.00', shipping_text: 'Free shipping', text: 'Logitech M185 Wireless Mouse KRW10,000.00 Free shipping' },
    ],
  };
  const { searched } = ebaySearch(rows);
  const value = lua.call('AX_normalize_store_product_result', { site: 'ebay', query: 'Logitech M185', result: searched.store_result });
  assert(value.candidates[0].shipping_cost === 0, 'free shipping must normalize to zero', value.candidates[0]);
  assert(value.candidates[0].cost_complete === true && value.candidates[0].total_base === 10, 'free shipping offer must have complete landed cost', value.candidates[0]);
}]);

tests.push(['FX failure preserves an explicitly incomplete candidate', () => {
  const rows = {
    body: [{ text: 'eBay results' }],
    '.srp-river-results': [{ text: '' }],
    [ebayResultSelector]: [
      { url: 'https://www.ebay.com/itm/327230547161', image_alt: 'Logitech M185 Wireless Mouse', price_text: 'EUR 10.00', shipping_text: 'Free shipping', text: 'Logitech M185 Wireless Mouse EUR 10.00 Free shipping' },
    ],
  };
  const { searched } = ebaySearch(rows, null);
  const value = lua.call('AX_normalize_store_product_result', { site: 'ebay', query: 'Logitech M185', result: searched.store_result });
  assert(value.candidates.length === 1 && value.candidates[0].cost_complete === false, 'candidate must remain visible but incomplete', value);
  assert(value.candidates[0].cost_error === 'fx_fetch_failed' && value.candidates[0].total_base == null, 'FX failure must not fabricate a base total', value.candidates[0]);
}]);

tests.push(['eBay cart confirmation must identify the requested item', () => {
  withoutNet();
  // Measured shape: an existing cart listing a DIFFERENT item. Nothing on it identifies the requested
  // product, so nothing may confirm it — and if ebay's site data ever grows a confirmation selector that
  // merely detects "a cart row exists", this fixture turns red exactly then.
  const page = makePage({
    href: 'https://cart.ebay.com/',
    dom: {
      body: [{ text: 'eBay cart' }],
      "[data-test-id='cart-item']": [{ text: 'Some other listing' }],
    },
    afterNavigate: { body: [{ text: 'eBay item' }] },
  });
  installRpcStub(lua, page);
  const value = lua.call('AX_RPC_CART.add_to_cart', {
    site: 'ebay',
    product_id: '327230547162',
    ...lockedApproval,
    cart_approval: 'user_selected_compared_offer',
  });
  assert(value.added !== true, 'an unrelated existing cart must not confirm the requested product', value);
  assert(clicksOf(page).length === 0, 'unrelated cart evidence must not trigger an add click from the wrong page', page.ops);
}]);

tests.push(['eBay localized alternate price can satisfy strict revalidation', () => {
  withoutNet();
  // Measured shape: the primary price is quoted in the seller's currency (EUR) and the buyer's localized
  // approximation (`.x-price-approx__price`) carries the KRW amount the comparison approved.
  const productPage = {
    body: [{ text: 'eBay item' }],
    'h1.x-item-title__mainTitle': [{ text: 'Logitech M185 Wireless Mouse' }],
    '.x-price-primary': [{ text: 'EUR 8.00' }],
    '.x-price-approx__price': [{ text: 'KRW10,000.00' }],
    '#atcBtn_btn_1': [{ text: 'Add to cart' }],
  };
  const page = makePage({ href: 'https://www.ebay.com/itm/327230547162', dom: productPage, afterNavigate: productPage });
  installRpcStub(lua, page);
  const value = lua.call('AX_RPC_CART.add_to_cart', {
    site: 'ebay',
    product_id: '327230547162',
    quantity: 1,
    expected_unit_price: 10000,
    expected_currency: 'KRW',
    ...lockedApproval,
    cart_approval: 'user_selected_compared_offer',
  });
  // Both halves of the original gap are closed, and each was measured live on
  // https://www.ebay.com/itm/236940774206 (2026-08-15): ebay now declares
  // `product_title_selectors` / `product_price_selectors` / `product_price_approx_selectors`
  // (`.x-price-approx__price` -> "KRW7,559.73") / `add_selectors` (`#atcBtn_btn_1`), and
  // `AX_RPC_CART.price_error` consults the localized approximation when the primary quote is another
  // currency. Before that this refused with `currency_changed`.
  //
  // What this test asserts is what its name says: the guarded click is PERMITTED. It cannot assert
  // `added === true`, because that is a claim about the SITE's response — the confirmation panel — and
  // this fixture models no confirmation, no cart page and no cart counter. eBay's real confirmation
  // selectors are unmeasured on purpose: reading them requires putting an item in a real cart.
  // So the contract here is that no GATE refused, and that exactly one click happened.
  assert(value.error !== 'currency_changed' && value.error !== 'price_changed'
    && value.error !== 'identity_changed' && value.error !== 'approval_required',
  'matching localized alternate price should permit the guarded click', value);
  assert(clicksOf(page).length === 1, 'a permitted guarded add clicks exactly once', page.ops);
}]);

tests.push(['stale price precondition blocks cart click', () => {
  withoutNet();
  // The durable gate proved this on eBay's bespoke adapter. The guard now lives once, in
  // `AX_RPC_CART.price_error`, driven by generated site data — exercised here through amazon's config,
  // which is the one that declares product price selectors.
  const page = makePage({
    href: 'https://www.amazon.com/dp/B004YAVF8I',
    dom: {
      body: [{ text: 'Amazon item' }],
      'span#productTitle': [{ text: 'Logitech M185 Wireless Mouse' }],
      '#corePrice_feature_div .a-offscreen': [{ text: '$21.00' }],
      '#add-to-cart-button': [{ text: 'Add to Cart' }],
    },
  });
  installRpcStub(lua, page);
  const value = lua.call('AX_RPC_CART.add_to_cart', {
    site: 'amazon',
    product_id: 'B004YAVF8I',
    quantity: 1,
    expected_unit_price: 20,
    expected_currency: 'USD',
    ...lockedApproval,
    cart_approval: 'user_selected_compared_offer',
  });
  assert(value.error === 'price_changed' && value.added === false, 'stale price rejected', value);
  assert(clicksOf(page).length === 0, 'stale price must not click', page.ops);
  assert(value.current_price === 21, 'the refusal reports the price the page actually shows', value);
}]);

tests.push(['identity preparation discovers broad products and locks explicit models', () => {
  withoutNet();
  const broad = lua.call('AX_prepare_product_identity', {
    product_category: 'wireless mouse',
    requested_brand: 'Logitech',
    stores: [
      { site: 'walmart' },
      { site: '11st' },
      { site: 'amazon' },
      { site: 'coupang' },
    ],
  });
  assert(broad.next === 'discover' && broad.identity_status === 'family', 'brand plus category should enter discovery', broad);
  assert(broad.discovery_query === 'Logitech wireless mouse', 'discovery query should preserve grounded product scope', broad);
  assert(broad.discovery_sites?.map(item => item.site).join(',') === 'walmart,11st,amazon', 'discovery should use a deterministic three-store frontier', broad);

  const exact = lua.call('AX_prepare_product_identity', {
    product_category: 'wireless mouse',
    requested_brand: 'Logitech',
    requested_model: 'M185',
  });
  assert(exact.next === 'lock' && exact.identity_status === 'exact', 'explicit model should skip discovery', exact);

  const missing = lua.call('AX_prepare_product_identity', {});
  assert(missing.next === 'ask_scope' && missing.identity_status === 'missing', 'missing category should ask before searching', missing);
}]);

tests.push(['identity fingerprints are canonical for nested and localized constraints', () => {
  withoutNet();
  const first = lua.call('AX_lock_product_identity', {
    identity_kind: 'standardized_model',
    identity_brand: '로지텍',
    identity_model: 'G304',
    product_category: '무선 마우스',
    hard_constraints: {
      color: 'black',
      connectivity: { receiver: 'USB', wireless: true },
    },
  });
  const second = lua.call('AX_lock_product_identity', {
    identity_kind: 'standardized_model',
    identity_brand: '로지텍',
    identity_model: 'G304',
    product_category: '무선 마우스',
    hard_constraints: {
      connectivity: { wireless: true, receiver: 'USB' },
      color: 'black',
    },
  });
  assert(first.identity_id === second.identity_id, 'nested constraint key order must not change identity', { first, second });
  assert(first.identity_fingerprint.includes('brand=로지텍'), 'localized identity text must remain part of the fingerprint', first);
}]);

tests.push(['common dispatcher waits for the target site adapter without reloading the same host', () => {
  withoutNet();
  const page = makePage({ href: 'https://www.11st.co.kr/', dom: { body: [{ text: '11번가' }] } });
  installRpcStub(lua, page);
  const value = lua.call('AX_search_store_product', {
    site: '11st',
    query: 'Logitech M185',
  });
  assert(value.pending === true && value.status === 'loading_adapter', 'site-script registration race must be retryable', value);
  assert(page.href === 'https://www.11st.co.kr/', 'adapter loading on the target host must not reload the page', page.href);
  assert(navigationsOf(page).length === 0, 'no navigation may fire for the host already showing', page.ops);
}]);

tests.push(['site search results are normalized after adapter-ready dispatch', () => {
  exposeNet();
  const value = lua.call('AX_normalize_store_product_result', {
    site: '11st',
    query: '로지텍 무선 마우스',
    purpose: 'discovery',
    requested_brand: '로지텍',
    result: {
      candidates: [
        { product_id: 'm185', name: '로지텍 M185 무선 마우스', price: 19000, currency: 'KRW', shipping_cost: 0, shipping_currency: 'KRW', url: 'https://www.11st.co.kr/products/m185' },
        { product_id: 'k123', name: 'Generic K123 Keyboard', price: 10000, currency: 'KRW', shipping_cost: 0, shipping_currency: 'KRW', url: 'https://www.11st.co.kr/products/k123' },
      ],
    },
  });
  assert(value.candidates?.length === 1 && value.candidates[0].product_id === 'm185', 'post-dispatch normalization must retain relevance filtering', value);
  assert(value.candidates[0].brand === '로지텍' && value.candidates[0].brand_source === 'title', 'post-dispatch normalization must preserve observed provenance', value.candidates[0]);
  assert(value.candidates[0].cost_complete === true && value.candidates[0].total_base === 19, 'post-dispatch normalization must compute landed base cost', value.candidates[0]);
  const navigation = lua.call('AX_normalize_store_product_result', {
    site: '11st',
    query: '로지텍 무선 마우스',
    result: { ok: true, fired: true, arrived: true, kind: 'document', navigated: true, url: 'https://search.11st.co.kr/' },
  });
  assert(navigation.pending === true && navigation.status === 'navigating', 'a navigation envelope must be retried before normalization', navigation);
}]);

tests.push(['localized discovery rejects unrelated listings and preserves observed provenance', () => {
  exposeNet();
  const page = makePage({ href: 'https://review.example/', dom: { body: [{ text: 'review store' }] } });
  installRpcStub(lua, page);
  lua.define(`
    AX_COMMERCE.register_adapter("review-store", {
      host_matches = function() return true end,
      search = function()
        return { candidates = {
          { product_id = "bad", name = "Generic K123 Keyboard", price = 10, currency = "USD", shipping_cost = 0, shipping_currency = "USD", url = "https://review.example/bad" },
          { product_id = "good", name = "로지텍 G304 무선 마우스", price = 20, currency = "USD", shipping_cost = 0, shipping_currency = "USD", url = "https://review.example/good" }
        } }
      end
    })
  `, 'localized discovery probe');

  const result = lua.call('AX_search_store_product', {
    site: 'review-store',
    query: '로지텍 무선 마우스',
    requested_brand: '로지텍',
    purpose: 'discovery',
  });
  assert(result.candidates.length === 1 && result.candidates[0].product_id === 'good', 'Korean discovery must reject unrelated product categories', result);
  assert(result.candidates[0].brand === '로지텍' && result.candidates[0].brand_source === 'title', 'requested brand may become observed only when the title proves it', result.candidates[0]);

  const options = lua.call('AX_build_product_options', {
    query: '로지텍 무선 마우스',
    requested_brand: '로지텍',
    results: [{ key: 'review-store', status: 'completed', value: { site: 'review-store', candidates: [
      result.candidates[0],
      { ...result.candidates[0], product_id: 'good-2', url: 'https://review.example/good-2' },
    ] } }],
  });
  assert(options.options[0].source_site_count === 1, 'duplicate listings from one storefront count as one independent site', options.options[0]);
  assert(options.options[0].identity_confidence === 'medium', 'same-site duplicate listings cannot create high identity confidence', options.options[0]);
}]);

tests.push(['discovery options group grounded model evidence without merging variants', () => {
  withoutNet();
  const value = lua.call('AX_build_product_options', {
    query: 'Logitech wireless mouse',
    max_options: 5,
    results: [
      { key: 'walmart', status: 'completed', value: { site: 'walmart', candidates: [
        { product_id: 'W185', name: 'Logitech M185 Wireless Mouse', url: 'https://www.walmart.com/ip/W185', brand: 'Logitech', manufacturer_model: 'M185', price: 13, currency: 'USD' },
        { product_id: 'W650', name: 'Logitech M650 Silent Mouse', url: 'https://www.walmart.com/ip/W650', brand: 'Logitech', manufacturer_model: 'M650', price: 30, currency: 'USD' },
      ] } },
      { key: '11st', status: 'completed', value: { site: '11st', candidates: [
        { product_id: 'K185', name: '로지텍 M185 무선 마우스', url: 'https://www.11st.co.kr/products/K185', brand: 'Logitech', manufacturer_model: 'M185', price: 16740, currency: 'KRW' },
      ] } },
    ],
  });
  assert(value.next === 'choose' && value.options.length === 2, 'two model families should remain', value);
  const m185 = value.options.find(option => option.model === 'M185');
  assert(m185?.source_refs?.length === 2, 'M185 option should retain both live source references', m185);
  assert(m185.source_refs.every(source => source.site && source.product_id && source.url), 'every option source must be grounded', m185.source_refs);
  assert(typeof value.options_version === 'string' && value.options_version.length > 4, 'discovery snapshot must be versioned', value);
}]);

tests.push(['product option versions bind source listings and displayed prices', () => {
  withoutNet();
  const build = (productId, price) => lua.call('AX_build_product_options', {
    query: 'Logitech M185 wireless mouse',
    requested_brand: 'Logitech',
    hard_constraints: { color: 'black' },
    results: [{ key: 'walmart', status: 'completed', value: { site: 'walmart', candidates: [{
      product_id: productId,
      name: 'Logitech M185 Wireless Mouse',
      url: `https://www.walmart.com/ip/${productId}`,
      brand: 'Logitech',
      brand_source: 'metadata',
      manufacturer_model: 'M185',
      price,
      currency: 'USD',
    }] } }],
  });
  const before = build('old-product', 10);
  const after = build('new-product', 99);
  assert(before.options_version !== after.options_version, 'source product or displayed price changes must invalidate the option snapshot', { before, after });
}]);

tests.push(['product option resolver rejects stale snapshots and locks only current evidence', () => {
  withoutNet();
  const options = [{
    option_id: 'D1',
    identity_kind: 'standardized_model',
    display_name: 'Logitech M185',
    brand: 'Logitech',
    model: 'M185',
    identity_confidence: 'high',
    source_refs: [{ site: 'walmart', product_id: 'W185', url: 'https://www.walmart.com/ip/W185' }],
  }];
  const stale = lua.call('AX_resolve_product_option', {
    options,
    options_version: 'disc-current',
    choice_options_version: 'disc-old',
    choice_index: 1,
  });
  assert(stale.next === 'invalid' && stale.error === 'stale_product_options', 'stale model choice must fail closed', stale);
  const unversioned = lua.call('AX_resolve_product_option', {
    options,
    options_version: 'disc-current',
    choice_index: 1,
  });
  assert(unversioned.next === 'invalid' && unversioned.error === 'product_options_version_required', 'unversioned model choice must fail closed', unversioned);

  const current = lua.call('AX_resolve_product_option', {
    options,
    options_version: 'disc-current',
    choice_options_version: 'disc-current',
    choice_index: 1,
  });
  assert(current.next === 'lock' && current.identity_status === 'locked', 'current grounded option should lock', current);
  assert(current.identity_id && current.identity_fingerprint, 'locked option should emit stable identity evidence', current);
}]);

tests.push(['offer identity attachment trusts the preceding LLM screening verdict', () => {
  withoutNet();
  const value = lua.call('AX_verify_product_offers', {
    identity_id: 'identity-m185',
    results: [{
      key: 'walmart',
      status: 'completed',
      value: {
        site: 'walmart',
        // This input is already the output of AX_apply_offer_screening. Semantic matching here would
        // overrule the LLM with a second, incompatible code matcher.
        candidates: [
          { product_id: 'W185', name: 'Logitech M185 Wireless Mouse', price: 13, currency: 'USD' },
          { product_id: 'W650', name: 'Logitech M650 Silent Mouse', price: 30, currency: 'USD' },
          { product_id: 'WU', name: 'Logitech Wireless Mouse', price: 9, currency: 'USD' },
        ],
      },
    }],
  });
  assert(value.verified_offers.length === 3, 'every LLM-kept structurally valid offer should be rankable', value);
  assert(value.verified_offers.every((offer) => offer.identity_id === 'identity-m185'),
    'the locked identity is attached without inventing a second semantic verdict', value);
  assert(value.excluded_offers === undefined && value.ambiguous_offers === undefined,
    'the retired code matcher publishes no shadow verdict', value);
}]);

tests.push(['locked model relevance survives localized category labels', () => {
  withoutNet();
  lua.define(`
    function AX_test_normalize_identity(args)
      local candidates = AX_COMMERCE.normalize_candidates("11st", args.candidates, 1, args.query, args)
      return { candidates = candidates }
    end
  `, 'identity normalization probe');
  const value = lua.call('AX_test_normalize_identity', {
    query: 'Logitech G304 mouse',
    identity_brand: 'Logitech',
    identity_model: 'G304',
    brand_aliases: 'Logitech|로지텍',
    product_category: 'mouse',
    candidates: [{
      product_id: 'K304',
      name: '로지텍 G304 LIGHTSPEED 무선마우스',
      price: 50000,
      currency: 'KRW',
      shipping_cost: 0,
      shipping_currency: 'KRW',
    }],
  });
  assert(value.candidates.length === 1, 'exact manufacturer model should outrank untranslated category tokens', value);
}]);

tests.push(['comparison versions and identity approval bind cart mutations to current evidence', () => {
  withoutNet();
  const page = makePage({
    href: 'https://www.ebay.com/itm/327230547159',
    dom: {
      body: [{ text: 'eBay item' }],
      'h1.x-item-title__mainTitle': [{ text: 'Logitech M185 Wireless Mouse' }],
      '#atcBtn_btn_1': [{ text: 'Add to cart' }],
    },
  });
  installRpcStub(lua, page);
  const ranked = lua.call('AX_rank_store_offers', {
    identity_id: 'identity-m185',
    verified_offers: [{ site: 'ebay', product_id: '327230547159', name: 'Logitech M185', price: 20, currency: 'USD', total_base: 20, cost_complete: true, identity_id: 'identity-m185' }],
  });
  assert(ranked.comparison_id && ranked.offers[0].comparison_id === ranked.comparison_id, 'ranked snapshot should carry one comparison version', ranked);

  const stale = lua.call('AX_resolve_store_offer', {
    offers: ranked.offers,
    comparison_id: ranked.comparison_id,
    choice_comparison_id: 'cmp-old',
    identity_id: 'identity-m185',
    choice_index: 1,
    choice_stage: 'asked',
  });
  assert(stale.next === 'invalid' && stale.error === 'stale_comparison', 'stale offer number must fail closed', stale);

  const missingIdentity = lua.call('AX_add_store_product_to_cart', {
    site: 'ebay',
    product_id: '327230547159',
    comparison_id: ranked.comparison_id,
    cart_approval: 'user_selected_compared_offer',
  });
  assert(missingIdentity.error === 'identity_approval_required', 'cart mutation must require locked identity evidence', missingIdentity);
  const rpcMissingIdentity = lua.call('AX_RPC_CART.add_to_cart', {
    site: 'ebay',
    product_id: '327230547159',
    comparison_id: ranked.comparison_id,
    cart_approval: 'user_selected_compared_offer',
  });
  assert(rpcMissingIdentity.error === 'identity_approval_required', 'the RPC cart fails the same gate closed', rpcMissingIdentity);
  assert(clicksOf(page).length === 0, 'identity approval failure must precede navigation and clicks', page.ops);
}]);

let failed = 0;
for (const [name, test] of tests) {
  try {
    test();
    console.log(`ok   - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL - ${name}\n       ${error.message}`);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} tests passed (${assertions} assertions)`);
process.exit(failed ? 1 : 0);
