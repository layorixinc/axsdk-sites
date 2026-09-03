import assert from 'node:assert/strict';
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
