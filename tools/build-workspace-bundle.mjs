#!/usr/bin/env node
// Builds `dist/workspace-bundle.json` — the M1 artifact the extension package ships so nothing
// logic-bearing is fetched at runtime (Chrome Web Store MV3 §1).
//
// Format C2: `{ version: 1, digest, generatedAt, stores }` where `stores` is `storeEnvelopes()`
// output VERBATIM — four store keys, each value a JSON string shaped `{ state, version: 0 }`.
// A consumer that does not recognise `version` must refuse, not guess.
//
// The bundle carries the `_common/rpc/*` modules too, as the `axsdk:lua-modules` store — one JSON
// name→source map per layer, decoded by core's `buildClientLuaModules` and sent with the session.
// Inlining them into the flow document instead is impossible: measured live as
// `execute.lua exceeds 65536 bytes (121605)`, a platform per-tool ceiling. The build still
// resolves every declared module; one that resolves NOWHERE is an error, because a name nothing
// delivers is a tool that fails its first turn.
//
// `--check` regenerates and compares on `digest` and the `stores` payload — never on `generatedAt`
// or the envelope's embedded `loadedAt` (the regeneration reuses the artifact's own). A timestamp
// makes a permanently red check, and a permanently red check is one nobody reads.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import {
  LAYER_MAX_BYTES,
  loadWorkspace,
  storeEnvelopes,
} from '../../axsdk-sdk-js/packages/axsdk-extension-cdp/scripts/workspace.mjs';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const bytesOf = (text) => Buffer.byteLength(text, 'utf8');
const kib = (n) => (n / 1024).toFixed(1);

