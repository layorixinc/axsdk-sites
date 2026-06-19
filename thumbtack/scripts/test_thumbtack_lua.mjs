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
const LUA_FILES = ['00_common.lua', 'resolve_zip.lua', 'search_service.lua', 'view_service.lua', 'update_search.lua', 'update_project.lua', 'request_quote.lua'];
const DEFAULT_SCENARIOS = [
  { name: 'house-cleaning', query: 'house cleaning', address: 'San Francisco, CA' },
  { name: 'lawn-mowing', query: 'lawn mowing', address: 'San Francisco, CA' },
  { name: 'handyman', query: 'handyman', address: 'San Francisco, CA' },
];
const DEFAULT_QUOTE_MESSAGE = 'Testing Thumbtack quote flow only. Do not send yet.';

function scenarioName(query) {
  return String(query || 'scenario').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scenario';
}

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
    submitQuote: false,
    maxQuoteSteps: Number(process.env.THUMBTACK_QUOTE_STEPS || 14),
    submitQuoteScenario: process.env.THUMBTACK_SUBMIT_QUOTE_SCENARIO || 'lawn-mowing',
    keepOpen: false,
  };
  for (const arg of argv) {
    if (arg === '--keep-open') options.keepOpen = true;
    else if (arg === '--multi-service') options.multiService = true;
    else if (arg === '--submit-quote') options.submitQuote = true;
    else if (arg.startsWith('--cdp=')) options.cdp = arg.slice('--cdp='.length);
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice('--port='.length));
    else if (arg.startsWith('--chrome=')) options.chrome = arg.slice('--chrome='.length);
    else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length);
    else if (arg.startsWith('--extension-id=')) options.extensionId = arg.slice('--extension-id='.length);
    else if (arg.startsWith('--query=')) options.query = arg.slice('--query='.length);
    else if (arg.startsWith('--address=')) options.address = arg.slice('--address='.length);
    else if (arg.startsWith('--scenario=')) options.scenarios.push(parseScenario(arg.slice('--scenario='.length)));
    else if (arg.startsWith('--max-quote-steps=')) options.maxQuoteSteps = Number(arg.slice('--max-quote-steps='.length));
    else if (arg.startsWith('--submit-quote-scenario=')) options.submitQuoteScenario = scenarioName(arg.slice('--submit-quote-scenario='.length));
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node thumbtack/scripts/test_thumbtack_lua.mjs [options]\n\nOptions:\n  --query=TEXT                         Single-service query.\n  --address=TEXT                       Single-service address/city/ZIP.\n  --scenario=QUERY|ADDRESS             Add one scenario; repeatable.\n  --multi-service                      Run the default varied-service scenario set.\n  --submit-quote                       Click the final quote/login-gate button only when logged out is clear.\n  --submit-quote-scenario=NAME         Scenario that may make the final login-gate click. Default: lawn-mowing.\n  --max-quote-steps=N                  Max request-flow steps for the submit scenario.\n  --cdp=http://127.0.0.1:9224          Connect to an existing Chrome CDP endpoint.\n  --port=9224\n  --profile=PATH\n  --keep-open`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
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
  return result?.status === 'pending'
    || result?.ok === false && result?.reason === 'pending'
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

