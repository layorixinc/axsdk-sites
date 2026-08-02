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

/**
 * Reads every `flows.yaml` under `root`, inlines declared modules, and returns the emitted documents
 * keyed by their relative path, plus a `__report` of what the result costs.
 */
export function buildRpcFlows({ root, modulePaths }) {
  const paths = modulePaths ?? discoverModules(root);
  const out = {};
  const report = { bytes: 0, tools: 0, modules: new Set(), documents: [] };

  for (const rel of flowDocuments(root)) {
    const source = readFileSync(join(root, rel), 'utf8');
    const doc = parseDocument(source);
    const parsed = parse(source) ?? {};

    for (const [toolName, tool] of Object.entries(parsed.flowTools ?? {})) {
      const declared = tool?.execute?.modules;
      if (!Array.isArray(declared) || declared.length === 0) continue;

      const chunks = declared.map((name) => {
        const path = paths[name];
        if (!path) {
          throw new Error(`${rel}: flowTool '${toolName}' declares module '${name}', which no file provides`);
        }
        report.modules.add(name);
        // Each module keeps its own chunk boundary in a comment so a runtime stack trace is traceable
        // back to a file. The runtime compiles them separately once the registry lands; until then they
        // share one chunk, which is why every module must stay under the 200-locals ceiling on its own.
        return `-- >>> module ${name} (${path})\n${readFileSync(join(root, path), 'utf8').trimEnd()}\n-- <<< module ${name}`;
      });

      const script = tool.execute.lua ?? '';
      doc.setIn(['flowTools', toolName, 'execute', 'lua'], `${chunks.join('\n\n')}\n\n${script}`);
      doc.deleteIn(['flowTools', toolName, 'execute', 'modules']);
      report.tools += 1;
    }

    const emitted = doc.toString({ lineWidth: 0 });
    out[rel] = emitted;
    report.bytes += Buffer.byteLength(emitted, 'utf8');
    report.documents.push({ path: rel, bytes: Buffer.byteLength(emitted, 'utf8') });
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

/** Emits a complete runnable workspace copy (index, site layers, built flows) under `dest`. */
export function emitWorkspace({ root, dest }) {
  const built = buildRpcFlows({ root });
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
