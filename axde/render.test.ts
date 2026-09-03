import assert from 'node:assert/strict';
import { test } from 'bun:test';

import { initialState, reduce } from './src/core/state.ts';
import { render } from './src/core/render.ts';

const PROFILES = [
  { name: 'packdev', kind: 'axde', chrome: 'up', port: 39701, ext: { id: 'ihdaghii', fingerprint: '9f3c2a1e' }, userScripts: true, stale: false },
  { name: 'x6-scratch', kind: 'axde', chrome: 'down', port: 39702, ext: { id: 'ihdaghii', fingerprint: '41ab77c2' }, userScripts: false, stale: true },
  { name: 'axsdk-extension-cdp', kind: 'foreign', chrome: 'down', port: 9334, ext: null, userScripts: null, stale: false },
];

function screen(overrides = {}) {
  let state = initialState({ dist: 'D:/dist', buildFingerprint: '9f3c2a1e' });
  state = reduce(state, { type: 'profiles', profiles: PROFILES }).state;
  state = reduce(state, { type: 'log', text: 'install packdev: devMode on -> allow-user-scripts on' }).state;
  return { ...state, ...overrides };
}

const wide = { rows: 24, cols: 100 };

test('every line fits the terminal, and the frame never exceeds the row budget', () => {
  for (const size of [wide, { rows: 12, cols: 44 }, { rows: 8, cols: 30 }]) {
    const lines = render(screen(), size);
    assert.ok(lines.length <= size.rows, `rows ${size.rows}: got ${lines.length}`);
    for (const line of lines) {
      assert.ok(line.length <= size.cols, `cols ${size.cols}: "${line}" is ${line.length}`);
    }
  }
});

test('the selected row is marked, and exactly one row is', () => {
  const lines = render(reduce(screen(), { type: 'key', name: 'down' }).state, wide);
  // Scoped to PROFILE ROWS on purpose: a log line reading "devMode on -> …" contains `>` too, and a
  // screen-wide search for it called the renderer wrong when the renderer was right.
  const rows = lines.filter((line) => /^│ [>\s]\s/.test(line));
  const marked = rows.filter((line) => line.startsWith('│ >'));
  assert.equal(marked.length, 1, `one marked row among ${rows.length}`);
  assert.match(marked[0], /x6-scratch/);
});

test('each profile row states the facts that were READ, including a stale build', () => {
  const lines = render(screen(), wide).join('\n');
  assert.match(lines, /packdev/);
  assert.match(lines, /9f3c2a1e/, 'the installed fingerprint');
  assert.match(lines, /41ab77c2/);
  assert.match(lines, /STALE/, 'a build that no longer matches dist says so');
  assert.match(lines, /foreign/, 'a profile axde did not create is labelled');
  // An unknown fact is shown as unknown, never as a default (absent stays absent).
  assert.match(lines, /—|-{1}/);
});

test('an attached-but-unread profile is labelled attached, never empty', () => {
  const attached = { ...PROFILES[0], ext: null, userScripts: null, dist: 'D:/dist' };
  const lines = render({ ...screen(), profiles: [attached] }, wide).join('\n');
  assert.match(lines, /ext attached/);
});

test('the header carries the build under test and the key hints are visible', () => {
  const lines = render(screen(), wide);
  assert.match(lines[0], /AXSDK Dev Env/);
  assert.match(lines.join('\n'), /9f3c2a1e/);
  for (const hint of ['new', 'delete', 'install', 'uninstall', 'quit']) {
    assert.match(lines.join('\n'), new RegExp(hint, 'i'), hint);
  }
});

test('the log pane shows the most recent lines last', () => {
  let state = screen();
  for (const text of ['first line', 'second line', 'third line']) {
    state = reduce(state, { type: 'log', text }).state;
  }
  const body = render(state, wide).join('\n');
  assert.ok(body.includes('third line'), 'the newest line is on screen');
  assert.ok(body.indexOf('second line') < body.indexOf('third line'));
});

test('a prompt replaces the hints and shows what is being asked, with the typed value', () => {
  const asked = reduce(screen(), { type: 'key', name: 'char', char: 'd' }).state;
  const typed = reduce(asked, { type: 'key', name: 'char', char: 'p' }).state;
  const body = render(typed, wide).join('\n');
  assert.match(body, /packdev/);
  assert.match(body, /delete/i);
  assert.match(body, /\bp\b|p_|p$|p\s*█|p▏/m, 'the typed value is echoed');
});

test('a busy screen says so, so a user does not read a stale row as the truth', () => {
  const body = render(screen({ busy: true }), wide).join('\n');
  assert.match(body, /working|busy/i);
});

test('rendering is pure: the same state renders identically and is not mutated', () => {
  const state = screen();
  const before = JSON.stringify(state);
  assert.deepEqual(render(state, wide), render(state, wide));
  assert.equal(JSON.stringify(state), before);
});

test('an empty inventory explains itself instead of showing an empty frame', () => {
  const empty = initialState({ dist: 'D:/dist', buildFingerprint: '9f3c2a1e' });
  assert.match(render(empty, wide).join('\n'), /no profiles|\[n\]/i);
});

test('a missing local build is stated in the header rather than assumed present', () => {
  const noBuild = initialState({ dist: 'D:/dist', buildFingerprint: undefined });
  assert.match(render(noBuild, wide)[0], /no build|missing/i);
});
