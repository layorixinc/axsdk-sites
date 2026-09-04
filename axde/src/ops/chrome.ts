/**
 * The capability side of the extension ops: one object that performs what `ops/extension.mjs`
 * decides. Everything is the SDK's own launcher plus the two WebUI controls that have no API.
 *
 * Two measurements from 2026-09-03 shape it:
 *
 * - a build is loaded with `--load-extension` at LAUNCH (durable across restarts), never with CDP
 *   `Extensions.loadUnpacked` (which lives only as long as that browser session);
 * - the browser is closed with `Browser.close` and given time to write `Preferences`, because
 *   killing it loses the extension registration AND both toggles.
 *
 * That gives this adapter TWO endings, and the difference is the whole of stage 2a: `close()` shuts
 * Chrome down gracefully (what a one-shot operation owes), while `release()` drops only our debugger
 * connection and leaves a detached browser running (what `launch` owes). `stopAt(port)` is the third
 * case — a graceful close of a browser this process never launched.
 */
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import {
  BUILD_KEY, CONFIG_KEY, WORKSPACE_KEYS, connectCdp, evaluate, launchChrome, probeDebugger,
  resetWorkspaceStores, writeConfig, writeWorkspaceStores,
} from '../../../../axsdk-sdk-js/packages/axsdk-extension-cdp/scripts/browser-session.mjs';
import {
  WORKSPACE_ENV_KEYS, credentialsFromEnv, extensionIdFromKey, fingerprintBuild, profileDir,
} from '../../../../axsdk-sdk-js/packages/axsdk-extension-cdp/scripts/chrome-launch.mjs';
import { harnessConfig } from '../../../../axsdk-sdk-js/packages/axsdk-extension-cdp/scripts/harness-config.mjs';
import {
  attachBuild, clearRunning, detachBuild, readManifest, recordRunning,
} from './profiles.ts';

export { fingerprintBuild, probeDebugger };

export function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Walks a shadow-DOM tree for one selector; the extensions WebUI nests its controls several deep. */
const FIND = `const find = (node, depth, selector) => {
  if (!node || depth > 18) return undefined;
  const hit = node.querySelector?.(selector);
  if (hit) return hit;
  for (const el of node.querySelectorAll('*')) {
    if (el.shadowRoot) { const nested = find(el.shadowRoot, depth + 1, selector); if (nested) return nested; }
  }
  return undefined;
};`;

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

