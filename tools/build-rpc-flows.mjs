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

/** `<dir>/scripts/<file>.lua` → `<dir>.<file>` — the naming the runtime accepts (no `/`, separator `.`). */
export function moduleName(relPath) {
  const match = relPath.replace(/\\/g, '/').match(/^(.+)\/scripts\/(.+)\.lua$/);
  if (!match) return null;
  return `${match[1]}.${match[2]}`;
}

/** Every Lua file under a workspace site directory, keyed by module name. */
export function discoverModules(root) {
  const found = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const scripts = join(root, entry.name, 'scripts');
    if (!existsSync(scripts)) continue;
    for (const file of readdirSync(scripts)) {
      if (!file.endsWith('.lua')) continue;
      const rel = `${entry.name}/scripts/${file}`;
      found[moduleName(rel)] = rel;
    }
  }
  return found;
}

/** The registry rejects a module over this; finding out mid-upload leaves a session half-loaded. */
export const MODULE_CEILING = 64 * 1024;
/** Our own discipline (D14): past this a module stops being reviewable well before the limit bites. */
export const MODULE_DISCIPLINE = 48 * 1024;

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
        if (inline) chunks.push(`-- >>> module ${name} (${path})\n${body.trimEnd()}\n-- <<< module ${name}`);
      }

      report.tools += 1;
      if (!inline) continue;
      doc.setIn(['flowTools', toolName, 'execute', 'lua'], `${chunks.join('\n\n')}\n\n${tool.execute.lua ?? ''}`);
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

const CEILING = 256 * 1024;

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const rootArg = process.argv[2] ?? 'playground';
  const root = resolve(repoRoot, rootArg);
  const dest = resolve(repoRoot, 'dist', relative(repoRoot, root));
  const report = emitWorkspace({ root, dest });
  const pct = ((report.bytes / CEILING) * 100).toFixed(1);
  console.log(`built ${rootArg} → ${relative(repoRoot, dest)}`);
  for (const doc of report.documents) console.log(`  ${doc.path.padEnd(28)} ${(doc.bytes / 1024).toFixed(1)} KiB`);
  console.log(`  ${report.tools} tool(s), ${report.modules.length} module(s) inlined`);
  console.log(`  total ${(report.bytes / 1024).toFixed(1)} KiB — ${pct}% of the 256 KiB clientFlows ceiling`);
  if (report.bytes > CEILING) {
    console.error('  ERROR: over the clientFlows ceiling');
    process.exitCode = 1;
  }
}
