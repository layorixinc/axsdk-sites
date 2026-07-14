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
    { rank: 1, site: 'amazon', product_id: 'A1', name: 'Mouse', price: 20, currency: 'USD', total_base: 20 },
  ];
  const valid = await call(runtime, 'AX_resolve_store_offer', { offers, choice_index: 1 });
  assert(valid.next === 'add' && valid.site === 'amazon' && valid.product_id === 'A1', 'valid rank resolves', valid);
  assert(valid.cart_approval === 'user_selected_compared_offer', 'scoped approval marker emitted', valid);
  const invalid = await call(runtime, 'AX_resolve_store_offer', { offers, choice_index: 2 });
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
