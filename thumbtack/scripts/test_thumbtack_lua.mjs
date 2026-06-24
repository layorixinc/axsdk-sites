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
const LUA_FILES = ['00_common.lua', 'resolve_zip.lua', 'search_service.lua', 'view_service.lua', 'update_search.lua', 'answer_quote.lua', 'open_quote.lua', 'submit_quote.lua'];
const commonDir = resolve(repoRoot, '_common', 'scripts');
const COMMON_FILES = ['00_base.lua', '10_form_wizard.lua', '20_echo.lua'];
const DEFAULT_SCENARIOS = [
  { name: 'house-cleaning', query: 'house cleaning', address: 'San Francisco, CA', requirements: 'Standard home cleaning for a small home, no pets.' },
  { name: 'lawn-mowing', query: 'lawn mowing', address: 'San Francisco, CA', requirements: 'Residential lawn mowing, one-time service within 48 hours.' },
  { name: 'handyman', query: 'handyman', address: 'San Francisco, CA', requirements: 'Small home repair task, less than 2 hours.' },
];
const DEFAULT_QUOTE_MESSAGE = 'Testing Thumbtack quote flow only. Do not send yet.';
const DEFAULT_CONTACT = {
  email: 'thumbtack-test@example.com',
  first_name: 'Test',
  last_name: 'User',
  phone: '4155550100',
  zip_code: '94101',
};

function scenarioName(query) {
  return String(query || 'scenario').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scenario';
}

function proPathUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

// Lua site scripts are wiped on every full navigation. Track whether a navigation happened since the
// last load so loadLuaFiles can skip the (8-file) reload for same-page calls.
let luaContextDirty = true;

let runT0 = Date.now();
const el = () => ((Date.now() - runT0) / 1000).toFixed(1);

function parseScenario(value) {
  const parts = String(value || '').split('|').map(part => part.trim()).filter(Boolean);
  const query = parts[0];
  if (!query) throw new Error('--scenario requires QUERY or QUERY|ADDRESS');
  return {
    name: scenarioName(query),
    query,
    address: parts[1] || 'San Francisco, CA',
  };
}

function parseArgs(argv) {
  const options = {
    cdp: process.env.CDP_URL || null,
    port: DEFAULT_PORT,
    chrome: DEFAULT_CHROME,
    profile: DEFAULT_PROFILE,
    extensionId: process.env.AXSDK_EXTENSION_ID || DEFAULT_EXTENSION_ID,
    query: 'house cleaning',
    address: 'San Francisco, CA',
    scenarios: [],
    multiService: false,
    multiQuote: false,
    quoteCount: Number(process.env.THUMBTACK_QUOTE_COUNT || 3),
    submitQuote: false,
    actualSubmit: false,
    maxQuoteSteps: Number(process.env.THUMBTACK_QUOTE_STEPS || 20),
    keepOpen: false,
  };
  for (const arg of argv) {
    if (arg === '--keep-open') options.keepOpen = true;
    else if (arg === '--multi-service') options.multiService = true;
    else if (arg === '--multi-quote') options.multiQuote = true;
    else if (arg === '--submit-quote') options.submitQuote = true;
    else if (arg === '--actual-submit') {
      options.submitQuote = true;
      options.actualSubmit = true;
    }
    else if (arg.startsWith('--cdp=')) options.cdp = arg.slice('--cdp='.length);
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice('--port='.length));
    else if (arg.startsWith('--chrome=')) options.chrome = arg.slice('--chrome='.length);
    else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length);
    else if (arg.startsWith('--extension-id=')) options.extensionId = arg.slice('--extension-id='.length);
    else if (arg.startsWith('--query=')) options.query = arg.slice('--query='.length);
    else if (arg.startsWith('--address=')) options.address = arg.slice('--address='.length);
    else if (arg.startsWith('--scenario=')) options.scenarios.push(parseScenario(arg.slice('--scenario='.length)));
    else if (arg.startsWith('--max-quote-steps=')) options.maxQuoteSteps = Number(arg.slice('--max-quote-steps='.length));
    else if (arg.startsWith('--quote-count=')) options.quoteCount = Number(arg.slice('--quote-count='.length));
    else if (arg.startsWith('--count=')) options.quoteCount = Number(arg.slice('--count='.length));
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node thumbtack/scripts/test_thumbtack_lua.mjs [options]

