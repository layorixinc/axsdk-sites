// App-package delivery: push a built workspace to an app, and verify the app is serving exactly what
// was built.
//
// A push replaces the whole app — flow document, sitemap, every module — so "did it land" is not a
// question the push response can settle on its own. The server reports a hash per part; recomputing
// those locally is what turns a push receipt into evidence. Confirmed against a live push: the format
// is `sha256:` + the first 12 hex characters of sha256 over the UTF-8 bytes.

import { createHash } from 'node:crypto';

/** @param {string} source @returns {string} `sha256:<12 hex>` */
export function packageHash(source) {
  return `sha256:${createHash('sha256').update(String(source ?? ''), 'utf8').digest('hex').slice(0, 12)}`;
}

/**
 * @param {{ flowDocument: string, sitemap: string, luaModules?: Record<string,string> }} pkg
 * @returns {{ flowDocument: string, sitemap: string, luaModules: Record<string,string> }}
 */
export function packageHashes({ flowDocument, sitemap, luaModules }) {
  const modules = {};
  // The live endpoint answers `luaModules: null` for an app that has never carried any — a default
  // parameter only fills `undefined`, so this is the same shape that broke `Object.keys` inside the
  // SDK's own init. An app with no modules has no modules; it is not a crash.
  for (const [name, source] of Object.entries(luaModules ?? {})) modules[name] = packageHash(source);
  return { flowDocument: packageHash(flowDocument), sitemap: packageHash(sitemap), luaModules: modules };
}

export const PACKAGE_PARTS = ['flowDocument', 'sitemap', 'luaModules'];

/**
 * Compares a built workspace against what an app is serving.
 *
 * `module_missing` and `module_stale` are deliberately different codes: stale means an old push is
 * live, missing means the document names a module the runtime cannot resolve — which surfaces inside a
 * turn as a nil call, not at push time.
 *
 * `compare` scopes the check to the parts this workspace owns. In the proven composition the app
 * document belongs to the platform — ours is an `extends: app` overlay and is rejected as an app
 * document ("actions must define at least one action") — and travels through `clientFlows`, while only
 * the modules ride the package. Comparing a document we never built would report a permanent mismatch,
 * which is how a check stops being read.
 *
 * @param {{ flowDocument: string, sitemap: string, luaModules?: Record<string,string> }} local
 * @param {{ revision?: number, hash?: object }} remote  as returned by `GET .../package`
 * @param {{ compare?: string[] }} [options]
 * @returns {{ code: string, name?: string, local?: string, remote?: string }[]}
 */
export function diffPackage(local, remote, { compare = PACKAGE_PARTS } = {}) {
  const want = packageHashes(local);
  const got = remote?.hash ?? {};
  const issues = [];
  const checking = new Set(compare);

  if (checking.has('flowDocument') && got.flowDocument !== want.flowDocument) {
    issues.push({ code: 'flow_document_stale', local: want.flowDocument, remote: got.flowDocument });
  }
  if (checking.has('sitemap') && got.sitemap !== want.sitemap) {
    issues.push({ code: 'sitemap_stale', local: want.sitemap, remote: got.sitemap });
  }
  if (!checking.has('luaModules')) return issues;
  const remoteModules = got.luaModules ?? {};
  for (const [name, hash] of Object.entries(want.luaModules)) {
    const there = remoteModules[name];
    if (there === undefined) issues.push({ code: 'module_missing', name, local: hash });
    else if (there !== hash) issues.push({ code: 'module_stale', name, local: hash, remote: there });
  }
  for (const name of Object.keys(remoteModules)) {
    // Harmless to a run — nothing references it — but it spends the app's module budget and is exactly
    // the sort of leftover that gets referenced by accident later.
    if (!(name in want.luaModules)) issues.push({ code: 'module_orphan', name, remote: remoteModules[name] });
  }

  return issues;
}

const PACKAGE_PATH = (appId) => `/axsdk/v2/apps/${encodeURIComponent(appId)}/package`;

