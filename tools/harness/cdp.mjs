// Shared, site-agnostic CDP harness for driving the AXSDK extension's Lua runtime over the
// Chrome DevTools Protocol. This is the single source of truth for "connect to the dev Chrome,
// find the AXSDK Assistant context, and run/load Lua" — ported from the proven plumbing in
// thumbtack/scripts/test_thumbtack_lua.mjs. No site-specific logic lives here.
//
// Consumed by tools/ax.mjs (the daily CLI). The heavy E2E scenario runner
// (thumbtack/scripts/test_thumbtack_lua.mjs) still carries its own copy of these primitives and is
// a candidate to migrate onto this module later.

import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..', '..');

// Canonical dev-Chrome configuration. Every knob is overridable via env so the CLI, the E2E
// harness, and a developer's shell all converge on ONE Chrome instance/port (default 9224).
export const DEFAULTS = {
  extensionId: process.env.AXSDK_EXTENSION_ID || 'dldlgmekahifbogjphgglkhibclglmpf',
  chrome: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  profile: process.env.CHROME_PROFILE || `${process.env.LOCALAPPDATA || ''}/AXSDKSitesChromeDevProfile`,
  port: Number(process.env.CDP_PORT || 9224),
  // Unpacked extension build (sibling repo). When present, launchChrome loads it so a fresh profile
  // still gets the extension; an existing dev profile already persists it.
  extensionPath: process.env.AXSDK_EXTENSION_PATH
    || resolve(repoRoot, '..', 'axsdk-sdk-js', 'packages', 'axsdk-extension', 'dist'),
};

// host substring -> published site slug (a top-level dir with scripts/). Mirrors index.md.
const SITE_HOSTS = [
  ['thumbtack.com', 'thumbtack'],
  ['amazon.', 'amazon'],
  ['bluemoonsoft.com', 'bluemoonsoft'],
];

export const SITE_HOME = {
  thumbtack: 'https://www.thumbtack.com/',
  amazon: 'https://www.amazon.com/',
  bluemoonsoft: 'http://bluemoonsoft.com/',
};

export function siteForUrl(url) {
  const host = String(url || '').match(/^https?:\/\/([^/]+)/)?.[1] || '';
  for (const [needle, slug] of SITE_HOSTS) if (host.includes(needle)) return slug;
  return null;
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// ── Chrome lifecycle ────────────────────────────────────────────────────────
export async function endpointIsReady(cdpUrl) {
  try {
    await fetchJson(`${cdpUrl}/json/version`);
    return true;
  } catch {
    return false;
  }
}

export async function waitForEndpoint(cdpUrl, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await endpointIsReady(cdpUrl)) return true;
    await sleep(250);
  }
  throw new Error(`Chrome CDP endpoint did not become ready: ${cdpUrl}`);
}

// Detached so the launched dev Chrome OUTLIVES the CLI process and can be reused by later commands.
// --remote-allow-origins=* is required for the Node WebSocket client to attach.
export function launchChrome({ chrome, port, profile, extensionPath, url = 'about:blank' } = {}) {
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
  ];
  if (extensionPath && existsSync(extensionPath)) {
    args.push(`--load-extension=${extensionPath}`, '--disable-features=DisableLoadExtensionCommandLineSwitch');
  }
  args.push(url);
  const child = spawn(chrome, args, { stdio: 'ignore', detached: true });
  child.unref();
  return child;
}

export async function listTargets(cdpUrl) {
  return fetchJson(`${cdpUrl}/json/list`);
}

async function createTarget(cdpUrl, url) {
  const encoded = encodeURIComponent(url);
  try {
    return await fetchJson(`${cdpUrl}/json/new?${encoded}`, { method: 'PUT' });
  } catch {
    return fetchJson(`${cdpUrl}/json/new?${encoded}`);
  }
}

// Most-recent page tab (CDP lists newest first). http(s) only; pass `match` to target by url substring.
export function pickPageTarget(targets, match) {
  const pages = (targets || []).filter(t => t.type === 'page' && /^https?:/.test(t.url || ''));
  if (match) return pages.find(t => (t.url || '').includes(match)) || null;
  return pages[0] || null;
}

