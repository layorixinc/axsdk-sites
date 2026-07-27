#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');
const sdkDir = process.env.AXSDK_SDK_DIR || resolve(repoRoot, '..', 'axsdk-sdk-js');
const runtimePath = join(sdkDir, 'packages', 'axsdk-lua', 'src', 'runtime.ts');
if (!existsSync(runtimePath)) {
  console.log(`SKIP: AXSDK Lua runtime not found at ${runtimePath}`);
  process.exit(0);
}

const { AXLuaRuntime } = await import(`file://${runtimePath}`);
const baseSource = readFileSync(join(repoRoot, '_common', 'scripts', '00_base.lua'), 'utf8');
const commercePath = join(repoRoot, '_common', 'scripts', '50_commerce.lua');
const ebayDir = join(repoRoot, 'ebay', 'scripts');
const amazonDir = join(repoRoot, 'amazon', 'scripts');

let assertions = 0;
function assert(condition, message, context) {
  if (!condition) throw new Error(`${message}${context === undefined ? '' : ` :: ${JSON.stringify(context)}`}`);
  assertions += 1;
}

async function loadRuntime({ globals = {}, files = [], site = 'ebay' } = {}) {
  const runtime = new AXLuaRuntime({ globals, logger: { log() {}, warn() {}, error() {} } });
  const siteDir = site === 'amazon' ? amazonDir : ebayDir;
  const sources = [
    ['_common/scripts/00_base.lua', baseSource],
    ['_common/scripts/50_commerce.lua', readFileSync(commercePath, 'utf8')],
    ...files.map((file) => [`${site}/scripts/${file}`, readFileSync(join(siteDir, file), 'utf8')]),
  ];
  for (const [id, source] of sources) {
    const loaded = await runtime.loadSource(source, { id });
    if (!loaded.ok) throw new Error(`failed to load ${id}: ${loaded.error}`);
  }
  return runtime;
}

function makeGlobals(page = {}) {
  const state = {
    href: page.href || 'https://www.ebay.com/sch/i.html?_nkw=Logitech%20M185',
    clicked: [],
    values: {},
    rows: page.rows || {},
    tokens: page.tokens || [],
    text: page.text || {},
    attrs: page.attrs || {},
    fxCalls: 0,
    fxResponse: page.fxResponse,
    clearTokensOnNavigate: page.clearTokensOnNavigate === true,
    clickAdds: page.clickAdds || [],
  };
  const exists = (selector) => state.tokens.some((token) => selector.includes(token));
  return {
    state,
    globals: {
      nav: {
        navigate(url) {
          state.href = url;
          if (state.clearTokensOnNavigate) state.tokens = [];
          return { fired: true, arrived: true, url };
        },
        clear_beforeunload() { return true; },
      },
      dom: {
        get_location_href() { return state.href; },
        exists,
        wait_for_selector(selector) { return exists(selector); },
        query_all(selector) { return state.rows[selector] || []; },
        get_text(selector) { return state.text[selector] ?? null; },
        get_attr(selector, name) { return state.attrs[`${selector}|${name}`] ?? null; },
        set_value(selector, value) { state.values[selector] = value; return true; },
        click(selector) {
          state.clicked.push(selector);
          if (!exists(selector)) return false;
          for (const token of state.clickAdds) {
            if (!state.tokens.includes(token)) state.tokens.push(token);
          }
          return true;
        },
      },
      net: {
        fetch(url) {
          state.fxCalls += 1;
          if (state.fxResponse === null) return { ok: false, url };
          return state.fxResponse || {
            ok: true,
            json: { base: 'USD', date: '2026-07-14', rates: { KRW: 1000, EUR: 0.8 } },
            url,
          };
        },
      },
    },
  };
}

async function call(runtime, command, args) {
  const result = await runtime.call(command, args);
  if (!result.ok) throw new Error(`${command} failed: ${result.error}`);
  return result.value;
}

