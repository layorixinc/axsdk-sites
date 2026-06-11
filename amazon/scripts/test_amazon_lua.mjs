#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const scriptDir = resolve(repoRoot, 'amazon', 'scripts');

const DEFAULT_EXTENSION_ID = 'dldlgmekahifbogjphgglkhibclglmpf';
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
];

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
  };

  for (const arg of argv) {
    if (arg === '--mutate-cart') options.mutateCart = true;
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

async function openPage(cdpUrl, initialUrl) {
  const target = await createTarget(cdpUrl, 'about:blank');
  const page = new CdpClient(target.webSocketDebuggerUrl);
  await page.ready;
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await navigate(page, initialUrl);
  return page;
}

async function navigate(page, url) {
  const loaded = page.waitFor('Page.loadEventFired', () => true, 30000).catch(() => null);
  await page.send('Page.navigate', { url });
  await loaded;
  await sleep(1000);
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

async function loadLuaFiles(page, options) {
  for (const file of LUA_FILES) {
    const source = await readFile(resolve(scriptDir, file), 'utf8');
    const id = `amazon-test-${file}-${Date.now()}`;
    const result = await callInAxContext(
      page,
      options.extensionId,
      'async function(source, id) { return await _AXLUA.load(source, { id }); }',
      [source, id],
    );
    if (!result?.ok) throw new Error(`Failed to load ${file}: ${JSON.stringify(result)}`);
  }
}

async function callLua(page, options, command, args) {
  await loadLuaFiles(page, options);
  return callInAxContext(
    page,
    options.extensionId,
    'async function(command, args) { return await _AXLUA.call(command, args); }',
    [command, args],
  );
}

function needsReplay(result) {
  const value = result?.value;
  return value?.error === 'navigation_pending' || (value?.pending === true && value?.error === 'navigation_pending');
}

function isContextLostError(error) {
  const message = String(error?.message || error || '');
  return message.includes('Cannot find context with specified id')
    || message.includes('Execution context was destroyed')
    || message.includes('Cannot find execution context')
    || message.includes('Inspected target navigated')
    || message.includes('Target closed');
}

async function waitForNavigationOrSettle(page) {
  await page.waitFor('Page.loadEventFired', () => true, 30000).catch(() => null);
  await sleep(2000);
}

async function callLuaWithNavigationReplay(page, options, command, args) {
  let lastResult = null;
  let lastContextError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await callLua(page, options, command, args);
      if (!needsReplay(result)) return result;
      lastResult = result;
    } catch (error) {
      if (!isContextLostError(error)) throw error;
      lastContextError = error;
    }

    await waitForNavigationOrSettle(page);
  }

  if (lastResult) return lastResult;
  throw lastContextError || new Error(`Failed to call ${command} after navigation replay`);
}

async function callLuaUntilNotPending(page, options, command, args) {
  let result = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    result = await callLuaWithNavigationReplay(page, options, command, args);
    if (result?.value?.pending !== true) return result;
    await waitForNavigationOrSettle(page);
  }
  return result;
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

async function runTests(page, options) {
  const summary = {};

  console.log(`Testing AX_search_product query=${JSON.stringify(options.query)}`);
  const search = await callLuaWithNavigationReplay(page, options, 'AX_search_product', { query: options.query });
  assertCondition(search?.ok, 'AX_search_product call failed', search);
  assertCondition((search.value?.candidates?.length || 0) > 0, 'AX_search_product returned no candidates', search.value);
  summary.search = {
    count: search.value.candidates.length,
    total_count: search.value.total_count,
    cursor: Boolean(search.value.cursor),
    first_product_id: search.value.candidates[0]?.product_id,
  };

  console.log(`Testing AX_view_product product_id=${options.productId}`);
  const view = await callLuaWithNavigationReplay(page, options, 'AX_view_product', { product_id: options.productId });
  assertCondition(view?.ok, 'AX_view_product call failed', view);
  assertCondition(Boolean(view.value?.title), 'AX_view_product returned no title', view.value);
  summary.view_product = compactProduct(view.value);

  console.log('Testing AX_update_product with generic variation/form input');
  const update = await callLuaWithNavigationReplay(page, options, 'AX_update_product', {
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
    const add = await callLuaWithNavigationReplay(page, options, 'AX_add_to_cart', {
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
  const cart = await callLuaWithNavigationReplay(page, options, 'AX_view_cart', {});
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
    const updateCart = await callLuaUntilNotPending(page, options, 'AX_update_cart', {
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
    const deleteCart = await callLuaUntilNotPending(page, options, 'AX_update_cart', {
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

main().catch(error => {
  console.error('\nFAIL');
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
