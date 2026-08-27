import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { STORE_EXCLUDED_INTENTS } from './build-store-flows.mjs';
import { packageHash } from './rpc-package.mjs';
import { readWorkspacePackage } from '../../axsdk-sdk-js/packages/axsdk-extension-cdp/scripts/cws-package.mjs';

const RELEASE_MANIFEST = 'release-manifest.json';

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function filesUnder(root, dir = root) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(root, path));
    else if (entry.isFile()) out.push(path);
  }
  return out.sort((left, right) => left.localeCompare(right));
}

async function extensionEvidence(distDir) {
  const files = {};
  for (const path of await filesUnder(distDir)) {
    const name = relative(distDir, path).split(sep).join('/');
    if (name === RELEASE_MANIFEST) continue;
    files[name] = sha256(await readFile(path));
  }
  if (files['manifest.json'] === undefined) throw new Error('CWS dist is missing manifest.json');
  if (files['workspace-manifest.json'] === undefined) throw new Error('CWS dist is missing workspace-manifest.json');
  return { digest: sha256(stable(files)), files };
}

function runtimeModules(workspace, sources) {
  const modules = {};
  for (const layer of Object.values(workspace.workspace?.modules ?? {})) {
    for (const [name, ref] of Object.entries(layer)) {
      const source = sources[ref];
      if (typeof source !== 'string') throw new Error(`runtime module ${name} has no package asset`);
      if (modules[name] !== undefined && modules[name] !== source) {
        throw new Error(`runtime module ${name} has conflicting package sources`);
      }
      modules[name] = source;
    }
  }
  return modules;
}

/**
 * @param modules the modules the SHIPPED package carries
 * @param backend the app revision this artifact is bound to
 * A declared module that is missing or stale at the backend is always drift: the artifact would run against
 * a revision that cannot answer for it. A backend module the package does not declare is a different fact —
 * the backend app serves the development surface too, and the store profile deliberately declares fewer.
 * A module no tool names is inert (the flow document is what names modules), so it is RECORDED as unused
 * rather than refused; refusing it made the artifact smoke unrunnable the moment the package was narrowed.
 * There is no full-surface branch here on purpose: `singlePurposeEvidence` has already refused a package
 * that is not the store profile, so a second rule keyed on the same fact would be a limb with no caller.
 */
function backendEvidence(modules, backend) {
  const remote = backend?.hash?.luaModules ?? {};
  const issues = [];
  for (const [name, source] of Object.entries(modules)) {
    const expected = packageHash(source);
    if (remote[name] === undefined) issues.push(`missing ${name}`);
    else if (remote[name] !== expected) issues.push(`stale ${name}`);
  }
  const unused = Object.keys(remote).filter((name) => modules[name] === undefined).sort();
  if (issues.length > 0) throw new Error(`backend module drift: ${issues.join(', ')}`);
  if (typeof backend?.appId !== 'string' || backend.appId === '') throw new Error('backend appId is required');
  if (!Number.isInteger(backend?.revision) || backend.revision < 0) throw new Error('backend revision is required');
  return {
    appId: backend.appId,
    revision: backend.revision,
    moduleHashes: Object.fromEntries(Object.entries(modules).map(([name, source]) => [name, packageHash(source)])),
    ...(unused.length > 0 ? { unusedBackendModules: unused } : {}),
  };
}

function workspaceEvidence(workspace) {
  if (workspace?.version !== 2 || typeof workspace?.digest !== 'string' || workspace.digest === '') {
    throw new Error('workspace manifest version/digest is invalid');
  }
  return {
    digest: workspace.digest,
    assets: Object.fromEntries(Object.keys(workspace.assets).sort().map((ref) => [ref, workspace.assets[ref].bytes])),
  };
}

/**
 * The packaged flow document must be the STORE profile — the sentence in `store/single-purpose.md` as
 * code. A release built from the development profile ships the service-quote and memory surfaces under a
 * listing that promises shopping only, and the most common way a §1 mismatch is found is a reviewer
 * typing something the listing never mentions and getting an answer.
 *
 * Read from the package, not from the repository: what ships is the only thing this can be true of.
 */
