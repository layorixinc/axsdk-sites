/**
 * The whole decision layer of `axde`, as a pure reducer: `reduce(state, event) → {state, effects}`.
 *
 * The screen is a CONSOLE: a transcript of what was asked and what was answered, plus one input
 * line. Every operation is a slash command typed into that line, so the target of an operation is
 * in the COMMAND rather than in a cursor — which is what let three mechanisms be deleted rather
 * than ported (design §5): the confirm-by-retyping prompt, the screen-has-no-`--force` guard, and
 * the cached profile inventory that every operation had to refresh.
 *
 * Effects are DECLARED, never performed here, so every rule below is tested with no terminal and no
 * browser — the shape `10_form_wizard.lua` and `44_pagination.lua` use, for the same reason.
 *
 * Two rules are load-bearing rather than cosmetic:
 * - while an operation runs, a submit is REFUSED and the line is kept: two overlapping installs
 *   drive one browser from two places, and a console that eats what you typed is worse than one
 *   that says no;
 * - `COMMANDS` is the single vocabulary. The parser, `/help` and the completer all read it, and a
 *   test pins it against the driver's handler table — a command the console offers and nothing
 *   performs is a promise the screen cannot keep.
 */

/** A profile name is a directory name: `profileDir` refuses separators, and so does this. */
const USABLE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const TRANSCRIPT_LIMIT = 200;

/**
 * `takes`: what the single positional argument is, or `none`. `flags`: `value` needs the next token,
 * `switch` is a bare presence. `local` means the reducer answers it with no capability at all.
 */
export const COMMANDS = {
  help: {
    usage: '/help', help: 'this list', takes: 'none', flags: {}, local: true,
  },
  profiles: {
    usage: '/profiles', help: 'every profile, and what was read from the ones that are up', takes: 'none', flags: {},
  },
  new: {
    usage: '/new <name> [--port <n>]', help: 'create a profile axde owns', takes: 'name', flags: { port: 'value' },
  },
  rm: {
    usage: '/rm <name> [--force]', help: 'remove a profile (--force for one axde did not create)', takes: 'name', flags: { force: 'switch' },
  },
  install: {
    usage: '/install <profile> [--merge]', help: 'attach the build, relaunch, turn on both toggles', takes: 'name', flags: { merge: 'switch' },
  },
  uninstall: {
    usage: '/uninstall <profile>', help: 'detach the build and relaunch without it', takes: 'name', flags: {},
  },
  status: {
    usage: '/status <profile>', help: 'what that profile carries right now', takes: 'name', flags: {},
  },
  launch: {
    usage: '/launch <profile> [--url <u>] [--force]', help: 'headed browser that stays up after the command', takes: 'name', flags: { url: 'value', force: 'switch' },
  },
  stop: {
    usage: '/stop <profile> [--force]', help: 'close it gracefully, so the toggles survive', takes: 'name', flags: { force: 'switch' },
  },
  up: {
    usage: '/up <profile> [--check]', help: 'this working copy INTO the profile (flows, Lua, modules)', takes: 'name', flags: { check: 'switch', force: 'switch' },
  },
  down: {
    usage: '/down <profile>', help: 'take the working copy back out; published sources return', takes: 'name', flags: { force: 'switch' },
  },
  sources: {
    usage: '/sources [--check]', help: 'what would be written — no browser at all', takes: 'none', flags: { check: 'switch' },
  },
  quit: {
    usage: '/quit', help: 'leave (ctrl-c does too)', takes: 'none', flags: {}, local: true,
  },
};

const HELP_HINT = 'try /help';

export function initialState({ dist, buildFingerprint, workspace }) {
  return {
    // One line, because the header already states what this program is. A banner that repeats the
    // title is the same furniture as a box around a conversation.
    transcript: [
      { kind: 'out', text: `${HELP_HINT} for the vocabulary; /profiles for what is on this machine.` },
    ],
    input: '',
    history: [],
    historyAt: null,
    busy: false,
    build: { dist, fingerprint: buildFingerprint },
    workspace,
  };
}

const say = (state, kind, text) => ({
  ...state,
  transcript: [...state.transcript, { kind, text }].slice(-TRANSCRIPT_LIMIT),
});

const answer = (state, effects = []) => ({ state, effects });

/**
 * A line → a command, or a refusal that quotes what was wrong. Pure and exported so the refusals
 * are asserted directly rather than through a screen.
 */
