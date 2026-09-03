/**
 * `render(state, size) → lines`, pure and PLAIN TEXT.
 *
 * No SGR codes here on purpose: colour bytes make width arithmetic lie, and the one thing this
 * function must never do is emit a line wider than the terminal (a wrapped line shifts the frame and
 * the frame is how a reader tells rows apart). The driver applies inverse video to the cursor row,
 * which needs no width maths.
 *
 * Unknown facts render as `—`. A default in this table would be a claim about a profile nobody read.
 */

const UNKNOWN = '—';

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

function profileRow(profile, isSelected, cols) {
  const marker = isSelected ? '>' : ' ';
  const chrome = profile.chrome === 'up' ? `chrome up :${profile.port ?? UNKNOWN}` : 'chrome down';
  // Attachment is readable from the manifest; the fingerprint and the toggles need a browser, so an
  // attached-but-unread profile says `attached` rather than looking empty (unknown stays unknown).
  const extension = profile.ext === null || profile.ext === undefined
    ? `ext ${profile.dist === undefined ? UNKNOWN : 'attached'}`
    : `ext ${cut(profile.ext.fingerprint ?? UNKNOWN, 8)}`;
  const scripts = profile.userScripts === null || profile.userScripts === undefined
    ? `us ${UNKNOWN}`
    : `us ${profile.userScripts ? 'on' : 'off'}`;
  const flags = profile.stale ? ' STALE' : '';
  const kind = profile.kind === 'axde' ? 'axde' : 'foreign';
  return cut(`${marker} ${pad(profile.name, 22)} ${pad(kind, 7)} ${pad(chrome, 20)} ${pad(extension, 13)} ${scripts}${flags}`, cols);
}

const HINTS = '[n] new  [d] delete  [i] install  [u] uninstall  [r] refresh  [q] quit';

export function render(state, { rows, cols }) {
  const build = state.build.fingerprint === undefined
    ? 'build: no build at dist — run the extension build first'
    : `build: ${cut(state.build.fingerprint, 8)} ok`;
  const header = cut(`AXSDK Dev Env — profiles${state.busy ? '  (working…)' : ''}   ${build}`, cols);

  const listBody = state.profiles.length === 0
    ? ['no profiles yet — [n] creates one']
    : state.profiles.map((profile, index) => profileRow(profile, index === state.cursor, cols - 4));

  const footer = state.prompt === null
    ? cut(HINTS, cols)
    : cut(state.prompt.kind === 'new-profile'
      ? `new profile name: ${state.prompt.value}▏  (enter to create, esc to cancel)`
      : `delete "${state.prompt.target}" — type the name to confirm: ${state.prompt.value}▏  (esc to cancel)`, cols);

  // The list gets what is left after the header, the footer and the log frame.
  const logHeight = Math.max(Math.min(4, rows - listBody.length - 5), 1);
  const listHeight = Math.max(rows - logHeight - 5, 1);
  const list = frame('profiles', listBody.slice(0, listHeight), cols);
  const logLines = state.log.slice(-logHeight).map((entry) => entry.text);
  const log = frame('log', logLines.length === 0 ? [''] : logLines, cols);

  return [header, ...list, footer, ...log].slice(0, rows);
}
