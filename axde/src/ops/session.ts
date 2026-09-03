/**
 * The headed browser a developer drives: `launch` starts one that OUTLIVES the command, `stop` ends
 * it gracefully.
 *
 * Stage 1's browser is a tool — open, do one thing, close so `Preferences` reach disk. Pack work
 * needs the opposite lifetime, and the spawn that gives it was measured rather than assumed
 * (2026-09-04, Chrome 151, Windows): `detached: true` ALONE never lets the launcher return (a
 * referenced child handle holds the event loop open), `child.unref()` alone lets the launcher return
 * and the browser dies with it, and only both together return in 0 s AND leave the browser up.
 *
 * Three rules here are load-bearing rather than cosmetic:
 *
 * - a browser that is already listening is REUSED, never relaunched: the one command whose purpose
 *   is "leave it up" must not be the command that takes a live session down;
 * - this module REPORTS the extension state and repairs nothing — `ext install` stays the single
 *   writer of the two toggles, because two writers of one setting is how a setting stops meaning
 *   anything;
 * - `stop` verifies the port went quiet. Reporting "stopped" while the browser answers is the
 *   false-positive class §13 keeps finding in cart adds.
 *
 * The `browser` argument is the capability boundary: this module decides, the adapter performs.
 */

const foreign = (verb, profile) =>
  `${verb} refused: axde did not create "${profile}" — two Chromes on one profile directory are not `
  + 'two browsers (the second hands off to the first and exits), so pass --force only if you mean to '
  + 'join that session';

const FIX = 'run `axde ext install <profile>` to load the build and turn the user-scripts row on';

export async function launchHeaded(browser, { profile, port, dist, url, kind = 'axde', force = false }) {
  if (kind !== 'axde' && !force) throw new Error(foreign('launch', profile));

  // The launcher probes the port before spawning, so this both launches and adopts.
  const opened = await browser.open({ profile, port, dist, url, detached: true });
  try {
    // A reused browser was given no launch arguments, so a start url has to be opened as a tab or
    // the flag would silently do nothing on the path a developer uses most.
    if (opened.reused && url) await browser.openTab(url);

    const extension = opened.present ? 'up' : 'absent';
    const userScripts = opened.present ? await browser.userScriptsReady() : false;
    const answer = {
      profile,
      outcome: opened.reused ? 'already-running' : 'launched',
      port,
      pid: opened.pid,
      extensionId: opened.extensionId,
      extension,
      userScripts,
      ...(extension === 'up' && userScripts ? {} : { fix: FIX }),
    };
    if (!opened.reused) {
      // The name travels WITH the call. The adapter keeps no session on the stop path, so a closure
      // variable set by `open` is not there to read — and a record that cannot be written is worse
      // than none, because `stop` then reports a shutdown while the row still claims a pid.
      await browser.recordRunning({ profile, pid: opened.pid, port, startedAt: new Date().toISOString() });
    }
    return answer;
  } finally {
    // Release the CDP connection and LEAVE the browser: `close()` here would defeat the command.
    await browser.release();
  }
}

export async function stopHeaded(browser, { profile, port, kind = 'axde', force = false }) {
  if (kind !== 'axde' && !force) throw new Error(foreign('stop', profile));

  if (!(await browser.reachable(port))) {
    await browser.clearRunning(profile);
    return { profile, outcome: 'already-stopped', port };
  }
  await browser.stopAt(port);
  if (await browser.reachable(port)) {
    throw new Error(
      `stop failed: the browser is still answering on ${port} — the record is left alone rather than `
      + 'reporting a shutdown that did not happen',
    );
  }
  await browser.clearRunning(profile);
  return { profile, outcome: 'stopped', port };
}