export function createBrowser({ root, log = () => {} }) {
  let launched;
  let optionsSession;
  let webUiTarget;
  let extensionId;
  let profile;
  let port;
  let startUrl;

  const optionsUrl = () => `chrome-extension://${extensionId}/options/options.html`;

  const start = async (detached = false) => {
    const manifest = await readManifest(root, profile);
    launched = await launchChrome({
      profileName: profile,
      profileRoot: root,
      port,
      url: startUrl,
      loadExtension: manifest?.dist,
      detached,
    });
    optionsSession = undefined;
    webUiTarget = undefined;
    return manifest?.dist;
  };

  /** Reads whether the extension is there and what build it last recorded. Installs nothing. */
  const probe = async () => {
    const url = optionsUrl();
    const { targetInfos } = await launched.cdp.send('Target.getTargets');
    const open = (targetInfos ?? []).find((one) => one.type === 'page' && String(one.url).startsWith(url));
    const targetId = open?.targetId ?? (await launched.cdp.send('Target.createTarget', { url })).targetId;
    const { sessionId } = await launched.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    // A reused tab can hold a dead document from a previous extension instance.
    if (open) await launched.cdp.send('Page.navigate', { url }, sessionId).catch(() => {});
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const answered = await evaluate(launched.cdp, sessionId, 'typeof chrome?.storage').catch(() => undefined);
      if (answered === 'object') {
        optionsSession = sessionId;
        const recorded = await evaluate(launched.cdp, sessionId,
          `chrome.storage.local.get(${JSON.stringify(BUILD_KEY)})`
          + `.then((stored) => stored[${JSON.stringify(BUILD_KEY)}] ?? null)`);
        return { present: true, recordedFingerprint: recorded ?? undefined };
      }
      await delay(250);
    }
    // A blocked page for an extension that is not loaded is debris if left open.
    if (!open) await launched.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    optionsSession = undefined;
    return { present: false, recordedFingerprint: undefined };
  };

  const webUi = async () => {
    if (webUiTarget !== undefined) return webUiTarget;
    const page = await launched.cdp.send('Target.createTarget', { url: `chrome://extensions/?id=${extensionId}` });
    const { sessionId } = await launched.cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    await delay(1_200);
    webUiTarget = { targetId: page.targetId, sessionId };
    return webUiTarget;
  };

  const clickUntil = async (selector, action, label) => {
    const { sessionId } = await webUi();
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const done = await evaluate(launched.cdp, sessionId, `(() => {${FIND}
        const node = find(document, 0, ${JSON.stringify(selector)});
        if (!node) return 'missing';
        ${action}
      })()`);
      if (done === true) return true;
      if (done === 'missing' && attempt > 8) throw new Error(`${label}: control not found (${selector})`);
      await delay(400);
    }
    throw new Error(`${label}: never took effect`);
  };

  const shutdown = async () => {
    if (launched === undefined) return;
    await launched.cdp.send('Browser.close').catch(() => {});
    // Chrome writes Preferences during shutdown; the next launch reads them.
    await delay(1_500);
    launched.cdp.close();
    launched.chrome?.unref?.();
    launched = undefined;
    optionsSession = undefined;
    webUiTarget = undefined;
  };

  const releaseConnection = async () => {
    launched?.cdp.close();
    launched = undefined;
    optionsSession = undefined;
    webUiTarget = undefined;
  };

  /**
   * Leave the browser as this call FOUND it. A read must not take down a browser `launch` left
   * running, and must not leave one of its own behind: measured 2026-09-04, `profile ls` did the
   * first and the next launch then quietly spawned a second Chrome.
   */
  const finish = async () => {
    if (launched === undefined) return;
    if (launched.reused) await releaseConnection();
    else await shutdown();
  };

  return {
    async open(target) {
      profile = target.profile;
      port = target.port;
      // Only a SPAWN can carry a start url; a reused browser gets `openTab` instead.
      startUrl = target.url;
      const manifest = JSON.parse(readFileSync(join(target.dist, 'manifest.json'), 'utf-8'));
      extensionId = extensionIdFromKey(manifest.key);
      if (!extensionId) throw new Error(`${target.dist} declares no manifest key; axde needs a keyed dev build`);
      const attachedDist = await start(target.detached === true);
      const probed = await probe();
      return {
        extensionId,
        attachedDist,
        ...probed,
        reused: launched.reused,
        // Absent for a reused browser: this process did not spawn it and cannot claim its pid.
        pid: launched.chrome?.pid,
      };
    },

    async openTab(url) {
      await launched.cdp.send('Target.createTarget', { url });
      log(`opened ${url}`);
    },

    /**
     * Hand the browser back while it keeps running: close only OUR debugger connection. The child
     * was spawned detached and unreffed, so nothing here holds it or is held by it.
     */
    release: releaseConnection,

    finish,

    /** The authority on "is a browser up": a recorded pid outlives its process, a port does not. */
    async reachable(at) {
      return Boolean(await probeDebugger(at ?? port));
    },

    /**
     * Stop a browser this process did not launch. Graceful, because Chrome writes `Preferences`
     * during shutdown and both toggles live there.
     */
    async stopAt(at) {
      const version = await probeDebugger(at);
      if (!version) return;
      const cdp = await connectCdp(version.webSocketDebuggerUrl);
      await cdp.send('Browser.close').catch(() => {});
      await delay(1_500);
      cdp.close();
      log(`closed the browser on :${at}`);
    },

    /**
     * The record calls take the profile NAME rather than reading the closure `open` sets: `stop`
     * never opens a session, so that variable is undefined there. Measured 2026-09-04 — the clear
     * threw on an undefined name, a catch swallowed it, and a stopped browser kept a recorded pid.
     */
    async recordRunning({ profile: name, ...entry }) {
      await recordRunning({ root, name, ...entry });
    },

    async clearRunning(name) {
      await clearRunning({ root, name });
    },

    /**
     * The four fields that decide whether a stored layer is read, by NAME. The config store also
     * holds the API key, so it is never read whole and never printed.
     */
    async sourceSwitches() {
      if (optionsSession === undefined) throw new Error('sourceSwitches: no options page to read');
      return evaluate(launched.cdp, optionsSession, `(async () => {
        const stored = (await chrome.storage.local.get(${JSON.stringify(CONFIG_KEY)}))[${JSON.stringify(CONFIG_KEY)}] ?? {};
        const config = typeof stored === 'string' ? JSON.parse(stored) : stored;
        return {
          remote_sites: config.remote_sites ?? null,
          storedFlowsEnabled: config.storedFlowsEnabled ?? null,
          storedLuaEnabled: config.storedLuaEnabled ?? null,
          remoteSiteFlowsEnabled: config.remoteSiteFlowsEnabled ?? null,
          packagedSourcesEnabled: config.packagedSourcesEnabled ?? null,
        };
      })()`);
    },

    async writeWorkspace(envelopes) {
      if (optionsSession === undefined) throw new Error('writeWorkspace: no options page to write into');
      return writeWorkspaceStores(launched.cdp, optionsSession, envelopes);
    },

    /**
     * What the store HOLDS, which is the only proof a write landed: sizes and the module names.
     *
     * The key list is the SDK's own `WORKSPACE_KEYS`, never a copy — a copy is exactly what left
     * the module store out of a reset for as long as that reset existed. The one key named here is
     * named because this call has to look INSIDE it, which is a fact about the module store rather
     * than a second list of stores.
     */
    async readWorkspace(moduleKey = 'axsdk:lua-modules') {
      if (optionsSession === undefined) throw new Error('readWorkspace: no options page to read');
      return evaluate(launched.cdp, optionsSession, `(async () => {
        const keys = ${JSON.stringify(WORKSPACE_KEYS)};
        const held = await chrome.storage.local.get(keys);
        const bytes = {};
        for (const key of keys) {
          if (typeof held[key] === 'string') bytes[key] = new TextEncoder().encode(held[key]).length;
        }
        let moduleNames = [];
        try {
          const layers = JSON.parse(held[${JSON.stringify(moduleKey)}]).state.lua ?? {};
          moduleNames = [...new Set(Object.values(layers).flatMap((slot) => Object.keys(JSON.parse(slot))))].sort();
        } catch { moduleNames = []; }
        return { bytes, moduleNames };
      })()`);
    },

    async clearWorkspace() {
      if (optionsSession === undefined) throw new Error('clearWorkspace: no options page to clear');
      return resetWorkspaceStores(launched.cdp, optionsSession);
    },

    async attachBuild(dist) {
      await attachBuild({ root, name: profile, dist });
      log(`attached ${dist}`);
    },

    async detachBuild() {
      await detachBuild({ root, name: profile });
      log('detached the build');
    },

    /**
     * Reload the extension in place, and confirm it came back.
     *
     * Measured 2026-09-04: `chrome.runtime.reload()` from the options page RE-READS the unpacked
     * build from disk — a `short_name` planted in the dist manifest was visible afterwards — clears
     * `chrome.storage.session` and replaces the service-worker target, while the browser stays up.
     * The chrome://extensions control does the same thing (`cr-icon-button#dev-reload-button`), but
     * its label is the browser's locale (`새로고침` here) and it renders twice, so the id would be
     * the only safe half of it anyway — and this path needs no WebUI at all.
     *
     * The call kills the page that makes it, so its answer is never awaited: what is awaited is the
     * options page answering again.
     */
    async refresh() {
      if (optionsSession === undefined) throw new Error('refresh: no options page to reload from');
      await evaluate(launched.cdp, optionsSession, 'chrome.runtime.reload()').catch(() => {});
      optionsSession = undefined;
      webUiTarget = undefined;
      await delay(1_500);
      const probed = await probe();
      log(probed.present ? 'refreshed the extension in place' : 'refresh: the extension did not come back');
      return probed;
    },
    /** Chrome reads `--load-extension` only at launch, so a changed attachment needs a restart. */
    async relaunch() {
      await shutdown();
      const attached = await start();
      const probed = await probe();
      if (!probed.present) {
        throw new Error(`relaunch: ${extensionId} did not come up from ${attached ?? '(nothing attached)'}`);
      }
      log('relaunched with the attached build');
    },

    async setDevMode(on) {
      // A fresh profile has developer mode OFF, and the per-extension row silently does nothing
      // without it.
      await clickUntil('cr-toggle#devMode', `
        if (node.checked === ${JSON.stringify(on)}) return true;
        node.click();
        return false;
      `, 'developer mode');
      log(`devMode ${on ? 'on' : 'off'}`);
    },

    async setUserScriptsRow(on) {
      await clickUntil('extensions-toggle-row#allow-user-scripts', `
        if (node.checked === ${JSON.stringify(on)}) return true;
        node.shadowRoot.querySelector('#crToggle').click();
        return false;
      `, 'allow user scripts');
      log(`allow-user-scripts ${on ? 'on' : 'off'}`);
    },

    async userScriptsReady() {
      if (optionsSession === undefined) return false;
      // With developer mode and the row on, the namespace appears immediately — no reload.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const ready = await evaluate(launched.cdp, optionsSession, "typeof chrome.userScripts !== 'undefined'")
          .catch(() => false);
        if (ready === true) return true;
        await delay(400);
      }
      return false;
    },

    async recordBuild(fingerprint) {
      if (optionsSession === undefined) throw new Error('recordBuild: no options page to record into');
      await evaluate(launched.cdp, optionsSession,
        `chrome.storage.local.set({ ${JSON.stringify(BUILD_KEY)}: ${JSON.stringify(fingerprint)} })`);
    },

    async uninstall(id) {
      await launched.cdp.send('Extensions.uninstall', { id }).catch(() => {});
      optionsSession = undefined;
      webUiTarget = undefined;
      log(`removed ${id} from the running browser`);
    },

    /** The only place a service worker that never registered says why. */
    async lastUncaughtError() {
      if (profile === undefined) return undefined;
      const file = join(profileDir(profile, root), 'chrome_debug.log');
      if (!existsSync(file)) return undefined;
      const text = await readFile(file, 'utf8').catch(() => '');
      const line = text.split('\n').reverse()
        .find((one) => /Uncaught|ERROR:/.test(one) && one.includes(extensionId ?? 'chrome-extension'));
      return line?.trim().slice(0, 300);
    },

    /** Seeds the extension's settings from a workspace `.env`; values are never returned or logged. */
    async seedCredentials(envPath, { packaged = false } = {}) {
      if (optionsSession === undefined) return 'no-options-page';
      if (!existsSync(envPath)) return 'no-env';
      const found = credentialsFromEnv(readFileSync(envPath, 'utf-8'), WORKSPACE_ENV_KEYS);
      if (!found) return 'no-credentials';
      const outcome = await writeConfig(launched.cdp, optionsSession,
        { ...harnessConfig(found, process.env, { local: true, packaged }), credentialsFrom: envPath },
        { overwrite: true });
      return typeof outcome === 'string' ? outcome : 'written';
    },

    close: shutdown,
  };
}