async function waitForLuaRuntime(page, options, timeoutMs = 30000) {
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

async function loadLuaFiles(page, options) {
  await waitForLuaRuntime(page, options);
  for (const file of LUA_FILES) {
    const source = await readFile(resolve(scriptDir, file), 'utf8');
    const result = await callInAxContext(page, options, `async function(source, id) {
      const lua = globalThis._AXSDK?.lua || globalThis._AXLUA;
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
    const lua = globalThis._AXSDK?.lua || globalThis._AXLUA;
    if (!lua) throw new Error('AX Lua runtime is not available');
    if (typeof lua.run === 'function') {
      const result = await lua.run(command, args, { timeoutMs: 90000 });
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

function buttonLabels(step) {
  return (step?.buttons || []).map(button => button.label).filter(Boolean);
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
    const submitButton = buttons.find(button => /(send|submit|quote|request|get quotes?|get estimate|check availability)/i.test(button.label));
    return {
      active: true,
      url,
      text: activeText.slice(0, 320),
      labels,
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

function quoteArgsForStep(step) {
  const radios = (step.labels || []).filter(option => option.type === 'radio');
  if (radios.length > 0) return { value: radios[0].text };
  const checks = (step.labels || []).filter(option => option.type === 'checkbox');
  if (checks.length > 0) return { selections: [checks[0].text] };
  if (step.textareaCount > 0) {
    if (step.safeButton === 'Skip') return {};
    return { text: DEFAULT_QUOTE_MESSAGE };
  }
  return {};
}

async function attemptQuoteSubmitLoginGate(page, before) {
  if (!before?.signedOut) {
    return {
      attempted: false,
      reason: 'refused_signed_out_not_clear',
      before: {
        button: before?.submitButton || null,
        signedOut: before?.signedOut === true,
        loginGate: before?.loginGate === true,
      },
    };
  }
  const click = await evaluatePage(page, `(() => {
    const norm = value => (value || '').replace(/\\s+/g, ' ').trim();
    const active = document.querySelector('[data-test="request-flow-step--active"]');
    if (!active) return { clicked: false, reason: 'no_active_step' };
    const button = [...active.querySelectorAll('button')].find(candidate => {
      const label = norm(candidate.textContent) || candidate.getAttribute('aria-label') || candidate.getAttribute('title') || '';
      return /(send|submit|quote|request|get quotes?|get estimate|check availability)/i.test(label);
    });
    if (!button) return { clicked: false, reason: 'submit_button_not_found' };
    const label = norm(button.textContent) || button.getAttribute('aria-label') || button.getAttribute('title') || '';
    button.click();
    return { clicked: true, label };
  })()`);
  await sleep(5000);
  const after = await readQuoteStep(page);
  return {
    attempted: click.clicked === true,
    click,
    stoppedAtLogin: after.loginGate === true || after.signedOut === true,
    after: {
      active: after.active,
      url: after.url,
      loginGate: after.loginGate,
      signedOut: after.signedOut,
      text: after.text,
      buttons: buttonLabels(after),
    },
  };
}

async function progressQuoteFlow(page, options) {
  const steps = [];
  let finalSubmit = null;
  for (let index = 1; index <= options.maxQuoteSteps; index += 1) {
    const before = await readQuoteStep(page);
    if (!before.active) {
      steps.push({ index, state: 'no_active_step', loginGate: before.loginGate, signedOut: before.signedOut, url: before.url });
      break;
    }
    if (before.loginGate) {
      console.log(`  quote step ${index}: login gate`);
      steps.push({ index, state: 'login_gate', text: before.text, buttons: buttonLabels(before), url: before.url });
      break;
    }
    if (before.submitButton && !before.safeButton) {
      console.log(`  quote step ${index}: submit button ${JSON.stringify(before.submitButton)}`);
      steps.push({ index, state: 'submit_step', button: before.submitButton, signedOut: before.signedOut, loginGate: before.loginGate });
      if (options.submitQuote) finalSubmit = await attemptQuoteSubmitLoginGate(page, before);
      break;
    }
    const args = quoteArgsForStep(before);
    console.log(`  quote step ${index}: ${JSON.stringify((before.text || '').slice(0, 80))} buttons=${JSON.stringify(buttonLabels(before).slice(0, 4))}`);
    const update = await callLuaSettled(page, options, 'AX_update_project', args);
    assertCondition(update?.ok, 'AX_update_project call failed while progressing quote flow', update);
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
    const reason = flow.advance_reason;
    if (after.loginGate) break;
    if (stepChanged) continue;
    if (flow.reached_submit_step === true
      || reason === 'unsafe_advance_button'
      || reason === 'advance_not_confirmed'
      || reason === 'missing_answer'
      || reason === 'answer_not_applied'
      || reason === 'advance_click_failed') {
      if (options.submitQuote && (flow.reached_submit_step === true || reason === 'unsafe_advance_button')) {
        finalSubmit = await attemptQuoteSubmitLoginGate(page, after);
      }
      break;
    }
  }
  const final = await readQuoteStep(page);
  return {
    steps,
    finalSubmit,
    final: {
      active: final.active,
      text: final.text,
      buttons: buttonLabels(final),
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
  const search = await callLuaSettled(page, options, 'AX_search_service', { query: scenario.query, address: scenario.address });
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
    console.log(`[${scenario.name}] Testing AX_view_service service_id=${candidate.service_id}`);
    const view = await callLuaSettled(page, options, 'AX_view_service', { url: candidate.url, service_id: candidate.service_id });
    assertCondition(view?.ok, `[${scenario.name}] AX_view_service call failed`, view);
    assertCondition(Boolean(view.value?.name), `[${scenario.name}] AX_view_service returned no name`, view.value);

    console.log(`[${scenario.name}] Testing AX_request_quote submit=false service_id=${candidate.service_id}`);
    const quote = await callLuaSettled(page, options, 'AX_request_quote', { url: candidate.url, service_id: candidate.service_id, submit: false });
    assertCondition(quote?.ok, `[${scenario.name}] AX_request_quote call failed`, quote);
    assertCondition(quote.value?.status === 'open' || quote.value?.error === 'quote_unavailable', `[${scenario.name}] AX_request_quote returned unexpected state`, quote.value);
    const choiceFields = (quote.value?.form?.fields || []).filter(field => field.type === 'radio' || field.type === 'checkbox');
    if (choiceFields.length > 0) {
      assertCondition(
        choiceFields.every(field => typeof field.text === 'string' && field.text.trim().length > 0),
        `[${scenario.name}] AX_request_quote returned empty choice field text`,
        choiceFields
      );
    }

    selected = { candidate, view: view.value, quote: quote.value };
    if (quote.value?.status === 'open') break;
  }
  assertCondition(Boolean(selected), `[${scenario.name}] no candidate could be viewed`, candidates);

  summary.view_service = {
    service_id: selected.view.service_id,
    name: selected.view.name,
    rating: selected.view.rating,
    services_offered: selected.view.services_offered?.length,
    photos: selected.view.photos?.length,
    request_quote: selected.view.actions?.request_quote,
  };
  summary.request_quote = {
    status: selected.quote?.status,
    error: selected.quote?.error,
    field_count: selected.quote?.form?.fields?.length,
    button_count: selected.quote?.form?.buttons?.length,
  };

  if (selected.quote?.status === 'open') {
    const fullQuote = !options.submitQuote || options.scenarios.length === 1 || scenario.name === options.submitQuoteScenario;
    const quoteOptions = {
      ...options,
      submitQuote: options.submitQuote && fullQuote,
      maxQuoteSteps: fullQuote ? options.maxQuoteSteps : Math.min(options.maxQuoteSteps, 2),
    };
    console.log(`[${scenario.name}] Progressing quote request flow${quoteOptions.submitQuote ? ' with submit/login-gate attempt' : ''}`);
    summary.quote_flow = await progressQuoteFlow(page, quoteOptions);
  } else {
    summary.quote_flow = 'skipped; quote unavailable';
  }

  return summary;
}

async function runTests(page, options) {
  const scenarios = [];
  for (const scenario of options.scenarios) {
    scenarios.push(await runScenario(page, options, scenario));
  }
  const quoteFlows = scenarios.filter(scenario => typeof scenario.quote_flow === 'object');
  assertCondition(quoteFlows.length > 0, 'No scenario opened a quote flow', scenarios);
  if (options.submitQuote) {
    const attempted = quoteFlows.some(scenario => scenario.quote_flow?.finalSubmit?.attempted === true);
    const loginGate = quoteFlows.some(scenario => scenario.quote_flow?.final?.loginGate === true);
    assertCondition(attempted || loginGate, '--submit-quote did not reach a login gate or submit-login attempt', quoteFlows);
  }
  return {
    scenario_count: scenarios.length,
    quote_flow_count: quoteFlows.length,
    submit_quote: options.submitQuote,
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