export function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) return { error: `commands start with / — ${HELP_HINT}` };
  const [name, ...rest] = trimmed.slice(1).split(/\s+/).filter((token) => token !== '');
  const spec = COMMANDS[name];
  if (spec === undefined) return { error: `unknown command: /${name ?? ''} — ${HELP_HINT}` };

  const positional = [];
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) { positional.push(token); continue; }
    const flag = token.slice(2);
    const kind = spec.flags[flag];
    if (kind === undefined) {
      // `--dist`/`--env` are program flags read when axde starts, so a command cannot quietly use a
      // different build than the header states.
      return { error: `${spec.usage.split(' ')[0]} has no --${flag} — ${spec.usage}` };
    }
    if (kind === 'switch') { flags[flag] = true; continue; }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) {
      return { error: `--${flag} needs a value — ${spec.usage}` };
    }
    flags[flag] = value;
    index += 1;
  }
  return { name, positional, flags };
}

function helpLines(state) {
  let next = say(state, 'out', 'commands:');
  for (const [name, spec] of Object.entries(COMMANDS)) {
    next = say(next, 'out', `  ${spec.usage.padEnd(42, ' ')}${spec.help}`);
  }
  return next;
}

function dispatch(state, line) {
  const parsed = parseLine(line);
  if (parsed.error !== undefined) return answer(say(state, 'err', parsed.error));

  const spec = COMMANDS[parsed.name];
  if (parsed.name === 'help') return answer(helpLines(state));
  if (parsed.name === 'quit') return answer(state, [{ type: 'quit' }]);

  if (spec.takes === 'name') {
    const name = parsed.positional[0];
    if (name === undefined) {
      return answer(say(state, 'err', `/${parsed.name} needs a profile — ${spec.usage}`));
    }
    if (!USABLE_NAME.test(name)) {
      // The launcher's rule, applied before anything is touched: a separator or a traversal would
      // point at a directory nobody asked for.
      return answer(say(state, 'err', `not a usable profile name: ${JSON.stringify(name)}`));
    }
  }
  return answer(state, [{
    type: 'command', name: parsed.name, positional: parsed.positional, flags: parsed.flags,
  }]);
}

function submit(state) {
  if (state.input.trim() === '') return answer(state);
  if (state.busy) {
    // Refused, never swallowed, and the line is kept: nothing typed is lost.
    return answer(say(state, 'err', 'an operation is still running — wait for it to finish'));
  }
  const line = state.input.trim();
  const echoed = say({
    ...state, input: '', history: [...state.history, line], historyAt: null,
  }, 'you', line);
  return dispatch(echoed, line);
}

function recall(state, delta) {
  if (state.history.length === 0) return state;
  if (state.historyAt === null) {
    // `down` on a fresh line has nothing newer to reach.
    if (delta > 0) return state;
    const at = state.history.length - 1;
    return { ...state, historyAt: at, input: state.history[at] };
  }
  const at = state.historyAt + delta;
  if (at < 0) return state;
  if (at >= state.history.length) return { ...state, historyAt: null, input: '' };
  return { ...state, historyAt: at, input: state.history[at] };
}

function complete(state) {
  const line = state.input;
  // Completion is for command NAMES: once a line carries an argument there is nothing here to
  // complete, and guessing a profile name is how the wrong profile gets installed into.
  if (!line.startsWith('/') || /\s/.test(line)) return answer(state);
  const prefix = line.slice(1);
  const names = Object.keys(COMMANDS).filter((name) => name.startsWith(prefix));
  if (names.length === 1) return answer({ ...state, input: `/${names[0]} ` });
  if (names.length === 0) {
    return answer(say(state, 'err', `no command starts with /${prefix} — ${HELP_HINT}`));
  }
  return answer(say(state, 'out', names.map((name) => `/${name}`).join('  ')));
}

function onKey(state, { name, char }) {
  // Quit is the one action a running operation cannot swallow.
  if (name === 'ctrl-c') return answer(state, [{ type: 'quit' }]);
  if (name === 'enter') return submit(state);
  if (name === 'escape') return answer({ ...state, input: '', historyAt: null });
  if (name === 'backspace') return answer({ ...state, input: state.input.slice(0, -1) });
  if (name === 'tab') return complete(state);
  if (name === 'up') return answer(recall(state, -1));
  if (name === 'down') return answer(recall(state, 1));
  if (name === 'char') return answer({ ...state, input: state.input + char });
  // Left/right are dropped: this is a one-line prompt, not an editor.
  return answer(state);
}

export function reduce(state, event) {
  switch (event.type) {
    case 'start':
      // Nothing is fetched on start. The inventory is an answer to `/profiles`, not a pane.
      return answer(state);
    case 'key':
      return onKey(state, event);
    case 'output':
      return answer(say({ ...state, busy: false }, 'out', event.text));
    case 'error':
      // An error always clears busy: a screen stuck on "working" hides the reason it stopped.
      return answer(say({ ...state, busy: false }, 'err', event.text));
    case 'busy':
      return answer({ ...state, busy: event.busy });
    default:
      return answer(state);
  }
}
