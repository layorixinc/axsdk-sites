/**
 * The whole decision layer of `axde`, as a pure reducer: `reduce(state, event) → {state, effects}`.
 *
 * Effects are DECLARED, never performed here, so every rule below is tested with no terminal and no
 * browser — the shape `10_form_wizard.lua` and `44_pagination.lua` use, for the same reason.
 *
 * Two rules are load-bearing rather than cosmetic:
 * - while an operation runs, only quit is accepted: two overlapping installs drive one browser from
 *   two places, and the second one wins in a way nobody can read afterwards;
 * - a destructive action on a profile `axde` did not create is refused BY NAME, because the shared
 *   harness profile holds the developer's credentials and chat history.
 */

/** A profile name is a directory name: `profileDir` refuses separators, and so does this. */
const USABLE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const LOG_LIMIT = 200;

export function initialState({ dist, buildFingerprint }) {
  return {
    profiles: [],
    cursor: 0,
    busy: false,
    prompt: null,
    log: [],
    build: { dist, fingerprint: buildFingerprint },
  };
}

const withLog = (state, text) => ({
  ...state,
  log: [...state.log, { at: Date.now(), text }].slice(-LOG_LIMIT),
});

const answer = (state, effects = []) => ({ state, effects });

const selected = (state) => state.profiles[state.cursor];

function movement(state, delta) {
  if (state.profiles.length === 0) return state;
  const cursor = Math.min(Math.max(state.cursor + delta, 0), state.profiles.length - 1);
  return { ...state, cursor };
}

function openPrompt(state, kind) {
  const profile = selected(state);
  if (kind === 'delete-profile') {
    if (profile === undefined) return answer(withLog(state, 'delete: no profile selected'));
    if (profile.kind !== 'axde') {
      return answer(withLog(state,
        `delete refused: axde did not create "${profile.name}" — remove it yourself if you mean to`));
    }
    return answer({ ...state, prompt: { kind, value: '', target: profile.name } });
  }
  return answer({ ...state, prompt: { kind, value: '' } });
}

function submitPrompt(state) {
  const { kind, value, target } = state.prompt;
  const name = value.trim();
  if (kind === 'new-profile') {
    if (name === '') return answer(withLog(state, 'new profile: a name is required'));
    if (!USABLE_NAME.test(name)) {
      return answer(withLog(state, `new profile: not a usable profile name: ${JSON.stringify(name)}`));
    }
    return answer(withLog({ ...state, prompt: null }, `new profile ${name}`), [{ type: 'create-profile', name }]);
  }
  if (name !== target) {
    return answer(withLog(state, `delete: "${name}" does not match "${target}" — nothing was removed`));
  }
  return answer(withLog({ ...state, prompt: null }, `delete ${target}`), [{ type: 'delete-profile', name: target }]);
}

function act(state, name) {
  const profile = selected(state);
  if (profile === undefined) return answer(withLog(state, `${name}: no profile selected`));
  return answer(state, [{ type: name, profile: profile.name }]);
}

function onKey(state, keyEvent) {
  const { name, char } = keyEvent;
  if (name === 'ctrl-c') return answer(state, [{ type: 'quit' }]);

  if (state.prompt !== null) {
    if (name === 'escape') return answer({ ...state, prompt: null });
    if (name === 'enter') return submitPrompt(state);
    if (name === 'backspace') {
      return answer({ ...state, prompt: { ...state.prompt, value: state.prompt.value.slice(0, -1) } });
    }
    if (name === 'char') {
      return answer({ ...state, prompt: { ...state.prompt, value: state.prompt.value + char } });
    }
    return answer(state);
  }

  // Quit is the one action a running operation cannot swallow.
  if (name === 'char' && char === 'q') return answer(state, [{ type: 'quit' }]);
  if (state.busy) return answer(state);

  if (name === 'up' || (name === 'char' && char === 'k')) return answer(movement(state, -1));
  if (name === 'down' || (name === 'char' && char === 'j')) return answer(movement(state, 1));
  if (name !== 'char') return answer(state);

  if (char === 'n') return openPrompt(state, 'new-profile');
  if (char === 'd') return openPrompt(state, 'delete-profile');
  if (char === 'i') return act(state, 'install');
  if (char === 'u') return act(state, 'uninstall');
  if (char === 'r') return answer(state, [{ type: 'refresh' }]);
  return answer(state);
}

export function reduce(state, event) {
  switch (event.type) {
    case 'start':
      return answer(state, [{ type: 'refresh' }]);
    case 'key':
      return onKey(state, event);
    case 'profiles': {
      const profiles = event.profiles;
      const cursor = Math.min(state.cursor, Math.max(profiles.length - 1, 0));
      return answer({ ...state, profiles, cursor, busy: false });
    }
    case 'busy':
      return answer({ ...state, busy: event.busy });
    case 'log':
      return answer(withLog(state, event.text));
    case 'error':
      // An error always clears busy: a screen stuck on "working" hides the reason it stopped.
      return answer(withLog({ ...state, busy: false }, event.text));
    default:
      return answer(state);
  }
}
