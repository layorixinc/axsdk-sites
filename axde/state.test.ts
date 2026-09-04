import assert from 'node:assert/strict';
import { test } from 'bun:test';

import { COMMANDS, initialState, parseLine, reduce } from './src/core/state.ts';

const key = (name, char) => ({ type: 'key', name, ...(char === undefined ? {} : { char }) });
const type = (state, text) => text.split('').reduce((acc, char) => reduce(acc, key('char', char)).state, state);
const submit = (state, line) => reduce(type(state, line), key('enter'));
const start = () => initialState({ dist: 'D:/dist', buildFingerprint: '9f3c2a1e' });
const last = (state) => state.transcript.at(-1);

test('the console starts with a banner that names /help, and asks for nothing', () => {
  const state = start();
  assert.equal(state.input, '');
  assert.ok(state.transcript.length >= 1);
  assert.match(state.transcript.map((entry) => entry.text).join('\n'), /\/help/);
  // Nothing is fetched on start: the inventory is a command now, not a pane.
  assert.deepEqual(reduce(state, { type: 'start' }).effects, []);
});

test('typing edits one line; backspace and escape are the way back out', () => {
  const typed = type(start(), '/launch pack');
  assert.equal(typed.input, '/launch pack');
  assert.equal(reduce(typed, key('backspace')).state.input, '/launch pac');
  assert.equal(reduce(typed, key('escape')).state.input, '', 'a prompt with no way out is a trap');
});

