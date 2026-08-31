#!/usr/bin/env node
// Resolves the build-only `execute.modules` key into inlined `execute.lua`, so Lua stays authored as
// files while the runtime receives one self-contained flow document.
//
// This is a stopgap with a known end date: once the runtime ships the module registry (R2), the same
// `modules:` declaration is sent as names and the sources stop travelling in the document. Keeping the
// declaration shape identical now means that switch is a change to this file only.

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, cpSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse, parseDocument } from 'yaml';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `<dir>/scripts/<file>.lua` or `<dir>/rpc/<file>.lua` → `<dir>.<file>` — the naming the runtime accepts
 * (no `/`, separator `.`).
 *
 * Two directories, one namespace: `scripts/` is the browser layer the extension injects, `rpc/` is the
 * runtime layer this migration produces. A module's name should not depend on which side of the move it
 * has reached, but its LOCATION decides whether the browser has to parse it — and the browser must
 * never parse a runtime module.
 */
export function moduleName(relPath) {
  const match = relPath.replace(/\\/g, '/').match(/^(.+)\/(?:scripts|rpc)\/(.+)\.lua$/);
  if (!match) return null;
  return `${match[1]}.${match[2]}`;
}

/** Every Lua file under a workspace layer's `scripts/` or `rpc/`, keyed by module name. */
export function discoverModules(root) {
  const found = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const kind of ['scripts', 'rpc']) {
      const dir = join(root, entry.name, kind);
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.lua')) continue;
        const rel = `${entry.name}/${kind}/${file}`;
        found[moduleName(rel)] = rel;
      }
    }
  }
  return found;
}

/** The registry rejects a module over this; finding out mid-upload leaves a session half-loaded. */
export const MODULE_CEILING = 64 * 1024;
/** Our own discipline (D14): past this a module stops being reviewable well before the limit bites. */
export const MODULE_DISCIPLINE = 48 * 1024;

/**
 * The wire form of a module: code only.
 *
 * These files are heavily commented on purpose — the reasoning is what makes them reviewable — and the
 * runtime never reads it. `61_rpc_storefront` is 38.3 KiB with 16.5 KiB of comment, which is the
 * difference between fitting the 64 KiB per-tool ceiling and failing to compile.
 *
 * Only WHOLE-LINE comments go. A trailing `--` may sit inside a string (`"the dash -- inside"`), and a
 * stripper that cannot tell the two apart would change behaviour to save bytes.
 */
export function stripForWire(source) {
  return String(source)
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('--'))
    .join('\n');
}

/**
 * Reads every `flows.yaml` under `root` and resolves the declared modules, returning the emitted
 * documents keyed by their relative path plus a `__report` of what the result costs.
 *
 * `delivery: 'inline'` folds each module source into `execute.lua` — the stopgap for a runtime without a
 * module registry. `delivery: 'registry'` leaves the names in place and hands the sources back to be
 * uploaded, which is what keeps the document's 256 KiB budget independent of how much Lua we own.
 * Both modes read the same declaration, so switching is a flag rather than an edit.
 */
