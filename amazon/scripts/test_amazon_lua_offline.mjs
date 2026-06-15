#!/usr/bin/env bun
// Offline unit tests for the Amazon AXSDK Lua commands.
//
// Runs the real AXSDK Lua runtime against a scripted mock DOM and durable-step
// engine, so command logic (durable replay ordering, the shared login_required
// path, and checkout-screen data extraction) is verified without Chrome, a
// network connection, or an Amazon login.
//
// Requires `bun` (loads the runtime from TypeScript source) and a local
// axsdk-sdk-js checkout. Override its location with AXSDK_SDK_DIR; when the
// runtime cannot be found the suite prints SKIP and exits 0.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const scriptDir = resolve(repoRoot, 'amazon', 'scripts');

const SDK_DIR = process.env.AXSDK_SDK_DIR || resolve(repoRoot, '..', 'axsdk-sdk-js');
const runtimePath = join(SDK_DIR, 'packages', 'axsdk-lua', 'src', 'runtime.ts');
if (!existsSync(runtimePath)) {
  console.log(`SKIP: AXSDK Lua runtime not found at ${runtimePath}.`);
  console.log('Set AXSDK_SDK_DIR to your axsdk-sdk-js checkout to run these offline tests.');
  process.exit(0);
}
const { AXLuaRuntime } = await import(`file://${runtimePath}`);

const LUA_FILES = [
  '00_common.lua',
  'search.lua',
  'view_product.lua',
  'update_product.lua',
  'add_to_cart.lua',
  'view_cart.lua',
  'update_cart.lua',
  'checkout.lua',
];

// Mock pages. `tokens` are substrings that "exist" on the page: a CSS selector
// is considered present when it contains one of the tokens. `text` maps a
// selector to dom.get_text output, `rows` maps a selector to dom.query_all rows.
function makePages() {
  return {
    search: {
      href: 'https://www.amazon.com/s?k=test',
      tokens: ['s-search-result', 's-no-results-result'],
      text: {},
      rows: {},
    },
    product: {
      href: 'https://www.amazon.com/dp/B000000001',
      tokens: ['productTitle', 'centerCol', 'buybox', 'add-to-cart-button'],
      text: {},
      rows: {},
    },
    cartWithItem: {
      href: 'https://www.amazon.com/gp/cart/view.html',
      tokens: ['sc-active-cart', 'sc-list-item', 'sc-subtotal-label', 'proceedToRetailCheckout', 'sc-buy-box-ptc-button'],
      text: { '#nav-cart-count': '1', '#sc-subtotal-amount-activecart .a-offscreen': '$12.34' },
      rows: {
        '.sc-list-item[data-asin]': [{
          asin: 'B000000001', item_id: 'i1', price_attr: '12.34', quantity: '1',
          title: 'Test Item', url: '/dp/B000000001', price_text: '$12.34',
          quantity_text: '1', availability: 'In Stock', variations: [],
        }],
      },
    },
    cartEmpty: {
      href: 'https://www.amazon.com/gp/cart/view.html',
      tokens: ['sc-active-cart', 'sc-empty-cart', 'sc-subtotal-label'],
      text: { '#nav-cart-count': '0' },
      rows: {},
    },
    signin: {
      href: 'https://www.amazon.com/ap/signin?openid.return_to=checkout',
      tokens: ['signIn', 'authportal-main-section', 'ap_email', 'ap_password'],
      text: {},
      rows: {},
    },
    checkout: {
      href: 'https://www.amazon.com/checkout/p/p-1/pay?pipelineType=Chewbacca',
      tokens: ['subtotals', 'deliver-to-customer-text', 'deliver-to-address-text', 'checkout-payment-option-panel', 'submitOrderButtonId', 'placeYourOrder1'],
      text: {
        '#subtotals': 'Use this payment method Items: $12.34 Shipping & handling: $0.00 Estimated tax to be collected: $0.99 Order total: $13.33',
        '#deliver-to-customer-text': 'Delivering to Test User',
        '#deliver-to-address-text': '123 Main St, Springfield, IL, 62704, United States',
        '#checkout-payment-option-panel': 'Payment method Visa ending in 1234, pay $13.33',
      },
      rows: {},
    },
  };
}