Options:
  --query=TEXT                         Single-service query.
  --address=TEXT                       Single-service address/city/ZIP.
  --scenario=QUERY|ADDRESS             Add one scenario; repeatable.
  --multi-service                      Run the default varied-service scenario set.
  --multi-quote                        Request multiple quote flows from one search input.
  --quote-count=N                      Number of quote candidates per scenario for --multi-quote (1-5).
  --submit-quote                       Progress every quote flow toward final Submit; accepts a safe login/contact gate; never clicks submit.
  --actual-submit                      Actually click final Submit via AX_submit_quote(confirm:true).
  --max-quote-steps=N                  Max request-flow steps per scenario.
  --cdp=http://127.0.0.1:9224          Connect to an existing Chrome CDP endpoint.
  --port=N                             Launch/connect using this CDP port when --cdp is omitted.
  --chrome=PATH                        Chrome executable to launch when CDP is unavailable.
  --profile=PATH                       Chrome profile directory.
  --extension-id=ID                    AXSDK extension id.
  --keep-open                          Keep launched Chrome open after the run.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  options.quoteCount = Math.max(1, Math.min(5, Number.isFinite(options.quoteCount) ? Math.floor(options.quoteCount) : 3));
  if (!options.cdp) options.cdp = `http://127.0.0.1:${options.port}`;
  if (options.scenarios.length === 0) {
    options.scenarios = options.multiService
      ? DEFAULT_SCENARIOS
      : [{ name: scenarioName(options.query), query: options.query, address: options.address }];
  }
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
  page.on('Page.javascriptDialogOpening', () => {
    page.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => null);
  });
  await page.send('Runtime.enable');
  await navigate(page, url);
  await page.send('Page.bringToFront').catch(() => null);
  return page;
}

async function navigate(page, url) {
  const t = Date.now();
  const loaded = page.waitFor('Page.loadEventFired', () => true, 10000).catch(() => null);
  await page.send('Page.navigate', { url });
  await loaded;
  await sleep(500);
  luaContextDirty = true;
  console.log(`  [${el()}s] nav ${Date.now() - t}ms ${String(url).replace('https://www.thumbtack.com', '').slice(0, 40)}`);
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
  return result?.status === 'pending'
    || result?.ok === false && result?.reason === 'pending'
    || result?.value?.pending === true
    || result?.value?.error === 'navigation_pending'
    || result?.value?.error === 'pending';
}

async function waitForSettle(page) {
  // Lua tools wait for their own readiness selectors and navigate() awaits real load events, so a
  // brief settle is enough here. Waiting for Page.loadEventFired would stall ~12s on same-page
  // (no-navigation) steps that never fire one.
  await sleep(400);
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

async function waitForLuaRuntime(page, options, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const status = await callInAxContext(page, options, `function() {
        const lua = globalThis._AXSDK?.lua || globalThis._AXLUA;
        return {
          available: Boolean(lua),
          hasCall: typeof lua?.call === 'function',
          hasLoad: typeof lua?.load === 'function' || typeof lua?.loadSiteScript === 'function'
        };
      }`);
      if (status?.available && status?.hasCall && status?.hasLoad) return status;
      last = status;
    } catch (error) {
      last = String(error?.message || error);
    }
    await sleep(500);
  }
  throw new Error(`AX Lua runtime is not available after wait: ${JSON.stringify(last)}`);
}

async function evaluatePage(page, expression) {
  const result = await page.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}

async function waitForResultsPage(page, timeoutMs = 3500) {
  // CDP-level wait (not a Lua durable step) for the search results page after a fire-and-forget
  // submit, so the read call lands on the results list.
  const t = Date.now();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = await evaluatePage(page, 'location.href').catch(() => '');
    if (/instant-results/.test(String(url || ''))) { console.log(`  [${el()}s] resultsPage ${Date.now() - t}ms`); return true; }
    await sleep(300);
  }
  console.log(`  [${el()}s] resultsPage TIMEOUT ${Date.now() - t}ms`);
  return false;
}