const tests = [];
const lockedApproval = {
  identity_id: 'identity-m185',
  comparison_id: 'cmp-current',
  identity_approval: 'locked_product_identity',
  comparison_approval: 'current_comparison',
};

tests.push(['deterministic ranking includes shipping and FX', async () => {
  const runtime = await loadRuntime();
  const value = await call(runtime, 'AX_rank_store_offers', {
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
  assert(value.comparison_text.includes('Reply with a numbered offer to add, or type cancel.'), 'ranked comparison must carry its deterministic approval question', value.comparison_text);
  const presentation = await call(runtime, 'AX_present_store_offers', { comparison_id: value.comparison_id });
  assert(presentation.question === value.comparison_text, 'presentation must read the exact cached comparison instead of model-generated prose', presentation);
  const stalePresentation = await call(runtime, 'AX_present_store_offers', { comparison_id: 'cmp-stale' });
  assert(stalePresentation.error === 'stale_comparison', 'presentation must fail closed for an unknown comparison snapshot', stalePresentation);
}]);

tests.push(['complete cost ranks before lower incomplete estimate', async () => {
  const runtime = await loadRuntime();
  const value = await call(runtime, 'AX_rank_store_offers', {
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

tests.push(['approval resolver accepts only a current integer rank', async () => {
  const runtime = await loadRuntime();
  const offers = [
    { rank: 1, site: 'amazon', product_id: 'A1', name: 'Mouse', price: 20, currency: 'USD', total_base: 20, identity_id: lockedApproval.identity_id, comparison_id: lockedApproval.comparison_id },
  ];
  const unpresented = await call(runtime, 'AX_resolve_store_offer', { offers, choice_index: 1, choice_comparison_id: lockedApproval.comparison_id, ...lockedApproval });
  assert(unpresented.next === 'invalid' && unpresented.error === 'approval_turn_required', 'same-turn product choice cannot approve a cart offer', unpresented);
  const unversioned = await call(runtime, 'AX_resolve_store_offer', { offers, choice_index: 1, choice_stage: 'asked', ...lockedApproval });
  assert(unversioned.next === 'invalid' && unversioned.error === 'comparison_version_required', 'unversioned offer choice must fail closed', unversioned);

  const valid = await call(runtime, 'AX_resolve_store_offer', { offers, choice_index: 1, choice_stage: 'asked', choice_comparison_id: lockedApproval.comparison_id, ...lockedApproval });
  assert(valid.next === 'add' && valid.site === 'amazon' && valid.product_id === 'A1', 'valid rank resolves', valid);
  assert(valid.cart_approval === 'user_selected_compared_offer', 'scoped approval marker emitted', valid);
  const invalid = await call(runtime, 'AX_resolve_store_offer', { offers, choice_index: 2, choice_stage: 'asked', choice_comparison_id: lockedApproval.comparison_id, ...lockedApproval });
  assert(invalid.next === 'invalid', 'out-of-range choice rejected', invalid);
  assert(!invalid.product_id && !invalid.cart_approval, 'invalid choice cannot leak mutation fields', invalid);
}]);

tests.push(['rank cap and all tie-breaks are stable', async () => {
  const runtime = await loadRuntime();
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
  const value = await call(runtime, 'AX_rank_store_offers', {
    results: [{ key: 'amazon', status: 'completed', value: { site: 'amazon', candidates } }],
  });
  assert(value.offers.length === 6, 'approval list must be capped at six', value.offers);
  assert(value.offers[0].product_id === 'A1' && value.offers[1].product_id === 'A2', 'rating, reviews, and lexical id break equal-cost ties', value.offers);
  assert(value.offers.every((offer, index) => offer.rank === index + 1), 'bounded list must be renumbered contiguously', value.offers);
}]);

tests.push(['cart dispatcher rejects missing scoped approval before navigation', async () => {
  const { globals, state } = makeGlobals({ href: 'https://www.ebay.com/itm/327230547159', tokens: ['x-item-title__mainTitle', 'atcBtn_btn_1'] });
  const runtime = await loadRuntime({ globals, files: ['00_common.lua', 'add_to_cart.lua'] });
  const value = await call(runtime, 'AX_add_store_product_to_cart', { site: 'ebay', product_id: '327230547159' });
  assert(value.error === 'approval_required' && value.added === false, 'missing approval marker must fail closed', value);
  assert(state.clicked.length === 0, 'approval failure must occur before any click', state.clicked);
}]);

tests.push(['Amazon ignores the hidden navbar sign-in form', async () => {
  const { globals } = makeGlobals({
    href: 'https://www.amazon.com/',
    tokens: ['form[name=\"signIn\"]', 's-no-results-result'],
  });
  const runtime = await loadRuntime({ globals, site: 'amazon', files: ['00_common.lua', 'search.lua'] });
  const value = await call(runtime, 'AX_search_store_product', { site: 'amazon', query: 'Logitech M185' });
  assert(value.login_required !== true, 'hidden navbar form must not be treated as an auth page', value);
}]);

tests.push(['Amazon existing cart must identify the requested ASIN', async () => {
  const { globals, state } = makeGlobals({
    href: 'https://www.amazon.com/gp/cart/view.html',
    tokens: ['sc-active-cart'],
    clearTokensOnNavigate: true,
  });
  const runtime = await loadRuntime({ globals, site: 'amazon', files: ['00_common.lua', 'add_to_cart.lua'] });
  const value = await call(runtime, 'AX_add_store_product_to_cart', {
    site: 'amazon',
    product_id: 'B004YAVF8I',
    ...lockedApproval,
    cart_approval: 'user_selected_compared_offer',
  });
  assert(value.added !== true, 'an unrelated Amazon cart must not confirm the requested ASIN', value);
  assert(state.clicked.length === 0, 'unrelated Amazon cart evidence must not click from the wrong page', state.clicked);
}]);

tests.push(['eBay parser excludes placeholders and normalizes paid shipping', async () => {
  const rowSelector = '.su-item-card[data-view], .s-item-card[data-view]';
  const { globals, state } = makeGlobals({
    tokens: ['su-item-card', 'srp-river-results'],
    rows: {
      [rowSelector]: [
        { url: 'https://ebay.com/itm/123456', title: 'Shop on eBay', price_text: '$20.00', text: 'Sponsored' },
        { url: 'https://www.ebay.com/itm/327230547159?x=1', title: 'Logitech M185 Wireless Mouse', price_text: 'KRW10,000.00', image_url: 'https://i.ebayimg.test/item.jpg', condition: 'Brand New', attributes_text: 'Buy It Now +Shipping KRW1,000.00 Free returns', seller_text: 'seller 99.8% positive (10K)', text: 'Logitech M185 Wireless Mouse Brand New KRW10,000.00 Buy It Now +Shipping KRW1,000.00 Free returns' },
        { url: 'https://www.ebay.com/itm/327230547158', title: 'Acer Wireless Mouse', price_text: 'KRW5,000.00', attributes_text: 'Free shipping', text: 'Acer Wireless Mouse KRW5,000.00 Free shipping' },
        { url: 'https://www.ebay.com/itm/327230547159?duplicate=1', title: 'Duplicate', price_text: 'KRW9,000.00', text: 'Duplicate' },
      ],
    },
  });
  const runtime = await loadRuntime({ globals, files: ['00_common.lua', 'search.lua'] });
  const value = await call(runtime, 'AX_search_store_product', { site: 'ebay', query: 'Logitech M185', quantity: 1 });
  assert(value.candidates.length === 1, 'placeholder and duplicate excluded', value);
  const candidate = value.candidates[0];
  assert(candidate.product_id === '327230547159', 'item id parsed', candidate);
  assert(candidate.shipping_cost === 1000 && candidate.shipping_currency === 'KRW', 'paid shipping parsed', candidate);
  assert(candidate.total_base === 11 && candidate.cost_complete === true, 'FX landed cost normalized', candidate);
  assert(candidate.return_terms && /return/i.test(candidate.return_terms), 'return evidence retained', candidate);
  assert(state.fxCalls === 1, 'one frozen FX lookup for the result set', state);
}]);

tests.push(['eBay free shipping stays complete after FX normalization', async () => {
  const rowSelector = '.su-item-card[data-view], .s-item-card[data-view]';
  const { globals } = makeGlobals({
    tokens: ['su-item-card', 'srp-river-results'],
    rows: {
      [rowSelector]: [
        { url: 'https://www.ebay.com/itm/327230547160', image_alt: 'Logitech M185 Wireless Mouse', price_text: 'KRW10,000.00', attributes_text: 'Free shipping', text: 'Logitech M185 Wireless Mouse KRW10,000.00 Free shipping' },
      ],
    },
  });
  const runtime = await loadRuntime({ globals, files: ['00_common.lua', 'search.lua'] });
  const value = await call(runtime, 'AX_search_store_product', { site: 'ebay', query: 'Logitech M185' });
  assert(value.candidates[0].shipping_cost === 0, 'free shipping must normalize to zero', value.candidates[0]);
  assert(value.candidates[0].cost_complete === true && value.candidates[0].total_base === 10, 'free shipping offer must have complete landed cost', value.candidates[0]);
}]);

tests.push(['FX failure preserves an explicitly incomplete candidate', async () => {
  const rowSelector = '.su-item-card[data-view], .s-item-card[data-view]';
  const { globals } = makeGlobals({
    tokens: ['su-item-card', 'srp-river-results'],
    fxResponse: null,
    rows: {
      [rowSelector]: [
        { url: 'https://www.ebay.com/itm/327230547161', image_alt: 'Logitech M185 Wireless Mouse', price_text: 'EUR 10.00', attributes_text: 'Free shipping', text: 'Logitech M185 Wireless Mouse EUR 10.00 Free shipping' },
      ],
    },
  });
  const runtime = await loadRuntime({ globals, files: ['00_common.lua', 'search.lua'] });
  const value = await call(runtime, 'AX_search_store_product', { site: 'ebay', query: 'Logitech M185' });
  assert(value.candidates.length === 1 && value.candidates[0].cost_complete === false, 'candidate must remain visible but incomplete', value);
  assert(value.candidates[0].cost_error === 'fx_fetch_failed' && value.candidates[0].total_base == null, 'FX failure must not fabricate a base total', value.candidates[0]);
}]);

tests.push(['eBay cart confirmation must identify the requested item', async () => {
  const { globals, state } = makeGlobals({
    href: 'https://cart.ebay.com/',
    tokens: ['cart-item'],
  });
  const runtime = await loadRuntime({ globals, files: ['00_common.lua', 'add_to_cart.lua'] });
  const value = await call(runtime, 'AX_add_store_product_to_cart', {
    site: 'ebay',
    product_id: '327230547162',
    ...lockedApproval,
    cart_approval: 'user_selected_compared_offer',
  });
  assert(value.added !== true, 'an unrelated existing cart must not confirm the requested product', value);
  assert(state.clicked.length === 0, 'unrelated cart evidence must not trigger an add click from the wrong page', state.clicked);
}]);

tests.push(['eBay localized alternate price can satisfy strict revalidation', async () => {
  const { globals, state } = makeGlobals({
    href: 'https://www.ebay.com/itm/327230547162',
    tokens: ['x-item-title__mainTitle', 'atcBtn_btn_1'],
    clickAdds: ['ADD_TO_CART_CONFIRMATION'],
    text: {
      'h1.x-item-title__mainTitle, h1[data-testid=\"x-item-title\"]': 'Logitech M185 Wireless Mouse',
      '.x-price-primary span, [data-testid=\"x-price-primary\"] span, .x-price-primary': 'EUR 8.00',
      '.x-price-approx__price, .x-price-approx': 'KRW10,000.00',
      "[data-test-id='ADD_TO_CART_CONFIRMATION']": 'Added to cart',
    },
  });
  const runtime = await loadRuntime({ globals, files: ['00_common.lua', 'add_to_cart.lua'] });
  const value = await call(runtime, 'AX_add_store_product_to_cart', {
    site: 'ebay',
    product_id: '327230547162',
    quantity: 1,
    expected_unit_price: 10000,
    expected_currency: 'KRW',
    ...lockedApproval,
    cart_approval: 'user_selected_compared_offer',
  });
  assert(value.added === true && value.error == null, 'matching localized alternate price should permit the guarded click', value);
  assert(state.clicked.length === 1, 'successful guarded add should click exactly once', state.clicked);
}]);

tests.push(['eBay stale price precondition blocks cart click', async () => {
  const { globals, state } = makeGlobals({
    href: 'https://www.ebay.com/itm/327230547159',
    tokens: ['x-item-title__mainTitle', 'atcBtn_btn_1'],
    text: {
      'h1.x-item-title__mainTitle, h1[data-testid="x-item-title"]': 'Logitech M185 Wireless Mouse',
      '.x-price-primary span, [data-testid="x-price-primary"] span, .x-price-primary': '$21.00',
    },
  });
  const runtime = await loadRuntime({ globals, files: ['00_common.lua', 'add_to_cart.lua'] });
  const value = await call(runtime, 'AX_add_to_cart', {
    product_id: '327230547159',
    quantity: 1,
    expected_unit_price: 20,
    expected_currency: 'USD',
  });
  assert(value.error === 'price_changed' && value.added === false, 'stale price rejected', value);
  assert(state.clicked.length === 0, 'stale price must not click', state.clicked);
}]);

tests.push(['identity preparation discovers broad products and locks explicit models', async () => {
  const runtime = await loadRuntime();
  const broad = await call(runtime, 'AX_prepare_product_identity', {
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

  const exact = await call(runtime, 'AX_prepare_product_identity', {
    product_category: 'wireless mouse',
    requested_brand: 'Logitech',
    requested_model: 'M185',
  });
  assert(exact.next === 'lock' && exact.identity_status === 'exact', 'explicit model should skip discovery', exact);

  const missing = await call(runtime, 'AX_prepare_product_identity', {});
  assert(missing.next === 'ask_scope' && missing.identity_status === 'missing', 'missing category should ask before searching', missing);
}]);

tests.push(['identity fingerprints are canonical for nested and localized constraints', async () => {
  const runtime = await loadRuntime();
  const first = await call(runtime, 'AX_lock_product_identity', {
    identity_kind: 'standardized_model',
    identity_brand: '로지텍',
    identity_model: 'G304',
    product_category: '무선 마우스',
    hard_constraints: {
      color: 'black',
      connectivity: { receiver: 'USB', wireless: true },
    },
  });
  const second = await call(runtime, 'AX_lock_product_identity', {
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

tests.push(['common dispatcher waits for the target site adapter without reloading the same host', async () => {
  const { globals, state } = makeGlobals({ href: 'https://www.11st.co.kr/' });
  const runtime = await loadRuntime({ globals });
  const value = await call(runtime, 'AX_search_store_product', {
    site: '11st',
    query: 'Logitech M185',
  });
  assert(value.pending === true && value.status === 'loading_adapter', 'site-script registration race must be retryable', value);
  assert(state.href === 'https://www.11st.co.kr/', 'adapter loading on the target host must not reload the page', state);
}]);

tests.push(['site search results are normalized after adapter-ready dispatch', async () => {
  const { globals } = makeGlobals();
  const runtime = await loadRuntime({ globals });
  const value = await call(runtime, 'AX_normalize_store_product_result', {
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
  const navigation = await call(runtime, 'AX_normalize_store_product_result', {
    site: '11st',
    query: '로지텍 무선 마우스',
    result: { ok: true, fired: true, arrived: true, kind: 'document', navigated: true, url: 'https://search.11st.co.kr/' },
  });
  assert(navigation.pending === true && navigation.status === 'navigating', 'a durable navigation envelope must be retried before normalization', navigation);
}]);

tests.push(['localized discovery rejects unrelated listings and preserves observed provenance', async () => {
  const { globals } = makeGlobals({ href: 'https://review.example/' });
  const runtime = await loadRuntime({ globals });
  const loaded = await runtime.loadSource(`
    AX_COMMERCE.register_adapter("review-store", {
      host_matches = function() return true end,
      search = function()
        return { candidates = {
          { product_id = "bad", name = "Generic K123 Keyboard", price = 10, currency = "USD", shipping_cost = 0, shipping_currency = "USD", url = "https://review.example/bad" },
          { product_id = "good", name = "로지텍 G304 무선 마우스", price = 20, currency = "USD", shipping_cost = 0, shipping_currency = "USD", url = "https://review.example/good" }
        } }
      end
    })
  `, { id: 'test-localized-discovery' });
  if (!loaded.ok) throw new Error(`failed to load localized discovery probe: ${loaded.error}`);

  const result = await call(runtime, 'AX_search_store_product', {
    site: 'review-store',
    query: '로지텍 무선 마우스',
    requested_brand: '로지텍',
    purpose: 'discovery',
  });
  assert(result.candidates.length === 1 && result.candidates[0].product_id === 'good', 'Korean discovery must reject unrelated product categories', result);
  assert(result.candidates[0].brand === '로지텍' && result.candidates[0].brand_source === 'title', 'requested brand may become observed only when the title proves it', result.candidates[0]);

  const options = await call(runtime, 'AX_build_product_options', {
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

tests.push(['discovery options group grounded model evidence without merging variants', async () => {
  const runtime = await loadRuntime();
  const value = await call(runtime, 'AX_build_product_options', {
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

tests.push(['product option versions bind source listings and displayed prices', async () => {
  const runtime = await loadRuntime();
  const build = (productId, price) => call(runtime, 'AX_build_product_options', {
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
  const before = await build('old-product', 10);
  const after = await build('new-product', 99);
  assert(before.options_version !== after.options_version, 'source product or displayed price changes must invalidate the option snapshot', { before, after });
}]);

tests.push(['product option resolver rejects stale snapshots and locks only current evidence', async () => {
  const runtime = await loadRuntime();
  const options = [{
    option_id: 'D1',
    identity_kind: 'standardized_model',
    display_name: 'Logitech M185',
    brand: 'Logitech',
    model: 'M185',
    identity_confidence: 'high',
    source_refs: [{ site: 'walmart', product_id: 'W185', url: 'https://www.walmart.com/ip/W185' }],
  }];
  const stale = await call(runtime, 'AX_resolve_product_option', {
    options,
    options_version: 'disc-current',
    choice_options_version: 'disc-old',
    choice_index: 1,
  });
  assert(stale.next === 'invalid' && stale.error === 'stale_product_options', 'stale model choice must fail closed', stale);
  const unversioned = await call(runtime, 'AX_resolve_product_option', {
    options,
    options_version: 'disc-current',
    choice_index: 1,
  });
  assert(unversioned.next === 'invalid' && unversioned.error === 'product_options_version_required', 'unversioned model choice must fail closed', unversioned);

  const current = await call(runtime, 'AX_resolve_product_option', {
    options,
    options_version: 'disc-current',
    choice_options_version: 'disc-current',
    choice_index: 1,
  });
  assert(current.next === 'lock' && current.identity_status === 'locked', 'current grounded option should lock', current);
  assert(current.identity_id && current.identity_fingerprint, 'locked option should emit stable identity evidence', current);
}]);

tests.push(['offer identity verification excludes mismatches and preserves ambiguity', async () => {
  const runtime = await loadRuntime();
  const value = await call(runtime, 'AX_verify_product_offers', {
    identity_id: 'identity-m185',
    identity_kind: 'standardized_model',
    identity_brand: 'Logitech',
    identity_model: 'M185',
    results: [{
      key: 'walmart',
      status: 'completed',
      value: {
        site: 'walmart',
        candidates: [
          { product_id: 'W185', name: 'Logitech M185 Wireless Mouse', price: 13, currency: 'USD', brand: 'Logitech', manufacturer_model: 'M185' },
          { product_id: 'W650', name: 'Logitech M650 Silent Mouse', price: 30, currency: 'USD', brand: 'Logitech', manufacturer_model: 'M650' },
          { product_id: 'WU', name: 'Logitech Wireless Mouse', price: 9, currency: 'USD', brand: 'Logitech' },
        ],
      },
    }],
  });
  assert(value.verified_offers.length === 1 && value.verified_offers[0].product_id === 'W185', 'only exact model should be rankable', value);
  assert(value.excluded_offers.length === 1 && value.excluded_offers[0].reason === 'model_mismatch', 'different model should be excluded with evidence', value);
  assert(value.ambiguous_offers.length === 1 && value.ambiguous_offers[0].reason === 'manufacturer_model_missing', 'missing model should remain visible but unranked', value);
}]);

tests.push(['locked model relevance survives localized category labels', async () => {
  const runtime = await loadRuntime();
  const loaded = await runtime.loadSource(`
    function AX_test_normalize_identity(args)
      local candidates = AX_COMMERCE.normalize_candidates("11st", args.candidates, 1, args.query, args)
      return { candidates = candidates }
    end
  `, { id: 'test-normalize-identity' });
  if (!loaded.ok) throw new Error(`failed to load identity normalization probe: ${loaded.error}`);
  const value = await call(runtime, 'AX_test_normalize_identity', {
    query: 'Logitech G304 mouse',
    identity_brand: 'Logitech',
    identity_model: 'G304',
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

tests.push(['comparison versions and identity approval bind cart mutations to current evidence', async () => {
  const { globals, state } = makeGlobals({ href: 'https://www.ebay.com/itm/327230547159', tokens: ['x-item-title__mainTitle', 'atcBtn_btn_1'] });
  const runtime = await loadRuntime({ globals, files: ['00_common.lua', 'add_to_cart.lua'] });
  const ranked = await call(runtime, 'AX_rank_store_offers', {
    identity_id: 'identity-m185',
    verified_offers: [{ site: 'ebay', product_id: '327230547159', name: 'Logitech M185', price: 20, currency: 'USD', total_base: 20, cost_complete: true, identity_id: 'identity-m185', identity_match: 'exact' }],
  });
  assert(ranked.comparison_id && ranked.offers[0].comparison_id === ranked.comparison_id, 'ranked snapshot should carry one comparison version', ranked);

  const stale = await call(runtime, 'AX_resolve_store_offer', {
    offers: ranked.offers,
    comparison_id: ranked.comparison_id,
    choice_comparison_id: 'cmp-old',
    identity_id: 'identity-m185',
    choice_index: 1,
    choice_stage: 'asked',
  });
  assert(stale.next === 'invalid' && stale.error === 'stale_comparison', 'stale offer number must fail closed', stale);

  const missingIdentity = await call(runtime, 'AX_add_store_product_to_cart', {
    site: 'ebay',
    product_id: '327230547159',
    comparison_id: ranked.comparison_id,
    cart_approval: 'user_selected_compared_offer',
  });
  assert(missingIdentity.error === 'identity_approval_required', 'cart mutation must require locked identity evidence', missingIdentity);
  assert(state.clicked.length === 0, 'identity approval failure must precede navigation and clicks', state.clicked);
}]);

let failed = 0;
for (const [name, test] of tests) {
  try {
    await test();
    console.log(`ok   - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL - ${name}\n       ${error.message}`);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} tests passed (${assertions} assertions)`);
process.exit(failed ? 1 : 0);
