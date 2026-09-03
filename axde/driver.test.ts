import assert from 'node:assert/strict';
import { test } from 'bun:test';

import { createDriver } from './src/driver.ts';
import { initialState } from './src/core/state.ts';

const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

function harness({ perform }: { perform?: (effect: any, push: (event: any) => void) => unknown } = {}) {
  const handlers: Record<string, (chunk: unknown) => void> = {};
  const rawModes: boolean[] = [];
  const written: string[] = [];
  const input = {
    isTTY: true,
    setRawMode: (on: boolean) => { rawModes.push(on); },
    resume: () => {},
    pause: () => {},
    on: (event: string, handler: (chunk: unknown) => void) => { handlers[event] = handler; },
  };
  const output = {
    rows: 24,
    columns: 80,
    write: (text: string) => { written.push(text); },
    on: () => {},
  };
  const effects: any[] = [];
  const driver = createDriver({
    input: input as never,
    output: output as never,
    initial: initialState({ dist: 'D:/dist', buildFingerprint: '9f3c2a1e' }),
    perform: perform ?? (async (effect, push) => {
      effects.push(effect);
      push({ type: 'output', text: `${effect.name}: done` });
    }),
  });
  const type = async (text: string) => {
    handlers.data?.(text);
    await delay(60);
  };
  return { driver, type, written, rawModes, effects };
}

test('the terminal is taken and handed back: alternate screen and raw mode both restore', async () => {
  const { driver, type, written, rawModes } = harness();
  const done = driver.run();
  await delay(40);
  await type('/quit\r');
  await done;

  const all = written.join('');
  assert.ok(all.includes('\u001b[?1049h'), 'the alternate screen is entered');
  assert.ok(all.includes('\u001b[?1049l'), 'and left again');
  assert.ok(all.includes('\u001b[?25l') && all.includes('\u001b[?25h'), 'the cursor is hidden then shown');
  // A TUI that exits leaving raw mode on makes the shell unusable.
  assert.deepEqual(rawModes, [true, false]);
});

test('the first event asks for NOTHING, and a typed command reaches the reducer', async () => {
  const { driver, type, effects } = harness();
  const done = driver.run();
  await delay(40);
  // Nothing is fetched on start: the inventory is an answer to /profiles, not a pane.
  assert.deepEqual(effects, []);
  await type('/profiles\r');
  await type('/quit\r');
  await done;

  assert.deepEqual(effects, [{ type: 'command', name: 'profiles', positional: [], flags: {} }]);
});

test('a letter is text now, not a shortcut: `q` alone does not quit', async () => {
  const { driver, type, effects } = harness();
  const done = driver.run();
  await delay(40);
  await type('q');
  assert.deepEqual(effects, [], 'the old single-key surface is gone');
  assert.equal(driver.snapshot().input, 'q', 'it is on the line, where it was typed');
  await type('\u0003');
  await done;
});

test('busy is on screen WHILE the operation runs, not after it', async () => {
  // A queued busy event would only be drawn once the operation it announces had finished.
  let seen;
  const { driver, type } = harness({
    perform: async () => {
      seen = driver.snapshot().busy;
      await delay(10);
    },
  });
  const done = driver.run();
  await delay(40);
  await type('/profiles\r');
  await type('/quit\r');
  await done;
  assert.equal(seen, true);
});

test('an operation that throws becomes a readable transcript line and clears busy', async () => {
  const { driver, type } = harness({
    perform: async () => { throw new Error('loadUnpacked refused: File path cannot be resolved'); },
  });
  const done = driver.run();
  await delay(40);
  await type('/install packdev\r');
  await type('/quit\r');
  await done;
  const state = driver.snapshot();
  const failure = state.transcript.filter((entry: any) => entry.kind === 'err').at(-1);
  assert.match(failure.text, /File path cannot be resolved/);
  assert.equal(state.busy, false, 'a screen stuck on "working" hides the reason it stopped');
});

test('ctrl-c quits even while an operation is running', async () => {
  const { driver, type } = harness({ perform: async () => { await delay(5); } });
  const done = driver.run();
  await delay(40);
  await type('\u0003');
  await done;
  assert.ok(true, 'run() returned');
});

test('painting is skipped when nothing changed, so a poll loop does not flicker', async () => {
  const { driver, type, written } = harness();
  const done = driver.run();
  await delay(40);
  const before = written.length;
  await delay(120); // several idle poll passes
  const idle = written.length - before;
  await type('\u0003');
  await done;
  assert.equal(idle, 0, `idle passes wrote ${idle} frames`);
});

test('without a terminal the TUI refuses BY NAME instead of waiting forever', async () => {
  // A piped or CI invocation used to enter the alternate screen and poll an input that never
  // arrives, so it hung with nothing on stdout to explain it.
  const written: string[] = [];
  const driver = createDriver({
    input: { isTTY: false, on: () => {}, setRawMode: () => {}, resume: () => {}, pause: () => {} } as never,
    output: { rows: 24, columns: 80, write: (text: string) => { written.push(text); }, on: () => {} } as never,
    initial: initialState({ dist: 'D:/dist', buildFingerprint: '9f3c2a1e' }),
    perform: async () => {},
  });
  await assert.rejects(() => driver.run(), /not a TTY|needs a terminal/i);
  assert.ok(!written.join('').includes('\u001b[?1049h'), 'it never took the alternate screen');
});
