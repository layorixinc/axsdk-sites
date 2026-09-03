import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeKeys } from './src/core/keys.mjs';

const names = (chunk) => decodeKeys(chunk).map((event) => event.name);

test('arrow sequences, enter, escape and backspace decode to names', () => {
  assert.deepEqual(names('\u001b[A'), ['up']);
  assert.deepEqual(names('\u001b[B'), ['down']);
  assert.deepEqual(names('\r'), ['enter']);
  assert.deepEqual(names('\n'), ['enter']);
  assert.deepEqual(names('\u001b'), ['escape']);
  assert.deepEqual(names('\u007f'), ['backspace']);
  assert.deepEqual(names('\b'), ['backspace']);
  assert.deepEqual(names('\u0003'), ['ctrl-c']);
});

test('printable characters carry their value and multibyte text survives', () => {
  assert.deepEqual(decodeKeys('ni'), [
    { type: 'key', name: 'char', char: 'n' },
    { type: 'key', name: 'char', char: 'i' },
  ]);
  // A profile name may be typed in any language; a byte-wise decoder would split this.
  assert.deepEqual(decodeKeys('팩').map((event) => event.char), ['팩']);
});

test('a Buffer decodes exactly like the equivalent string', () => {
  assert.deepEqual(decodeKeys(Buffer.from('\u001b[Ax', 'utf8')), decodeKeys('\u001b[Ax'));
});

test('one chunk carrying a sequence AND text yields both, in order', () => {
  assert.deepEqual(names('\u001b[Bq'), ['down', 'char']);
});

test('unknown escape sequences are dropped, never mistaken for text', () => {
  // A mouse report or an unhandled CSI must not type garbage into a prompt.
  assert.deepEqual(names('\u001b[<0;10;10M'), []);
  assert.deepEqual(names('\u001b[200~'), []);
});

test('control characters other than the handled ones are dropped', () => {
  assert.deepEqual(names('\u0000\u0007'), []);
});
