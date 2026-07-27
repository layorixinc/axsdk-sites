#!/usr/bin/env node

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';

import {
  attachActive,
  call,
  callInAxContext,
  classifyCommandSources,
  currentUrl,
  ensureChrome,
  evaluatePage,
  openPage,
  listCommands,
  navigate,
  reloadExtension,
  run,
  sendMessage,
  status,
  waitForLuaRuntime,
} from './harness/cdp.mjs';
import {
  PLAYGROUND_STATE_KEY,
  SITES_STATE_KEY,
  FLOWS_STATE_KEY,
  LUA_STATE_KEY,
  WIDGETS_STATE_KEY,
  EXTENSION_CONFIG_KEY,
  readPlaygroundSnapshot,
  syncPlaygroundStores,
  verifyPlaygroundSnapshot,
} from './playground/store.mjs';
import {
  PLAYGROUND_USAGE,
  parseCliArguments,
  resolvePlaygroundOptions,
} from './playground/cli.mjs';
import {
  CREDENTIAL_ENV_KEYS,
  describeExtensionCredentialPatch,
  loadExtensionCredentials,
} from './playground/credentials.mjs';
import { runPlaygroundRepl } from './playground/repl.mjs';
import { waitForStoredActivation } from './playground/runtime.mjs';
import { initializePlaygroundProfile, waitForUserExtensionSetup } from './playground/setup.mjs';
import { loadWorkspace, parseLocalSitesIndex } from './playground/sources.mjs';

const RESET_KEYS = [
  SITES_STATE_KEY,
  FLOWS_STATE_KEY,
  LUA_STATE_KEY,
  WIDGETS_STATE_KEY,
  PLAYGROUND_STATE_KEY,
  EXTENSION_CONFIG_KEY,
];