// ── CDP client (one WebSocket per tab) ────────────────────────────────────────
export class CdpClient {
  constructor(webSocketDebuggerUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket = new WebSocket(webSocketDebuggerUrl);
    this.ready = new Promise((res, rej) => {
      this.socket.addEventListener('open', res, { once: true });
      this.socket.addEventListener('error', rej, { once: true });
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
    const promise = new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }
  waitFor(method, predicate = () => true, timeoutMs = 30000) {
    return new Promise((res, rej) => {
      const timeout = setTimeout(() => { off(); rej(new Error(`Timed out waiting for ${method}`)); }, timeoutMs);
      const off = this.on(method, params => {
        if (!predicate(params)) return;
        clearTimeout(timeout);
        off();
        res(params);
      });
    });
  }
  close() {
    this.socket.close();
  }
}

async function attachClient(webSocketDebuggerUrl) {
  const page = new CdpClient(webSocketDebuggerUrl);
  await page.ready;
  await page.send('Page.enable');
  // Auto-accept beforeunload/alert dialogs (unsaved quote/form state blocks navigation otherwise).
  page.on('Page.javascriptDialogOpening', () => {
    page.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => null);
  });
  await page.send('Runtime.enable');
  return page;
}

export async function openPage(cdpUrl, url) {
  const target = await createTarget(cdpUrl, url);
  const page = await attachClient(target.webSocketDebuggerUrl);
  await page.send('Page.bringToFront').catch(() => null);
  return page;
}

export async function navigate(page, url) {
  const loaded = page.waitFor('Page.loadEventFired', () => true, 10000).catch(() => null);
  await page.send('Page.navigate', { url });
  await loaded;
  await sleep(500);
}

// ── AXSDK Assistant context + Lua runtime ─────────────────────────────────────
export async function findAxContext(page, extensionId, timeoutMs = 15000) {
  const contexts = [];
  const off = page.on('Runtime.executionContextCreated', event => contexts.push(event.context));
  await page.send('Runtime.disable').catch(() => null);
  await page.send('Runtime.enable');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const context = contexts.find(c => c.name === 'AXSDK Assistant' && c.origin === `chrome-extension://${extensionId}`);
    if (context) { off(); return context; }
    await sleep(100);
  }
  off();
  throw new Error(`AXSDK Assistant execution context not found for extension ${extensionId} (open a site tab with the extension loaded, in debug mode)`);
}

