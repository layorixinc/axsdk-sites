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
  ['search.11st.co.kr', '11st'],
  ['11st.co.kr', '11st'],
  ['aliexpress.com', 'aliexpress'],
  ['thumbtack.com', 'thumbtack'],
  ['amazon.', 'amazon'],
  ['coupang.com', 'coupang'],
  ['ebay.com', 'ebay'],
  ['etsy.com', 'etsy'],
  ['gmarket.co.kr', 'gmarket'],
  ['shopping.naver.com', 'naver-shopping'],
  ['ssg.com', 'ssg'],
  ['walmart.com', 'walmart'],
  ['bluemoonsoft.com', 'bluemoonsoft'],
];

export const SITE_HOME = {
  '11st': 'https://www.11st.co.kr/',
  aliexpress: 'https://www.aliexpress.com/',
  thumbtack: 'https://www.thumbtack.com/',
  amazon: 'https://www.amazon.com/',
  coupang: 'https://www.coupang.com/',
  ebay: 'https://www.ebay.com/',
  etsy: 'https://www.etsy.com/',
  gmarket: 'https://www.gmarket.co.kr/',
  'naver-shopping': 'https://search.shopping.naver.com/search/all?query=%EC%87%BC%ED%95%91',
  ssg: 'https://www.ssg.com/',
  walmart: 'https://www.walmart.com/',
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
// A target that Chrome destroyed (an extension page after chrome.runtime.reload(), a discarded tab)
// still appears in /json/list, and its WebSocket may never open, error, or close. Without the
// deadline below `ready` never settles and every later send() waits forever, which is how a CLI
// recovery path turns into a silent hang. Requests themselves are deliberately NOT timed out: a
// durable lua.run legitimately keeps one Runtime.evaluate open for minutes; a dropped socket is
// detected instead, and fails every in-flight request at once.
export const CDP_CONNECT_TIMEOUT_MS = 10000;

export class CdpClient {
  constructor(webSocketDebuggerUrl, {
    connectTimeoutMs = CDP_CONNECT_TIMEOUT_MS,
    createSocket = (url) => new WebSocket(url),
  } = {}) {
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.failure = null;
    this.socket = createSocket(webSocketDebuggerUrl);
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(this.fail(new Error(`Timed out attaching to ${webSocketDebuggerUrl} after ${connectTimeoutMs}ms`))),
        connectTimeoutMs,
      );
      const settle = (handler) => (event) => { clearTimeout(timer); handler(event); };
      this.socket.addEventListener('open', settle(resolve), { once: true });
      this.socket.addEventListener('error', settle(() => reject(this.fail(new Error(`Failed to attach to ${webSocketDebuggerUrl}`)))), { once: true });
      this.socket.addEventListener('close', settle(() => reject(this.fail(new Error(`CDP socket closed before attach: ${webSocketDebuggerUrl}`)))), { once: true });
    });
    this.ready.catch(() => { /* surfaced to whoever awaits ready or send() */ });
    this.socket.addEventListener('message', event => this.onMessage(event));
    this.socket.addEventListener('close', () => this.fail(new Error('CDP socket closed')), { once: true });
  }
  /** Records the terminal failure and rejects every in-flight request with it. */
  fail(error) {
    this.failure = this.failure || error;
    for (const callback of this.pending.values()) callback.reject(this.failure);
    this.pending.clear();
    return this.failure;
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
    if (this.failure) throw this.failure;
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

/** Keeps a newly attached page from pinning the Node event loop after setup/reload failure. */
export async function closePageOnFailure(page, operation) {
  try {
    return await operation();
  } catch (error) {
    try { page?.close(); } catch { /* best-effort WebSocket cleanup */ }
    throw error;
  }
}

/** Navigates a newly attached page after an extension reload, closing it if preparation fails. */
export async function prepareReloadedPage(page, {
  destination,
  target,
  extensionId,
  options,
  waitForRuntime = true,
  navigatePage = navigate,
  waitForRuntimeFn = waitForLuaRuntime,
} = {}) {
  return closePageOnFailure(page, async () => {
    await navigatePage(page, destination);
    if (waitForRuntime) await waitForRuntimeFn(page, options, 20000);
    return { page, target, reloaded: true, extensionId, url: destination };
  });
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

// Fire a document navigation and confirm it via the document lifecycle (performance.timeOrigin =
// document identity), not the load event or a URL match (NAVIGATION.md). Returns
// { fired, arrived, kind, url }; a no-op (document + URL unchanged past firedTimeout) reports fired:false.
export async function navigate(page, url, { firedTimeout = 2500, timeout = 20000, interval = 150 } = {}) {
  const before = await navBefore(page);
  const firedAt = Date.now();
  await page.send('Page.navigate', { url });
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const st = await readNavState(page, before);
    if (st.arrived) { await sleep(250); return st; }
    if (!st.pending) return st;
    if (Date.now() - firedAt > firedTimeout && st.url === before.url && !st.contextLost) {
      return { fired: false, arrived: false, kind: 'none', url: before.url };
    }
    await sleep(interval);
  }
  return { fired: true, arrived: false, kind: 'document', url: before.url, timedOut: true };
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

// Capture the current document identity (performance.timeOrigin) + URL before firing a navigation.
async function navBefore(page) {
  return evaluatePage(page, '({ timeOrigin: performance.timeOrigin, url: location.href })')
    .catch(() => ({ timeOrigin: null, url: null }));
}

// Resolve navigation state from web-standard signals only (NAVIGATION.md §3): a changed
// performance.timeOrigin = a fresh document (arrived, kind 'document'); a same-document URL change =
// 'within_document'; otherwise pending. A transient context loss (evaluate throws during a document
// swap) is reported as pending.
async function readNavState(page, before) {
  try {
    const s = await evaluatePage(page, '({ t: performance.timeOrigin, u: location.href })');
    if (!s || typeof s.t !== 'number') return { pending: true };
    if (s.t !== before.timeOrigin) return { fired: true, arrived: true, kind: 'document', url: s.u };
    if (s.u !== before.url) return { fired: true, arrived: true, kind: 'within_document', url: s.u };
    return { pending: true, url: s.u };
  } catch {
    return { pending: true, contextLost: true };
  }
}

// Wait until a fresh document (or same-document URL change) appears after `before`, or timeout. The
// durable nav is async and may commit seconds after lua.run returns; timeOrigin identity detects it
// deterministically and handles same-URL reloads / redirects that a URL comparison misses.
async function waitForArrival(page, before, { timeout = 15000, interval = 200 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const st = await readNavState(page, before);
    if (st.arrived) return st;
    await sleep(interval);
  }
  return null;
}

// Durable run (lua.run), resilient across full-reload navigations (NAVIGATION.md). A Thumbtack full
// reload destroys the execution context mid-run; when a run ends ambiguously (context lost, a
// value-less "completed" turn after a durable nav, or pending) we wait for a fresh document via
// performance.timeOrigin, then read that page with a single-turn call. A value-less completion with no
// navigation is terminal.
export async function run(session, command, args, { timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = { status: 'timeout' };
  for (let turn = 0; turn < 12 && Date.now() < deadline; turn++) {
    const perAttempt = Math.min(20000, Math.max(4000, deadline - Date.now()));
    const before = await navBefore(session.page);
    let result = null;
    let navLost = false;
    try {
      result = await callInAxContext(session.page, session.options, `async function(command, args, perAttempt) {
        const lua = globalThis._AXSDK?.lua || globalThis._AXLUA;
        if (!lua) return { status: 'pending', reason: 'no_runtime' };
        if (typeof lua.run !== 'function') { const r = await lua.call(command, args); return { ok: true, status: 'completed', value: r }; }
        const out = await lua.run(command, args, { timeoutMs: perAttempt, timeout: perAttempt });
        let value = null;
        if (out?.result) { try { value = JSON.parse(out.result); } catch { value = out.result; } }
        return { ok: out?.status === 'completed', status: out?.status, deferId: out?.deferId, value, error: out?.error || (value && value.error) };
      }`, [command, args ?? {}, perAttempt]);
    } catch (error) {
      if (!isContextLostError(error)) throw error;
      navLost = true; // a full reload destroyed the execution context mid-run
      last = { status: 'navigating', reason: 'context_lost' };
    }
    if (result) {
      last = result;
      if (result.value && result.value.error) return result;                        // tool surfaced an error
      if (result.status === 'completed' && result.value != null) return result;      // done, with a value
      if (result.status !== 'completed' && !isPendingResult(result)) return result;  // non-pending terminal
    }
    // A durable nav may be in flight (async — sometimes seconds after lua.run returns). Wait for a fresh
    // document (timeOrigin identity) if one is coming.
    const arrival = await waitForArrival(session.page, before, { timeout: Math.min(15000, Math.max(2000, deadline - Date.now())) });
    // Read the current page with a single-turn call (bypasses the SDK per-execution durable cache, which
    // can serve a value-less result on re-invoke). Retry briefly for runtime readiness right after a nav.
    for (let r = 0; r < 3 && Date.now() < deadline; r++) {
      await waitForLuaRuntime(session.page, session.options, Math.max(2000, deadline - Date.now())).catch(() => {});
      const settled = await call(session, command, args).catch(() => null);
      if (settled && settled.status && settled.status !== 'pending' && settled.pending !== true) {
        return { ok: settled.status === 'completed', status: settled.status, value: settled, error: settled.error || (settled.value && settled.value.error) };
      }
      await sleep(500);
    }
    if (!arrival && !navLost && result && result.status === 'completed') return result; // genuine value-less
  }
  return last;
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
          if (typeof lua.load === 'function') return await lua.load(source, { id, replace: true });
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

// chrome.runtime.reload() destroys every extension page, and the leftover chrome-extension:// target
// can linger in /json/list without ever accepting a WebSocket. Reattach to a live http(s) tab when
// one exists and open a fresh tab otherwise, so a reload never strands the caller on a dead target.
export async function attachAfterExtensionReload(cdpUrl, options, destination, {
  listTargetsFn = listTargets,
  attachActiveFn = attachActive,
  openPageFn = openPage,
} = {}) {
  try {
    const targets = await listTargetsFn(cdpUrl);
    if (pickPageTarget(targets, options.match)) {
      return await attachActiveFn(cdpUrl, options, { match: options.match });
    }
  } catch { /* fall through to a fresh tab */ }
  return { page: await openPageFn(cdpUrl, destination), target: null };
}

// Reload the unpacked extension via chrome.runtime.reload() (fired from its options page), then
// re-attach and land on `url`. It waits for Lua by default; callers that intentionally remove runtime
// credentials may pass waitForRuntime:false to return to the extension setup prompt without a timeout.
// The runtime applies site scripts by scriptId, so same-name edits are sticky (a store re-sync or
// `ax load` may not re-run them); an extension reload re-reads persisted stores fresh.
export async function reloadExtension(cdpUrl, options, { url, waitForRuntime = true } = {}) {
  const extId = options.extensionId;
  const first = await attachActive(cdpUrl, options, { match: options.match, allowBlank: true });
  let dest = url;
  if (!dest) {
    dest = await evaluatePage(first.page, 'location.href').catch(() => null);
    if (!dest || !/^https?:/.test(dest)) dest = SITE_HOME[options.site] || SITE_HOME.thumbtack;
  }
  await navigate(first.page, `chrome-extension://${extId}/options.html`).catch(() => {});
  await sleep(700);
  try { await evaluatePage(first.page, 'setTimeout(function(){ try { chrome.runtime.reload(); } catch (e) {} }, 50); true'); } catch { /* context dies on reload */ }
  try { first.page.close(); } catch { /* ws may already be gone */ }
  await sleep(2800);
  const { page, target } = await attachAfterExtensionReload(cdpUrl, options, dest);
  return prepareReloadedPage(page, {
    destination: dest,
    target,
    extensionId: extId,
    options,
    waitForRuntime,
  });
}

// ── store-based local Lua + flows (build/read -> stores -> remote off) ────────
// Production-faithful alternative to loadLocal(): writes the local working copy into the extension's
// PERSISTED stores and turns OFF the matching remote sources, then reloads so the SDK runs what is in
// the store instead of fetching GitHub. Persisted, so it survives the navigations of a multi-step flow.
//   - Lua:   build per-layer bundles -> `axsdk:lua` (":" = _common, ":"+domain = site); "Use remote
//            site Lua scripts" OFF (`remoteLuaEnabled` -> core `remote_lua=false`). Applied as scriptId
//            `stored-lua:` / `stored-lua:<domain>` (not remote `<site>/scripts/*`).
//   - Flows: read raw `_common/flows.yaml` (":") + `<site>/flows.yaml` (":"+domain) -> `axsdk:flows`;
//            "Use remote sites flows" OFF + "Use saved flows" ON (clientFlows {remoteSites:false, stored:true}).
// The extension owns the sites store; sync publishes the local index into it and fills each record's
// `sitemapMd`, which stored mode otherwise leaves empty because the remote site loader never runs.
export const SITES_STATE_KEY = 'axsdk:sites';
export const LUA_STATE_KEY = 'axsdk:lua';
export const FLOWS_STATE_KEY = 'axsdk:flows';
export const EXTENSION_CONFIG_KEY = 'axsdk:extension:config';

// The extension only activates its assistant on hosts listed in the sites index, and by default that
// index is fetched from GitHub. A site layer that exists only in the working copy therefore never
// activates: no AXSDK Assistant context, no AX_* command, and syncStore cannot even attach. Publishing
// the LOCAL index.md into `axsdk:sites` (and pinning remote sites off) makes the working copy
// authoritative for the dev profile — the same rule the stored Lua/flows path already applies. Written
// from the extension's own options page because the site tab has no runtime yet.
export async function syncSitesIndex(cdpUrl, options, { indexMd, destination, reload = true } = {}) {
  const markdown = indexMd ?? await readFile(join(repoRoot, 'index.md'), 'utf8');
  const envelope = {
    state: {
      index: {
        source: 'local',
        indexUrl: '',
        indexMd: markdown,
        loadedAt: new Date().toISOString(),
        commonFlowsYaml: '',
        commonScripts: [],
        commonWidgets: [],
      },
      sites: {},
    },
    version: 0,
  };

  const { page } = await attachActive(cdpUrl, options, { match: options.match, allowBlank: true });
  let dest = destination;
  try {
    if (!dest) {
      dest = await evaluatePage(page, 'location.href').catch(() => null);
      if (!dest || !/^https?:/.test(dest)) dest = SITE_HOME[options.site] || SITE_HOME.amazon;
    }
    await navigate(page, `chrome-extension://${options.extensionId}/options.html`);
    await evaluatePage(page, `(async () => {
      const sitesKey = ${JSON.stringify(SITES_STATE_KEY)};
      const configKey = ${JSON.stringify(EXTENSION_CONFIG_KEY)};
      await chrome.storage.local.set({ [sitesKey]: ${JSON.stringify(JSON.stringify(envelope))} });
      const stored = (await chrome.storage.local.get(configKey))[configKey];
      const base = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
      await chrome.storage.local.set({ [configKey]: { ...base, remote_sites: false } });
      return true;
    })()`);
  } finally {
    try { page.close(); } catch { /* ws may already be gone */ }
  }

  if (reload) {
    const reloaded = await reloadExtension(cdpUrl, options, { url: dest, waitForRuntime: false });
    try { reloaded.page.close(); } catch { /* ws may already be gone */ }
  }
  return { indexBytes: Buffer.byteLength(markdown, 'utf8'), remoteSitesDisabled: true, destination: dest };
}

// Build dist/_common.lua + dist/<site>.lua via tools/merge-lua.mjs (= npm run build:lua).
export function buildLua({ selfContained = false } = {}) {
  return new Promise((resolveBuild, rejectBuild) => {
    const args = [join(repoRoot, 'tools', 'merge-lua.mjs')];
    if (selfContained) args.push('--self-contained');
    const child = spawn(process.execPath, args, { cwd: repoRoot, stdio: 'inherit' });
    child.on('error', rejectBuild);
    child.on('exit', code => (code === 0 ? resolveBuild() : rejectBuild(new Error(`build:lua exited with code ${code}`))));
  });
}

// The SDK's domain for the current site (from the always-fetched sites index); equals the repo slug.
export async function siteDomain(session, { timeoutMs = 12000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const domain = await callInAxContext(session.page, session.options, `function(){
      const s = globalThis._AXSDK || globalThis.AXSDK;
      try { return s?.getSitesStore?.().getState?.().currentSite?.domain ?? null; } catch { return null; }
    }`).catch(() => null);
    if (domain) return domain;
    await sleep(400);
  }
  return null;
}

// Group listCommands() scriptIds by source so callers can verify which layer served each command.
export function classifyCommandSources(commands) {
  const by = { store: [], remote: [], local: [], builtin: [] };
  for (const c of commands || []) {
    const id = String(c.scriptId || '');
    const bucket = id.startsWith('stored-lua:') ? 'store'
      : /\/scripts\//.test(id) ? 'remote'
      : id.startsWith('ax-local-') ? 'local'
      : 'builtin';
    by[bucket].push(c.command);
  }
  return by;
}

// Build/read local layers -> write flows store + lua store -> disable remote flows & lua -> reload ->
// verify. Flows are injected just before Lua (same store pattern), as raw YAML (no build step).
/**
 * Whether the extension's storage is close enough to its quota that a durable call could fail to
 * persist. Reclaiming at the ceiling is too late: the failure lands mid-flow, after a store was searched.
 */
export function shouldPruneDebugStorage(usedBytes, quotaBytes, threshold = 0.8) {
  if (!Number.isFinite(usedBytes) || !Number.isFinite(quotaBytes) || quotaBytes <= 0) return false;
  return usedBytes / quotaBytes >= threshold;
}

/**
 * What a reclaim should do at this pressure. Telemetry first because it is pure debug data; finished
 * chats only when telemetry did not bring usage back under the mark (they were 4.7 MB of a 10.4 MB fill).
 */
export function reclaimPlan(usedBytes, quotaBytes, usedAfterTelemetry, threshold = 0.8) {
  if (!shouldPruneDebugStorage(usedBytes, quotaBytes, threshold)) return 'none';
  if (usedAfterTelemetry === undefined) return 'telemetry';
  return shouldPruneDebugStorage(usedAfterTelemetry, quotaBytes, threshold) ? 'chats' : 'telemetry';
}

async function storageUsage(session) {
  return callInAxContext(session.page, session.options, `async function(){
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return null;
    return { used: await chrome.storage.local.getBytesInUse(null), quota: chrome.storage.local.QUOTA_BYTES ?? null };
  }`).catch(() => null);
}

/** Reads storage pressure and reclaims what it must; returns null when nothing was needed. */
export async function reclaimDebugStorageIfNeeded(session, { threshold = 0.8 } = {}) {
  const usage = await storageUsage(session);
  if (reclaimPlan(usage?.used, usage?.quota, undefined, threshold) === 'none') return null;

  const telemetry = await pruneDebugStorage(session);
  if (reclaimPlan(usage.used, usage.quota, telemetry.usedAfter, threshold) !== 'chats') {
    return { ...telemetry, usedBefore: usage.used, quota: usage.quota, reclaimed: 'telemetry' };
  }
  const chats = await reclaimChatStorage(session);
  return {
    reclaimed: 'telemetry+chats',
    usedBefore: usage.used,
    quota: usage.quota,
    freedBytes: telemetry.freedBytes + chats.freedBytes,
    removed: telemetry.removed + chats.removed,
    keptChats: chats.kept,
    usedAfter: chats.usedAfter,
  };
}

/**
 * Chat histories that belong to finished sessions. The active chat is never disposable, and without a
 * known active chat nothing is dropped — a wrong guess here deletes what the user is reading.
 */
export function disposableChatKeys(keys, activeKeys) {
  const active = new Set(activeKeys || []);
  if (active.size === 0) return [];
  return (keys || []).filter(key => /:chat$/.test(String(key)) && !active.has(key));
}

/** Frees finished-session chat history; explicit only, never part of an automatic reclaim. */
export async function reclaimChatStorage(session) {
  return callInAxContext(session.page, session.options, `async function() {
    const all = await chrome.storage.local.get(null);
    const chatKeys = Object.keys(all).filter(key => /:chat$/.test(key));
    const state = (globalThis._AXSDK || globalThis.AXSDK);
    const active = [];
    for (const key of chatKeys) {
      const binding = state?.getSession?.()?.id ?? state?.session?.id ?? null;
      if (binding && key.includes(binding)) active.push(key);
    }
    // Keep the largest chat when the active one cannot be identified: it is almost certainly the live one.
    if (active.length === 0 && chatKeys.length > 0) {
      const biggest = chatKeys.map(k => [k, JSON.stringify(all[k] ?? null).length]).sort((a, b) => b[1] - a[1])[0];
      active.push(biggest[0]);
    }
    const doomed = chatKeys.filter(key => !active.includes(key));
    const freedBytes = doomed.reduce((total, key) => total + JSON.stringify(all[key] ?? null).length, 0);
    if (doomed.length > 0) await chrome.storage.local.remove(doomed);
    return { removed: doomed.length, kept: active, freedBytes, usedAfter: await chrome.storage.local.getBytesInUse(null) };
  }`);
}

/** chrome.storage keys that only hold debug telemetry, safe to drop to make room for a store sync. */
export function prunableDebugKeys(keys) {
  return (keys || []).filter(key => /:(sse-events|debug-events)$/.test(String(key)));
}

export function isQuotaError(error) {
  return /quota\s*exceeded|kQuotaBytes|QUOTA_BYTES/i.test(String(error?.message || error || ''));
}

/** Drops the disposable telemetry keys from the extension's storage and reports what it freed. */
export async function pruneDebugStorage(session) {
  return callInAxContext(session.page, session.options, `async function(pattern) {
    const all = await chrome.storage.local.get(null);
    const doomed = Object.keys(all).filter(key => new RegExp(pattern).test(key));
    const freedBytes = doomed.reduce((total, key) => total + JSON.stringify(all[key] ?? null).length, 0);
    if (doomed.length > 0) await chrome.storage.local.remove(doomed);
    return { removed: doomed.length, freedBytes, usedAfter: await chrome.storage.local.getBytesInUse(null) };
  }`, [':(sse-events|debug-events)$']);
}

export async function syncStore(session, { site, build = true, reload = true } = {}) {
  if (build) await buildLua();
  const url = await currentUrl(session);
  const slug = site || siteForUrl(url);
  if (!slug) throw new Error(`cannot determine site for "${url}"; pass { site }`);
  const distDir = join(repoRoot, 'dist');
  const readDist = async name => {
    try { return await readFile(join(distDir, name), 'utf8'); }
    catch { throw new Error(`dist/${name} missing — run "npm run build:lua" first`); }
  };
  const readMaybe = async path => { try { return await readFile(path, 'utf8'); } catch { return ''; } };
  const commonLua = await readDist('_common.lua');
  const commonFlows = await readMaybe(join(repoRoot, '_common', 'flows.yaml'));
  // Remote Lua/flows are OFF in stored mode, so the store must carry EVERY published site (not just the
  // one being synced) — otherwise a cross-site flow (e.g. bluemoonsoft -> shopping/amazon) lands on a
  // site whose Lua is absent and a durable call fails "command unavailable". Slug == SDK domain (AGENTS §6).
  const siteSlugs = (await readdir(distDir)).filter(f => f.endsWith('.lua') && f !== '_common.lua').map(f => f.slice(0, -4)).sort();
  const lua = { ':': commonLua };
  const flows = { ':': commonFlows };
  for (const s of siteSlugs) {
    lua[':' + s] = await readDist(`${s}.lua`);
    const sf = await readMaybe(join(repoRoot, s, 'flows.yaml'));
    if (sf && sf.trim()) flows[':' + s] = sf;
  }
  await waitForLuaRuntime(session.page, session.options);
  const domain = (await siteDomain(session)) || slug;
  // Every published site's sitemap.md. Stored mode turns the remote site loader OFF, so the site record
  // the extension keeps is a stub — `scripts: 0`, `flowsYaml: 0`, `sitemapMd: 0`, and no errors, because
  // nothing tried to fetch. Lua and flows are delivered here instead; the sitemap was not, and
  // `sitemap.search_site` then answered from the app's site INDEX (its documented fallback), so the
  // bluemoonsoft flow resolved every request to lines about other sites and navigated home. Measured
  // live: `currentSitemap` 0 bytes while `index.indexMd` held 1507.
  const sitemaps = {};
  for (const s of siteSlugs) {
    const md = await readMaybe(join(repoRoot, s, 'sitemap.md'));
    if (md && md.trim()) sitemaps[s] = md;
  }
  // Write flows + lua stores (ALL sites) and pin remote OFF / stored ON — from the content-script context.
  const writeStores = () => callInAxContext(session.page, session.options, `async function(lua, flows, sitemaps, here, luaKey, flowsKey, cfgKey, sitesKey) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      throw new Error('chrome.storage.local unavailable in this context');
    }
    await chrome.storage.local.set({ [flowsKey]: JSON.stringify({ state: { flows }, version: 0 }) });
    await chrome.storage.local.set({ [luaKey]: JSON.stringify({ state: { lua }, version: 0 }) });
    // MERGE into the sites store: the extension owns those records and only the sitemap is ours to fill.
    let sitemapKeys = [];
    const rawSites = (await chrome.storage.local.get(sitesKey))?.[sitesKey];
    const parsedSites = typeof rawSites === 'string' ? JSON.parse(rawSites) : rawSites;
    if (parsedSites?.state?.sites) {
      const state = parsedSites.state;
      for (const [slug, markdown] of Object.entries(sitemaps)) {
        if (!state.sites[slug]) continue;
        state.sites[slug] = { ...state.sites[slug], sitemapMd: markdown };
        sitemapKeys.push(slug);
      }
      if (state.currentSite && sitemaps[state.currentSite.domain]) {
        state.currentSite = { ...state.currentSite, sitemapMd: sitemaps[state.currentSite.domain] };
        state.currentSitemap = sitemaps[state.currentSite.domain];
      } else if (sitemaps[here]) {
        state.currentSitemap = sitemaps[here];
      }
      await chrome.storage.local.set({ [sitesKey]: JSON.stringify(parsedSites) });
    }
    const got = await chrome.storage.local.get(cfgKey);
    const cfg = (got && got[cfgKey] && typeof got[cfgKey] === 'object') ? got[cfgKey] : {};
    await chrome.storage.local.set({ [cfgKey]: { ...cfg, remoteLuaEnabled: false, remoteSiteFlowsEnabled: false, storedFlowsEnabled: true } });
    return { luaKeys: Object.keys(lua), flowsKeys: Object.keys(flows), sitemapKeys, hadConfig: Boolean(got && got[cfgKey]) };
  }`, [lua, flows, sitemaps, domain, LUA_STATE_KEY, FLOWS_STATE_KEY, EXTENSION_CONFIG_KEY, SITES_STATE_KEY]);

  let written;
  let reclaimed = null;
  try {
    written = await writeStores();
  } catch (error) {
    // A long-lived dev profile fills chrome.storage.local with per-session chat + SSE telemetry until no
    // sync fits. The telemetry is disposable; chat history and every axsdk:* store are left alone.
    if (!isQuotaError(error)) throw error;
    reclaimed = await pruneDebugStorage(session);
    written = await writeStores();
  }
  let verify = null;
  let flowsCfg = null;
  if (reload) {
    await navigate(session.page, url); // reload -> boot() rehydrates stores + applies stored scripts/flows
    await waitForLuaRuntime(session.page, session.options);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      verify = classifyCommandSources(await listCommands(session));
      if (verify.store.length > 0 && verify.remote.length === 0) break;
      await sleep(500);
    }
    flowsCfg = await callInAxContext(session.page, session.options, `function(){
      const s = globalThis._AXSDK || globalThis.AXSDK;
      let cf = null; try { cf = s?.config?.clientFlows ?? null; } catch {}
      let keys = []; try { keys = Object.keys(s?.getFlowsStore?.().getState?.().flows ?? {}); } catch {}
      return { clientFlows: cf, flowsStoreKeys: keys };
    }`).catch(() => null);
  }
  return {
    site: slug,
    domain,
    luaStoreKeys: written.luaKeys,
    sitemapKeys: written.sitemapKeys,
    flowsStoreKeys: written.flowsKeys,
    remoteLuaDisabled: true,
    remoteFlowsDisabled: true,
    storedFlowsEnabled: true,
    hadExistingConfig: written.hadConfig,
    ...(reclaimed ? { reclaimedDebugStorage: reclaimed } : {}),
    ...(verify ? { fromStore: verify.store.length, fromRemote: verify.remote.length, sources: verify } : {}),
    ...(flowsCfg ? { appliedClientFlows: flowsCfg.clientFlows, appliedFlowsStoreKeys: flowsCfg.flowsStoreKeys } : {}),
  };
}

// Read a compact chat-store snapshot (status + last message parts). Re-finds the AXSDK context per
// call, so polling with it tolerates the flow's mid-turn page navigations.
export async function readChat(session) {
  return callInAxContext(session.page, session.options, `function() {
    const s = globalThis._AXSDK || globalThis.AXSDK;
    const chat = s && s.getChatStore && s.getChatStore();
    if (!chat) return null;
    const st = chat.getState();
    const status = st.status || (st.session && st.session.status) || (st.isBusy || st.busy ? 'busy' : 'idle');
    const msgs = st.messages || [];
    const parseOut = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return v; } };
    const last = msgs[msgs.length - 1] || {};
    const parts = (last.parts || []).map(p => {
      if (p.type === 'text') return { type: 'text', text: p.text };
      if (p.type === 'tool' || p.tool || p.toolName) return { type: 'tool', tool: p.tool || p.toolName, status: p.state && p.state.status, output: parseOut(p.state ? p.state.output : p.output) };
      return { type: p.type };
    });
    return { status, messageCount: msgs.length, parts };
  }`);
}

// Drive the flow ENGINE: send a user message, then poll the chat store FROM NODE (re-finding the
// context each read so it survives the flow's navigations) until the assistant turn settles. Returns
// the assistant reply text + the last message's tool/text parts.
export async function sendMessage(session, text, { timeoutMs = 180000 } = {}) {
  // A turn writes chat + SSE telemetry as it runs; starting one with storage already near the quota
  // makes a durable call fail to persist mid-navigation and silently costs the flow a whole store.
  await reclaimDebugStorageIfNeeded(session).catch(() => null);
  const before = (await readChat(session).catch(() => null))?.messageCount ?? 0;
  await callInAxContext(session.page, session.options, `async function(text) {
    const s = globalThis._AXSDK || globalThis.AXSDK;
    if (!s || typeof s.sendMessage !== 'function') throw new Error('AXSDK.sendMessage is not available');
    await s.sendMessage(text);
    return true;
  }`, [text]);
  const deadline = Date.now() + timeoutMs;
  let sawBusy = false, idleStreak = 0, snap = null;
  while (Date.now() < deadline) {
    await sleep(1000);
    const s = await readChat(session).catch(() => null);
    if (!s) { idleStreak = 0; continue; }       // context lost mid-navigation; retry
    snap = s;
    if (s.status === 'busy') { sawBusy = true; idleStreak = 0; } else idleStreak += 1;
    if (s.messageCount >= before + 2 && (sawBusy || idleStreak >= 5) && idleStreak >= 2) break;
  }
  const reply = (snap?.parts || []).filter(p => p.type === 'text').map(p => p.text).filter(Boolean).join('\n');
  return { status: snap?.status, messageCount: snap?.messageCount, reply, parts: snap?.parts };
}
