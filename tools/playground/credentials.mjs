import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/**
 * Playground extension configuration is rebuilt from the local gitignored `.env`.
 *
 * The dedicated profile loads the extension from the command line, and Chrome discards that
 * extension's `chrome.storage.local` on a cold browser start, which erases `axsdk:extension:config`
 * and leaves the AXSDK content script unconfigured. Reading the same development values the operator
 * already keeps in `.env` lets every attach restore the profile instead of failing into the manual
 * setup prompt. Secret values are only ever written into the browser profile: nothing here logs,
 * prints, or copies them into the workspace.
 */

export const CREDENTIAL_ENV_KEYS = Object.freeze({
  apiKey: 'AXSDK_API_KEY',
  appId: 'AXSDK_APP_ID',
  baseUrl: 'AXSDK_BASE_URL',
  sitesSource: 'AXSDK_SITES_URL',
  enabled: 'AXSDK_EXTENSION_ENABLED',
  debug: 'AXSDK_EXTENSION_DEBUG',
});

export const REQUIRED_CREDENTIAL_FIELDS = Object.freeze(['apiKey', 'appId', 'baseUrl']);

const FALSE_LITERALS = new Set(['false', '0', 'no', 'off']);

function unquote(value) {
  const quoted = /^(['"])(.*)\1$/s.exec(value);
  return quoted ? quoted[2] : value;
}

/**
 * Parses `KEY=VALUE` lines. Comments, blank lines, `export ` prefixes, and surrounding quotes are
 * handled; escape sequences are not, because AXSDK development values are plain single-line strings.
 */
export function parseEnvFile(text) {
  const values = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const assignment = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed;
    const separator = assignment.indexOf('=');
    if (separator <= 0) continue;
    const key = assignment.slice(0, separator).trim();
    if (key === '') continue;
    values[key] = unquote(assignment.slice(separator + 1).trim());
  }
  return values;
}

/**
 * A shell override wins over the `.env` file, but a blank one does not: an empty variable left in the
 * environment must not erase a working value and push the profile back into the unconfigured state.
 */
export function selectCredentialValues({ file = {}, env = {} } = {}) {
  const selected = {};
  for (const [field, key] of Object.entries(CREDENTIAL_ENV_KEYS)) {
    const value = [env[key], file[key]].find((candidate) => typeof candidate === 'string' && candidate.trim() !== '');
    if (value !== undefined) selected[field] = value.trim();
  }
  return selected;
}

function parseFlag(value, fallback) {
  if (value === undefined) return fallback;
  return !FALSE_LITERALS.has(String(value).trim().toLowerCase());
}

/**
 * Builds the `axsdk:extension:config` patch. `debug` defaults to true because the harness reaches the
 * runtime through the debug-only `_AXSDK` / `_AXLUA` handles.
 */
export function buildExtensionCredentialPatch(values = {}) {
  const patch = {
    enabled: parseFlag(values.enabled, true),
    debug: parseFlag(values.debug, true),
    apiKey: values.apiKey ?? '',
    appId: values.appId ?? '',
    baseUrl: values.baseUrl ?? '',
  };
  if (values.sitesSource) patch.sitesSource = values.sitesSource;
  const missing = REQUIRED_CREDENTIAL_FIELDS.filter((field) => patch[field] === '');
  return { patch, missing };
}

/** Secret-free receipt for CLI output and logs. */
export function describeExtensionCredentialPatch(patch = {}) {
  return {
    enabled: patch.enabled,
    debug: patch.debug,
    appId: patch.appId,
    baseUrl: patch.baseUrl,
    sitesSource: patch.sitesSource ?? null,
    apiKey: patch.apiKey ? 'set' : 'missing',
  };
}

/** Repository root, workspace root, and the workspace parent, in the order a run is usually invoked. */
export function envFileCandidates({ root, cwd = process.cwd() } = {}) {
  const candidates = [];
  for (const base of [cwd, root, root ? dirname(resolve(root)) : null]) {
    if (!base) continue;
    const candidate = resolve(base, '.env');
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }
  return candidates;
}

async function readFirstEnvFile(candidates, reader) {
  for (const candidate of candidates) {
    try {
      return { envFile: candidate, file: parseEnvFile(await reader(candidate)) };
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'EISDIR') throw error;
    }
  }
  return { envFile: null, file: {} };
}

/**
 * Resolves the extension configuration patch for the dedicated profile.
 * Returns `missing` field names instead of throwing so the caller can keep the manual setup hint.
 */
export async function loadExtensionCredentials({
  root,
  cwd = process.cwd(),
  env = process.env,
  readEnvFile = (path) => readFile(path, 'utf8'),
} = {}) {
  const { envFile, file } = await readFirstEnvFile(envFileCandidates({ root, cwd }), readEnvFile);
  const { patch, missing } = buildExtensionCredentialPatch(selectCredentialValues({ file, env }));
  return { patch, missing, envFile };
}
