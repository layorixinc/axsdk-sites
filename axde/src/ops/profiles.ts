/**
 * Profile inventory and lifecycle.
 *
 * A profile `axde` created carries `axde-profile.json`. That file is the whole basis for the
 * `axde`/`foreign` distinction, and the distinction is load-bearing: the shared harness profile
 * holds the developer's credentials and chat history, so a destructive action there is refused
 * unless it is asked for twice.
 *
 * The name rule is imported, not re-written: `profileDir` already refuses separators and traversal,
 * and a second copy of that rule is a second thing to get wrong.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { profileDir } from '../../../../axsdk-sdk-js/packages/axsdk-extension-cdp/scripts/chrome-launch.mjs';

export const MANIFEST = 'axde-profile.json';

/** The harness's own convention, so one person has one answer to "where are my profiles". */
export function profileRootFrom(env = process.env) {
  if (env.AXSDK_PROFILE_ROOT) return env.AXSDK_PROFILE_ROOT;
  const local = env.LOCALAPPDATA ?? env.HOME ?? '.';
  return `${local}/AXSDKChromeProfiles`;
}

function resolveProfile(root, name) {
  // Throws for a separator, a traversal or an empty name — the launcher's rule, not a copy of it.
  return profileDir(name, root);
}

export async function readManifest(root, name) {
  try {
    const parsed = JSON.parse(await readFile(join(resolveProfile(root, name), MANIFEST), 'utf8'));
    return parsed?.createdBy === 'axde' ? parsed : undefined;
  } catch {
    // Absent OR unreadable: either way this is not a profile we can claim as ours.
    return undefined;
  }
}

export async function listProfiles({ root, probe }) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const rows = [];
  for (const name of names) {
    const manifest = await readManifest(root, name);
    const port = manifest?.port;
    // Only a profile that RECORDS a port can be probed; asking about a port nobody assigned would
    // report another profile's browser as this one's.
    const up = port === undefined ? false : Boolean(await probe(port));
    rows.push({
      name,
      kind: manifest === undefined ? 'foreign' : 'axde',
      port,
      dist: manifest?.dist,
      chrome: up ? 'up' : 'down',
      // A recorded pid is reported as a fact about the RECORD; `chrome` above stays the probe's
      // answer, because a pid outlives its process and an answering port does not.
      pid: manifest?.running?.pid,
      ext: null,
      userScripts: null,
      stale: false,
    });
  }
  return rows;
}

export async function createProfile({ root, name, port }) {
  const directory = resolveProfile(root, name);
  const existing = await readdir(directory).then(() => true).catch(() => false);
  if (existing) throw new Error(`profile already exists: ${name}`);
  await mkdir(directory, { recursive: true });
  const manifest = { createdBy: 'axde', createdAt: new Date().toISOString(), port };
  await writeFile(join(directory, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return { name, directory, port };
}

export async function deleteProfile({ root, name, force = false }) {
  const directory = resolveProfile(root, name);
  const present = await readdir(directory).then(() => true).catch(() => false);
  if (!present) throw new Error(`no such profile: ${name}`);
  if (!force && (await readManifest(root, name)) === undefined) {
    throw new Error(`refused: axde did not create "${name}" — pass --force if you mean to remove it`);
  }
  await rm(directory, { recursive: true, force: true });
  return { name, removed: true };
}

/**
 * Records which build this profile loads at launch. The ATTACHMENT is the install: measured
 * 2026-09-03, a CDP `Extensions.loadUnpacked` registration dies with its browser session, while a
 * build passed as `--load-extension` is present on every later launch.
 */
async function withManifest(root, name, change) {
  const manifest = await readManifest(root, name);
  if (manifest === undefined) {
    throw new Error(`refused: axde did not create "${name}" — it manages only its own profiles`);
  }
  const next = change({ ...manifest });
  await writeFile(join(resolveProfile(root, name), MANIFEST), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export async function attachBuild({ root, name, dist }) {
  return withManifest(root, name, (manifest) => ({ ...manifest, dist }));
}

export async function detachBuild({ root, name }) {
  return withManifest(root, name, ({ dist, ...rest }) => rest);
}

/**
 * What `launch` left running. Written for the row to print and for `stop` to quote — never to
 * decide whether a browser is up, which only the port can answer.
 */
export async function recordRunning({ root, name, pid, port, startedAt = new Date().toISOString() }) {
  return withManifest(root, name, (manifest) => ({ ...manifest, running: { pid, port, startedAt } }));
}

export async function clearRunning({ root, name }) {
  // Absent, not null: a null `running` would read as "recorded, with nothing in it".
  return withManifest(root, name, ({ running, ...rest }) => rest);
}
