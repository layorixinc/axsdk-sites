#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const scriptDir = resolve(repoRoot, 'amazon', 'scripts');

export const DEFAULT_EXTENSION_ID = 'dldlgmekahifbogjphgglkhibclglmpf';
const DEFAULT_CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEFAULT_PROFILE = process.env.CHROME_PROFILE || `${process.env.LOCALAPPDATA || ''}/AXSDKSitesChromeDevProfile`;
const DEFAULT_PORT = Number(process.env.CDP_PORT || 9223);
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

let luaContextDirty = true;
const __t0 = Date.now();
const el = () => ((Date.now() - __t0) / 1000).toFixed(1);

function parseArgs(argv) {
  const options = {
    cdp: process.env.CDP_URL || null,
    port: DEFAULT_PORT,
    chrome: DEFAULT_CHROME,
    profile: DEFAULT_PROFILE,
    extensionId: process.env.AXSDK_EXTENSION_ID || DEFAULT_EXTENSION_ID,
    query: 'wireless mouse',
    productId: 'B006CQ1ZHI',
    mutateCart: false,
    keepOpen: false,
    deleteCartProductId: null,
    checkout: false,
    checkoutOnly: false,
  };

  for (const arg of argv) {
    if (arg === '--mutate-cart') options.mutateCart = true;
    else if (arg === '--checkout') options.checkout = true;
    else if (arg === '--checkout-only') { options.checkout = true; options.checkoutOnly = true; }
    else if (arg === '--keep-open') options.keepOpen = true;
    else if (arg.startsWith('--cdp=')) options.cdp = arg.slice('--cdp='.length);
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice('--port='.length));
    else if (arg.startsWith('--chrome=')) options.chrome = arg.slice('--chrome='.length);
    else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length);
    else if (arg.startsWith('--extension-id=')) options.extensionId = arg.slice('--extension-id='.length);
    else if (arg.startsWith('--query=')) options.query = arg.slice('--query='.length);
    else if (arg.startsWith('--product-id=')) options.productId = arg.slice('--product-id='.length);
    else if (arg.startsWith('--delete-cart-product-id=')) options.deleteCartProductId = arg.slice('--delete-cart-product-id='.length);
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.cdp) options.cdp = `http://127.0.0.1:${options.port}`;
  return options;
}

function printHelp() {
  console.log(`Usage: node amazon/scripts/test_amazon_lua.mjs [options]

Options:
  --cdp=http://127.0.0.1:9223   Connect to an existing Chrome CDP endpoint.
  --port=9223                   CDP port when launching Chrome.
  --chrome=PATH                 Chrome executable path.
  --profile=PATH                Chrome user-data-dir with AXSDK extension installed.
  --extension-id=ID             AXSDK Assistant extension id.
  --query=TEXT                  Search query. Default: wireless mouse.
  --product-id=ASIN             Product used for view/update/add tests. Default: B006CQ1ZHI.
  --mutate-cart                 Also run AX_add_to_cart. This changes the real cart.
  --checkout                    Also run AX_checkout after the suite (proceeds to checkout; no order is placed).
  --checkout-only               Run only AX_checkout (skips the rest of the suite).
  --delete-cart-product-id=ASIN   Also test AX_update_cart deletion by setting this cart item quantity to 0.
  --keep-open                   Leave Chrome running when this script launched it.
`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} from ${url}`);
  return response.json();
}

async function endpointIsReady(cdpUrl) {
  try {
    await fetchJson(`${cdpUrl}/json/version`);
    return true;
  } catch {
    return false;
  }
}

async function waitForEndpoint(cdpUrl, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await endpointIsReady(cdpUrl)) return;
    await sleep(250);
  }
  throw new Error(`Chrome CDP endpoint did not become ready: ${cdpUrl}`);
}

function launchChrome(options) {
  const args = [
    `--remote-debugging-port=${options.port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${options.profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
    'about:blank',
  ];
  return spawn(options.chrome, args, { stdio: 'ignore', detached: false });
}

async function createTarget(cdpUrl, url) {
  const encoded = encodeURIComponent(url);
  try {
    return await fetchJson(`${cdpUrl}/json/new?${encoded}`, { method: 'PUT' });
  } catch {
    return fetchJson(`${cdpUrl}/json/new?${encoded}`);
  }
}

class CdpClient {
  constructor(webSocketDebuggerUrl) {
    if (!globalThis.WebSocket) {
      throw new Error('This runner requires Node.js with global WebSocket support. Use Node 22+ or pass a Playwright/Puppeteer-based harness instead.');
    }

    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket = new WebSocket(webSocketDebuggerUrl);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', event => this.onMessage(event));
  }

  onMessage(event) {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const callback = this.pending.get(message.id);
      if (!callback) return;
      this.pending.delete(message.id);
      if (message.error) callback.reject(new Error(`${message.error.message}: ${JSON.stringify(message.error.data || {})}`));
      else callback.resolve(message.result || {});
      return;
    }

    const listeners = this.listeners.get(message.method);
    if (!listeners) return;
    for (const listener of [...listeners]) listener(message.params || {});
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(payload);
    return promise;
  }

  waitFor(method, predicate = () => true, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        off();
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const off = this.on(method, params => {
        if (!predicate(params)) return;
        clearTimeout(timeout);
        off();
        resolve(params);
      });
    });
  }

  close() {
    this.socket.close();
  }
}

