import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

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

function backendEvidence(modules, backend) {
  const remote = backend?.hash?.luaModules ?? {};
  const issues = [];
  for (const [name, source] of Object.entries(modules)) {
    const expected = packageHash(source);
    if (remote[name] === undefined) issues.push(`missing ${name}`);
    else if (remote[name] !== expected) issues.push(`stale ${name}`);
  }
  for (const name of Object.keys(remote)) {
    if (modules[name] === undefined) issues.push(`orphan ${name}`);
  }
  if (issues.length > 0) throw new Error(`backend module drift: ${issues.join(', ')}`);
  if (typeof backend?.appId !== 'string' || backend.appId === '') throw new Error('backend appId is required');
  if (!Number.isInteger(backend?.revision) || backend.revision < 0) throw new Error('backend revision is required');
  return {
    appId: backend.appId,
    revision: backend.revision,
    moduleHashes: Object.fromEntries(Object.entries(modules).map(([name, source]) => [name, packageHash(source)])),
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
  const body = {
    version: 1,
    extension: {
      version: String(extensionManifest.version ?? ''),
      digest: extension.digest,
      files: extension.files,
    },
    workspace: workspaceEvidence(workspace),
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