function output(value) {
  if (value === undefined) return;
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

function closePage(page) {
  try { page?.close(); } catch { /* CDP socket may be invalid after a reload */ }
}

/**
 * Rewrites `axsdk:extension:config` from the local `.env` through the extension's own options page,
 * then reloads the extension so the content script picks the configuration up. A cold Chrome start
 * drops the command-line-loaded extension's storage, so this is the normal recovery path rather than
 * an exceptional one. The patch is written straight into the browser profile and never printed.
 */
async function restoreExtensionCredentials(cdpUrl, options) {
  const credentials = await loadExtensionCredentials({ root: options.root });
  if (credentials.missing.length > 0) {
    return { restored: false, missing: credentials.missing, envFile: credentials.envFile };
  }

  const { page } = await attachActive(cdpUrl, options, { match: options.match, allowBlank: true });
  try {
    await navigate(page, `chrome-extension://${options.extensionId}/options.html`);
    await evaluatePage(page, `(async () => {
      const key = ${JSON.stringify(EXTENSION_CONFIG_KEY)};
      const patch = ${JSON.stringify(credentials.patch)};
      const stored = (await chrome.storage.local.get(key))[key];
      const base = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
      await chrome.storage.local.set({ [key]: { ...base, ...patch } });
      return true;
    })()`);
  } finally {
    closePage(page);
  }

  const reloaded = await reloadExtension(cdpUrl, options, { url: options.home, waitForRuntime: false });
  closePage(reloaded.page);
  return {
    restored: true,
    envFile: credentials.envFile,
    config: describeExtensionCredentialPatch(credentials.patch),
  };
}

function runtimeUnavailableError(error, restoration) {
  const detail = restoration.restored
    ? `Extension configuration was restored from ${restoration.envFile}, but the runtime stayed unavailable.`
    : restoration.missing?.length
      ? `Automatic restore needs ${restoration.missing.map((field) => CREDENTIAL_ENV_KEYS[field]).join(', ')} in .env or the environment.`
      : restoration.error
        ? `Automatic restore failed: ${restoration.error}`
        : '';
  return new Error(
    `AXSDK Assistant runtime is unavailable in the playground profile. ${detail} Configure the isolated extension Options with nonempty development credentials and Debug logging, then retry. ${error?.message || error}`
      .replace(/\s+/g, ' '),
  );
}

async function attachPlaygroundSession(options, { forceHome = false, restoreCredentials = true } = {}) {
  const { cdpUrl } = await ensureChrome({ ...options, openUrl: options.home }, { launch: options.launch });
  const attempt = async () => {
    const { page } = await attachActive(cdpUrl, options, { match: options.match, allowBlank: true });
    const session = { page, options, cdpUrl };
    try {
      const url = await currentUrl(session).catch(() => '');
      if (forceHome || !/^https?:\/\//.test(url)) await navigate(page, options.home);
      await waitForLuaRuntime(page, options, 20000);
      return session;
    } catch (error) {
      closePage(page);
      throw error;
    }
  };

  try {
    return await attempt();
  } catch (error) {
    if (!restoreCredentials) throw runtimeUnavailableError(error, { restored: false });
    const restoration = await restoreExtensionCredentials(cdpUrl, options)
      .catch((failure) => ({ restored: false, error: String(failure?.message || failure) }));
    if (!restoration.restored) throw runtimeUnavailableError(error, restoration);
    try {
      return await attempt();
    } catch (retryError) {
      throw runtimeUnavailableError(retryError, restoration);
    }
  }
}

async function withPlaygroundSession(options, operation, { forceHome = false } = {}) {
  const session = await attachPlaygroundSession(options, { forceHome });
  try {
    return await operation(session);
  } finally {
    closePage(session.page);
  }
}

async function readOwnership(session) {
  return callInAxContext(session.page, session.options, `async function(stampKey) {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      throw new Error('chrome.storage.local unavailable in this context');
    }
    if (typeof chrome.storage.local.getKeys !== 'function') {
      throw new Error('Chrome storage getKeys is required for secret-safe playground ownership checks');
    }
    const keys = await chrome.storage.local.getKeys();
    const stamp = (await chrome.storage.local.get(stampKey))[stampKey] ?? null;
    return {
      stamp,
      axsdkKeys: keys.filter((key) => key.startsWith('axsdk:')),
    };
  }`, [PLAYGROUND_STATE_KEY]);
}

async function assertSafeOwnership(session, options) {
  const ownership = await readOwnership(session);
  if (ownership.stamp?.version === 1) return ownership;
  if (ownership.axsdkKeys.length === 0) return ownership;
  if (options.adopt) return ownership;
  throw new Error(
    `Refusing nonempty unstamped profile. Existing AXSDK keys: ${ownership.axsdkKeys.join(', ')}. Use --adopt only for the dedicated playground profile.`,
  );
}

function workspaceSummary(workspace) {
  return {
    root: workspace.root,
    indexDomains: workspace.index.domains,
    indexDigest: workspace.indexDigest,
    widgetsDigest: workspace.widgetsDigest,
    sourceDigest: workspace.sourceDigest,
    flows: Object.keys(workspace.flows),
    lua: Object.keys(workspace.lua),
    layers: workspace.layers,
  };
}

async function syncWorkspace(options) {
  const workspace = await loadWorkspace(options.root);
  const session = await attachPlaygroundSession(options, { forceHome: true });
  try {
    await assertSafeOwnership(session, options);
    const result = await syncPlaygroundStores(session, workspace, { home: options.home });
    return { workspace, receipt: result, session: result.session };
  } catch (error) {
    closePage(session.page);
    throw error;
  }
}

async function verifySavedRuntime(options) {
  const workspace = await loadWorkspace(options.root);
  return withPlaygroundSession(options, async (session) => {
    await waitForStoredActivation(() => readPlaygroundSnapshot(session), {
      expectedDomain: null,
      requireCommonLua: Object.hasOwn(workspace.lua, ':'),
      timeoutMs: Math.min(20_000, options.timeout),
    });
    const snapshot = await readPlaygroundSnapshot(session);
    const receipt = verifyPlaygroundSnapshot(snapshot, workspace, {
      home: options.home,
      allowLazyLocalSites: true,
    });
    return {
      ...receipt,
      url: await currentUrl(session),
      activeDomain: snapshot.runtime.currentSite?.domain ?? null,
      lua: await status(session),
    };
  }, { forceHome: true });
}

function expectedDomain(indexMd, url) {
  const hostname = new URL(url).hostname;
  return parseLocalSitesIndex(indexMd).find((entry) => entry.hostname === hostname)?.domain ?? null;
}

async function openUrl(options, url) {
  if (!/^https?:\/\//.test(url)) throw new Error('Only HTTP(S) URLs may be opened');
  const workspace = await loadWorkspace(options.root);
  return withPlaygroundSession(options, async (session) => {
    await navigate(session.page, url);
    await waitForLuaRuntime(session.page, options, 20000);
    const opened = await currentUrl(session);
    const expected = expectedDomain(workspace.index.raw, opened);
    const requireCommonLua = Object.hasOwn(workspace.lua, ':');
    const requireSiteLua = expected !== null && Object.hasOwn(workspace.lua, `:${expected}`);
    const activation = await waitForStoredActivation(
      () => readPlaygroundSnapshot(session),
      {
        expectedDomain: expected,
        requireCommonLua,
        requireSiteLua,
        timeoutMs: Math.min(20_000, options.timeout),
      },
    );
    return { opened, activeDomain: activation.activeDomain, sources: activation.sources };
  });
}

async function readPage(session, options) {
  const url = await currentUrl(session);
  const result = await run(session, 'AX_read_page', { mode: 'auto', max_chars: 1500 }, { timeoutMs: options.timeout })
    .catch((error) => ({ error: String(error?.message || error) }));
  return { url, read: result?.value ?? result };
}

async function resetPlayground(options, { confirmed = false } = {}) {
  if (!confirmed) throw new Error('reset requires --yes or typed RESET confirmation');
  return withPlaygroundSession(options, async (session) => {
    await assertSafeOwnership(session, options);
    await callInAxContext(session.page, session.options, `async function(keys) {
      await chrome.storage.local.remove(keys);
      return keys;
    }`, [RESET_KEYS]);
    const reloaded = await reloadExtension(session.cdpUrl, options, {
      url: options.home,
      waitForRuntime: false,
    });
    closePage(reloaded.page);
    return { reset: true, removed: RESET_KEYS };
  }, { forceHome: true });
}

async function stopPlayground(options, { confirmed = false } = {}) {
  if (!confirmed) throw new Error('stop requires typed STOP confirmation');
  const session = await attachPlaygroundSession(options);
  try {
    await assertSafeOwnership(session, options);
    await session.page.send('Browser.close');
    return { stopped: true, cdp: session.cdpUrl };
  } finally {
    closePage(session.page);
  }
}

async function createWorkspace(root) {
  let entries;
  try {
    entries = await readdir(root);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    entries = [];
  }
  if (entries.length > 0) throw new Error(`Refusing to initialize nonempty workspace: ${root}`);
  await mkdir(join(root, '_common', 'scripts'), { recursive: true });
  await writeFile(join(root, 'index.md'), '# Local sites\n\n- [Example](https://example.com): [`example`](example)\n', 'utf8');
  await writeFile(join(root, '_common', 'flows.yaml'), 'extends: app\ndefaults:\n  mapping: legacy\nflows: {}\n', 'utf8');
  await writeFile(join(root, '_common', 'scripts', '00_playground.lua'), 'function AX_playground_common_ping(args)\n  return { layer = "common" }\nend\n', 'utf8');
  return { initialized: root };
}

function setupInstructions(options, profile) {
  return [
    'Opened headed Chrome for manual AXSDK extension setup.',
    `Profile: ${profile.profile}`,
    `Extension directory: ${options.extensionPath}`,
    '1. At chrome://extensions, enable Developer mode and Load unpacked from the directory above.',
    `2. Return here and press Enter. Development credentials are restored from .env (${Object.values(CREDENTIAL_ENV_KEYS).join(', ')}); enter them in the extension Options only when that file is unavailable.`,
    '3. Type quit to cancel without changing extension settings.',
  ].join('\n');
}

async function setupExtension(options) {
  const profile = await initializePlaygroundProfile(options.profile);
  const launchOptions = {
    ...options,
    extensionPath: null,
    openUrl: 'chrome://extensions/',
  };
  const { cdpUrl } = await ensureChrome(launchOptions, { launch: options.launch });
  const extensionsPage = await openPage(cdpUrl, 'chrome://extensions/');
  const page = await openPage(cdpUrl, options.home);
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    output(setupInstructions(options, profile));
    let restoration = null;
    const runtime = await waitForUserExtensionSetup({
      prompt: (message) => readline.question(message),
      // The operator installs the unpacked extension; its development configuration comes from the
      // local .env so the same values survive every later cold start.
      prepareRuntime: async () => {
        await navigate(page, options.home);
        try {
          return await waitForLuaRuntime(page, options, 20_000);
        } catch (error) {
          restoration = await restoreExtensionCredentials(cdpUrl, options);
          if (!restoration.restored) throw error;
          await navigate(page, options.home);
          return waitForLuaRuntime(page, options, 20_000);
        }
      },
      report: (message) => process.stdout.write(`${message}\n`),
    });
    return {
      setup: true,
      profile,
      extensionPath: options.extensionPath,
      extensionId: options.extensionId,
      runtime,
      credentials: restoration?.restored
        ? { restoredFrom: restoration.envFile, config: restoration.config }
        : 'existing extension configuration kept',
      next: 'Run playground sync after adding local workspace files.',
    };
  } finally {
    readline.close();
    closePage(page);
    closePage(extensionsPage);
  }
}

async function requestConfirmation(readline, word) {
  const answer = await readline.question(`Type ${word} to continue: `);
  return answer === word;
}

async function executeReplAction(action, readline, options) {
  switch (action.kind) {
    case 'help':
      return '.reload | .ext-reload | .page-reload | .home | .open <url> | .send <text> | .run <AX_*> [json] | .call <AX_*> [json] | .page | .ls | .status | .sources | .clear | .stop | .quit';
    case 'sync': {
      const result = await syncWorkspace(options);
      closePage(result.session.page);
      return { ...result.receipt, workspace: workspaceSummary(result.workspace) };
    }
    case 'extension-reload':
      return withPlaygroundSession(options, async (session) => {
        const result = await reloadExtension(session.cdpUrl, options, { url: options.home });
        closePage(result.page);
        return { reloaded: true, url: result.url };
      });
    case 'page-reload':
      return withPlaygroundSession(options, async (session) => {
        const url = await currentUrl(session);
        await navigate(session.page, url);
        await waitForLuaRuntime(session.page, options, 20000);
        return { reloaded: await currentUrl(session) };
      });
    case 'home':
      return openUrl(options, options.home);
    case 'open':
      return openUrl(options, action.url);
    case 'send':
      return withPlaygroundSession(options, (session) => sendMessage(session, action.text, { timeoutMs: options.timeout }));
    case 'run':
      return withPlaygroundSession(options, (session) => run(session, action.command, action.args, { timeoutMs: options.timeout }));
    case 'call':
      return withPlaygroundSession(options, (session) => call(session, action.command, action.args));
    case 'page':
      return withPlaygroundSession(options, (session) => readPage(session, options));
    case 'list':
      return withPlaygroundSession(options, (session) => listCommands(session));
    case 'status':
      return verifySavedRuntime(options);
    case 'sources':
      return workspaceSummary(await loadWorkspace(options.root));
    case 'reset':
      return resetPlayground(options, { confirmed: await requestConfirmation(readline, 'RESET') });
    case 'stop':
      return stopPlayground(options, { confirmed: await requestConfirmation(readline, 'STOP') });
    default:
      throw new Error(`Unsupported REPL action: ${action.kind}`);
  }
}

async function main() {
  const { command, positionals, flags } = parseCliArguments(process.argv.slice(2));
  if (command === 'help') {
    output(PLAYGROUND_USAGE);
    return;
  }
  if (positionals.length > 0) throw new Error(`Unexpected arguments: ${positionals.join(' ')}`);
  const options = resolvePlaygroundOptions(flags);

  switch (command) {
    case 'init':
      output(await createWorkspace(options.root));
      return;
    case 'setup':
      output(await setupExtension(options));
      return;
    case 'sync': {
      const result = await syncWorkspace(options);
      closePage(result.session.page);
      output({ ...result.receipt, workspace: workspaceSummary(result.workspace) });
      return;
    }
    case 'status':
      output(await verifySavedRuntime(options));
      return;
    case 'reset':
      output(await resetPlayground(options, { confirmed: options.yes }));
      return;
    case 'repl': {
      if (options.sync) {
        const result = await syncWorkspace(options);
        closePage(result.session.page);
        output({ ...result.receipt, workspace: workspaceSummary(result.workspace) });
      } else {
        output(await verifySavedRuntime(options));
      }
      await runPlaygroundRepl({ execute: (action, readline) => executeReplAction(action, readline, options) });
      return;
    }
    default:
      throw new Error(`Unsupported command: ${command}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || error}\n`);
  process.exitCode = 1;
});
