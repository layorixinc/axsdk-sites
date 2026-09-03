/**
 * `render(state, size) → lines`, pure and PLAIN TEXT.
 *
 * No SGR codes here on purpose: colour bytes make width arithmetic lie, and the one thing this
 * function must never do is emit a line wider than the terminal — a wrapped line shifts every row
 * below it. What tells an answer from the question above it is the MARKER (`›` for what you typed,
 * `✗` for a refusal), not a box: a border around a conversation is furniture.
 *
 * The screen is a transcript plus one input line, and the input line is the last row whatever the
 * transcript holds — a prompt that moves as output arrives is a prompt the hands have to look for.
 *
 * `profileLine` and `statusLines` are exported because an ANSWER is text now: the driver prints them
 * into the transcript, and `profile ls`/`ext status` print the same lines, so one row cannot read
 * two ways.
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

  // header, one blank under it, one blank over the prompt, the prompt: four rows that are not
  // transcript. The transcript is BOTTOM-anchored in what is left, so the newest answer is always
  // the line directly above where you type.
  const height = Math.max(rows - 4, 1);
  const shown = state.transcript.slice(-height)
    .map((entry) => cut(`${MARKERS[entry.kind] ?? '  '}${entry.text}`, cols));
  const body = [...Array(Math.max(height - shown.length, 0)).fill(''), ...shown];

  return [header, '', ...body, '', inputLine(state, cols)].slice(0, rows);
}