export function buildRpcFlows({ root, modulePaths, delivery = 'inline' }) {
  const paths = modulePaths ?? discoverModules(root);
  const out = {};
  const report = { bytes: 0, tools: 0, modules: new Set(), moduleSources: {}, oversized: [], documents: [] };

  for (const rel of flowDocuments(root)) {
    const source = readFileSync(join(root, rel), 'utf8');
    const doc = parseDocument(source);
    const parsed = parse(source) ?? {};

    for (const [toolName, tool] of Object.entries(parsed.flowTools ?? {})) {
      const declared = tool?.execute?.modules;
      if (!Array.isArray(declared) || declared.length === 0) continue;

      const inline = delivery !== 'registry';
      const chunks = [];
      for (const name of declared) {
        const path = paths[name];
        if (!path) {
          throw new Error(`${rel}: flowTool '${toolName}' declares module '${name}', which no file provides`);
        }
        report.modules.add(name);
        const body = readFileSync(join(root, path), 'utf8');
        report.moduleSources[name] = body;
        // Each module keeps its own chunk boundary in a comment so a runtime stack trace is traceable
        // back to a file. The runtime compiles them separately under registry delivery; inlined they
        // share one chunk, which is why every module must stay under the 200-locals ceiling on its own.
        if (inline) chunks.push(`-- >>> module ${name} (${path})\n${stripForWire(body)}\n-- <<< module ${name}`);
      }

      report.tools += 1;
      if (!inline) continue;
      const lua = `${chunks.join('\n\n')}\n\n${tool.execute.lua ?? ''}`;
      // The runtime rejects a TOOL over 64 KiB, not a module — measured live as `flow document failed to
      // compile: ... .execute.lua exceeds 65536 bytes`, from two modules that were each legal alone
      // inside a document that was under its own ceiling. Every turn answered with a compile failure.
      const bytes = Buffer.byteLength(lua, 'utf8');
      if (bytes > MODULE_CEILING) {
        // Same wording the runtime uses, so a search for the live failure lands on the build that could
        // have prevented it.
        throw new Error(`tool '${toolName}' execute.lua exceeds ${MODULE_CEILING} bytes (${bytes})`);
      }
      doc.setIn(['flowTools', toolName, 'execute', 'lua'], lua);
      doc.deleteIn(['flowTools', toolName, 'execute', 'modules']);
    }

    const emitted = doc.toString({ lineWidth: 0 });
    out[rel] = emitted;
    report.bytes += Buffer.byteLength(emitted, 'utf8');
    report.documents.push({ path: rel, bytes: Buffer.byteLength(emitted, 'utf8') });
  }

  if (delivery === 'registry') {
    for (const [name, body] of Object.entries(report.moduleSources)) {
      const bytes = Buffer.byteLength(body, 'utf8');
      if (bytes > MODULE_CEILING) {
        throw new Error(`module '${name}' is ${bytes} bytes; the registry rejects anything over ${MODULE_CEILING}`);
      }
      if (bytes > MODULE_DISCIPLINE) report.oversized.push({ name, bytes });
    }
  }

  out.__report = { ...report, modules: [...report.modules] };
  return out;
}

function flowDocuments(root) {
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = `${entry.name}/flows.yaml`;
    if (existsSync(join(root, candidate))) found.push(candidate);
  }
  return found;
}

/**
 * Emits a complete runnable workspace copy (index, site layers, built flows) under `dest`.
 *
 * `delivery` decides whether the emitted documents carry their Lua. The two halves travel separately
 * in the real composition: the flow document is an `extends: app` OVERLAY and goes through
 * `clientFlows`, while the modules go in the app package. Pushing the overlay as an app document fails
 * validation ("actions must define at least one action") — it was never a whole document.
 */
export function emitWorkspace({ root, dest, delivery = 'inline' }) {
  const built = buildRpcFlows({ root, delivery });
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(root, dest, { recursive: true });
  for (const [rel, body] of Object.entries(built)) {
    if (rel === '__report') continue;
    writeFileSync(join(dest, rel), body);
  }
  return built.__report;
}

const CEILING = 512 * 1024;

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const rootArg = process.argv[2] ?? 'playground';
  const root = resolve(repoRoot, rootArg);
  const dest = resolve(repoRoot, 'dist', relative(repoRoot, root));
  const report = emitWorkspace({ root, dest });
  const pct = ((report.bytes / CEILING) * 100).toFixed(1);
  console.log(`built ${rootArg} → ${relative(repoRoot, dest)}`);
  for (const doc of report.documents) console.log(`  ${doc.path.padEnd(28)} ${(doc.bytes / 1024).toFixed(1)} KiB`);
  console.log(`  ${report.tools} tool(s), ${report.modules.length} module(s) inlined`);
  console.log(`  total ${(report.bytes / 1024).toFixed(1)} KiB — ${pct}% of the 512 KiB clientFlows ceiling`);
  if (report.bytes > CEILING) {
    console.error('  ERROR: over the clientFlows ceiling');
    process.exitCode = 1;
  }
}
