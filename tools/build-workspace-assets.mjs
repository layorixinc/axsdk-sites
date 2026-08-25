#!/usr/bin/env node
// Builds the immutable package workspace: a small reference manifest plus one text file per
// unique SHA-256 source. Flow, Lua and runtime-module bytes never become persisted-store values.

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { loadWorkspace } from '../../axsdk-sdk-js/packages/axsdk-extension-cdp/scripts/workspace.mjs';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST_NAME = 'workspace-manifest.json';
export const ASSET_DIRECTORY = 'workspace-assets';

const bytesOf = (text) => Buffer.byteLength(text, 'utf8');
const digestOf = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const assetFileName = (ref) => `${ref.slice('sha256:'.length)}.txt`;
const kib = (n) => (n / 1024).toFixed(1);

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function readIfPresent(path) {
  try { return await readFile(path, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Every module named by a flow must have one source in the package graph. */
export async function resolveDeclaredModules(root) {
  const source = await readIfPresent(join(root, '_common', 'flows.yaml'));
  if (source === undefined || source.trim() === '') return [];
  const declaredBy = new Map();
  const parsed = parseYaml(source);
  for (const [toolName, tool] of Object.entries(parsed?.flowTools ?? {})) {
    const declared = tool?.execute?.modules;
    if (!Array.isArray(declared)) continue;
    for (const name of declared) {
      if (!declaredBy.has(name)) declaredBy.set(name, []);
      declaredBy.get(name).push(toolName);
    }
  }
  const unresolved = [];
  for (const [name, tools] of declaredBy) {
    const match = String(name).match(/^(.+)\.([^.]+)$/);
    const [directory, file] = match ? [match[1], match[2]] : [undefined, undefined];
    const rpc = directory && await readIfPresent(join(root, directory, 'rpc', `${file}.lua`));
    const script = directory && await readIfPresent(join(root, directory, 'scripts', `${file}.lua`));
    if (rpc === undefined && script === undefined) {
      unresolved.push(`${name} (declared by ${tools.join(', ')})`);
    }
  }
  if (unresolved.length > 0) {
    throw new Error(`Flow modules have no package source:\n  ${unresolved.join('\n  ')}`);
  }
  return [...declaredBy.keys()].sort();
}

function addAsset(table, source) {
  const ref = digestOf(source);
  const existing = table.get(ref);
  if (existing !== undefined && existing !== source) throw new Error(`SHA-256 collision at ${ref}`);
  table.set(ref, source);
  return ref;
}

/** Creates format C3 without touching disk. */
export async function buildPackage({ root, generatedAt = Date.now() } = {}) {
  const workspace = await loadWorkspace(root, { storeLimits: false });
  const declaredModules = await resolveDeclaredModules(root);
  const sourceByRef = new Map();
  const refs = (layers) => Object.fromEntries(Object.entries(layers).map(([key, source]) => [
    key,
    addAsset(sourceByRef, source),
  ]));
  const document = {
    index: addAsset(sourceByRef, workspace.indexMd),
    flows: refs(workspace.flows),
    // Storefront site Lua files are generator-only AX_SITE_CONFIGS declarations. Their generated
    // runtime data is already in the module graph; executing the declarations in the browser adds
    // no command or capability. Keep only the common runtime layer as a package Lua asset.
    lua: refs(workspace.lua[':'] === undefined ? {} : { ':': workspace.lua[':'] }),
    modules: Object.fromEntries(Object.entries(workspace.modules).map(([layer, modules]) => [
      layer,
      refs(modules),
    ])),
    sitemaps: refs(workspace.sitemaps),
    widgets: {},
  };
  const carriedModules = new Set(Object.values(workspace.modules).flatMap((modules) => Object.keys(modules)));
  const missing = declaredModules.filter((name) => !carriedModules.has(name));
  if (missing.length > 0) throw new Error(`Declared runtime modules missing from package graph: ${missing.join(', ')}`);

  const assets = Object.fromEntries([...sourceByRef.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([ref, source]) => [ref, { bytes: bytesOf(source) }]));
  const manifest = {
    version: 2,
    digest: digestOf(stable(document)),
    generatedAt: new Date(generatedAt).toISOString(),
    assets,
    workspace: document,
  };
  return { manifest, sourceByRef, workspace, declaredModules };
}

export async function writePackage({ out, built }) {
  const assetDirectory = join(dirname(out), ASSET_DIRECTORY);
  await rm(assetDirectory, { recursive: true, force: true });
  await mkdir(assetDirectory, { recursive: true });
  await Promise.all([...built.sourceByRef.entries()].map(([ref, source]) =>
    writeFile(join(assetDirectory, assetFileName(ref)), source)));
  await writeFile(out, `${JSON.stringify(built.manifest, null, 2)}\n`);
}

/** Rebuilds in memory and verifies the manifest and every referenced file. Writes nothing. */
export async function checkPackage({ root, out }) {
  const text = await readIfPresent(out);
  if (text === undefined) return { ok: false, reason: `no manifest at ${out}; run build:bundle first` };
  let current;
  try { current = JSON.parse(text); } catch { return { ok: false, reason: `${out} is not JSON` }; }
  if (current.version !== 2) return { ok: false, reason: `unrecognised manifest version ${JSON.stringify(current.version)}` };
  const generatedAt = Date.parse(current.generatedAt);
  if (!Number.isFinite(generatedAt)) return { ok: false, reason: 'generatedAt is not a date' };
  const built = await buildPackage({ root, generatedAt });
  if (stable(current) !== stable(built.manifest)) return { ok: false, reason: 'manifest graph drift' };

  const assetDirectory = join(dirname(out), ASSET_DIRECTORY);
  let actualFiles;
  try { actualFiles = (await readdir(assetDirectory)).sort(); } catch {
    return { ok: false, reason: `asset directory is missing: ${assetDirectory}` };
  }
  const expectedFiles = [...built.sourceByRef.keys()].map(assetFileName).sort();
  if (actualFiles.join('\n') !== expectedFiles.join('\n')) return { ok: false, reason: 'package asset file set drift' };
  for (const [ref, expected] of built.sourceByRef) {
    const actual = await readIfPresent(join(assetDirectory, assetFileName(ref)));
    if (actual !== expected) return { ok: false, reason: `package asset drift in ${ref}` };
  }
  return { ok: true, digest: built.manifest.digest, assetCount: expectedFiles.length };
}

function report({ out, manifest, sourceByRef, workspace, declaredModules }) {
  const uniqueBytes = [...sourceByRef.values()].reduce((sum, source) => sum + bytesOf(source), 0);
  const references = [
    manifest.workspace.index,
    ...Object.values(manifest.workspace.flows),
    ...Object.values(manifest.workspace.lua),
    ...Object.values(manifest.workspace.sitemaps),
    ...Object.values(manifest.workspace.modules).flatMap((modules) => Object.values(modules)),
  ].length;
  const largest = [...sourceByRef.entries()].reduce(
    (best, [ref, source]) => bytesOf(source) > best.bytes ? { ref, bytes: bytesOf(source) } : best,
    { ref: '-', bytes: 0 },
  );
  const moduleCount = Object.values(workspace.modules).reduce((sum, modules) => sum + Object.keys(modules).length, 0);
  return [
    `workspace-manifest → ${out}`,
    `  digest ${manifest.digest}`,
    `  ${sourceByRef.size} unique assets / ${references} references / ${kib(uniqueBytes)} KiB source`,
    `  largest asset ${largest.ref} ${kib(largest.bytes)} KiB — package asset, not a persisted-store value`,
    `  sites ${workspace.entries.length} declared, ${workspace.domains.length} with content`,
    `  runtime modules ${moduleCount}; all ${declaredModules.length} flow-declared names carried`,
  ].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let root = repoRoot;
  let out;
  let check = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === '--check') check = true;
    else if (arg.startsWith('--root=')) root = resolve(arg.slice('--root='.length));
    else if (arg.startsWith('--out=')) out = resolve(arg.slice('--out='.length));
    else { console.error(`unknown argument: ${arg}`); process.exit(2); }
  }
  out ??= join(root, 'dist', MANIFEST_NAME);
  try {
    if (check) {
      const result = await checkPackage({ root, out });
      if (!result.ok) { console.error(`workspace-manifest check FAILED: ${result.reason}`); process.exit(1); }
      console.log(`workspace-manifest check ok — ${result.digest}, ${result.assetCount} assets`);
    } else {
      const built = await buildPackage({ root });
      await mkdir(dirname(out), { recursive: true });
      await writePackage({ out, built });
      console.log(report({ out, ...built }));
    }
  } catch (error) {
    console.error(`workspace-manifest: ${error?.message ?? error}`);
    process.exit(1);
  }
}