test('a line must start with a slash, and a bare word is refused BY NAME', () => {
  const out = submit(start(), 'profiles');
  assert.deepEqual(out.effects, []);
  assert.equal(last(out.state).kind, 'err');
  assert.match(last(out.state).text, /commands start with \//);
  assert.match(last(out.state).text, /\/help/);
});

test('a submitted line is echoed, then cleared, and kept in history', () => {
  const out = submit(start(), '/profiles');
  assert.deepEqual(out.effects, [{ type: 'command', name: 'profiles', positional: [], flags: {} }]);
  assert.equal(out.state.input, '', 'the line is consumed');
  const echoed = out.state.transcript.filter((entry) => entry.kind === 'you').at(-1);
  assert.equal(echoed.text, '/profiles');
  assert.deepEqual(out.state.history, ['/profiles']);
});

test('an empty line does nothing at all — a console must not answer a question nobody asked', () => {
  const out = reduce(start(), key('enter'));
  assert.deepEqual(out.effects, []);
  assert.equal(out.state.transcript.length, start().transcript.length);
});

test('an unknown command is refused by name and points at the vocabulary', () => {
  const out = submit(start(), '/instal packdev');
  assert.deepEqual(out.effects, []);
  assert.match(last(out.state).text, /unknown command: \/instal/);
  assert.match(last(out.state).text, /\/help/);
});

test('a command with a missing argument answers its own usage line', () => {
  for (const name of ['install', 'uninstall', 'status', 'launch', 'stop', 'new', 'rm']) {
    const out = submit(start(), `/${name}`);
    assert.deepEqual(out.effects, [], name);
    assert.match(last(out.state).text, new RegExp(`/${name}`), name);
    assert.match(last(out.state).text, /needs/, name);
  }
});

test('a profile name is validated with the launcher rule, before any browser is touched', () => {
  const out = submit(start(), '/new ab/c');
  assert.deepEqual(out.effects, []);
  assert.match(last(out.state).text, /not a usable profile name/i);
});

test('flags are parsed into values and switches, and reach the effect', () => {
  const launched = submit(start(), '/launch packdev --url https://example.com/ --force');
  assert.deepEqual(launched.effects, [{
    type: 'command',
    name: 'launch',
    positional: ['packdev'],
    flags: { url: 'https://example.com/', force: true },
  }]);
  const created = submit(start(), '/new packdev --port 39701');
  assert.deepEqual(created.effects[0].flags, { port: '39701' });
});

test('a value flag with nothing after it is refused rather than passed as true', () => {
  const out = submit(start(), '/launch packdev --url');
  assert.deepEqual(out.effects, []);
  assert.match(last(out.state).text, /--url needs a value/);
});

test('/help is answered by the reducer itself — it needs no capability', () => {
  const out = submit(start(), '/help');
  assert.deepEqual(out.effects, []);
  const printed = out.state.transcript.map((entry) => entry.text).join('\n');
  for (const name of Object.keys(COMMANDS)) {
    assert.ok(printed.includes(`/${name}`), name);
  }
});

test('/quit is the one command that ends the loop', () => {
  assert.deepEqual(submit(start(), '/quit').effects, [{ type: 'quit' }]);
  assert.deepEqual(reduce(start(), key('ctrl-c')).effects, [{ type: 'quit' }]);
});

test('while an operation runs, a submit is REFUSED and the line is kept', () => {
  // Two overlapping installs would drive one browser from two places. The old screen swallowed the
  // keystroke; a console that eats what you typed is worse than one that says no.
  const busy = reduce(start(), { type: 'busy', busy: true }).state;
  const typed = type(busy, '/install packdev');
  const out = reduce(typed, key('enter'));
  assert.deepEqual(out.effects, []);
  assert.equal(out.state.input, '/install packdev', 'nothing typed is lost');
  assert.match(last(out.state).text, /still running/i);
  // Quitting is never swallowed.
  assert.deepEqual(reduce(busy, key('ctrl-c')).effects, [{ type: 'quit' }]);
});

test('the arrows walk history, because with no list they would be dead keys', () => {
  let state = submit(start(), '/profiles').state;
  state = submit(state, '/launch packdev').state;
  state = reduce(state, key('up')).state;
  assert.equal(state.input, '/launch packdev', 'the newest first');
  state = reduce(state, key('up')).state;
  assert.equal(state.input, '/profiles');
  state = reduce(state, key('up')).state;
  assert.equal(state.input, '/profiles', 'clamped at the oldest');
  state = reduce(state, key('down')).state;
  assert.equal(state.input, '/launch packdev');
  state = reduce(state, key('down')).state;
  assert.equal(state.input, '', 'past the newest is a fresh line, not a repeat');
});

test('tab completes a unique command and lists an ambiguous one without guessing', () => {
  const unique = reduce(type(start(), '/lau'), key('tab')).state;
  assert.equal(unique.input, '/launch ', 'completed, with the space that follows it');

  const ambiguous = reduce(type(start(), '/s'), key('tab'));
  assert.equal(ambiguous.state.input, '/s', 'an ambiguous prefix is never guessed');
  assert.match(last(ambiguous.state).text, /\/status/);
  assert.match(last(ambiguous.state).text, /\/stop/);

  const nothing = reduce(type(start(), '/zz'), key('tab'));
  assert.match(last(nothing.state).text, /no command starts with \/zz/);
});

test('tab leaves a line alone once it carries an argument', () => {
  const state = reduce(type(start(), '/launch pack'), key('tab')).state;
  assert.equal(state.input, '/launch pack', 'completion is for command NAMES');
});

test('output and errors append readable lines, and an error always clears busy', () => {
  const busy = reduce(start(), { type: 'busy', busy: true }).state;
  const out = reduce(busy, { type: 'output', text: 'install packdev: installed' }).state;
  assert.equal(last(out).kind, 'out');
  const failed = reduce(busy, { type: 'error', text: 'loadUnpacked refused: File path cannot be resolved' });
  assert.equal(last(failed.state).kind, 'err');
  assert.match(last(failed.state).text, /File path cannot be resolved/);
  assert.equal(failed.state.busy, false, 'a screen stuck on "working" hides the reason it stopped');
});

test('the transcript is bounded so a long session cannot grow state without limit', () => {
  let state = start();
  for (let index = 0; index < 500; index += 1) {
    state = reduce(state, { type: 'output', text: `line ${index}` }).state;
  }
  assert.ok(state.transcript.length <= 200, `bounded, got ${state.transcript.length}`);
  assert.equal(last(state).text, 'line 499');
});

test('parseLine is pure and reports its own refusals rather than throwing', () => {
  assert.deepEqual(parseLine('/launch packdev --force'),
    { name: 'launch', positional: ['packdev'], flags: { force: true } });
  assert.match(parseLine('packdev').error, /commands start with \//);
  assert.match(parseLine('/nope').error, /unknown command/);
  // Extra whitespace is a typing accident, not an argument.
  assert.deepEqual(parseLine('  /profiles   '), { name: 'profiles', positional: [], flags: {} });
});

test('every command in the table states a usage line, so a refusal can always quote one', () => {
  for (const [name, spec] of Object.entries(COMMANDS)) {
    assert.ok(spec.usage.startsWith(`/${name}`), name);
    assert.ok(spec.help.length > 0, name);
  }
});

test('the workspace commands parse their own flags', () => {
  assert.deepEqual(submit(start(), '/up packdev --check').effects, [{
    type: 'command', name: 'up', positional: ['packdev'], flags: { check: true },
  }]);
  assert.deepEqual(submit(start(), '/down packdev --force').effects, [{
    type: 'command', name: 'down', positional: ['packdev'], flags: { force: true },
  }]);
  // `/sources` names no profile: it reads the working copy and touches no browser at all.
  assert.deepEqual(submit(start(), '/sources').effects, [{
    type: 'command', name: 'sources', positional: [], flags: {},
  }]);
  assert.match(submit(start(), '/up').state.transcript.at(-1).text, /\/up needs a profile/);
});

test('a program-level flag cannot be passed per command', () => {
  // `--dist`, `--env` and `--workspace` are read when axde starts, so a command cannot quietly
  // deliver a different working copy than the header states.
  const out = submit(start(), '/up packdev --workspace .');
  assert.deepEqual(out.effects, []);
  assert.match(out.state.transcript.at(-1).text, /has no --workspace/);
});