function singlePurposeEvidence(workspace, sources) {
  const ref = workspace.workspace?.flows?.[':'];
  const source = typeof ref === 'string' ? sources[ref] : undefined;
  if (typeof source !== 'string') throw new Error('the packaged workspace has no common flow document');
  const document = parseYaml(source) ?? {};
  const routable = new Set((document.router?.routes ?? []).map((route) => route.intent));
  const offenders = STORE_EXCLUDED_INTENTS.filter((intent) => routable.has(intent));
  if (offenders.length > 0) {
    throw new Error(`outside the single purpose: the packaged document still routes ${offenders.join(', ')}`);
  }
  // A hook must be NEUTRAL, not absent. The app document declares `hooks.beforeIntent: [record_memory]`
  // itself and an overlay cannot delete a key the app declares, so a package with no hook flow lets the
  // app's model-driven version run — measured, that answered the user with raw channel scaffolding. What
  // ships must define the hook and do nothing in it: no tool, no module, no user-facing text.
  const hooks = Object.values(document.hooks ?? {}).flat().map(String);
  const neutralHooks = [];
  for (const name of hooks) {
    const nodes = Object.values(document.flows?.[name]?.nodes ?? {});
    if (nodes.length === 0) {
      throw new Error(`outside the single purpose: hook ${name} is named but not defined here`);
    }
    const reaches = nodes.some((node) => node.run !== undefined || node.id !== undefined
      || (node.allowedTools ?? []).length > 0 || node.kind !== 'terminal' || node.respond !== undefined);
    if (reaches) {
      throw new Error(`outside the single purpose: hook ${name} still does work`);
    }
    neutralHooks.push(name);
  }
  const fallthrough = String(document.router?.defaultIntent ?? '');
  if (!fallthrough.startsWith('shopping')) {
    throw new Error(`outside the single purpose: unmatched requests enter ${fallthrough || '(nothing)'}`);
  }
  return { defaultIntent: fallthrough, routableIntents: [...routable].sort(), neutralHooks: neutralHooks.sort() };
}

export async function createReleaseManifest({ distDir, backend }) {
  const extension = await extensionEvidence(distDir);
  let extensionManifest;
  let workspacePackage;
  try {
    extensionManifest = JSON.parse(await readFile(join(distDir, 'manifest.json'), 'utf8'));
    workspacePackage = await readWorkspacePackage(join(distDir, 'workspace-manifest.json'));
  } catch (error) {
    throw new Error(`CWS dist contains invalid package JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { manifest: workspace, sources } = workspacePackage;
  const modules = runtimeModules(workspace, sources);
  // Narrowed packages legitimately declare fewer modules than the backend carries, so the profile has
  // to be established before the backend comparison can be read.
  const singlePurpose = singlePurposeEvidence(workspace, sources);
  const body = {
    version: 1,
    extension: {
      version: String(extensionManifest.version ?? ''),
      digest: extension.digest,
      files: extension.files,
    },
    workspace: workspaceEvidence(workspace),
    singlePurpose,
    runtime: {
      moduleCount: Object.keys(modules).length,
      modules: Object.fromEntries(Object.keys(modules).sort().map((name) => [name, sha256(modules[name])])),
    },
    backend: backendEvidence(modules, backend),
  };
  return { ...body, releaseId: sha256(stable(body)) };
}

export async function verifyReleaseManifest({ distDir, manifest, backend }) {
  const actual = await createReleaseManifest({ distDir, backend });
  if (stable(actual) !== stable(manifest)) {
    throw new Error(`release manifest drift: expected ${manifest?.releaseId ?? '-'}, actual ${actual.releaseId}`);
  }
  return actual;
}

export async function writeReleaseManifest({ distDir, backend }) {
  const manifest = await createReleaseManifest({ distDir, backend });
  await writeFile(join(distDir, RELEASE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  await verifyReleaseManifest({ distDir, manifest, backend });
  return manifest;
}
