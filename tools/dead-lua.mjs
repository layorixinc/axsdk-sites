#!/usr/bin/env node
// Which Lua files nothing can reach.
//
// There are exactly two ways in. A DURABLE command is invoked by a flowTool declared `kind: remote`; a
// RUNTIME module is named in a tool's `modules:` list. `<dir>/scripts/*.lua` and `<dir>/rpc/*.lua` share
// one namespace (`build-rpc-flows.mjs`), so a file under `scripts/` can be either kind — which is why a
// heuristic that only counts `AX_*` definitions calls `10_form_wizard.lua` dead while the quote tool
// loads it every step.
//
// From those entry points the graph is walked over GLOBALS: a file is alive if something alive references
// a global it defines. Libraries define no command and are reached that way, not by name.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('../', import.meta.url);
const dir = (path) => new URL(path, root);

const FLOW_FILES = [
  '_common/flows.yaml', 'bluemoonsoft/flows.yaml', 'thumbtack/flows.yaml', 'playground/_common/flows.yaml',
];

/** Everything under `tools/`, concatenated. A command the dev CLI or a scenario runner calls is in use
 *  even though no flow names it — `ax page` is `AX_read_page`, and deleting it breaks the CLI. */
function toolingText() {
  const parts = [];
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) parts.push(readFileSync(path, 'utf8'));
    }
  };
  walk(join(dir('.').pathname.replace(/^\//, ''), 'tools'));
  return parts.join('\n');
}

/** Every Lua file under a layer's `scripts/` or `rpc/`, with the globals it defines and references. */
function inventory() {
  const files = [];
  const base = dir('.');
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === 'dist') continue;
    for (const kind of ['scripts', 'rpc']) {
      const folder = join(base.pathname.replace(/^\//, ''), entry.name, kind);
      if (!existsSync(folder)) continue;
      for (const file of readdirSync(folder)) {
        if (!file.endsWith('.lua')) continue;
        const path = join(folder, file);
        const source = readFileSync(path, 'utf8');
        const defines = new Set([...source.matchAll(/^(?:function\s+)?(AX_[A-Za-z_]+)/gm)].map((m) => m[1]));
        const refs = new Set([...source.matchAll(/\b(AX_[A-Za-z_]+)/g)].map((m) => m[1]));
        for (const name of defines) refs.delete(name);
        files.push({
          id: relative(base.pathname.replace(/^\//, ''), path).replace(/\\/g, '/'),
          module: `${entry.name}.${file.replace(/\.lua$/, '')}`,
          defines: [...defines],
          refs: [...refs],
          lines: source.split('\n').length,
          commands: [...defines].filter((name) => /^AX_[a-z]/.test(name)),
          // Registration runs at load time and nothing references the file that does it.
          registers: /^\s*[A-Z]\.register\(/m.test(source),
        });
      }
    }
  }
  return files;
}

export function deadLua() {
  const flows = FLOW_FILES.filter((path) => existsSync(dir(path)))
    .map((path) => readFileSync(dir(path), 'utf8')).join('\n');

  // Way in #1: a durable command named by a `kind: remote` tool.
  const remote = new Set([...flows.matchAll(/tool:\s*(AX_[a-z_]+)/g)].map((m) => m[1]));
  // Way in #2: a module named in a runtime tool's `modules:` list.
  const named = new Set([...flows.matchAll(/["']([a-z0-9_-]+\.[0-9a-z_]+)["']/gi)].map((m) => m[1]));
  // Way in #3: the dev CLI and the scenario runners. `ax page` calls `AX_read_page`, the playground tests
  // call `AX_echo`, `tools/scenarios/checkout.mjs` calls `AX_checkout`. None of that is in a flow, and all
  // of it breaks if the command goes.
  const tooling = toolingText();

  const files = inventory();
  const alive = new Set(
    files.filter((file) => file.commands.some((name) => remote.has(name) || tooling.includes(name))
      || named.has(file.module)
      // Way in #4: registration is a SIDE EFFECT at load time, not a global anything references. A
      // storefront config's whole job is `S.register(CONFIG)`, and the graph cannot see that edge.
      || file.registers)
      .map((file) => file.id),
  );

  // Then transitively: whatever an alive file references, whoever defines it is alive too.
  for (let changed = true; changed;) {
    changed = false;
    for (const file of files) {
      if (!alive.has(file.id)) continue;
      for (const ref of file.refs) {
        for (const other of files) {
          if (!alive.has(other.id) && other.defines.includes(ref)) {
            alive.add(other.id);
            changed = true;
          }
        }
      }
    }
  }

  return {
    alive: files.filter((file) => alive.has(file.id)),
    dead: files.filter((file) => !alive.has(file.id)),
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const { alive, dead } = deadLua();
  console.log(`alive ${alive.length} · dead ${dead.length} (${dead.reduce((n, f) => n + f.lines, 0)} lines)\n`);
  for (const file of dead) console.log(`  ${file.id.padEnd(44)} ${file.lines}L  ${file.commands.join(' ')}`);
}
