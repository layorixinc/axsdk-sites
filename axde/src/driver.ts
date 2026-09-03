/**
 * The terminal driver: stdin bytes → events, state → screen, effects → operations.
 *
 * It owns exactly three things the pure core cannot: raw mode, the alternate screen, and the
 * promise that whatever happens the terminal is handed back the way it was found. A TUI that exits
 * leaving raw mode on makes the shell unusable, which is why the restore runs from one place and is
 * registered before the first byte is read.
 */
import { decodeKeys } from './core/keys.ts';
import { render } from './core/render.ts';
import { reduce } from './core/state.ts';

const ALT_SCREEN_ON = '\u001b[?1049h';
const ALT_SCREEN_OFF = '\u001b[?1049l';
const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';
const CLEAR = '\u001b[H\u001b[2J';
const INVERSE = '\u001b[7m';
const RESET = '\u001b[0m';

export function createDriver({ input = process.stdin, output = process.stdout, initial, perform }) {
  let state = initial;
  let painted = [];
  let restored = false;

  const size = () => ({
    rows: Math.max(output.rows ?? 24, 8),
    cols: Math.max(output.columns ?? 80, 30),
  });

  const paint = () => {
    const lines = render(state, size());
    // A cursor row is the one place colour is added, AFTER width maths — the renderer stays plain.
    const decorated = lines.map((line) => (line.startsWith('│ >') ? `${INVERSE}${line}${RESET}` : line));
    if (decorated.length === painted.length && decorated.every((line, index) => line === painted[index])) return;
    painted = decorated;
    output.write(`${CLEAR}${decorated.join('\r\n')}`);
  };

  const restore = () => {
    if (restored) return;
    restored = true;
    if (input.isTTY) input.setRawMode?.(false);
    output.write(`${SHOW_CURSOR}${ALT_SCREEN_OFF}`);
    input.pause?.();
  };

  const apply = (event) => {
    const next = reduce(state, event);
    state = next.state;
    paint();
    return next.effects;
  };

  const run = async () => {
    // Without a TTY there is no input to poll and no screen to keep: entering the alternate screen
    // and looping would hang a piped or CI invocation with nothing on stdout to explain it. The
    // commands are the non-interactive answer, so the refusal names them.
    if (!input.isTTY) {
      throw new Error(
        'the TUI needs a terminal (stdin is not a TTY) — use `axde profile ls` or `axde ext status <profile>`',
      );
    }
    output.write(`${ALT_SCREEN_ON}${HIDE_CURSOR}`);
    input.setRawMode?.(true);
    input.resume?.();
    output.on?.('resize', paint);
    process.on('exit', restore);

    let running = true;
    const queue = [{ type: 'start' }];
    const push = (event) => { queue.push(event); };
    input.on('data', (chunk) => { for (const event of decodeKeys(chunk)) queue.push(event); });

    while (running) {
      if (queue.length === 0) {
        await new Promise((delay) => setTimeout(delay, 16));
        continue;
      }
      const effects = apply(queue.shift());
      for (const effect of effects) {
        if (effect.type === 'quit') { running = false; break; }
        // Applied IMMEDIATELY, not queued: a queued busy event would only be drawn after the
        // operation it is meant to announce had already finished.
        apply({ type: 'busy', busy: true });
        try {
          await perform(effect, push);
        } catch (error) {
          push({ type: 'error', text: `${effect.type}: ${error?.message ?? error}` });
        }
        // A safety net: `perform` normally pushes a fresh inventory (which clears busy), but a
        // handler that pushed nothing must not leave the screen stuck on "working".
        push({ type: 'busy', busy: false });
      }
    }
    restore();
  };

  return { run, restore, snapshot: () => state };
}