export async function openPage(cdpUrl, initialUrl) {
  const target = await createTarget(cdpUrl, 'about:blank');
  const page = new CdpClient(target.webSocketDebuggerUrl);
  await page.ready;
  await page.send('Page.enable');
  page.on('Page.javascriptDialogOpening', () => {
    page.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => null);
  });
  await page.send('Runtime.enable');
  await navigate(page, initialUrl);
  await page.send('Page.bringToFront').catch(() => null);
  return page;
}

async function navigate(page, url) {
  const loaded = page.waitFor('Page.loadEventFired', () => true, 30000).catch(() => null);
  await page.send('Page.navigate', { url });
  await loaded;
  await sleep(1000);
  luaContextDirty = true;
}

async function findAxContext(page, extensionId, timeoutMs = 15000) {
  const contexts = [];
  const off = page.on('Runtime.executionContextCreated', event => contexts.push(event.context));
  await page.send('Runtime.disable').catch(() => null);
  await page.send('Runtime.enable');

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const context = contexts.find(c => c.name === 'AXSDK Assistant' && c.origin === `chrome-extension://${extensionId}`);
    if (context) {
      off();
      return context;
    }
    await sleep(100);
  }

  off();
  throw new Error(`AXSDK Assistant execution context not found for extension ${extensionId}. Is the extension installed and enabled in this Chrome profile?`);
}

async function callInAxContext(page, extensionId, functionDeclaration, args = []) {
  const context = await findAxContext(page, extensionId);
  const result = await page.send('Runtime.callFunctionOn', {
    functionDeclaration,
    arguments: args.map(value => ({ value })),
    executionContextId: context.id,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
  }
  return result.result?.value;
}

export async function waitForLuaRuntime(page, options, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const status = await callInAxContext(page, options.extensionId, `function() {
        const lua = globalThis._AXSDK?.lua || globalThis._AXLUA;
        return {
          available: Boolean(lua),
          hasRun: typeof lua?.run === 'function' || typeof lua?.call === 'function',
          hasLoad: typeof lua?.load === 'function' || typeof lua?.loadSiteScript === 'function'
        };
      }`);
      if (status?.available && status?.hasRun && status?.hasLoad) return status;
      last = status;
    } catch (error) {
      last = String(error?.message || error);
    }
    await sleep(500);
  }
  throw new Error(`AX Lua runtime is not available after wait: ${JSON.stringify(last)}`);
}

