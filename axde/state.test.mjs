import assert from 'node:assert/strict';
import test from 'node:test';

import { initialState, reduce } from './src/core/state.mjs';

const key = (name, char) => ({ type: 'key', name, ...(char === undefined ? {} : { char }) });
const type = (state, text) => text.split('').reduce((acc, char) => reduce(acc, key('char', char)).state, state);

const PROFILES = [
  { name: 'packdev', kind: 'axde', chrome: 'down', port: 39701, ext: { id: 'aaa', fingerprint: '9f3c2a1e' }, userScripts: true, stale: false },
  { name: 'x6-scratch', kind: 'axde', chrome: 'down', port: 39702, ext: { id: 'aaa', fingerprint: '41ab77c2' }, userScripts: false, stale: true },
  { name: 'axsdk-extension-cdp', kind: 'foreign', chrome: 'up', port: 9334, ext: { id: 'aaa', fingerprint: '9f3c2a1e' }, userScripts: true, stale: false },
];

function loaded() {
  const start = initialState({ dist: 'D:/dist', buildFingerprint: '9f3c2a1e' });
  return reduce(start, { type: 'profiles', profiles: PROFILES }).state;
}

test('the first event is a refresh: the screen never invents an inventory', () => {
  const start = initialState({ dist: 'D:/dist', buildFingerprint: '9f3c2a1e' });
  assert.deepEqual(start.profiles, []);
  assert.deepEqual(reduce(start, { type: 'start' }).effects, [{ type: 'refresh' }]);
});

test('the cursor moves with arrows and jk, clamped at both ends', () => {
  let state = loaded();
  assert.equal(state.cursor, 0);
  state = reduce(state, key('up')).state;
  assert.equal(state.cursor, 0, 'clamped at the top');
  state = reduce(state, key('down')).state;
  state = reduce(state, key('char', 'j')).state;
  assert.equal(state.cursor, 2);
  state = reduce(state, key('down')).state;
  assert.equal(state.cursor, 2, 'clamped at the bottom');
  state = reduce(state, key('char', 'k')).state;
  assert.equal(state.cursor, 1);
});

test('install and uninstall act on the SELECTED profile', () => {
  const state = reduce(loaded(), key('down')).state;
  assert.deepEqual(reduce(state, key('char', 'i')).effects, [{ type: 'install', profile: 'x6-scratch' }]);
  assert.deepEqual(reduce(state, key('char', 'u')).effects, [{ type: 'uninstall', profile: 'x6-scratch' }]);
});

test('an empty inventory refuses every action BY NAME instead of acting on nothing', () => {
  const empty = initialState({ dist: 'D:/dist', buildFingerprint: '9f3c2a1e' });
  for (const name of ['i', 'u', 'd']) {
    const out = reduce(empty, key('char', name));
    assert.deepEqual(out.effects, [], name);
    assert.match(out.state.log.at(-1).text, /no profile selected/i, name);
  }
});

test('while an operation runs, every action except quit is ignored', () => {
  // Two overlapping installs would drive one browser from two places.
  const busy = reduce(loaded(), { type: 'busy', busy: true }).state;
  for (const name of ['i', 'u', 'n', 'd', 'r']) {
    assert.deepEqual(reduce(busy, key('char', name)).effects, [], name);
  }
  assert.deepEqual(reduce(busy, key('char', 'q')).effects, [{ type: 'quit' }]);
  assert.deepEqual(reduce(busy, key('ctrl-c')).effects, [{ type: 'quit' }]);
});

test('a new profile is typed into a prompt; an empty name is refused, escape cancels', () => {
  const opened = reduce(loaded(), key('char', 'n')).state;
  assert.equal(opened.prompt.kind, 'new-profile');
  // Typing must not be read as commands while a prompt is open.
  const typed = type(opened, 'packdev2');
  assert.equal(typed.prompt.value, 'packdev2');
  assert.equal(typed.cursor, 0, 'j and k are text here, not movement');
  assert.deepEqual(reduce(typed, key('enter')).effects, [{ type: 'create-profile', name: 'packdev2' }]);

  const emptied = reduce(opened, key('enter'));
  assert.deepEqual(emptied.effects, []);
  assert.match(emptied.state.log.at(-1).text, /name is required/i);
  assert.equal(reduce(opened, key('escape')).state.prompt, null);
});

test('backspace edits the prompt and a rejected name never becomes an effect', () => {
  const typed = type(reduce(loaded(), key('char', 'n')).state, 'ab/c');
  const fixed = reduce(typed, key('backspace')).state;
  assert.equal(fixed.prompt.value, 'ab/');
  // A separator would put the profile somewhere the caller did not ask for (profileDir's rule).
  const out = reduce(fixed, key('enter'));
  assert.deepEqual(out.effects, []);
  assert.match(out.state.log.at(-1).text, /not a usable profile name/i);
});

test('deleting a FOREIGN profile is refused by name, with no prompt and no effect', () => {
  const onForeign = reduce(reduce(loaded(), key('down')).state, key('down')).state;
  const out = reduce(onForeign, key('char', 'd'));
  assert.deepEqual(out.effects, []);
  assert.equal(out.state.prompt, null);
  assert.match(out.state.log.at(-1).text, /axde did not create/i);
});

test('deleting an axde profile requires the exact name typed back', () => {
  const asked = reduce(loaded(), key('char', 'd')).state;
  assert.deepEqual(asked.prompt, { kind: 'delete-profile', value: '', target: 'packdev' });

  const wrong = reduce(type(asked, 'packde'), key('enter'));
  assert.deepEqual(wrong.effects, []);
  assert.match(wrong.state.log.at(-1).text, /does not match/i);

  const right = reduce(type(asked, 'packdev'), key('enter'));
  assert.deepEqual(right.effects, [{ type: 'delete-profile', name: 'packdev' }]);
});

test('results replace the inventory, keep the cursor in range, and log', () => {
  const state = reduce(reduce(loaded(), key('down')).state, key('down')).state;
  const shrunk = reduce(state, { type: 'profiles', profiles: [PROFILES[0]] }).state;
  assert.equal(shrunk.cursor, 0, 'a cursor past the end is pulled back');
  const logged = reduce(shrunk, { type: 'log', text: 'install packdev: up to date' }).state;
  assert.equal(logged.log.at(-1).text, 'install packdev: up to date');
});

test('an error is kept as a line the user can read, never swallowed', () => {
  const out = reduce(loaded(), { type: 'error', text: 'loadUnpacked refused: File path cannot be resolved' });
  assert.match(out.state.log.at(-1).text, /File path cannot be resolved/);
  assert.equal(out.state.busy, false, 'an error always clears busy');
});

test('the log is bounded so a long session cannot grow state without limit', () => {
  let state = loaded();
  for (let index = 0; index < 500; index += 1) {
    state = reduce(state, { type: 'log', text: `line ${index}` }).state;
  }
  assert.ok(state.log.length <= 200, `bounded, got ${state.log.length}`);
  assert.equal(state.log.at(-1).text, 'line 499');
});
