/**
 * The capability side of the extension ops: one object that performs what `ops/extension.mjs`
 * decides. Everything is the SDK's own launcher plus the two WebUI controls that have no API.
 *
 * Two measurements from 2026-09-03 shape it:
 *
 * - a build is loaded with `--load-extension` at LAUNCH (durable across restarts), never with CDP
 *   `Extensions.loadUnpacked` (which lives only as long as that browser session);
 * - the browser is closed with `Browser.close` and given time to write `Preferences`, because
 *   killing it loses the extension registration AND both toggles. `close()` here is therefore a
 *   graceful shutdown, not the harness's release-and-leave-running.
 */
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';

import {
  BUILD_KEY, evaluate, launchChrome, probeDebugger, writeConfig,
} from '../../../../axsdk-sdk-js/packages/axsdk-extension-cdp/scripts/browser-session.mjs';
import {
  WORKSPACE_ENV_KEYS, credentialsFromEnv, extensionIdFromKey, fingerprintBuild, profileDir,
} from '../../../../axsdk-sdk-js/packages/axsdk-extension-cdp/scripts/chrome-launch.mjs';
import { harnessConfig } from '../../../../axsdk-sdk-js/packages/axsdk-extension-cdp/scripts/harness-config.mjs';
import { attachBuild, detachBuild, readManifest } from './profiles.mjs';

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

  const optionsUrl = () => `chrome-extension://${extensionId}/options/options.html`;

  const start = async () => {
    const manifest = await readManifest(root, profile);
    launched = await launchChrome({
      profileName: profile,
      profileRoot: root,
      port,
      loadExtension: manifest?.dist,
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

  return {
    async open(target) {
      profile = target.profile;
      port = target.port;
      const manifest = JSON.parse(readFileSync(join(target.dist, 'manifest.json'), 'utf-8'));
      extensionId = extensionIdFromKey(manifest.key);
      if (!extensionId) throw new Error(`${target.dist} declares no manifest key; axde needs a keyed dev build`);
      const attachedDist = await start();
      const probed = await probe();
      return { extensionId, attachedDist, ...probed };
    },

    async attachBuild(dist) {
      await attachBuild({ root, name: profile, dist });
      log(`attached ${dist}`);
    },

    async detachBuild() {
      await detachBuild({ root, name: profile });
      log('detached the build');
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
    async seedCredentials(envPath) {
      if (optionsSession === undefined) return 'no-options-page';
      if (!existsSync(envPath)) return 'no-env';
      const found = credentialsFromEnv(readFileSync(envPath, 'utf-8'), WORKSPACE_ENV_KEYS);
      if (!found) return 'no-credentials';
      const outcome = await writeConfig(launched.cdp, optionsSession,
        { ...harnessConfig(found, process.env, { local: true }), credentialsFrom: envPath },
        { overwrite: true });
      return typeof outcome === 'string' ? outcome : 'written';
    },

    close: shutdown,
  };
}