// Minimal durable-step engine matching the runtime contract: steps are keyed by
// (kind, input, occurrence); a thrown PENDING unwinds the call and the command
// re-runs from the top, with completed steps replaying their stored result.
function makeHarness({ start, navTo, clickTo }) {
  const pages = makePages();
  const state = { current: start, steps: new Map(), occ: new Map() };
  const opts = v => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  const keyFor = (kind, input) => {
    const base = JSON.stringify({ kind, input });
    const o = state.occ.get(base) ?? 0;
    state.occ.set(base, o + 1);
    return `${base}#${o}`;
  };
  function step(kind, input, execute, mode = 'effect', isReady = () => true) {
    const k = keyFor(kind, input);
    const rec = state.steps.get(k);
    if (rec && rec.status === 'done') return rec.result;
    const result = execute();
    if (mode === 'await' && !isReady(result)) {
      state.steps.set(k, { status: 'pending' });
      throw new Error('PENDING');
    }
    state.steps.set(k, { status: 'done', result });
    if (mode === 'pause') throw new Error('PENDING');
    return result;
  }
  const cur = () => pages[state.current];
  const existsOn = sel => cur().tokens.some(t => sel.includes(t));
  const globals = {
    nav: {
      navigate(url) {
        return step('nav.navigate', { url }, () => {
          const dest = navTo(url, state.current);
          if (state.current === dest) return { ok: true, url };
          state.current = dest;
          return { ok: false, reason: 'navigation_pending' };
        }, 'await', r => r && r.ok === true);
      },
    },
    dom: {
      get_location_href: () => cur().href,
      exists: sel => existsOn(sel),
      wait_for_selector: (sel, o) => step('dom.wait_for_selector', { selector: sel, timeout: opts(o).timeout }, () => existsOn(sel), 'await', r => r === true),
      click: sel => step('dom.click', { selector: sel }, () => {
        const dest = clickTo ? clickTo(sel, state.current) : state.current;
        if (dest && dest !== state.current && existsOn(sel)) { state.current = dest; return true; }
        return existsOn(sel);
      }, 'pause'),
      get_text: sel => (sel in cur().text ? cur().text[sel] : null),
      get_attr: () => null,
      query_all: sel => (cur().rows[sel] ? cur().rows[sel] : []),
    },
  };
  return { globals, state, reset() { state.occ = new Map(); } };
}

async function loadRuntime(globals) {
  const rt = new AXLuaRuntime({ globals, logger: { log() {}, warn() {}, error() {} } });
  for (const file of LUA_FILES) {
    const result = await rt.loadSource(readFileSync(resolve(scriptDir, file), 'utf8'), { id: `amazon/scripts/${file}` });
    if (!result.ok) throw new Error(`failed to load ${file}: ${result.error}`);
  }
  return rt;
}

async function drive(command, args, spec) {
  const h = makeHarness(spec);
  const rt = await loadRuntime(h.globals);
  for (let i = 0; i < 12; i += 1) {
    h.reset();
    const res = await rt.call(command, args);
    if (res.ok) {
      const steps = [...h.state.steps.keys()].map(k => JSON.parse(k.slice(0, k.lastIndexOf('#'))).kind);
      return { value: res.value, steps };
    }
    if (!String(res.error).includes('PENDING')) throw new Error(`${command} errored: ${res.error}`);
  }
  throw new Error(`${command} never settled (still pending after 12 passes)`);
}

let assertions = 0;
function assert(cond, message, ctx) {
  if (!cond) throw new Error(`${message}${ctx !== undefined ? ` :: ${JSON.stringify(ctx)}` : ''}`);
  assertions += 1;
}

