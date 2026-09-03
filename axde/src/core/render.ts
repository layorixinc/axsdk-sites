/**
 * `render(state, size) → lines`, pure and PLAIN TEXT.
 *
 * No SGR codes here on purpose: colour bytes make width arithmetic lie, and the one thing this
 * function must never do is emit a line wider than the terminal — a wrapped line shifts the frame,
 * and the frame is how a reader tells an answer from the question above it.
 *
 * The screen is a transcript plus one input line. `profileLine` and `statusLines` are exported
 * because an ANSWER is text now: the driver prints them into the transcript instead of a pane
 * holding an inventory that could go stale.
 *
 * Unknown facts render as `—`. A default in this table would be a claim about a profile nobody read.
 */

const UNKNOWN = '—';
const PROMPT = 'axde › ';
const CURSOR = '▏';

const cut = (text, width) => {
  const value = String(text ?? '');
  return value.length <= width ? value : `${value.slice(0, Math.max(width - 1, 0))}…`;
};

const pad = (text, width) => cut(text, width).padEnd(width, ' ');

function frame(title, bodyLines, cols) {
  const inner = Math.max(cols - 4, 8);
  const head = cut(`┌ ${title} ${'─'.repeat(Math.max(cols - title.length - 4, 0))}┐`, cols);
  const foot = cut(`└${'─'.repeat(Math.max(cols - 2, 0))}┘`, cols);
  return [head, ...bodyLines.map((line) => cut(`│ ${pad(line, inner)} │`, cols)), foot];
}

/** One profile as one line. Attachment comes from the manifest; the rest needs a browser. */
export function profileLine(profile) {
  const pid = profile.pid === undefined ? '' : ` pid ${profile.pid}`;
  const chrome = profile.chrome === 'up'
    ? `chrome up :${profile.port ?? UNKNOWN}${pid}`
    : `chrome down${pid}`;
  const extension = profile.ext === null || profile.ext === undefined
    ? `ext ${profile.dist === undefined ? UNKNOWN : 'attached'}`
    : `ext ${cut(profile.ext.fingerprint ?? UNKNOWN, 8)}`;
  const scripts = profile.userScripts === null || profile.userScripts === undefined
    ? `us ${UNKNOWN}`
    : `us ${profile.userScripts ? 'on' : 'off'}`;
  const kind = profile.kind === 'axde' ? 'axde' : 'foreign';
  return `${pad(profile.name, 20)} ${pad(kind, 7)} ${pad(chrome, 27)} ${pad(extension, 13)} ${scripts}`
    + `${profile.stale ? ' STALE' : ''}`;
}

/** A read, one field per line, with an absent field shown as absent rather than as a default. */
export function statusLines(status) {
  return Object.entries(status).map(([key, value]) => `${pad(key, 14)} ${value ?? UNKNOWN}`);
}

const MARKERS = { you: '› ', out: '  ', err: '✗ ' };

function inputLine(state, cols) {
  const hint = state.input === '' ? '  (/help for the vocabulary)' : '';
  const room = Math.max(cols - PROMPT.length - CURSOR.length - hint.length, 4);
  // A prompt shows its TAIL when the line outgrows the terminal: hiding what is being typed right
  // now would make a long url impossible to check before pressing enter.
  const shown = state.input.length <= room ? state.input : `…${state.input.slice(-(room - 1))}`;
  return cut(`${PROMPT}${shown}${CURSOR}${hint}`, cols);
}

export function render(state, { rows, cols }) {
  const build = state.build.fingerprint === undefined
    ? 'build: no build at dist — run the extension build first'
    : `build: ${cut(state.build.fingerprint, 8)} ok`;
  const header = cut(`AXSDK Dev Env${state.busy ? '  (working…)' : ''}   ${build}`, cols);

  // header + frame borders + the input line are four rows; the rest is transcript.
  const body = Math.max(rows - 4, 1);
  const shown = state.transcript.slice(-body)
    .map((entry) => `${MARKERS[entry.kind] ?? '  '}${entry.text}`);

  return [header, ...frame('session', shown.length === 0 ? [''] : shown, cols), inputLine(state, cols)]
    .slice(0, rows);
}