async function loadLuaFiles(page, options) {
  if (!luaContextDirty) return;
  let lastError = null;
  // A hard navigation re-inits the AXSDK runtime; a late resource can reset the context mid-load,
  // leaving a later file loaded before 00_common. Retry the whole ordered load once on failure.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await waitForLuaRuntime(page, options);
    try {
      const ordered = [
        ...COMMON_FILES.map(f => [commonDir, f]),
        ...LUA_FILES.map(f => [scriptDir, f]),
      ];
      for (const [dir, file] of ordered) {
        const source = await readFile(resolve(dir, file), 'utf8');
        const result = await callInAxContext(page, options, `async function(source, id) {
          const lua = globalThis._AXSDK?.lua || globalThis._AXLUA;
          if (!lua) throw new Error('AX Lua runtime is not available');
          if (typeof lua.load === 'function') return await lua.load(source, { id });
          return await lua.loadSiteScript(source, { id, replace: true, kind: 'devtools' });
        }`, [source, `thumbtack-test-${file}-${Date.now()}`]);
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

async function callLua(page, options, command, args) {
  await loadLuaFiles(page, options);
  const ret = await callInAxContextCmd(page, options, command, args);
  // AX_search_service navigates to the results page; mark the context dirty so the next call reloads.
  if (command === 'AX_search_service') luaContextDirty = true;
  return ret;
}

async function callInAxContextCmd(page, options, command, args) {
  return callInAxContext(page, options, `async function(command, args) {
    const lua = globalThis._AXSDK?.lua || globalThis._AXLUA;
    if (!lua) throw new Error('AX Lua runtime is not available');
    if (typeof lua.run === 'function') {
      const result = await lua.run(command, args, { timeoutMs: 5000, timeout: 5000 });
      let value = null;
      if (result?.result) {
        try {
          value = JSON.parse(result.result);
        } catch {
          value = result.result;
        }
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

async function callLuaSettled(page, options, command, args, maxAttempts = 2) {
  const started = Date.now();
  let last = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      last = await callLua(page, options, command, args);
      if (!isPendingResult(last)) break;
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
  if (!condition) throw new Error(`${message}\n${JSON.stringify(details, null, 2)}`);
}

function buttonLabels(step) {
  return (step?.buttons || []).map(button => button.label).filter(Boolean);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return Object.keys(value)
    .sort((left, right) => Number(left) - Number(right))
    .map(key => value[key]);
}

function firstSelectableFilter(serviceOptions) {
  for (const group of serviceOptions || []) {
    const choices = Array.isArray(group?.choices) ? group.choices : [];
    const value = choices.find(choice => choice && choice !== group.selected);
    if (value) return { group: group.title, value };
  }
  return null;
}

async function readQuoteStep(page) {
  return evaluatePage(page, `(() => {
    const norm = value => (value || '').replace(/\\s+/g, ' ').trim();
    const active = document.querySelector('[data-test="request-flow-step--active"]');
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const signedOut = [...document.querySelectorAll('a, button')]
      .filter(visible)
      .some(element => /^(log in|sign in|sign up)$/i.test(norm(element.textContent) || element.getAttribute('aria-label') || ''));
    const url = location.href;
    if (!active) {
      return {
        active: false,
        url,
        signedOut,
        loginGate: signedOut || /login|signup|sign-in/i.test(url)
      };
    }
    const activeText = norm(active.innerText);
    const labels = [...active.querySelectorAll('label')]
      .filter(label => label.querySelector('input[type="radio"], input[type="checkbox"]'))
      .map(label => {
        const input = label.querySelector('input');
        return {
          text: norm(label.textContent),
          type: input?.type || '',
          checked: Boolean(input?.checked)
        };
      })
      .filter(option => option.text);
    const buttons = [...active.querySelectorAll('button')]
      .map((button, index) => ({
        index,
        label: norm(button.textContent) || button.getAttribute('aria-label') || button.getAttribute('title') || '',
        type: button.getAttribute('type') || '',
        disabled: Boolean(button.disabled)
      }))
      .filter(button => button.label);
    const safeButton = buttons.find(button => /^(next|continue|skip)$/i.test(button.label));
    const fields = [...active.querySelectorAll('input, textarea, select')]
      .map((field, index) => ({
        index,
        tag: field.tagName,
        type: field.type || field.tagName.toLowerCase(),
        name: field.getAttribute('name') || '',
        id: field.getAttribute('id') || '',
        placeholder: field.getAttribute('placeholder') || '',
        aria: field.getAttribute('aria-label') || '',
        autocomplete: field.getAttribute('autocomplete') || '',
        value: field.value || '',
        visible: visible(field)
      }));
    const submitButton = buttons.find(button => /(send|submit|quote|request|get quotes?|get estimate|check availability)/i.test(button.label));
    return {
      active: true,
      url,
      text: activeText.slice(0, 320),
      labels,
      fields,
      textareaCount: active.querySelectorAll('textarea').length,
      textareaValue: active.querySelector('textarea')?.value || '',
      buttons,
      safeButton: safeButton?.label || null,
      submitButton: submitButton?.label || null,
      signedOut,
      loginGate: /continue with google|continue with apple|enter your email|where should we send the pro.?s response|we don.?t share your email|log in|sign in|sign up/i.test(activeText)
        || /login|signup|sign-in/i.test(url)
    };
  })()`);
}
function contactArgsForStep(step) {
  const args = {};
  for (const field of step.fields || []) {
    const type = String(field.type || '').toLowerCase();
    const placeholder = String(field.placeholder || '').toLowerCase();
    const aria = String(field.aria || '').toLowerCase();
    const autocomplete = String(field.autocomplete || '').toLowerCase();
    const haystack = `${type} ${placeholder} ${aria} ${autocomplete}`;
    if ((type === 'email' || autocomplete === 'email' || haystack.includes('email')) && !field.value) {
      args.email = DEFAULT_CONTACT.email;
    } else if ((autocomplete === 'given-name' || haystack.includes('first name')) && !field.value) {
      args.first_name = DEFAULT_CONTACT.first_name;
    } else if ((autocomplete === 'family-name' || haystack.includes('last name')) && !field.value) {
      args.last_name = DEFAULT_CONTACT.last_name;
    } else if ((type === 'tel' || autocomplete === 'tel' || haystack.includes('phone')) && !field.value) {
      args.phone = DEFAULT_CONTACT.phone;
    } else if ((autocomplete === 'postal-code' || haystack.includes('zip code')) && !field.value) {
      args.zip_code = DEFAULT_CONTACT.zip_code;
    }
  }
  return args;
}

function hasArgs(args) {
  return Object.keys(args || {}).length > 0;
}

function quoteArgsForStep(step, scenario) {
  const contactArgs = contactArgsForStep(step);
  if (hasArgs(contactArgs)) return contactArgs;
  return {
    auto: true,
    user_requirements: scenario?.requirements || DEFAULT_QUOTE_MESSAGE,
  };
}

function quoteItemStatus(quote, quoteFlow, actualSubmit) {
  if (quote?.status !== 'open') return quote?.error === 'quote_unavailable' ? 'skipped' : 'failed';
  if (actualSubmit && quoteFlow?.finalSubmit?.ok) return 'submitted';
  if (quoteFlow?.blocker) return 'blocked';
  if (quoteFlow?.final?.submitButton) return 'ready_to_submit';
  return 'quoting';
}

async function inspectQuoteCandidate(page, options, scenario, candidate, label, tolerant = false) {
  const summary = {
    index: null,
    selected_service_id: candidate.service_id,
    selected_pro_url: candidate.url,
    status: 'pending',
    view_service: null,
    open_quote: null,
    blocker: null,
    quote_flow: null,
  };

  console.log(`[${label}] Testing AX_view_service service_id=${candidate.service_id}`);
  const view = await callLuaSettled(page, options, 'AX_view_service', { url: candidate.url, service_id: candidate.service_id });
  if (!view?.ok || !view.value?.name) {
    if (!tolerant) {
      assertCondition(view?.ok, `[${label}] AX_view_service call failed`, view);
      assertCondition(Boolean(view.value?.name), `[${label}] AX_view_service returned no name`, view.value);
    }
    summary.status = 'failed';
    summary.blocker = { stage: 'view_service', reason: view?.error || view?.value || 'view_service_failed' };
    console.log(`[${label}] view_service unavailable -> item ${summary.status}`);
    return { candidate, view: view?.value || null, quote: null, summary };
  }
  summary.view_service = {
    service_id: view.value.service_id,
    name: view.value.name,
    rating: view.value.rating,
    services_offered: view.value.services_offered?.length,
    photos: view.value.photos?.length,
    request_quote: view.value.actions?.request_quote,
  };

  console.log(`[${label}] Testing AX_open_quote submit=false service_id=${candidate.service_id}`);
  const quote = await callLuaSettled(page, options, 'AX_open_quote', { url: candidate.url, service_id: candidate.service_id, submit: false });
  if (!quote?.ok) {
    if (!tolerant) assertCondition(quote?.ok, `[${label}] AX_open_quote call failed`, quote);
    summary.status = 'blocked';
    summary.blocker = { stage: 'open_quote', reason: quote?.error || quote?.value || 'open_quote_failed' };
    console.log(`[${label}] open_quote failed -> item ${summary.status}`);
    return { candidate, view: view.value, quote: quote?.value || null, summary };
  }
  if (!tolerant) {
    assertCondition(quote.value?.status === 'open' || quote.value?.error === 'quote_unavailable', `[${label}] AX_open_quote returned unexpected state`, quote.value);
  }
  const choiceFields = asArray(quote.value?.form?.fields).filter(field => field.type === 'radio' || field.type === 'checkbox');
  if (choiceFields.length > 0) {
    assertCondition(
      choiceFields.every(field => typeof field.text === 'string' && field.text.trim().length > 0),
      `[${label}] AX_open_quote returned empty choice field text`,
      choiceFields
    );
  }
  summary.open_quote = {
    status: quote.value?.status,
    error: quote.value?.error,
    field_count: asArray(quote.value?.form?.fields).length,
    button_count: asArray(quote.value?.form?.buttons).length,
    question_count: asArray(quote.value?.questions).length,
    question_collection_status: quote.value?.question_collection_status,
    all_questions_available: quote.value?.all_questions_available,
  };
  summary.status = quoteItemStatus(quote.value, null, options.actualSubmit);
  summary.quote_flow = quote.value?.status === 'open' ? null : 'skipped; quote unavailable';

  if (quote.value?.status === 'open') {
    console.log(`[${label}] Progressing quote request flow${options.submitQuote ? ' until submit button' : ''}`);
    summary.quote_flow = await progressQuoteFlow(page, options, scenario);
    summary.status = quoteItemStatus(quote.value, summary.quote_flow, options.actualSubmit);
    if (summary.quote_flow?.blocker) summary.blocker = summary.quote_flow.blocker;
  }

  return { candidate, view: view.value, quote: quote.value, summary };
}


async function progressQuoteFlow(page, options, scenario) {
  const steps = [];
  let finalSubmit = null;
  let blocker = null;
  for (let index = 1; index <= options.maxQuoteSteps; index += 1) {
    const before = await readQuoteStep(page);
    if (!before.active) {
      blocker = before.loginGate || before.signedOut
        ? { type: 'login_gate', signedOut: before.signedOut, url: before.url }
        : null;
      steps.push({ index, state: 'no_active_step', loginGate: before.loginGate, signedOut: before.signedOut, url: before.url });
      break;
    }
    if (before.submitButton && !before.safeButton) {
      const args = quoteArgsForStep(before, scenario);
      console.log(`  quote step ${index}: submit button ${JSON.stringify(before.submitButton)} buttons=${JSON.stringify(buttonLabels(before).slice(0, 4))}`);
      let update = null;
      let after = before;
      if (hasArgs(args)) {
        update = await callLuaSettled(page, options, 'AX_answer_quote', { ...args, advance: false });
        assertCondition(update?.ok, 'AX_answer_quote failed while filling submit step fields', update);
        await waitForSettle(page);
        after = await readQuoteStep(page);
      }
      steps.push({
        index,
        state: 'submit_step',
        button: before.submitButton,
        args,
        update: update?.value || null,
        before: {
          text: before.text,
          buttons: buttonLabels(before).slice(0, 5),
        },
        after: {
          text: after.text,
          buttons: buttonLabels(after).slice(0, 5),
          submitButton: after.submitButton,
        },
      });
      if (options.actualSubmit) {
        finalSubmit = await callLuaSettled(page, options, 'AX_submit_quote', { confirm: true, ...DEFAULT_CONTACT, max_steps: 8 });
        assertCondition(finalSubmit?.ok, 'AX_submit_quote call failed', finalSubmit);
        await waitForSettle(page);
      } else {
        finalSubmit = { attempted: false, reason: 'submit_button_reached_not_clicked' };
      }
      break;
    }
    const args = quoteArgsForStep(before, scenario);
    console.log(`  quote step ${index}: ${JSON.stringify((before.text || '').slice(0, 80))} buttons=${JSON.stringify(buttonLabels(before).slice(0, 4))}`);
    const update = await callLuaSettled(page, options, 'AX_answer_quote', args);
    assertCondition(update?.ok, 'AX_answer_quote call failed while progressing quote flow', update);
    await waitForSettle(page);
    const after = await readQuoteStep(page);
    const flow = update.value?.flow || {};
    const stepChanged = after.active === true && after.text && after.text !== before.text;
    steps.push({
      index,
      before: {
        text: before.text,
        buttons: buttonLabels(before).slice(0, 5),
        labels: before.labels.slice(0, 5).map(option => ({ text: option.text, type: option.type })),
      },
      args,
      flow,
      after: {
        text: after.text,
        buttons: buttonLabels(after).slice(0, 5),
        loginGate: after.loginGate,
      },
    });
    if (flow.request_error) {
      blocker = {
        type: flow.request_error.retry_field ? 'contact_update_required' : 'request_flow_error',
        error: flow.request_error.error,
        message: flow.request_error.message,
      };
      break;
    }
    const reason = flow.advance_reason;
    if (after.submitButton && !after.safeButton) continue;
    if (stepChanged) continue;
    if (flow.reached_submit_step === true
      || reason === 'unsafe_advance_button'
      || reason === 'advance_not_confirmed'
      || reason === 'missing_answer'
      || reason === 'answer_not_applied'
      || reason === 'advance_click_failed') {
      break;
    }
  }
  const final = await readQuoteStep(page);
  return {
    steps,
    finalSubmit,
    blocker,
    final: {
      active: final.active,
      text: final.text,
      buttons: buttonLabels(final),
      submitButton: final.submitButton,
      loginGate: final.loginGate,
      signedOut: final.signedOut,
      url: final.url,
    },
  };
}

async function runScenario(page, options, scenario) {
  const summary = { name: scenario.name, query: scenario.query, address: scenario.address };
  await navigate(page, 'https://www.thumbtack.com/');
  await waitForSettle(page);


  console.log(`[${scenario.name}] Testing AX_resolve_zip`);
  const zip = await callLuaSettled(page, options, 'AX_resolve_zip', { address: scenario.address });
  assertCondition(zip?.ok, `[${scenario.name}] AX_resolve_zip call failed`, zip);
  assertCondition(Boolean(zip.value?.zip_code), `[${scenario.name}] AX_resolve_zip returned no zip_code`, zip.value);
  summary.resolve_zip = zip.value;

  console.log(`[${scenario.name}] Testing AX_search_service query=${JSON.stringify(scenario.query)}`);
  const searchArgs = { query: scenario.query, zip_code: zip.value.zip_code, address: scenario.address };
  // Two-phase navigating search: the first call runs start_search (fill + autocomplete wait + submit
  // click) and navigates to /instant-results; later calls read the loaded pros. Wait for the results
  // page between attempts and give each call enough durable-replay attempts to finish its phase.
  let search = await callLuaSettled(page, options, 'AX_search_service', searchArgs, 5);
  for (let attempt = 0; attempt < 3 && !(search?.ok && (search.value?.candidates?.length || 0) > 0); attempt += 1) {
    await waitForResultsPage(page);
    await sleep(300);
    search = await callLuaSettled(page, options, 'AX_search_service', searchArgs, 5);
  }
  assertCondition(search?.ok, `[${scenario.name}] AX_search_service call failed`, search);
  assertCondition((search.value?.candidates?.length || 0) > 0, `[${scenario.name}] AX_search_service returned no candidates`, search.value);
  summary.search_service = {
    zip_code: search.value.zip_code,
    count: search.value.candidates.length,
    first_service_id: search.value.candidates[0]?.service_id,
    option_groups: search.value.service_options?.length || 0,
  };

  const filter = firstSelectableFilter(search.value.service_options);
  if (filter) {
    console.log(`[${scenario.name}] Testing AX_update_search value=${JSON.stringify(filter.value)}`);
    const updateSearch = await callLuaSettled(page, options, 'AX_update_search', { value: filter.value, option: filter.group });
    assertCondition(updateSearch?.ok, `[${scenario.name}] AX_update_search call failed`, updateSearch);
    summary.update_search = {
      group: filter.group,
      value: filter.value,
      count: updateSearch.value?.candidates?.length || 0,
    };
  } else {
    summary.update_search = 'skipped; no selectable search filters';
  }

  const candidates = search.value.candidates.slice(0, 3);
  let selected = null;
  for (const candidate of candidates) {
    const inspected = await inspectQuoteCandidate(page, options, scenario, candidate, scenario.name);
    selected = inspected;
    if (inspected.quote?.status === 'open') break;
  }
  assertCondition(Boolean(selected), `[${scenario.name}] no candidate could be viewed`, candidates);

  summary.view_service = selected.summary.view_service;
  summary.open_quote = selected.summary.open_quote;
  summary.quote_flow = selected.summary.quote_flow;

  return summary;
}

async function runQuotePlanScenario(page, options, scenario) {
  const summary = {
    name: scenario.name,
    query: scenario.query,
    address: scenario.address,
    quote_plan: {
      requested_count: options.quoteCount,
      current_index: 0,
      submit_policy: options.submitQuote || options.actualSubmit ? 'submit_if_ready' : 'prepare_only',
      status: 'searching',
      items: [],
    },
  };
  runT0 = Date.now();
  // openPage already navigates to the home page; only re-navigate if we somehow aren't there.
  const here = await evaluatePage(page, 'location.href').catch(() => '');
  if (!/^https?:\/\/www\.thumbtack\.com\/?(\?|$)/.test(String(here || ''))) {
    await navigate(page, 'https://www.thumbtack.com/');
  }
  await waitForSettle(page);

  console.log(`[${scenario.name}] Testing AX_resolve_zip`);
  const zip = await callLuaSettled(page, options, 'AX_resolve_zip', { address: scenario.address });
  assertCondition(zip?.ok, `[${scenario.name}] AX_resolve_zip call failed`, zip);
  assertCondition(Boolean(zip.value?.zip_code), `[${scenario.name}] AX_resolve_zip returned no zip_code`, zip.value);
  summary.resolve_zip = zip.value;

  console.log(`[${scenario.name}] Testing AX_search_service query=${JSON.stringify(scenario.query)}`);
  // Pass the already-resolved zip_code so search skips its internal (rate-limit-prone) ZIP fetch.
  const searchArgs = { query: scenario.query, zip_code: zip.value.zip_code, address: scenario.address };
  // Two-phase: the first call must fully run start_search (input wait + dom.fill + submit click) so
  // the results navigation is actually triggered — it returns status="navigating". Then wait for the
  // results page (CDP) and read. Each call gets enough durable-replay attempts to complete its phase.
  let search = await callLuaSettled(page, options, 'AX_search_service', searchArgs, 5);
  for (let attempt = 0; attempt < 3 && !(search?.ok && (search.value?.candidates?.length || 0) > 0); attempt += 1) {
    await waitForResultsPage(page);
    await sleep(300);
    search = await callLuaSettled(page, options, 'AX_search_service', searchArgs, 5);
  }
  assertCondition(search?.ok, `[${scenario.name}] AX_search_service call failed`, search);
  assertCondition((search.value?.candidates?.length || 0) > 0, `[${scenario.name}] AX_search_service returned no candidates`, search);
  summary.search_service = {
    zip_code: search.value.zip_code,
    count: search.value.candidates.length,
    first_service_id: search.value.candidates[0]?.service_id,
    option_groups: search.value.service_options?.length || 0,
  };

  const candidates = search.value.candidates.slice(0, options.quoteCount);
  summary.quote_plan.available_count = search.value.candidates.length;
  summary.quote_plan.selected_count = candidates.length;
  assertCondition(candidates.length > 0, `[${scenario.name}] no quote candidates available`, search.value);

  for (const [index, candidate] of candidates.entries()) {
    const label = `${scenario.name}:quote-${index + 1}`;
    // Hard-navigate (CDP full load) to the clean pro path so each item loads in a stable context:
    // the bare /service/<id> path avoids the search quote params that auto-open the request flow and
    // reset the Lua runtime mid-load, and a full load avoids stale pro->pro soft-nav reads.
    await navigate(page, proPathUrl(candidate.url));
    await waitForSettle(page);
    const inspected = await inspectQuoteCandidate(page, options, scenario, candidate, label, true);
    summary.quote_plan.items.push({
      ...inspected.summary,
      index: index + 1,
    });
    summary.quote_plan.current_index = index + 1;
  }

  const statuses = summary.quote_plan.items.map(item => item.status);
  const successful = statuses.filter(status => status === 'ready_to_submit' || status === 'submitted').length;
  summary.quote_plan.status = successful === summary.quote_plan.items.length
    ? 'complete'
    : successful > 0
      ? 'partial'
      : 'failed';
  return summary;
}

function quoteFlowReachedSubmitOrGate(scenario) {
  const flow = scenario.quote_flow;
  return Boolean(flow?.final?.submitButton) || Boolean(flow?.blocker);
}

async function runTests(page, options) {
  const scenarios = [];
  for (const scenario of options.scenarios) {
    scenarios.push(options.multiQuote
      ? await runQuotePlanScenario(page, options, scenario)
      : await runScenario(page, options, scenario));
  }
  const quoteFlows = options.multiQuote
    ? scenarios.flatMap(scenario => (scenario.quote_plan?.items || []).filter(item => typeof item.quote_flow === 'object'))
    : scenarios.filter(scenario => typeof scenario.quote_flow === 'object');
  if (options.multiQuote) {
    assertCondition(
      scenarios.every(scenario => (scenario.quote_plan?.items?.length || 0) > 0),
      '--multi-quote selected no quote items',
      scenarios
    );
  }
  assertCondition(quoteFlows.length > 0, 'No scenario opened a quote flow', scenarios);
  if (options.actualSubmit) {
    assertCondition(
      quoteFlows.every(scenario => scenario.quote_flow?.finalSubmit?.ok === true),
      '--actual-submit did not call AX_submit_quote successfully for every scenario',
      quoteFlows
    );
  } else if (options.submitQuote) {
    assertCondition(
      quoteFlows.every(quoteFlowReachedSubmitOrGate),
      '--submit-quote reached neither the final submit button nor a safe login/contact gate',
      quoteFlows
    );
  }
  return {
    scenario_count: scenarios.length,
    quote_flow_count: quoteFlows.length,
    submit_quote: options.submitQuote,
    actual_submit: options.actualSubmit,
    multi_quote: options.multiQuote,
    quote_count: options.quoteCount,
    scenarios,
  };
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