async function readIfPresent(path) {
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Every module `_common/flows.yaml` flowTools declare, resolved against the workspace.
 *
 * A module name is `<dir>.<file>` and may live as `<dir>/scripts/<file>.lua` (carried by the
 * bundle's Lua layers) or `<dir>/rpc/<file>.lua` (carried by the `axsdk:lua-modules` store).
 * Resolving to neither is a build failure, listed with the tools that declared it.
 *
 * @returns {Promise<{ carried: string[], rpc: string[] }>}
 */
export async function resolveDeclaredModules(root) {
  const source = await readIfPresent(join(root, '_common', 'flows.yaml'));
  if (source === undefined || source.trim() === '') return { carried: [], rpc: [] };

  const declaredBy = new Map(); // module name → [tool names]
  const parsed = parseYaml(source);
  for (const [toolName, tool] of Object.entries(parsed?.flowTools ?? {})) {
    const declared = tool?.execute?.modules;
    if (!Array.isArray(declared)) continue;
    for (const name of declared) {
      if (!declaredBy.has(name)) declaredBy.set(name, []);
      declaredBy.get(name).push(toolName);
    }
  }

  const carried = [];
  const rpc = [];
  const unresolved = [];
  for (const [name, tools] of [...declaredBy.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const match = String(name).match(/^(.+)\.([^.]+)$/);
    const [dir, file] = match ? [match[1], match[2]] : [undefined, undefined];
    if (dir !== undefined && (await readIfPresent(join(root, dir, 'rpc', `${file}.lua`))) !== undefined) {
      rpc.push(name);
    } else if (dir !== undefined && (await readIfPresent(join(root, dir, 'scripts', `${file}.lua`))) !== undefined) {
      carried.push(name);
    } else {
      unresolved.push(`${name} (declared by ${tools.join(', ')})`);
    }
  }
  if (unresolved.length > 0) {
    throw new Error(
      '_common/flows.yaml declares modules that resolve to neither _common/rpc/ nor _common/scripts/ '
      + `— nothing would ever deliver them:\n  ${unresolved.join('\n  ')}`,
    );
  }
  return { carried, rpc };
}

/**
 * Loads the workspace and wraps its store envelopes in the C2 artifact shape.
 *
 * `loadedAt` is caller-suppliable so `--check` can regenerate with the artifact's own timestamp and
 * compare payloads byte for byte; a build uses now, and `generatedAt` is the same instant.
 */
export async function buildBundle({ root, loadedAt = Date.now() } = {}) {
  const workspace = await loadWorkspace(root);
  const modules = await resolveDeclaredModules(root);
  const stores = storeEnvelopes(workspace, { loadedAt });
  const bundle = {
    version: 1,
    digest: workspace.digest.slice(0, 12),
    generatedAt: new Date(loadedAt).toISOString(),
    stores,
  };
  return { bundle, workspace, modules };
}

/**
 * Compares the on-disk artifact against a fresh generation. Writes nothing.
 *
 * @returns {Promise<{ ok: true, digest: string } | { ok: false, reason: string }>}
 */
export async function checkBundle({ root, out }) {
  const text = await readIfPresent(out);
  if (text === undefined) return { ok: false, reason: `no artifact at ${out}; run build:bundle first` };
  let existing;
  try {
    existing = JSON.parse(text);
  } catch {
    return { ok: false, reason: `${out} is not JSON` };
  }
  if (existing.version !== 1) {
    return { ok: false, reason: `unrecognised bundle version ${JSON.stringify(existing.version)}; expected 1` };
  }

  // Reuse the artifact's own loadedAt so only real drift can fail — never the clock.
  let loadedAt;
  try {
    loadedAt = JSON.parse(existing.stores['axsdk:sites']).state.index.loadedAt;
  } catch {
    return { ok: false, reason: 'axsdk:sites envelope is not parseable; rebuild' };
  }

  const { bundle } = await buildBundle({ root, loadedAt });
  if (existing.digest !== bundle.digest) {
    return { ok: false, reason: `digest drift: artifact ${existing.digest}, workspace ${bundle.digest}` };
  }
  const expectedKeys = Object.keys(bundle.stores).sort();
  const existingKeys = Object.keys(existing.stores ?? {}).sort();
  if (existingKeys.join(',') !== expectedKeys.join(',')) {
    return {
      ok: false,
      reason: `store keys drift: artifact has [${existingKeys.join(', ')}], workspace makes [${expectedKeys.join(', ')}]`,
    };
  }
  for (const key of expectedKeys) {
    if (existing.stores[key] !== bundle.stores[key]) {
      return { ok: false, reason: `stores payload drift in ${key}` };
    }
  }
  return { ok: true, digest: bundle.digest };
}

/** The numbers a build prints. A number nobody prints is a number nobody checks. */
function report({ out, bundle, workspace, modules }) {
  const lines = [];
  lines.push(`workspace-bundle → ${out}`);
  lines.push(`  digest ${bundle.digest}`);
  lines.push(`  sites ${workspace.entries.length} declared, ${workspace.domains.length} with layers`);

  let total = 0;
  const storeKeys = Object.keys(bundle.stores);
  for (const key of storeKeys) {
    const size = bytesOf(bundle.stores[key]);
    total += size;
    lines.push(`  ${key.padEnd(18)} ${kib(size).padStart(7)} KiB`);
  }
  lines.push(`  total ${kib(total)} KiB across ${storeKeys.length} stores`);

  let largest = { label: '(none)', size: 0 };
  const moduleLayers = bundle.stores['axsdk:lua-modules'] === undefined
    ? {}
    : JSON.parse(bundle.stores['axsdk:lua-modules']).state.lua;
  for (const [kind, layers] of [['flows', workspace.flows], ['lua', workspace.lua], ['modules', moduleLayers]]) {
    for (const [key, value] of Object.entries(layers)) {
      const size = bytesOf(value);
      if (size > largest.size) largest = { label: `${kind}[${key}]`, size };
    }
  }
  const pct = ((largest.size / LAYER_MAX_BYTES) * 100).toFixed(1);
  lines.push(`  largest layer ${largest.label} ${kib(largest.size)} KiB — ${pct}% of the 256 KiB per-layer store ceiling`);

  // Carrying is directory-driven, so a declared rpc module can only go missing when resolution
  // and loading disagree. The line prints only when that is true: a warning that always printed
  // was one nobody read.
  const carriedNames = new Set(
    Object.values(workspace.modules ?? {}).flatMap((layer) => Object.keys(layer)),
  );
  const missing = modules.rpc.filter((name) => !carriedNames.has(name));
  if (missing.length > 0) {
    lines.push(
      `  NOT in this bundle — ${missing.length} declared rpc module(s), `
      + 'delivered by tools/rpc-package.mjs push --modules-only:',
    );
    lines.push(`    ${missing.join(' ')}`);
  } else {
    lines.push(
      `  all ${modules.carried.length + modules.rpc.length} declared modules are carried — `
      + `${modules.carried.length} scripts/ in the Lua layers, ${modules.rpc.length} rpc/ in the module store`,
    );
  }
  return lines.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────────
// `node tools/build-workspace-bundle.mjs [--root=<path>] [--out=<path>] [--check]`
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let root = repoRoot;
  let out;
  let check = false;
  for (const arg of process.argv.slice(2)) {
    if (arg === '--check') check = true;
    else if (arg.startsWith('--root=')) root = resolve(arg.slice('--root='.length));
    else if (arg.startsWith('--out=')) out = resolve(arg.slice('--out='.length));
    else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  out ??= join(root, 'dist', 'workspace-bundle.json');

  try {
    if (check) {
      const result = await checkBundle({ root, out });
      if (!result.ok) {
        console.error(`workspace-bundle check FAILED: ${result.reason}`);
        process.exit(1);
      }
      console.log(`workspace-bundle check ok — digest ${result.digest}, stores match ${out}`);
    } else {
      const built = await buildBundle({ root });
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, `${JSON.stringify(built.bundle, null, 2)}\n`);
      console.log(report({ out, ...built }));
    }
  } catch (error) {
    console.error(`workspace-bundle: ${error?.message ?? error}`);
    process.exit(1);
  }
}
