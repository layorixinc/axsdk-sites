#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');
const scriptDir = resolve(repoRoot, 'thumbtack', 'scripts');
const DEFAULT_EXTENSION_ID = 'dldlgmekahifbogjphgglkhibclglmpf';
const DEFAULT_CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEFAULT_PROFILE = process.env.CHROME_PROFILE || `${process.env.LOCALAPPDATA || ''}/AXSDKSitesChromeDevProfile`;
const DEFAULT_PORT = Number(process.env.CDP_PORT || 9224);
const LUA_FILES = ['00_common.lua', 'resolve_zip.lua', 'search_service.lua', 'view_service.lua', 'update_project.lua', 'request_quote.lua'];

function parseArgs(argv) {
  const options = {
    cdp: process.env.CDP_URL || null,
    port: DEFAULT_PORT,
    chrome: DEFAULT_CHROME,
    profile: DEFAULT_PROFILE,
    extensionId: process.env.AXSDK_EXTENSION_ID || DEFAULT_EXTENSION_ID,
    query: 'house cleaning',
    address: '1 Market St San Francisco CA 94105',
    keepOpen: false,
  };
  for (const arg of argv) {
    if (arg === '--keep-open') options.keepOpen = true;
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice('--port='.length));
    else if (arg.startsWith('--chrome=')) options.chrome = arg.slice('--chrome='.length);
    else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length);
    else if (arg.startsWith('--extension-id=')) options.extensionId = arg.slice('--extension-id='.length);
    else if (arg.startsWith('--query=')) options.query = arg.slice('--query='.length);
    else if (arg.startsWith('--address=')) options.address = arg.slice('--address='.length);
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node thumbtack/scripts/test_thumbtack_lua.mjs [options]\n\nOptions:\n  --query=TEXT\n  --address=TEXT\n  --cdp=http://127.0.0.1:9224\n  --port=9224\n  --profile=PATH\n  --keep-open`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.cdp) options.cdp = `http://127.0.0.1:${options.port}`;
  return options;
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
  return spawn(options.chrome, [
    `--remote-debugging-port=${options.port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${options.profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
    'about:blank',
  ], { stdio: 'ignore', detached: false });
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
    if (listeners) for (const listener of [...listeners]) listener(message.params || {});
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
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }
  waitFor(method, predicate = () => true, timeoutMs = 30000) {
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

async function openPage(cdpUrl, url) {
  const target = await createTarget(cdpUrl, 'about:blank');
  const page = new CdpClient(target.webSocketDebuggerUrl);
  await page.ready;
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await navigate(page, url);
  return page;
}

async function navigate(page, url) {
  const loaded = page.waitFor('Page.loadEventFired', () => true, 30000).catch(() => null);
  await page.send('Page.navigate', { url });
  await loaded;
  await sleep(1200);
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
  throw new Error(`AXSDK Assistant execution context not found for extension ${extensionId}`);
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
  return result?.ok === false && result?.reason === 'pending'
    || result?.value?.pending === true
    || result?.value?.error === 'navigation_pending'
    || result?.value?.error === 'pending';
}

async function waitForSettle(page) {
  await page.waitFor('Page.loadEventFired', () => true, 30000).catch(() => null);
  await sleep(2500);
}

async function callInAxContext(page, options, functionDeclaration, args = []) {
  const context = await findAxContext(page, options.extensionId);
  const result = await page.send('Runtime.callFunctionOn', {
    functionDeclaration,
    arguments: args.map(value => ({ value })),
    executionContextId: context.id,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}

async function loadLuaFiles(page, options) {
  for (const file of LUA_FILES) {
    const source = await readFile(resolve(scriptDir, file), 'utf8');
    const result = await callInAxContext(page, options, `async function(source, id) {
      const lua = globalThis._AXLUA || globalThis._AXSDK?.lua;
      if (!lua) throw new Error('AX Lua runtime is not available');
      if (typeof lua.load === 'function') return await lua.load(source, { id });
      return await lua.loadSiteScript(source, { id, replace: true, kind: 'devtools' });
    }`, [source, `thumbtack-test-${file}-${Date.now()}`]);
    if (!result?.ok && result?.status !== 'loaded') throw new Error(`Failed to load ${file}: ${JSON.stringify(result)}`);
  }
}

async function callLua(page, options, command, args) {
  await loadLuaFiles(page, options);
  return callInAxContext(page, options, `async function(command, args) {
    const lua = globalThis._AXLUA || globalThis._AXSDK?.lua;
    if (!lua) throw new Error('AX Lua runtime is not available');
    return await lua.call(command, args);
  }`, [command, args]);
}

async function callLuaSettled(page, options, command, args) {
  let last = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      last = await callLua(page, options, command, args);
      if (!isPendingResult(last)) return last;
    } catch (error) {
      if (!isContextLostError(error)) throw error;
      last = { ok: false, reason: 'context_lost', error: String(error.message || error) };
    }
    await waitForSettle(page);
  }
  return last;
}

function assertCondition(condition, message, details) {
  if (!condition) throw new Error(`${message}\n${JSON.stringify(details, null, 2)}`);
}

async function runTests(page, options) {
  const summary = {};

  console.log('Testing AX_resolve_zip');
  const zip = await callLuaSettled(page, options, 'AX_resolve_zip', { address: options.address });
  assertCondition(zip?.ok, 'AX_resolve_zip call failed', zip);
  assertCondition(Boolean(zip.value?.zip_code), 'AX_resolve_zip returned no zip_code', zip.value);
  summary.resolve_zip = zip.value;

  console.log('Testing AX_search_service');
  const search = await callLuaSettled(page, options, 'AX_search_service', { query: options.query, address: options.address });
  assertCondition(search?.ok, 'AX_search_service call failed', search);
  assertCondition((search.value?.candidates?.length || 0) > 0, 'AX_search_service returned no candidates', search.value);
  const first = search.value.candidates[0];
  summary.search_service = {
    zip_code: search.value.zip_code,
    count: search.value.candidates.length,
    first: {
      service_id: first.service_id,
      name: first.name,
      rating: first.rating,
      url: first.url,
    },
  };

  console.log('Testing AX_view_service');
  const view = await callLuaSettled(page, options, 'AX_view_service', { url: first.url, service_id: first.service_id });
  assertCondition(view?.ok, 'AX_view_service call failed', view);
  assertCondition(Boolean(view.value?.name), 'AX_view_service returned no name', view.value);
  summary.view_service = {
    service_id: view.value.service_id,
    name: view.value.name,
    rating: view.value.rating,
    services_offered: view.value.services_offered?.length,
    photos: view.value.photos?.length,
    request_quote: view.value.actions?.request_quote,
  };

  console.log('Testing AX_request_quote submit=false');
  const quote = await callLuaSettled(page, options, 'AX_request_quote', { url: first.url, service_id: first.service_id, submit: false });
  assertCondition(quote?.ok, 'AX_request_quote call failed', quote);
  assertCondition(quote.value?.status === 'open' || quote.value?.error === 'quote_unavailable', 'AX_request_quote returned unexpected state', quote.value);
  summary.request_quote = {
    status: quote.value?.status,
    error: quote.value?.error,
    field_count: quote.value?.form?.fields?.length,
    button_count: quote.value?.form?.buttons?.length,
  };

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
  const page = await openPage(options.cdp, 'https://www.thumbtack.com/');
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