async function loadLuaFiles(page, options) {
  // Durable navigations re-init the AXSDK runtime on the new page, so the scripts must be reloaded
  // after every navigating command. Skip the reload when the context is still clean.
  if (!luaContextDirty) return;
  let lastError = null;
  // A late resource can reset the context mid-load, leaving a later file loaded before 00_common.
  // Retry the whole ordered load once on failure.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await waitForLuaRuntime(page, options);
    try {
      for (const file of LUA_FILES) {
        const source = await readFile(resolve(scriptDir, file), 'utf8');
        const result = await callInAxContext(page, options.extensionId, `async function(source, id) {
          const lua = globalThis._AXSDK?.lua || globalThis._AXLUA;
          if (!lua) throw new Error('AX Lua runtime is not available');
          if (typeof lua.load === 'function') return await lua.load(source, { id });
          return await lua.loadSiteScript(source, { id, replace: true, kind: 'devtools' });
        }`, [source, `amazon-test-${file}-${Date.now()}`]);
        if (!result?.ok && result?.status !== 'loaded') throw new Error(`Failed to load ${file}: ${JSON.stringify(result)}`);
      }
      luaContextDirty = false;
      return;
    } catch (error) {
      lastError = error;
      await sleep(700);
    }
  }
  throw lastError;
}

async function callInAxContextCmd(page, options, command, args) {
  // Durable command path: lua.run suspends/resumes across the navigation (full page reload) the
  // command triggers, and returns the settled result. lua.call (legacy) is a single non-durable turn
  // that never waits for navigation, so prefer lua.run whenever it exists.
  return callInAxContext(page, options.extensionId, `async function(command, args) {
    const lua = globalThis._AXSDK?.lua || globalThis._AXLUA;
    if (!lua) throw new Error('AX Lua runtime is not available');
    if (typeof lua.run === 'function') {
      const result = await lua.run(command, args, { timeoutMs: 30000, timeout: 30000 });
      let value = null;
      if (result?.result) {
        try { value = JSON.parse(result.result); } catch { value = result.result; }
      }
      return {
        ok: result?.status === 'completed',
        status: result?.status,
        deferId: result?.deferId,
        value,
        error: result?.error || (value && value.error)
      };
    }
    return await lua.call(command, args);
  }`, [command, args]);
}

async function callLua(page, options, command, args) {
  await loadLuaFiles(page, options);
  const ret = await callInAxContextCmd(page, options, command, args);
  // Every Amazon command navigates (search / product / cart / checkout pages), re-initializing the
  // AXSDK runtime on the new page; mark the context dirty so the next call reloads the scripts.
  luaContextDirty = true;
  return ret;
}

function isContextLostError(error) {
  const message = String(error?.message || error || '');
  return message.includes('Cannot find context with specified id')
    || message.includes('Execution context was destroyed')
    || message.includes('Cannot find execution context')
    || message.includes('Inspected target navigated')
    || message.includes('Target closed');
}

function isPendingResult(result) {
  return result?.status === 'pending'
    || (result?.ok === false && result?.reason === 'pending')
    || result?.value?.pending === true
    || result?.value?.error === 'navigation_pending'
    || result?.value?.error === 'pending';
}

function isResumeFailure(result) {
  // A durable call can fail to resume after a redundant same-page navigation reloaded the runtime (the
  // deferred handler/command is briefly unavailable on the freshly-loaded page). Retrying with reloaded
  // scripts on the now-settled page recovers, so treat it like a pending result and retry.
  const detail = typeof result?.value === 'string' ? result.value : (result?.value?.error || result?.error || '');
  return /cannot resume|command unavailable|handler code changed/i.test(String(detail));
}

async function waitForSettle(page) {
  // Lua tools wait for their own readiness selectors; a brief settle is enough between durable retries.
  await sleep(400);
}

export async function callLuaSettled(page, options, command, args, maxAttempts = 5) {
  const started = Date.now();
  let last = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      last = await callLua(page, options, command, args);
      if (isResumeFailure(last)) luaContextDirty = true; // deferred could not resume -> reload + retry
      else if (!isPendingResult(last)) break;
    } catch (error) {
      if (!isContextLostError(error)) throw error;
      luaContextDirty = true; // context gone -> force a reload on retry
      last = { ok: false, reason: 'context_lost', error: String(error.message || error) };
    }
    await waitForSettle(page);
  }
  const ms = Date.now() - started;
  if (last) last.ms = ms;
  console.log(`  [${el()}s] · ${command} ${ms}ms${ms > 3000 ? '  [SLOW >3s]' : ''}`);
  return last;
}

