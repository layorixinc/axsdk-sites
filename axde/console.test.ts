import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'bun:test';

import { COMMANDS } from './src/core/state.ts';
import { HANDLERS } from './src/cli.ts';

/**
 * The one thing that can drift between the two surfaces is the SET of names. The console offers
 * whatever `COMMANDS` lists — the parser, `/help` and tab completion all read it — so a name with
 * nothing behind it is a promise the screen cannot keep, and a handler nothing can reach is dead
 * code that looks alive.
 */
test('every command the console offers is performed, and every handler is reachable', () => {
  const offered = Object.entries(COMMANDS)
    .filter(([, spec]) => spec.local !== true)
    .map(([name]) => name)
    .sort();
  assert.deepEqual(Object.keys(HANDLERS).sort(), offered);
});

test('the commands the reducer answers itself have NO handler, on purpose', () => {
  // `/help` needs no capability and `/quit` is the driver's own branch; a handler for either would
  // be a second implementation of something already answered.
  for (const name of ['help', 'quit']) {
    assert.equal(COMMANDS[name].local, true, name);
    assert.equal(HANDLERS[name], undefined, name);
  }
});

/**
 * The workspace mechanism has exactly one implementation, and it is the SDK's. A second encoder, a
 * second envelope shape or a second list of store keys would agree with the first only until the
 * next fix landed in one of them — and the copy that DID exist is what left `axsdk:lua-modules` out
 * of a reset for as long as that reset existed.
 */
test('axde re-implements none of the workspace mechanism', () => {
  const root = new URL('./src/', import.meta.url);
  const sources: { name: string; text: string }[] = [];
  const walk = (dir: URL) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
      if (entry.isDirectory()) { walk(child); continue; }
      if (entry.name.endsWith('.ts')) sources.push({ name: entry.name, text: readFileSync(child, 'utf8') });
    }
  };
  walk(root);
  assert.ok(sources.length >= 8, `expected the axde sources, found ${sources.length}`);

  for (const { name, text } of sources) {
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // A store VALUE is a zustand persist envelope; building one here would be a second shape.
    assert.ok(!/state:\s*\{\s*(flows|lua|widgets|index)\b/.test(code), `${name} builds a store envelope`);
    // The splitter, the digest and the merge all live in the SDK.
    for (const owned of ['encodeFlowLayers', 'encodeModuleLayers', 'bundleLua', 'sha256']) {
      assert.ok(!new RegExp(`function\\s+${owned}\\b`).test(code), `${name} re-implements ${owned}`);
    }
    // A LIST of store keys: one array literal naming two or more of them.
    const arrays = code.match(/\[[^\]]*'axsdk:[^\]]*\]/g) ?? [];
    for (const array of arrays) {
      const named = (array.match(/'axsdk:[a-z-]+'/g) ?? []).length;
      assert.ok(named < 2, `${name} carries its own list of store keys: ${array}`);
    }
  }
});