const toCart = url => (url.includes('/cart/') ? 'cartWithItem' : 'product');

const tests = [
  ['AX_checkout extracts checkout-screen data when logged in', async () => {
    const { value, steps } = await drive('AX_checkout', {}, { start: 'product', navTo: toCart, clickTo: () => 'checkout' });
    assert(value.status === 'checkout', 'status should be checkout', value);
    assert(value.login_required === false, 'login_required should be false', value);
    assert(value.checkout, 'checkout payload present', value);
    const c = value.checkout;
    assert(c.delivering_to === 'Test User', 'delivering_to parsed from heading', c);
    assert(typeof c.shipping_address === 'string' && c.shipping_address.includes('Springfield'), 'shipping_address read', c);
    assert(typeof c.payment_method === 'string' && c.payment_method.includes('Visa ending in 1234'), 'payment_method read', c);
    const s = c.order_summary;
    assert(s && s.items === '$12.34', 'order_summary.items', s);
    assert(s.shipping_handling === '$0.00', 'order_summary.shipping_handling', s);
    assert(s.estimated_tax === '$0.99', 'order_summary.estimated_tax', s);
    assert(s.order_total === '$13.33', 'order_summary.order_total', s);
    assert(c.place_order_available === true, 'place_order_available', c);
    assert(JSON.stringify(steps) === JSON.stringify(['nav.navigate', 'dom.wait_for_selector', 'dom.click', 'dom.wait_for_selector']), 'durable step order', steps);
  }],
  ['AX_checkout returns login_required when sign-in appears', async () => {
    const { value } = await drive('AX_checkout', {}, { start: 'product', navTo: toCart, clickTo: () => 'signin' });
    assert(value.status === 'login_required', 'status login_required', value);
    assert(value.login_required === true, 'login_required true', value);
  }],
  ['AX_checkout returns cart_empty for an empty cart', async () => {
    const { value, steps } = await drive('AX_checkout', {}, { start: 'product', navTo: () => 'cartEmpty', clickTo: () => 'checkout' });
    assert(value.status === 'cart_empty', 'status cart_empty', value);
    assert(!steps.includes('dom.click'), 'must not click checkout for empty cart', steps);
  }],
  ['AX_view_cart returns login_required on sign-in redirect', async () => {
    const { value } = await drive('AX_view_cart', {}, { start: 'product', navTo: () => 'signin' });
    assert(value.status === 'login_required' && value.login_required === true, 'login_required', value);
  }],
  ['AX_search_product returns login_required on sign-in redirect', async () => {
    const { value } = await drive('AX_search_product', { query: 'x' }, { start: 'product', navTo: () => 'signin' });
    assert(value.status === 'login_required' && value.login_required === true, 'login_required', value);
  }],
  ['AX_view_product returns login_required on sign-in redirect', async () => {
    const { value } = await drive('AX_view_product', { product_id: 'B000000001' }, { start: 'search', navTo: () => 'signin' });
    assert(value.status === 'login_required' && value.login_required === true, 'login_required', value);
  }],
  ['AX_update_cart returns login_required on sign-in redirect', async () => {
    const { value } = await drive('AX_update_cart', { product_id: 'B000000001', quantity: 2 }, { start: 'product', navTo: () => 'signin' });
    assert(value.status === 'login_required' && value.login_required === true, 'login_required', value);
  }],
  ['AX_view_cart returns the cart contents when logged in', async () => {
    const { value } = await drive('AX_view_cart', {}, { start: 'product', navTo: () => 'cartWithItem' });
    assert(value.item_count === 1, 'item_count 1', value);
    assert(value.empty === false, 'cart not empty', value);
    assert(value.login_required === undefined, 'no login_required flag on success', value);
  }],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL - ${name}\n       ${error.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} tests passed (${assertions} assertions)`);
process.exit(failed ? 1 : 0);