export async function callInAxContext(page, options, functionDeclaration, args = []) {
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

export async function evaluatePage(page, expression) {
  const result = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}

export async function waitForLuaRuntime(page, options, timeoutMs = 12000) {
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

export function isContextLostError(error) {
  const message = String(error?.message || error || '');
  return message.includes('Cannot find context with specified id')
    || message.includes('Execution context was destroyed')
    || message.includes('Cannot find execution context')
    || message.includes('Inspected target navigated')
    || message.includes('Target closed');
}

export function isPendingResult(result) {
  return result?.status === 'pending'
    || (result?.ok === false && result?.reason === 'pending')
    || result?.value?.pending === true
    || result?.value?.error === 'navigation_pending'
    || result?.value?.error === 'pending';
}

// ── High-level session API (what the CLI uses) ────────────────────────────────
export function resolveOptions(overrides = {}) {
  const options = { ...DEFAULTS, ...overrides };
  options.cdp = overrides.cdp || `http://127.0.0.1:${options.port}`;
  return options;
}

// Make sure a dev Chrome is reachable; launch it (detached) when it is not and launch !== false.
export async function ensureChrome(options, { launch = true } = {}) {
  const cdpUrl = options.cdp || `http://127.0.0.1:${options.port}`;
  let launched = null;
  if (!(await endpointIsReady(cdpUrl))) {
    if (!launch) throw new Error(`No Chrome CDP on ${cdpUrl}. Start it with "ax chrome".`);
    launched = launchChrome({ ...options, url: options.openUrl || 'about:blank' });
    await waitForEndpoint(cdpUrl);
    await sleep(800);
  }
  return { cdpUrl, launched };
}

// Attach to the active site tab (newest http page). allowBlank also accepts an about:blank tab
// (used by `open` so a freshly launched Chrome can be navigated).
export async function attachActive(cdpUrl, options, { match, allowBlank = false } = {}) {
  const targets = await listTargets(cdpUrl);
  let target = pickPageTarget(targets, match);
  if (!target && allowBlank) target = targets.find(t => t.type === 'page') || null;
  if (!target) throw new Error('No open site tab. Run "ax open <site>" first (e.g. ax open thumbtack).');
  const page = await attachClient(target.webSocketDebuggerUrl);
  return { page, target };
}

// Durable run (lua.run) — handles nav/reload-driven flows. Returns { ok, status, deferId, value, error }.
export async function run(session, command, args, { timeoutMs = 60000 } = {}) {
  return callInAxContext(session.page, session.options, `async function(command, args, timeoutMs) {
    const lua = globalThis._AXSDK?.lua || globalThis._AXLUA;
    if (!lua) throw new Error('AX Lua runtime is not available');
    if (typeof lua.run !== 'function') { const r = await lua.call(command, args); return { ok: true, status: 'completed', value: r }; }
    const result = await lua.run(command, args, { timeoutMs, timeout: timeoutMs });
    let value = null;
    if (result?.result) { try { value = JSON.parse(result.result); } catch { value = result.result; } }
    return { ok: result?.status === 'completed', status: result?.status, deferId: result?.deferId, value, error: result?.error || (value && value.error) };
  }`, [command, args ?? {}, timeoutMs]);
}

// Single Lua turn (lua.call) — read-only / no-navigation checks; navigating steps return a pending marker.
export async function call(session, command, args) {
  return callInAxContext(session.page, session.options, `async function(command, args) {
    const lua = globalThis._AXSDK?.lua || globalThis._AXLUA;
    if (!lua) throw new Error('AX Lua runtime is not available');
    return await lua.call(command, args);
  }`, [command, args ?? {}]);
}

export async function listCommands(session) {
  return callInAxContext(session.page, session.options, `function(){ const lua=globalThis._AXSDK?.lua||globalThis._AXLUA; return lua?.listCommands?.() ?? null; }`);
}

export async function status(session) {
  return callInAxContext(session.page, session.options, `function(){ const lua=globalThis._AXSDK?.lua||globalThis._AXLUA; return lua?.status?.() ?? null; }`);
}

export async function currentUrl(session) {
  return evaluatePage(session.page, 'location.href');
}

async function discoverLua(dir) {
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter(f => f.endsWith('.lua')).sort();
  return files.map(f => join(dir, f));
}

// Inject the LOCAL working-copy Lua into the live runtime (in-memory) — bypasses the git-push +
// raw.githubusercontent cache + extension-reload loop documented in DEVTOOLS.md §5. Loads
// _common/scripts/* first, then <site>/scripts/* (filename order), matching the extension's order.
// Overrides are lost on the next full navigation (re-run `ax load`).
export async function loadLocal(session, { site } = {}) {
  await waitForLuaRuntime(session.page, session.options);
  const slug = site || siteForUrl(await currentUrl(session));
  const dirs = [join(repoRoot, '_common', 'scripts')];
  if (slug) dirs.push(join(repoRoot, slug, 'scripts'));
  const loaded = [];
  const failed = [];
  for (const dir of dirs) {
    for (const file of await discoverLua(dir)) {
      const source = await readFile(file, 'utf8');
      const id = `ax-local-${basename(file)}-${Date.now()}`;
      try {
        const result = await callInAxContext(session.page, session.options, `async function(source, id) {
          const lua = globalThis._AXSDK?.lua || globalThis._AXLUA;
          if (!lua) throw new Error('AX Lua runtime is not available');
          if (typeof lua.load === 'function') return await lua.load(source, { id });
          return await lua.loadSiteScript(source, { id, replace: true, kind: 'devtools' });
        }`, [source, id]);
        if (!result?.ok && result?.status !== 'loaded') throw new Error(JSON.stringify(result));
        loaded.push(basename(file));
      } catch (error) {
        failed.push({ file: basename(file), error: String(error?.message || error) });
      }
    }
  }
  return { site: slug, loaded, failed };
}