function assertCondition(condition, message, details) {
  if (condition) return;
  const suffix = details === undefined ? '' : `\n${JSON.stringify(details, null, 2)}`;
  throw new Error(`${message}${suffix}`);
}

function compactProduct(product) {
  return {
    product_id: product?.product_id,
    title: product?.title,
    price_text: product?.price_text,
    variations: product?.variations?.length,
    form_controls: product?.form?.controls?.length,
  };
}

const CHECKOUT_STATUSES = ['login_required', 'checkout', 'cart_empty', 'checkout_unavailable', 'checkout_pending'];

async function runCheckout(page, options, summary) {
  console.log('Testing AX_checkout. This navigates to the cart and proceeds to checkout; it does not place an order.');
  const checkout = await callLuaSettled(page, options, 'AX_checkout', {}, 6);
  assertCondition(checkout?.ok, 'AX_checkout call failed', checkout);
  assertCondition(checkout.value?.pending !== true, 'AX_checkout is still pending', checkout.value);
  assertCondition(CHECKOUT_STATUSES.includes(checkout.value?.status), 'AX_checkout returned an unexpected status', checkout.value);
  summary.checkout = {
    status: checkout.value.status,
    login_required: checkout.value.login_required === true,
    item_count: checkout.value.item_count,
    url: checkout.value.url,
  };
  if (checkout.value.checkout) {
    const c = checkout.value.checkout;
    summary.checkout.data = {
      delivering_to: c.delivering_to,
      has_shipping_address: typeof c.shipping_address === 'string' && c.shipping_address.length > 0,
      has_payment_method: typeof c.payment_method === 'string' && c.payment_method.length > 0,
      order_summary: c.order_summary,
      place_order_available: c.place_order_available,
    };
  }
  return summary;
}

