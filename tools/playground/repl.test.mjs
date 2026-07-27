import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough, Writable } from 'node:stream';

import { runPlaygroundRepl } from './repl.mjs';

test('drains queued commands without prompting a closed input stream', async () => {
  const input = new PassThrough();
  let output = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const actions = [];
  const repl = runPlaygroundRepl({
    input,
    output: stream,
    execute: async (action) => {
      actions.push(action.kind);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { executed: action.kind };
    },
  });

  input.end('.call AX_echo {"value":"queued"}\n.quit\n');
  await repl;

  assert.deepEqual(actions, ['call']);
  assert.match(output, /"executed": "call"/);
});