/** @returns {Promise<{ revision: number, hash?: object, flowDocument?: string, sitemap?: string }>} */
export async function fetchPackage({ baseUrl, appId, headers, fetchImpl = fetch }) {
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}${PACKAGE_PATH(appId)}`, { headers });
  if (!response.ok) throw new Error(`package read failed (${response.status}) for app '${appId}'`);
  return response.json();
}

/**
 * Pushes and then re-reads, so the return value is what the app is serving rather than what the push
 * claimed. A push that reports success and a package that disagrees is the one failure this is for.
 *
 * `modulesOnly` is the production delivery: the app document belongs to the platform and our modules
 * ride beside it, but the endpoint replaces the WHOLE package. So the current document is read and sent
 * back byte for byte, and only the modules change. An app with no document is refused rather than given
 * an empty one — that would replace a real deployment with nothing.
 */
export async function pushPackage({ baseUrl, appId, headers, local, compare, modulesOnly = false, fetchImpl = fetch }) {
  let payload = { flowDocument: local.flowDocument, sitemap: local.sitemap, luaModules: local.luaModules ?? {} };
  let scope = compare;

  if (modulesOnly) {
    const current = await fetchPackage({ baseUrl, appId, headers, fetchImpl });
    if (!current.flowDocument) {
      throw new Error(`app '${appId}' serves no flow document; refusing to send an empty one`);
    }
    payload = { flowDocument: current.flowDocument, sitemap: current.sitemap ?? '', luaModules: local.luaModules ?? {} };
    scope = ['luaModules'];
  }

  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}${PACKAGE_PATH(appId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    let detail = `${response.status}`;
    try { const body = await response.json(); detail = [body?.code, body?.message].filter(Boolean).join(': ') || detail; } catch { /* keep status */ }
    throw new Error(`package push refused for app '${appId}': ${detail}`);
  }
  const receipt = await response.json();
  const served = await fetchPackage({ baseUrl, appId, headers, fetchImpl });
  return {
    revision: served.revision,
    previousRevision: receipt.previousRevision,
    issues: diffPackage({ ...local, ...payload, luaModules: local.luaModules ?? {} }, served, scope ? { compare: scope } : undefined),
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
// `node tools/rpc-package.mjs verify|push [root]` — builds the workspace with registry delivery and
// compares it against (or pushes it to) the sandbox app. Never the production app: a push replaces the
// whole document, and `browser-extension` is what real users run.

if (process.argv[1] && (await import('node:url')).fileURLToPath(import.meta.url) === (await import('node:path')).resolve(process.argv[1])) {
  const { readFileSync } = await import('node:fs');
  const { join, resolve: resolvePath } = await import('node:path');
  const { parseEnvFile } = await import('./playground/credentials.mjs');
  const { buildRpcFlows, repoRoot } = await import('./build-rpc-flows.mjs');

  const [command = 'verify', rootArg = 'playground'] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const appFlag = process.argv.find((arg) => arg.startsWith('--app='));
  const env = { ...parseEnvFile(readFileSync(join(repoRoot, '.env'), 'utf8')), ...process.env };
  const appId = appFlag ? appFlag.slice('--app='.length) : env.AXSDK_SANDBOX_APP_ID;
  const apiKey = appId === env.AXSDK_SANDBOX_APP_ID ? env.AXSDK_SANDBOX_API_KEY : env.AXSDK_API_KEY;
  const baseUrl = env.AXSDK_BASE_URL;

  // Production's document belongs to the platform. Reading it is always fine; writing it is only fine
  // when the write cannot touch it — that is what `--modules-only` guarantees.
  if (appId === env.AXSDK_APP_ID && command === 'push' && !process.argv.includes('--modules-only')) {
    console.error(`refusing to replace the package of '${appId}': its document is production. Use --modules-only, or the sandbox app.`);
    process.exit(2);
  }

  const root = resolvePath(repoRoot, rootArg);
  const built = buildRpcFlows({ root, delivery: 'registry' });
  const local = {
    flowDocument: built['_common/flows.yaml'],
    sitemap: readFileSync(join(root, 'index.md'), 'utf8'),
    luaModules: built.__report.moduleSources,
  };
  const headers = {
    'x-api-key': apiKey, 'x-app-id': appId,
    'x-app-user-id': 'axsdk-sites-package-cli', 'x-app-user-name': 'package cli',
    origin: 'http://localhost:3334',
  };

  const kib = (text) => (Buffer.byteLength(text, 'utf8') / 1024).toFixed(1);
  console.log(`${command} ${appId} ← ${rootArg}`);
  console.log(`  document ${kib(local.flowDocument)} KiB · sitemap ${kib(local.sitemap)} KiB · modules ${Object.keys(local.luaModules).length}`);

  const modulesOnly = process.argv.includes('--modules-only');
  const compare = modulesOnly ? ['luaModules'] : PACKAGE_PARTS;
  const result = command === 'push'
    ? await pushPackage({ baseUrl, appId, headers, local, compare, modulesOnly })
    : { ...(await fetchPackage({ baseUrl, appId, headers })), issues: null };
  const issues = result.issues ?? diffPackage(local, result, { compare });

  console.log(`  revision ${result.previousRevision === undefined ? result.revision : `${result.previousRevision} → ${result.revision}`}`);
  if (issues.length === 0) {
    console.log('  serving exactly what this workspace builds');
  } else {
    for (const issue of issues) console.log(`  ${issue.code}${issue.name ? ` ${issue.name}` : ''} (local ${issue.local ?? '-'} / remote ${issue.remote ?? '-'})`);
    process.exitCode = 1;
  }
}
