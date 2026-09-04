import assert from 'node:assert/strict';
import { test } from 'bun:test';

import { initialState, reduce } from './src/core/state.ts';
import { profileLine, render, statusLines } from './src/core/render.ts';

const PROFILES = [
  { name: 'packdev', kind: 'axde', chrome: 'up', port: 39701, pid: 35472, dist: 'D:/dist', ext: { id: 'ihdaghii', fingerprint: '9f3c2a1e' }, userScripts: true, stale: false },
  { name: 'x6-scratch', kind: 'axde', chrome: 'down', port: 39702, dist: 'D:/dist', ext: { id: 'ihdaghii', fingerprint: '41ab77c2' }, userScripts: false, stale: true },
  { name: 'axsdk-extension-cdp', kind: 'foreign', chrome: 'down', port: 9334, ext: null, userScripts: null, stale: false },
];

function session() {
  let state = initialState({ dist: 'D:/dist', buildFingerprint: '9f3c2a1e' });
  state = reduce(state, { type: 'key', name: 'char', char: '/' }).state;
  for (const char of 'profiles') state = reduce(state, { type: 'key', name: 'char', char }).state;
  state = reduce(state, { type: 'key', name: 'enter' }).state;
  for (const profile of PROFILES) {
    state = reduce(state, { type: 'output', text: profileLine(profile) }).state;
  }
  return state;
}

const wide = { rows: 24, cols: 100 };

test('every line fits the terminal, and the frame never exceeds the row budget', () => {
  for (const size of [wide, { rows: 12, cols: 44 }, { rows: 8, cols: 30 }]) {
    const lines = render(session(), size);
    assert.ok(lines.length <= size.rows, `rows ${size.rows}: got ${lines.length}`);
    for (const line of lines) {
      assert.ok(line.length <= size.cols, `cols ${size.cols}: "${line}" is ${line.length}`);
    }
  }
});

test('there is no profile pane and no key legend — the list is an ANSWER now', () => {
  const fresh = initialState({ dist: 'D:/dist', buildFingerprint: '9f3c2a1e' });
  const screen = render(fresh, wide).join('\n');
  assert.ok(!screen.includes('packdev'), 'nothing is listed until it is asked for');
  assert.ok(!/\[n\]|\[i\]|\[q\]/.test(screen), 'single-key hints are gone');
  assert.match(screen, /\/help/, 'the banner names the way in');
});

test('there is no box: a border around a conversation is furniture, not information', () => {
  for (const line of render(session(), wide)) {
    assert.ok(!/[┌┐└┘│─]/.test(line), `box drawing survived: "${line}"`);
  }
  assert.ok(!render(session(), wide).join('\n').includes('session'), 'and no frame title');
});

test('the input line is the LAST line and does not move as the transcript grows', () => {
  const short = render(initialState({ dist: 'D:/dist', buildFingerprint: '9f3c2a1e' }), wide);
  const long = render(session(), wide);
  assert.equal(short.length, long.length, 'the prompt stays where the hands expect it');
  assert.match(short.at(-1), /^axde › /);
  assert.match(long.at(-1), /^axde › /);
  // Newest answer sits directly above the prompt, separated by one blank line.
  assert.equal(long.at(-2), '');
  assert.match(long.at(-3), /axsdk-extension-cdp/);
});

test('what you typed and what it answered are both readable, newest last', () => {
  const lines = render(session(), wide).join('\n');
  assert.match(lines, /› \/profiles/, 'the echo of the command');
  assert.match(lines, /packdev/);
  assert.match(lines, /9f3c2a1e/);
  assert.match(lines, /STALE/, 'a build that no longer matches dist says so');
  assert.match(lines, /foreign/);
});

test('the input line shows the prompt, the typed value and a cursor', () => {
  const typed = 'abcdefgh'.split('').reduce(
    (state, char) => reduce(state, { type: 'key', name: 'char', char }).state,
    initialState({ dist: 'D:/dist', buildFingerprint: '9f3c2a1e' }),
  );
  const input = render(typed, wide).at(-1);
  assert.match(input, /axde › abcdefgh▏/);
});

test('an empty prompt names /help rather than sitting there blank', () => {
  const input = render(initialState({ dist: 'D:/dist', buildFingerprint: '9f3c2a1e' }), wide).at(-1);
  assert.match(input, /\/help/);
});

test('a long line is CUT, never wrapped: a wrapped line shifts the whole frame', () => {
  const long = reduce(session(), { type: 'output', text: 'x'.repeat(400) }).state;
  for (const line of render(long, { rows: 10, cols: 40 })) {
    assert.ok(line.length <= 40, `"${line}" is ${line.length}`);
  }
  const typed = 'y'.repeat(300).split('').reduce(
    (state, char) => reduce(state, { type: 'key', name: 'char', char }).state, long,
  );
  assert.ok(render(typed, { rows: 10, cols: 40 }).at(-1).length <= 40);
});

test('a busy screen says so, so a user does not read a finished answer as the current one', () => {
  const busy = reduce(session(), { type: 'busy', busy: true }).state;
  assert.match(render(busy, wide)[0], /working/i);
});

test('the header carries the build under test, and a missing one is stated', () => {
  assert.match(render(session(), wide)[0], /AXSDK Dev Env/);
  assert.match(render(session(), wide)[0], /9f3c2a1e/);
  const noBuild = initialState({ dist: 'D:/dist', buildFingerprint: undefined });
  assert.match(render(noBuild, wide)[0], /no build|missing/i);
});

test('rendering is pure: the same state renders identically and is not mutated', () => {
  const state = session();
  const before = JSON.stringify(state);
  assert.deepEqual(render(state, wide), render(state, wide));
  assert.equal(JSON.stringify(state), before);
});

test('a profile line states what was READ and leaves unknown unknown', () => {
  assert.match(profileLine(PROFILES[0]), /chrome up :39701 pid 35472/);
  assert.match(profileLine(PROFILES[0]), /us on/);
  assert.match(profileLine(PROFILES[1]), /chrome down/);
  assert.match(profileLine(PROFILES[1]), /STALE/);
  // Attachment is readable from the manifest; the fingerprint needs a browser.
  assert.match(profileLine({ ...PROFILES[0], ext: null, userScripts: null }), /ext attached/);
  assert.match(profileLine(PROFILES[2]), /ext —/);
  assert.match(profileLine(PROFILES[2]), /us —/);
});

test('a status answer is one line per field, with absent fields shown as absent', () => {
  const lines = statusLines({
    profile: 'packdev', installed: true, userScripts: true, stale: false, lastError: undefined,
  });
  assert.ok(lines.some((line) => /installed\s+true/.test(line)), lines.join('|'));
  assert.ok(lines.some((line) => /lastError\s+—/.test(line)), lines.join('|'));
});

test('the header names the workspace, because /up delivers THAT one', () => {
  const state = initialState({ dist: 'D:/dist', buildFingerprint: '9f3c2a1e', workspace: 'workspace' });
  // The name, never the digest: a digest goes stale the moment a file is saved, and a stale fact on
  // screen is a lie. `/sources` computes one when asked.
  assert.match(render(state, wide)[0], /ws: workspace/);
  const none = initialState({ dist: 'D:/dist', buildFingerprint: '9f3c2a1e', workspace: undefined });
  assert.match(render(none, wide)[0], /ws: none/);
});