async function runTests(page, options) {
  const summary = {};

  if (options.checkoutOnly) return runCheckout(page, options, summary);

  console.log(`Testing AX_search_product query=${JSON.stringify(options.query)}`);
  let search = await callLuaSettled(page, options, 'AX_search_product', { query: options.query }, 5);
  for (let attempt = 0; attempt < 3 && !(search?.ok && (search.value?.candidates?.length || 0) > 0); attempt += 1) {
    await sleep(800);
    search = await callLuaSettled(page, options, 'AX_search_product', { query: options.query }, 5);
  }
  assertCondition(search?.ok, 'AX_search_product call failed', search);
  assertCondition((search.value?.candidates?.length || 0) > 0, 'AX_search_product returned no candidates', search.value);
  summary.search = {
    count: search.value.candidates.length,
    total_count: search.value.total_count,
    cursor: Boolean(search.value.cursor),
    first_product_id: search.value.candidates[0]?.product_id,
  };

  console.log(`Testing AX_view_product product_id=${options.productId}`);
  const view = await callLuaSettled(page, options, 'AX_view_product', { product_id: options.productId });
  assertCondition(view?.ok, 'AX_view_product call failed', view);
  assertCondition(Boolean(view.value?.title), 'AX_view_product returned no title', view.value);
  summary.view_product = compactProduct(view.value);

  console.log('Testing AX_update_product with generic variation/form input');
  const update = await callLuaSettled(page, options, 'AX_update_product', {
    product_id: options.productId,
    variations: { size_name: '16 Oz (Pack of 1)' },
    form_values: { quantity: '1' },
  });
  assertCondition(update?.ok, 'AX_update_product call failed', update);
  assertCondition(update.value?.pending !== true, 'AX_update_product is still pending', update.value);
  summary.update_product = {
    product_id: update.value?.product_id,
    applied: update.value?.applied,
    product: compactProduct(update.value?.product),
  };

  if (options.mutateCart) {
    console.log('Testing AX_add_to_cart. This mutates the real Amazon cart.');
    const add = await callLuaSettled(page, options, 'AX_add_to_cart', {
      product_id: options.productId,
      quantity: '1',
    });
    assertCondition(add?.ok, 'AX_add_to_cart call failed', add);
    assertCondition(add.value?.added === true || add.value?.pending === true, 'AX_add_to_cart did not report add/pending', add.value);
    summary.add_to_cart = add.value;
  } else {
    summary.add_to_cart = 'skipped; pass --mutate-cart to run this cart-changing test';
  }

  console.log('Testing AX_view_cart');
  const cart = await callLuaSettled(page, options, 'AX_view_cart', {});
  assertCondition(cart?.ok, 'AX_view_cart call failed', cart);
  assertCondition(Array.isArray(cart.value?.items), 'AX_view_cart did not return items array', cart.value);
  summary.view_cart = {
    item_count: cart.value.item_count,
    subtotal_text: cart.value.subtotal_text,
    items: cart.value.items.slice(0, 5).map(item => ({
      product_id: item.product_id,
      title: item.title,
      quantity: item.quantity,
      price_text: item.price_text,
      variations: item.variations,
    })),
  };

  const updateCartTarget = cart.value.items.find(item => item.product_id && item.quantity > 0);
  if (updateCartTarget) {
    console.log(`Testing AX_update_cart product_id=${updateCartTarget.product_id} quantity=${updateCartTarget.quantity}`);
    const updateCart = await callLuaSettled(page, options, 'AX_update_cart', {
      product_id: updateCartTarget.product_id,
      quantity: String(updateCartTarget.quantity),
    });
    assertCondition(updateCart?.ok, 'AX_update_cart call failed', updateCart);
    assertCondition(updateCart.value?.ok === true, 'AX_update_cart did not report success', updateCart.value);
    assertCondition(updateCart.value?.after?.quantity === updateCartTarget.quantity, 'AX_update_cart quantity mismatch', updateCart.value);
    summary.update_cart = {
      product_id: updateCartTarget.product_id,
      requested_quantity: updateCart.value.requested_quantity,
      reason: updateCart.value.reason,
      after_quantity: updateCart.value.after?.quantity,
    };
  } else {
    summary.update_cart = 'skipped; cart is empty';
  }

  if (options.deleteCartProductId) {
    console.log(`Testing AX_update_cart delete product_id=${options.deleteCartProductId}`);
    const deleteCart = await callLuaSettled(page, options, 'AX_update_cart', {
      product_id: options.deleteCartProductId,
      quantity: '0',
    });
    assertCondition(deleteCart?.ok, 'AX_update_cart delete call failed', deleteCart);
    assertCondition(deleteCart.value?.ok === true, 'AX_update_cart delete did not report success', deleteCart.value);
    assertCondition(deleteCart.value?.pending !== true, 'AX_update_cart delete is still pending', deleteCart.value);
    assertCondition(deleteCart.value?.reason === 'deleted' || deleteCart.value?.reason === 'already_absent', 'AX_update_cart delete did not finish deletion', deleteCart.value);
    summary.update_cart_delete = {
      product_id: options.deleteCartProductId,
      reason: deleteCart.value.reason,
      item_count: deleteCart.value.cart?.item_count,
    };
  } else {
    summary.update_cart_delete = 'skipped; pass --delete-cart-product-id=ASIN to delete a cart item';
  }

  if (options.checkout) await runCheckout(page, options, summary);
  else summary.checkout = 'skipped; pass --checkout to run the checkout flow';

  return summary;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let chrome = null;
  let launched = false;

  if (!(await endpointIsReady(options.cdp))) {
    console.log(`Launching Chrome: ${options.chrome}`);
    chrome = launchChrome(options);
    launched = true;
    await waitForEndpoint(options.cdp);
  }

  const page = await openPage(options.cdp, 'https://www.amazon.com/');
  try {
    const summary = await runTests(page, options);
    console.log('\nPASS');
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    page.close();
    if (chrome && launched && !options.keepOpen) chrome.kill();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error('\nFAIL');
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}
