#!/usr/bin/env node
// Generates SCHEMA.md from the flows, because a hand-kept mirror of a machine-readable source drifts and
// this one had: 40 entries against 85 real tools, still advertising the whole durable command set the RPC
// port replaced — `AX_open_quote`, `AX_search_service`, `AX_add_to_cart` and twenty more that no flow can
// reach. Every one of those is a promise to the model about a tool that is not there.
//
// The tools the model may call ARE the flow tools: what a node lists in `allowedTools` resolves to a
// `flowTools` entry, and that entry's `parameters` is the schema the model is given. So the document is
// derivable, and deriving it is the only way it stays true.
//
//   node tools/build-schema.mjs           # write SCHEMA.md
//   node tools/build-schema.mjs --check   # fail if SCHEMA.md is stale

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseDocument } from 'yaml';

const root = new URL('../', import.meta.url);

/** Every flow file in the repo. A hand-kept list here would reintroduce the drift this file removes. */
const FLOW_FILES = [
  '_common/flows.yaml',
  'thumbtack/flows.yaml',
  'playground/_common/flows.yaml',
];

export function buildSchema() {
  const tools = new Map();
  for (const path of FLOW_FILES) {
    const url = new URL(path, root);
    if (!existsSync(url)) continue;
    const document = parseDocument(readFileSync(url, 'utf8')).toJS() ?? {};
    for (const [name, tool] of Object.entries(document.flowTools ?? {})) {
      if (!tool || typeof tool !== 'object' || !tool.parameters) continue;
      // A site layer may redefine a common tool; last file wins, which is the merge order the runtime uses.
      tools.set(name, {
        name,
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: tool.parameters,
      });
    }
  }
  // Sorted, so a diff shows what CHANGED rather than where a tool happened to be declared.
  return [...tools.values()].sort((left, right) => left.name.localeCompare(right.name));
}
// CLI only when executed directly. As a top-level side effect this REWROTE SCHEMA.md the moment a test
// imported `buildSchema`, so the check compared the file against itself and passed on a document it had
// just written. An import that edits the repo is a trap for whoever imports next.
function main(argv) {
  const rendered = `${JSON.stringify(buildSchema(), null, 2)}\n`;
  const target = new URL('SCHEMA.md', root);
  if (argv.includes('--check')) {
    const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
    if (current !== rendered) {
      console.error('SCHEMA.md is stale — run `npm run build:schema`');
      process.exit(1);
    }
    console.log(`SCHEMA.md is current (${buildSchema().length} tools)`);
    return;
  }
  writeFileSync(target, rendered);
  console.log(`wrote SCHEMA.md (${buildSchema().length} tools)`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  main(process.argv.slice(2));
}
