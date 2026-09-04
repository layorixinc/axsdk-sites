/**
 * Install, uninstall and inspect the local build in one profile.
 *
 * The mechanism is a measurement, not a preference (2026-09-03):
 *
 * - CDP `Extensions.loadUnpacked` registers a build for THAT BROWSER SESSION ONLY. Measured: an
 *   install reported success, the browser closed, and the next `ext status` on the same profile read
 *   `installed false`.
 * - `--load-extension` plus a GRACEFUL `Browser.close` is durable: the extension is present on every
 *   later launch, its service worker registers, and developer mode + the Allow-User-Scripts row both
 *   persist, so `chrome.userScripts` is there after a restart. Killing the browser loses all of it,
 *   because Chrome writes `Preferences` during shutdown.
 *
 * So an install ATTACHES the build to the profile, RELAUNCHES so Chrome loads it, enables the two
 * toggles once, and RECORDS the fingerprint. Chrome only reads the build at launch, which is why a
 * changed build needs a relaunch and an unchanged one must NOT get one: a relaunch kills whatever
 * session the developer is looking at (the §13 reload lesson).
 *
 * The `browser` argument is the capability boundary: this module decides, the adapter performs.
 */

async function ensureUserScripts(browser) {
  if (await browser.userScriptsReady()) return true;
  // Developer mode first: without it the per-extension row silently does nothing.
  await browser.setDevMode(true);
  await browser.setUserScriptsRow(true);
  return browser.userScriptsReady();
}

export async function installExtension(browser, { profile, port, dist, fingerprint }) {
  const opened = await browser.open({ profile, port, dist });
  try {
    const carriesThisBuild = opened.present
      && opened.attachedDist === dist
      && opened.recordedFingerprint === fingerprint;

    if (carriesThisBuild && await browser.userScriptsReady()) {
      return {
        profile, outcome: 'up-to-date', fingerprint, extensionId: opened.extensionId, userScripts: true,
      };
    }

    // Present, current, but its toggles are off: repair without a relaunch nobody needs.
    if (carriesThisBuild) {
      const userScripts = await ensureUserScripts(browser);
      if (!userScripts) throw new Error(refusal());
      return { profile, outcome: 'repaired', fingerprint, extensionId: opened.extensionId, userScripts };
    }

    // The attachment is right and only the BYTES changed. Measured 2026-09-04:
    // `chrome.runtime.reload()` re-reads the unpacked build from disk — a `short_name` planted in the
    // dist manifest was visible afterwards — so this needs no relaunch, and a relaunch would take
    // down the browser `axde launch` deliberately left running (stage 2a).
    if (opened.present && opened.attachedDist === dist) {
      const refreshed = await browser.refresh();
      if (!refreshed.present) {
        throw new Error(`install refused: ${opened.extensionId} did not come up after a refresh of ${dist}`);
      }
      // Asked again on purpose: the toggles persist on disk, but `chrome.userScripts` is answered by
      // a NEW worker.
      const userScripts = await ensureUserScripts(browser);
      if (!userScripts) throw new Error(refusal());
      await browser.recordBuild(fingerprint);
      return { profile, outcome: 'refreshed', fingerprint, extensionId: opened.extensionId, userScripts };
    }

    await browser.attachBuild(dist);
    await browser.relaunch();
    const userScripts = await ensureUserScripts(browser);
    if (!userScripts) throw new Error(refusal());
    await browser.recordBuild(fingerprint);
    return { profile, outcome: 'installed', fingerprint, extensionId: opened.extensionId, userScripts };
  } finally {
    // `finish()`, not `close()`: closes a browser this process launched — which is what makes the
    // toggles reach disk — and RELEASES one it adopted. Measured live 2026-09-04: the refresh applied
    // a new build without a relaunch and the close then took down the browser `axde launch` had left
    // running, so the whole point of refreshing was lost one line later.
    await browser.finish();
  }
}

const refusal = () =>
  'install refused: user scripts never became available (developer mode + the per-extension row)';

export async function uninstallExtension(browser, { profile, port, dist }) {
  const opened = await browser.open({ profile, port, dist });
  try {
    if (!opened.present && opened.attachedDist === undefined) return { profile, outcome: 'absent' };
    // Detach, then relaunch. Measured 2026-09-03: CDP `Extensions.uninstall` removes a
    // `loadUnpacked` install and CANNOT remove one Chrome was given on the command line — the
    // profile answered "still reachable" every time. Starting Chrome without the flag is the removal.
    await browser.detachBuild();
    // A relaunch with nothing attached legitimately brings nothing up.
    await browser.relaunch().catch(() => {});
    const after = await browser.open({ profile, port, dist });
    if (after.present) {
      throw new Error(`uninstall refused: ${opened.extensionId} is still reachable in ${profile}`);
    }
    return { profile, outcome: 'uninstalled', extensionId: opened.extensionId };
  } finally {
    await browser.finish();
  }
}

/**
 * A READ, and therefore the one operation that must leave the browser as it found it: `finish()`
 * closes only a browser this process launched. Measured 2026-09-04, before that split existed:
 * `profile ls` read a row as `up` and then closed the browser `axde launch` had deliberately left
 * running, so the next launch found a dead port and quietly spawned a second Chrome.
 */
export async function extensionStatus(browser, { profile, port, dist, fingerprint }) {
  const opened = await browser.open({ profile, port, dist });
  try {
    return {
      profile,
      extensionId: opened.extensionId,
      installed: opened.present,
      attachedDist: opened.attachedDist,
      fingerprint: opened.recordedFingerprint,
      // Unknown stays unknown: with nothing installed there is nothing to call stale.
      stale: opened.present && opened.recordedFingerprint !== fingerprint,
      userScripts: await browser.userScriptsReady(),
      lastError: await browser.lastUncaughtError(),
    };
  } finally {
    await browser.finish();
  }
}
