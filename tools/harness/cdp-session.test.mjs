import assert from 'node:assert/strict';
import test from 'node:test';

import { openCdpSession } from './cdp-session.mjs';

// The driver never touches the filesystem for credentials when the environment carries them.
process.env.AXSDK_API_KEY = 'test-key';
process.env.AXSDK_APP_ID = 'test-app';

const OPTIONS_SESSION = 'options-session-1';
const EXTENSION_ID = 'kmpjeabgdfgicnnplgiokmaolfilokko';
const INDEX_MD = '# sites\n- amazon: amazon.com\n- bluemoonsoft: bluemoonsoft.com\n- thumbtack: thumbtack.com\n';

const HOSTS = [
  ['amazon.', 'amazon'],
  ['bluemoonsoft.com', 'bluemoonsoft'],
  ['thumbtack.com', 'thumbtack'],
];

function domainForUrl(url) {
  for (const [needle, domain] of HOSTS) {
    if (String(url).includes(needle)) return domain;
  }
  return undefined;
}

function envelope(state, version = 0) {
  return JSON.stringify({ state, version });
}

/**
 * An offline stand-in for the SDK library (`browser-session.mjs` + `workspace.mjs` +
 * the config helpers) AND for the extension behind it.
 *
 * Every fake enforces the real primitive's constraint rather than accepting anything:
 * - `evaluate` actually RUNS the expression, against an emulated `chrome` and an isolated
 *   page global, and only in the options session it handed out.
 * - the message router refuses malformed frames exactly like the service worker's parsers
 *   (`parseRunLua`, `parseSendMessage`, `applyStateRequest`) — a refused frame answers
 *   `undefined`, never a helpful error.
 * - `applyStateRequest` get answers null unless the stored value is a string (a non-string
 *   store value is invisible, which is the "wrong shape rehydrates as empty" trap).
 * - `writeWorkspaceStores` refuses a layer that is not a `{"state":...,"version":N}` JSON
 *   string, because that is the shape the zustand persist layer can rehydrate.
 * - a host restart RE-READS the persisted chat: a reset that forgets to remove the chat key
 *   gets the old conversation (and the old backend session) back, exactly like the product.
 */
function fakeExtension() {
  const storage = new Map();
  const pageGlobal = {}; // the options page's globalThis
  const cdpToken = { closed: false, close() { this.closed = true; } };
  const calls = { writeConfig: [], writeWorkspaceStores: [], cleared: 0, luaRequests: [] };

  let group; // the single AXSDK session group: { id, url, sessionId, turnQueue }
  let nextGroupId = 7;
  let backendSessions = 0;

  const fake = {
    storage, pageGlobal, cdpToken, calls,
    // Tests override this to script the Lua runtime's answers (a LuaRunAnswer per request).
    onLua: () => { throw new Error('no scripted lua behaviour'); },
    // Queue of turns; each turn is a list of chat-store snapshots served one per read.
    turns: [],
    // What `launchChrome` hands back. Default: a browser that was already running, so nothing is ours.
    chromeChild: undefined,
    chromeReused: true,
    groupOf: () => group,
    chatKey: () => `s${group.id}:axsdk:chat`,
    setSitesStore(domain) {
      storage.set('axsdk:sites', envelope({
        index: { source: 'local', indexMd: INDEX_MD },
        sites: {},
        currentSite: domain === undefined ? null : { domain },
      }));
    },
    seedConversation(messages) {
      writeChat(group, messages, group.sessionId);
    },
    /** Any store, verbatim — the driver's own stores are envelope-shaped, so a test writes the real shape. */
    setState(key, value) {
      storage.set(key, value);
    },
    /** The session-scoped key the driver will read. The group id starts at 7 and increments, so a test that
     *  hardcodes `s1:` writes to a store nobody looks at — which is how the first version of this passed
     *  nothing to the assertion it was meant to prove. */
    sessionKey(store) {
      return `s${group.id}:axsdk:${store}`;
    },
  };

  function writeChat(target, messages, sessionId) {
    target.sessionId = sessionId;
    storage.set(`s${target.id}:axsdk:chat`, envelope({ session: { id: sessionId }, messages }, 3));
  }

  /**
   * The worker respawning: it rehydrates the persisted chat FIRST. An existing conversation
   * keeps its messages and its backend session; a removed key starts fresh on a new one.
   */
  function spawnBackend(target) {
    const stored = storage.get(`s${target.id}:axsdk:chat`);
    if (typeof stored === 'string') {
      let state;
      try { state = JSON.parse(stored)?.state; } catch { state = undefined; }
      const messages = Array.isArray(state?.messages) ? state.messages : [];
      const kept = state?.session?.id;
      if (typeof kept === 'string' && kept !== '') {
        writeChat(target, messages, kept);
        return;
      }
      backendSessions += 1;
      writeChat(target, messages, `ses_${backendSessions}`);
      return;
    }
    backendSessions += 1;
    writeChat(target, [], `ses_${backendSessions}`);
  }

  function maybeAdvanceChat(key, stored) {
    if (!group || key !== `s${group.id}:axsdk:chat`) return stored;
    if (!Array.isArray(group.turnQueue) || group.turnQueue.length === 0) return stored;
    const next = group.turnQueue.shift();
    writeChat(group, next, group.sessionId);
    return storage.get(key);
  }

  async function handleMessage(message) {
    if (typeof message !== 'object' || message === null || typeof message.type !== 'string') {
      return undefined;
    }

    if (message.type === 'axsdk.cdp.state') {
      const { op, key, value } = message;
      if (typeof key !== 'string' || key === '') return undefined;
      if (op === 'get') {
        const stored = storage.get(key);
        return typeof stored === 'string' ? maybeAdvanceChat(key, stored) : null;
      }
      if (op === 'set') {
        if (typeof value !== 'string') return undefined; // the state proxy stores strings only
        storage.set(key, value);
        return null;
      }
      if (op === 'remove') {
        storage.delete(key);
        return null;
      }
      return undefined;
    }

    if (message.type === 'axsdk.cdp.send-message') {
      const { groupId, text } = message;
      if (typeof groupId !== 'number' || typeof text !== 'string' || text.trim() === '') {
        return undefined; // parseSendMessage refuses; nothing answers
      }
      if (!group || group.id !== groupId) return { delivered: false, reason: 'no such session' };
      const turn = fake.turns.shift();
      if (turn === undefined) return { delivered: false, reason: 'no scripted turn' };
      group.turnQueue = [...turn];
      return { delivered: true, ready: true };
    }

    if (message.type === 'axsdk.cdp.run-lua') {
      const groupId = message.groupId;
      const op = message.op ?? 'eval';
      const source = message.source ?? '';
      const args = message.args ?? {};
      if (typeof groupId !== 'number') return undefined;
      if (!['eval', 'call', 'run', 'status'].includes(op)) return undefined;
      if (op !== 'status' && (typeof source !== 'string' || source.trim() === '')) return undefined;
      if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined;
      if (!group || group.id !== groupId) return { ok: false, error: 'no such session' };
      calls.luaRequests.push({ op, source, args });
      return fake.onLua(op, source, args, fake);
    }

    if (message.type === 'axsdk.cdp.page-url') {
      const { groupId } = message;
      if (typeof groupId !== 'number' || !group || group.id !== groupId) return '';
      return group.url;
    }

    if (message.type === 'axsdk.cdp.restart-host') {
      if (group) spawnBackend(group);
      return undefined; // the real handler never calls sendResponse for this one
    }

    return undefined;
  }

  const chromeApi = {
    storage: {
      local: {
        async get(query) {
          if (query === null || query === undefined) return Object.fromEntries(storage);
          if (typeof query === 'string') {
            return storage.has(query) ? { [query]: storage.get(query) } : {};
          }
          if (Array.isArray(query)) {
            const out = {};
            for (const key of query) if (storage.has(key)) out[key] = storage.get(key);
            return out;
          }
          throw new Error('chrome.storage.local.get: unsupported query');
        },
        async set(items) {
          if (typeof items !== 'object' || items === null) {
            throw new Error('chrome.storage.local.set needs an object');
          }
          for (const [key, value] of Object.entries(items)) storage.set(key, value);
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) storage.delete(key);
        },
      },
    },
    runtime: { sendMessage: (message) => handleMessage(message) },
  };

  const assertCdp = (cdp) => {
    if (cdp !== cdpToken) throw new Error('not the connection this fake handed out');
  };
  const assertOptions = (sessionId) => {
    if (sessionId !== OPTIONS_SESSION) {
      throw new Error(`evaluated in an unattached target: ${String(sessionId)}`);
    }
  };

  const AsyncFunction = (async () => {}).constructor;

  const lib = {
    // ── browser-session.mjs ────────────────────────────────────────────────
    async launchChrome({ profileName, profileRoot, port }) {
      // profileDir's real refusal: a separator or traversal escapes the profile root.
      if (typeof profileName !== 'string' || profileName.trim() === ''
        || /[\\/]/.test(profileName) || profileName === '..') {
        throw new Error(`Not a usable profile name: ${JSON.stringify(profileName)}`);
      }
      if (typeof port !== 'number' || !Number.isInteger(port)) {
        throw new Error(`Not a debugger port: ${String(port)}`);
      }
      return {
        cdp: cdpToken,
        chrome: fake.chromeChild,
        profile: `${profileRoot}/${profileName}`,
        reused: fake.chromeReused,
      };
    },
    async ensureExtension(cdp, extensionDir) {
      assertCdp(cdp);
      if (typeof extensionDir !== 'string' || extensionDir === '') {
        throw new Error(`No build at ${String(extensionDir)}.`);
      }
      return {
        extensionId: EXTENSION_ID,
        options: {
          url: `chrome-extension://${EXTENSION_ID}/options/options.html`,
          targetId: 'target-1',
          sessionId: OPTIONS_SESSION,
        },
        installed: false,
      };
    },
    async evaluate(cdp, sessionId, expression) {
      assertCdp(cdp);
      assertOptions(sessionId);
      // Shadowing `globalThis` scopes the expression to this fake's page, like a real target.
      const run = new AsyncFunction('chrome', 'globalThis', `return (${expression});`);
      try {
        return await run(chromeApi, pageGlobal);
      } catch (error) {
        throw new Error(String(error?.message ?? error));
      }
    },
    async writeConfig(cdp, sessionId, config, options) {
      assertCdp(cdp);
      assertOptions(sessionId);
      if (typeof options?.overwrite !== 'boolean') {
        throw new Error('writeConfig needs an explicit overwrite decision');
      }
      calls.writeConfig.push({ config, options });
      const existing = storage.get('axsdk:extension-cdp:config');
      const same = existing !== undefined && JSON.stringify(existing) === JSON.stringify(config);
      if (same) return 'unchanged';
      storage.set('axsdk:extension-cdp:config', config);
      if (group) spawnBackend(group); // a write restarts the host
      return 'written';
    },
    async writeWorkspaceStores(cdp, sessionId, layers) {
      assertCdp(cdp);
      assertOptions(sessionId);
      if (typeof layers !== 'object' || layers === null) {
        throw new Error('writeWorkspaceStores needs the storeEnvelopes map');
      }
      for (const [key, value] of Object.entries(layers)) {
        if (!key.startsWith('axsdk:')) throw new Error(`not a store key: ${key}`);
        // The real constraint: each value is a JSON STRING shaped like a persist envelope.
        // Anything else rehydrates as an empty store and reports nothing.
        let parsed;
        try { parsed = typeof value === 'string' ? JSON.parse(value) : undefined; } catch { parsed = undefined; }
        if (parsed === undefined || typeof parsed.state !== 'object' || parsed.state === null
          || typeof parsed.version !== 'number') {
          throw new Error(`layer ${key} is not a persist envelope string`);
        }
      }
      calls.writeWorkspaceStores.push(layers);
      const changed = Object.entries(layers).some(([key, value]) => storage.get(key) !== value);
      if (!changed) return 'unchanged';
      for (const [key, value] of Object.entries(layers)) storage.set(key, value);
      if (group) spawnBackend(group); // a write restarts the host
      return 'written';
    },
    async resetWorkspaceStores(cdp, sessionId) {
      assertCdp(cdp);
      assertOptions(sessionId);
      const keys = ['axsdk:sites', 'axsdk:flows', 'axsdk:lua', 'axsdk:widgets'];
      const removed = keys.filter((key) => storage.delete(key));
      if (group) spawnBackend(group);
      return { removed };
    },
    async findSession(cdp, sessionId) {
      assertCdp(cdp);
      assertOptions(sessionId);
      return group === undefined ? undefined : { groupId: group.id, url: group.url };
    },
    async clearPreviousSessions(cdp, sessionId) {
      assertCdp(cdp);
      assertOptions(sessionId);
      calls.cleared += 1;
      let sessions = 0;
      for (const key of [...storage.keys()]) {
        const head = key.slice(0, key.indexOf(':'));
        if (head.length > 1 && head[0] === 's' && Number.isInteger(Number(head.slice(1)))) {
          storage.delete(key);
        }
      }
      if (group !== undefined) { sessions = 1; group = undefined; }
      return { tabs: sessions, sessions };
    },
    async startSessionOn(cdp, sessionId, url) {
      assertCdp(cdp);
      assertOptions(sessionId);
      if (typeof url !== 'string' || url === '') throw new Error('startSessionOn needs a url');
      const origin = (value) => { try { return new URL(value).origin; } catch { return ''; } };
      if (group && origin(group.url) === origin(url) && origin(url) !== '') {
        return { url: group.url, groupId: group.id, reused: true };
      }
      group = { id: nextGroupId, url, sessionId: undefined, turnQueue: [] };
      nextGroupId += 1;
      spawnBackend(group);
      return { url, groupId: group.id, reused: false };
    },

    // ── workspace.mjs ──────────────────────────────────────────────────────
    async loadWorkspace(root) {
      if (typeof root !== 'string' || root === '') throw new Error(`Not a workspace directory: ${root}`);
      return {
        root,
        indexMd: INDEX_MD,
        entries: [],
        domains: ['amazon', 'bluemoonsoft', 'thumbtack'],
        flows: {},
        lua: {},
        digest: 'abc123def456',
      };
    },
    storeEnvelopes(workspace) {
      if (typeof workspace?.digest !== 'string' || typeof workspace?.indexMd !== 'string') {
        throw new Error('storeEnvelopes needs a loaded workspace');
      }
      return {
        'axsdk:sites': envelope({ index: { source: 'local', indexMd: workspace.indexMd }, sites: {} }),
        'axsdk:flows': envelope({ flows: {} }),
        'axsdk:lua': envelope({ lua: {} }),
        'axsdk:widgets': envelope({ widgets: {} }),
      };
    },
    workspaceDomainFor(indexMd, url) {
      if (typeof indexMd !== 'string' || typeof url !== 'string') {
        throw new Error('workspaceDomainFor takes (indexMd, url)');
      }
      return domainForUrl(url);
    },

    // ── harness-config.mjs / chrome-launch.mjs ────────────────────────────
    profileName: 'axsdk-extension-cdp',
    harnessConfig(credentials, _env, { local = false } = {}) {
      return {
        apiKey: credentials.apiKey,
        appId: credentials.appId,
        baseUrl: credentials.baseUrl ?? '',
        enabled: true,
        debug: true,
        ...(local ? { remote_sites: false, storedFlowsEnabled: true, storedLuaEnabled: true } : {}),
      };
    },
    credentialsFromEnv(text, keys) {
      const found = {};
      for (const line of String(text).split(/\r?\n/)) {
        const at = line.indexOf('=');
        if (at < 1) continue;
        found[line.slice(0, at).trim()] = line.slice(at + 1).trim().replace(/^["']|["']$/g, '');
      }
      const apiKey = found[keys.apiKey];
      const appId = found[keys.appId];
      if (!apiKey || !appId) return undefined;
      return { apiKey, appId, baseUrl: found[keys.baseUrl] ?? '' };
    },
    workspaceEnvKeys: { apiKey: 'AXSDK_API_KEY', appId: 'AXSDK_APP_ID', baseUrl: 'AXSDK_BASE_URL' },
    extensionDir: '/fake/extension/dist',
    profileRoot: '/fake/profiles',
  };

  fake.lib = lib;
  return fake;
}

const STATUS_ANSWER = {
  ok: true,
  value: {
    status: {
      enabled: true,
      site: { domain: 'amazon' },
      scripts: [{ id: 'stored-lua:' }, { id: 'stored-lua:amazon' }],
    },
    commands: [
      { command: 'AX_search_product', scriptId: 'stored-lua:amazon' },
      { command: 'AX_read_page', scriptId: 'stored-lua:' },
    ],
  },
};

async function openSession(fake, options = {}) {
  return openCdpSession({ workspace: '/ws', url: 'https://www.amazon.com/', ...options }, fake.lib);
}

// Message factories for scripted turns.
const user = (id, text) => ({ info: { role: 'user', id, time: { created: 1 } }, parts: [{ type: 'text', text, id: `${id}-t` }] });
const assistant = (id, parts, { completed = true } = {}) => ({
  info: { role: 'assistant', id, time: completed ? { created: 2, completed: 3 } : { created: 2 } },
  parts,
});
const textPart = (id, text) => ({ type: 'text', text, id });
const toolPart = (id, tool, status, output) => ({ type: 'tool', tool, callID: `${id}-c`, state: { status, output }, id });

test('openCdpSession provisions the profile and reports the session', async () => {
  const fake = fakeExtension();

  const session = await openSession(fake);

  assert.equal(session.extensionId, EXTENSION_ID);
  assert.equal(session.port, 9334);
  assert.equal(session.sessionId, 'ses_1');
  assert.deepEqual(session.workspace, {
    root: '/ws',
    digest: 'abc123def456',
    domains: ['amazon', 'bluemoonsoft', 'thumbtack'],
  });
  assert.equal(fake.calls.writeConfig.length, 1);
  assert.equal(fake.calls.writeConfig[0].options.overwrite, true);
  assert.equal(fake.calls.writeConfig[0].config.apiKey, 'test-key');
  assert.equal(fake.calls.writeConfig[0].config.remote_sites, false);
  assert.equal(fake.calls.writeWorkspaceStores.length, 1);
  await session.close();
  assert.equal(fake.cdpToken.closed, true);
});

test('run unwraps the command payload once: JSON result becomes the value', async () => {
  const fake = fakeExtension();
  fake.onLua = (op, source, args) => {
    assert.equal(op, 'run');
    assert.equal(source, 'AX_probe');
    assert.deepEqual(args, { a: 1 });
    return { ok: true, value: { status: 'completed', result: '{"answer":42}', deferId: '' } };
  };
  const session = await openSession(fake);

  assert.deepEqual(await session.run('AX_probe', { a: 1 }), { answer: 42 });
  await session.close();
});

test('a bare payload passes through untouched', async () => {
  const fake = fakeExtension();
  const session = await openSession(fake);

  // eval answers its value directly — nothing to unwrap past the LuaRunAnswer.
  fake.onLua = () => ({ ok: true, value: 7 });
  assert.equal(await session.eval('return 7'), 7);

  // a run whose payload is not a run-record passes through.
  fake.onLua = () => ({ ok: true, value: { answer: 1 } });
  assert.deepEqual(await session.run('AX_bare'), { answer: 1 });

  // a completed run whose result is not JSON stays a string.
  fake.onLua = () => ({ ok: true, value: { status: 'completed', result: 'not json', deferId: '' } });
  assert.equal(await session.run('AX_text'), 'not json');
  await session.close();
});

test('a refused or failed run surfaces the runtime error', async () => {
  const fake = fakeExtension();
  const session = await openSession(fake);

  fake.onLua = () => ({ ok: false, error: 'no such command' });
  await assert.rejects(() => session.run('AX_missing'), /no such command/);

  fake.onLua = () => ({ ok: true, value: { status: 'failed', result: 'ERROR: boom', deferId: '' } });
  await assert.rejects(() => session.run('AX_broken'), /boom/);
  await session.close();
});

test('a pending run is a value the caller sees, not an error', async () => {
  const fake = fakeExtension();
  fake.onLua = () => ({ ok: true, value: { status: 'pending', deferId: 'd1' } });
  const session = await openSession(fake);

  assert.deepEqual(await session.run('AX_navigating'), { status: 'pending', deferId: 'd1' });
  await session.close();
});

test('call resolves the command payload and throws on a refusal', async () => {
  const fake = fakeExtension();
  const session = await openSession(fake);

  fake.onLua = (op) => {
    assert.equal(op, 'call');
    return {
      ok: true,
      value: { ok: true, command: 'AX_x', scriptId: 'stored-lua:', value: { got: 'it' }, durationMs: 3 },
    };
  };
  assert.deepEqual(await session.call('AX_x'), { got: 'it' });

  fake.onLua = () => ({ ok: true, value: { ok: false, command: 'AX_x', reason: 'command_not_found' } });
  await assert.rejects(() => session.call('AX_x'), /command_not_found/);
  await session.close();
});

test('send ignores the stale assistant message and resolves only on a new one', async () => {
  const fake = fakeExtension();
  const session = await openSession(fake);
  const before = [user('m1', 'hi'), assistant('m2', [textPart('p2', 'old reply')])];
  fake.seedConversation(before);
  fake.turns.push([
    before, // stale read: the previous turn's completed reply is still the last message
    [...before, user('m3', 'again')],
    [...before, user('m3', 'again'), assistant('m4', [textPart('p4', 'new re')], { completed: false })],
    [...before, user('m3', 'again'), assistant('m4', [textPart('p4', 'new reply')])],
  ]);

  const turn = await session.send('again');

  assert.equal(turn.text, 'new reply');
  await session.close();
});

test('send surfaces the whole tool trace with state.output, parts verbatim', async () => {
  const fake = fakeExtension();
  const session = await openSession(fake);
  const before = [user('m1', 'hi')];
  fake.seedConversation(before);
  const toolMessage = assistant('m5', [toolPart('p5', 'AX_read_page', 'completed', '{"ok":true,"chars":120}')]);
  const replyParts = [
    toolPart('p6', 'AX_search_product', 'completed', '{"items":2}'),
    textPart('p7', 'found it'),
  ];
  const replyMessage = assistant('m6', replyParts);
  fake.turns.push([
    [...before, user('m4', 'find'), toolMessage],
    [...before, user('m4', 'find'), toolMessage, replyMessage],
  ]);

  const turn = await session.send('find');

  assert.equal(turn.text, 'found it');
  assert.deepEqual(turn.parts, replyParts); // the last message's parts, verbatim
  assert.deepEqual(turn.toolCalls, [
    { name: 'AX_read_page', status: 'completed', output: { ok: true, chars: 120 } },
    { name: 'AX_search_product', status: 'completed', output: { items: 2 } },
  ]);
  await session.close();
});

test('an undelivered send throws instead of waiting', async () => {
  const fake = fakeExtension();
  const session = await openSession(fake);
  // No scripted turn: the router answers delivered:false like a dead session would.

  await assert.rejects(() => session.send('hello'), /not delivered/i);
  await session.close();
});

test('a send nobody answers times out against its deadline', async () => {
  const fake = fakeExtension();
  const session = await openSession(fake);
  fake.seedConversation([user('m1', 'hi'), assistant('m2', [textPart('p2', 'old')])]);
  fake.turns.push([]); // delivered, but the store never moves

  await assert.rejects(() => session.send('hello', { timeoutMs: 900 }), /agent/i);
  await session.close();
});

test('open reports the landed url and the site the session resolved', async () => {
  const fake = fakeExtension();
  fake.onLua = (op, source, args, extension) => {
    assert.equal(op, 'run');
    assert.equal(source, 'AX_navigate');
    extension.groupOf().url = args.url;
    extension.setSitesStore(domainForUrl(args.url));
    return { ok: true, value: { status: 'completed', result: 'true', deferId: '' } };
  };
  const session = await openSession(fake, { url: 'https://axsdk.ai' });

  const opened = await session.open('https://www.amazon.com/s?k=mouse');

  assert.deepEqual(opened, { url: 'https://www.amazon.com/s?k=mouse', site: 'amazon' });
  await session.close();
});

test('status reports url, current site and the loaded script ids', async () => {
  const fake = fakeExtension();
  fake.onLua = () => STATUS_ANSWER;
  const session = await openSession(fake);
  fake.setSitesStore('amazon');

  const status = await session.status();

  assert.equal(status.url, 'https://www.amazon.com/');
  assert.equal(status.site, 'amazon');
  assert.deepEqual(status.scriptIds, ['stored-lua:', 'stored-lua:amazon']);
  await session.close();
});

test('reset starts a clean conversation on a new backend session and reports remaining', async () => {
  const fake = fakeExtension();
  const session = await openSession(fake);
  assert.equal(session.sessionId, 'ses_1');
  fake.seedConversation([user('m1', 'hi'), assistant('m2', [textPart('p2', 'paused gate')])]);
  fake.storage.set(`s${fake.groupOf().id}:axsdk:sse-events`, '[]');
  fake.storage.set('axsdk:memory', envelope({ memory: { 'g/phone': '415-555-0123' } }, 1));

  const reset = await session.reset();

  assert.deepEqual(reset, { remaining: 0 });
  assert.equal(session.sessionId, 'ses_2'); // a NEW backend session, not the old one revived
  assert.equal(fake.storage.has(`s${fake.groupOf().id}:axsdk:sse-events`), false);
  const chat = JSON.parse(fake.storage.get(fake.chatKey()));
  assert.deepEqual(chat.state.messages, []);
  // Shared stores are the user's, not the session's.
  assert.equal(fake.storage.has('axsdk:memory'), true);
  await session.close();
});

test('readMemory parses the persist envelope and answers the document map', async () => {
  const fake = fakeExtension();
  const session = await openSession(fake);

  assert.deepEqual(await session.readMemory(), {}); // absent store: empty, like a fresh profile

  fake.storage.set('axsdk:memory', envelope({ memory: { 'g/phone': '415-555-0123', 'g/name': 'AX Tester' } }, 1));
  assert.deepEqual(await session.readMemory(), { 'g/phone': '415-555-0123', 'g/name': 'AX Tester' });

  fake.storage.set('axsdk:memory', envelope({ memory: 'not a map' }, 1));
  assert.deepEqual(await session.readMemory(), {}); // the wrong shape rehydrates as empty
  await session.close();
});

test('writeMemory writes the exact envelope the store rehydrates, and refuses junk', async () => {
  const fake = fakeExtension();
  const session = await openSession(fake);

  await session.writeMemory({ 'g/email': 'thumbtack-test@example.com' });
  assert.equal(
    fake.storage.get('axsdk:memory'),
    '{"state":{"memory":{"g/email":"thumbtack-test@example.com"}},"version":1}',
  );

  await session.writeMemory({}); // clearing is a legal write
  assert.equal(fake.storage.get('axsdk:memory'), '{"state":{"memory":{}},"version":1}');

  await assert.rejects(() => session.writeMemory('nope'), /map/i);
  await assert.rejects(() => session.writeMemory({ 'g/x': 42 }), /string/i);
  await assert.rejects(() => session.writeMemory({ 'g/x': '   ' }), /string/i);
  await assert.rejects(() => session.writeMemory({ ' ': 'value' }), /key/i);
  await session.close();
});

test('resetStores clears the workspace stores from the profile', async () => {
  const fake = fakeExtension();
  const session = await openSession(fake);
  assert.equal(fake.storage.has('axsdk:lua'), true);

  await session.resetStores();

  for (const key of ['axsdk:sites', 'axsdk:flows', 'axsdk:lua', 'axsdk:widgets']) {
    assert.equal(fake.storage.has(key), false, `${key} should be gone`);
  }
  await session.close();
});

// ── a flow that pauses has answered ──────────────────────────────────────────
//
// Measured live: a three-store comparison ran its whole pipeline — collect, normalize, screen, judge,
// apply, verify, rank — and ended on `present_offers` with
//   {"next":"ask","question":"총 5개 중 1-5번 (1/1 페이지)\n사이트 3곳 중 2곳에서 결과를 받았습니다 …"}
// 19 tool parts, nothing wedged. But the comparison loop has NO model node by design (the presenter
// renders, pauses and reads the reply), so the assistant message never gets `time.completed` and `send`
// waited out its whole bound on a turn that had already finished. The window IS the answer.
test('a turn that pauses on a question resolves, and the question is the text', async () => {
  const fake = fakeExtension();
  const session = await openSession(fake);
  const before = [user('m1', 'hi')];
  fake.seedConversation(before);
  const asked = assistant('m9', [
    toolPart('p9', 'present_offers', 'completed',
      '{"next":"ask","question":"총 5개 중 1-5번 (1/1 페이지)","choice_stage":"offer"}'),
  ], { completed: false });
  fake.turns.push([
    before,
    [...before, user('m8', '비교해줘')],
    [...before, user('m8', '비교해줘'), asked],
    [...before, user('m8', '비교해줘'), asked],
  ]);

  const turn = await session.send('비교해줘');

  assert.match(turn.text, /총 5개 중 1-5번/);
  assert.equal(turn.toolCalls.at(-1)?.output?.next, 'ask');
  await session.close();
});

test('an ordinary completed tool does not resolve an unfinished turn', async () => {
  // Only a PAUSE counts. Otherwise the driver would report the first tool result as the answer and every
  // multi-step turn would be cut off at its first step.
  const fake = fakeExtension();
  const session = await openSession(fake);
  const before = [user('m1', 'hi')];
  fake.seedConversation(before);
  const midTurn = assistant('m11', [
    toolPart('p11', 'collect', 'completed', '{"next":"done","page":1}'),
  ], { completed: false });
  fake.turns.push([before, [...before, user('m10', 'go')], [...before, user('m10', 'go'), midTurn]]);

  await assert.rejects(() => session.send('go', { timeoutMs: 400 }), /Timed out/);
  await session.close();
});

// ── provision: false — drive what the PACKAGE installed ──────────────────────
//
// M1 needs a turn driven against stores the extension wrote from its own `workspace-bundle.json`, and any
// write from here would be proving this driver instead. Measured while establishing that: with the stores
// cleared and the extension reloaded, it repopulated all five itself and recorded the artifact's digest —
// but every route to a SESSION went through provisioning, so the end-to-end half stayed unproven.
//
// The workspace is not even read in this mode: reading it is how a run gets a digest to write, and a
// workspace that fails to load must not stop a session that was never going to use it.
test('provision false writes neither the settings nor the stores', async () => {
  const fake = fakeExtension();

  const session = await openSession(fake, { provision: false });

  assert.equal(fake.calls.writeConfig.length, 0, 'the config the package forced must stand');
  assert.equal(fake.calls.writeWorkspaceStores.length, 0, 'the layers the package installed must stand');
  assert.ok(session.sessionId, 'a session is still started');
  await session.close();
});

test('provision false still installs the build and starts a session', async () => {
  // The build has to be there — that is what carries the artifact — and a session is the whole point.
  const fake = fakeExtension();

  const session = await openSession(fake, { provision: false });

  assert.ok(session.extensionId, 'the build is installed — it is what carries the artifact');
  assert.ok(session.workspace.root, 'the root is still reported, for the banner');
  await session.close();
});

test('the default still provisions', async () => {
  // Nothing about the normal path changes: omitting the flag writes both, as every scenario relies on.
  const fake = fakeExtension();

  const session = await openSession(fake);

  assert.equal(fake.calls.writeConfig.length, 1);
  assert.equal(fake.calls.writeWorkspaceStores.length, 1);
  await session.close();
});

// ── a turn reports how long it took ──────────────────────────────────────────
//
// The sweep's bound is `max(300000, sites * 120000)`, which was never measured. Same code, consecutive
// runs: ten stores attributed in ~85 s, then a batch lost to its own 360 s ceiling. §13's own finding is
// that latency here is LLM-dominated and swings ~4x for the SAME request, so a bound can only come from a
// distribution — and nothing was recording one. A number nobody measures is a number somebody guesses.
test('send reports the turn duration', async () => {
  const fake = fakeExtension();
  const session = await openSession(fake);
  const before = [user('m1', 'hi')];
  fake.seedConversation(before);
  fake.turns.push([
    before,
    [...before, user('m2', 'go')],
    [...before, user('m2', 'go'), assistant('m3', [textPart('p3', 'done')])],
  ]);

  const turn = await session.send('go');

  assert.equal(typeof turn.elapsedMs, 'number');
  assert.ok(turn.elapsedMs >= 0, 'a duration, not a timestamp');
  assert.ok(turn.elapsedMs < 60_000, `a scripted turn cannot take a minute, saw ${turn.elapsedMs}`);
  await session.close();
});

// A timeout that says only "waiting for the agent to answer" turns every hang into a repeat of the run that
// produced it. The sweep already survives a hang and records it; what it cannot do is name the node that
// stopped answering, and all of that is sitting in the chat snapshot the poll just read. Same rule as the
// quote driver's `quote_last_step`: a stop must say WHERE it was.
test('a hang names the tool it stopped on and how far the turn got', async () => {
  const fake = fakeExtension();
  const session = await openSession(fake);
  const seeded = [user('m1', 'hi')];
  fake.seedConversation(seeded);
  // A turn that ran two nodes and stalled on the third: the assistant message never closes, so the poll
  // keeps waiting on the last snapshot until the bound runs out.
  const stalled = [...seeded, user('m2', 'compare'), assistant('m3', [
    toolPart('p1', 'shopping_collect_request', 'completed', { next: 'ok' }),
    toolPart('p2', 'shopping_search_stores', 'completed', { next: 'done' }),
    toolPart('p3', 'shopping_judge_relevance', 'pending', undefined),
  ], { completed: false })];
  fake.turns.push([stalled]);

  await assert.rejects(() => session.send('compare', { timeoutMs: 900 }), (error) => {
    assert.match(error.message, /agent/i, 'keeps the original sentence');
    assert.match(error.message, /shopping_judge_relevance/, 'names where it stopped');
    assert.match(error.message, /pending/, 'and the state it stopped in');
    assert.match(error.message, /\b3\b/, 'names how many tool calls ran');
    assert.match(error.message, /\b2\b/, 'and how many of them finished');
    return true;
  });
  await session.close();
});

// A turn with no tool call at all is a DIFFERENT fact: the flow never started, so the send never reached the
// engine — not a node that stalled. Reporting one as the other sends the next reader to the wrong file.
test('a hang with no tool call says the turn never started', async () => {
  const fake = fakeExtension();
  const session = await openSession(fake);
  fake.seedConversation([user('m1', 'hi')]);
  fake.turns.push([]); // delivered, and the store never moves

  await assert.rejects(() => session.send('compare', { timeoutMs: 900 }), (error) => {
    assert.match(error.message, /agent/i);
    assert.match(error.message, /no tool call/i, 'says the flow never ran a node');
    assert.doesNotMatch(error.message, /stopped on/, 'and never claims a node it did not see');
    return true;
  });
  await session.close();
});

// The launcher spawns Chrome ATTACHED and deliberately so (`detached: true` was tried and left the shell
// pipeline open on Windows). The consequence was missed: an attached child holds the event loop, so node
// cannot exit while it lives. Measured — the sweep printed its whole summary and `34/36 PASS`, then sat
// there until a 2400s bash timeout killed it, twice, and both times the run had ALREADY finished. That is
// what every earlier "the sweep hangs" reading actually was.
//
// `close` releases the handle instead of killing the browser: killing it would relaunch and re-provision on
// every CLI call, and leaving the browser up for the next run to reuse is the whole reason it is attached.
test('close releases the browser it launched so the process can exit', async () => {
  const fake = fakeExtension();
  let released = 0;
  let killed = 0;
  fake.chromeChild = { unref: () => { released += 1; }, kill: () => { killed += 1; } };
  fake.chromeReused = false;

  const session = await openSession(fake);
  await session.close();

  assert.equal(released, 1, 'the child handle we launched is released');
  assert.equal(killed, 0, 'and the browser stays up for the next run to reuse');
});

// A browser this session did not launch is not this session's to touch.
test('close leaves a browser it did not launch alone', async () => {
  const fake = fakeExtension();
  let touched = 0;
  fake.chromeChild = { unref: () => { touched += 1; }, kill: () => { touched += 1; } };
  fake.chromeReused = true;

  const session = await openSession(fake);
  await session.close();

  assert.equal(touched, 0, 'a reused browser is never ours to release or kill');
});

// One sample is not enough to fix a hang, but it is enough to make the NEXT one conclusive. "The turn ran no
// tool call at all" has two possible causes and they live in different repos: the send never reached the
// engine, or the engine took it and produced nothing. Whether the user's own message landed in the chat
// store separates them, and §9 already records the second shape — after a reconnect the first send comes
// back empty. Measured once live, on the fourth batch of a sweep whose other three answered in 12-25s.
test('a hang says whether the message itself even landed', async () => {
  const fake = fakeExtension();
  const session = await openSession(fake);
  fake.seedConversation([user('m1', 'hi')]);
  fake.turns.push([]); // delivered, and the store never moves at all

  await assert.rejects(() => session.send('compare', { timeoutMs: 900 }), (error) => {
    assert.match(error.message, /no tool call/i);
    assert.match(error.message, /did not reach the chat store|never reached the chat store/i,
      'the send was accepted and the message is not even there — delivery, not the flow');
    return true;
  });
  await session.close();
});

test('a hang whose message landed says the engine answered nothing', async () => {
  const fake = fakeExtension();
  const session = await openSession(fake);
  const seeded = [user('m1', 'hi')];
  fake.seedConversation(seeded);
  // The user's message is in the store and nothing else ever happens: the engine has it and ran no node.
  fake.turns.push([[...seeded, user('m2', 'compare')]]);

  await assert.rejects(() => session.send('compare', { timeoutMs: 900 }), (error) => {
    assert.match(error.message, /no tool call/i);
    assert.match(error.message, /reached the chat store/i, 'the message landed');
    assert.doesNotMatch(error.message, /did not reach|never reached/i, 'so it must not be blamed on delivery');
    return true;
  });
  await session.close();
});

// A caller that has to decide what to do about a hang must not sniff the prose. The sentence is for the
// human reading the summary; the field is for the sweep deciding whether the batch is evidence about an
// adapter at all. A turn that reached no node measured nothing, so its stores are not adapter failures.
test('a hang carries the stage it failed at, not just a sentence', async () => {
  const fake = fakeExtension();
  const session = await openSession(fake);
  fake.seedConversation([user('m1', 'hi')]);
  fake.turns.push([]);

  await assert.rejects(() => session.send('compare', { timeoutMs: 900 }), (error) => {
    assert.equal(error.stage, 'no-node', 'the turn never reached a node');
    assert.equal(error.landed, false, 'and the message never even landed');
    assert.equal(error.stoppedOn, undefined, 'there is no node to name');
    return true;
  });
  await session.close();
});

test('a stalled turn carries the node it stalled on', async () => {
  const fake = fakeExtension();
  const session = await openSession(fake);
  const seeded = [user('m1', 'hi')];
  fake.seedConversation(seeded);
  fake.turns.push([[...seeded, user('m2', 'go'), assistant('m3', [
    toolPart('p1', 'shopping_collect_request', 'completed', { next: 'ok' }),
    toolPart('p2', 'shopping_judge_relevance', 'pending', undefined),
  ], { completed: false })]]);

  await assert.rejects(() => session.send('go', { timeoutMs: 900 }), (error) => {
    assert.equal(error.stage, 'stalled');
    assert.equal(error.stoppedOn, 'shopping_judge_relevance');
    assert.equal(error.landed, true);
    return true;
  });
  await session.close();
});

// The runtime team found what a whole day of "the turn ran nothing" actually was: `POST /sessions/message`
// answered **402 LimitExceeded (mar 1001/1000)** while session creation returned 200. Our driver never looked at
// the status, so a quota refusal and a healthy-but-silent turn were the same observation — and a hook, which adds
// one flow per turn, reached the limit sooner, which is why removing it "fixed" things and why I misattributed
// the stall to it.
//
// The extension records what it knows in its own `axsdk:errors` store. On a turn that ran NO node, the driver now
// reads it and says so. It cannot invent the status — it reports whatever is there — and that is the point: the
// bare timeout was the least informative sentence available.
test('a turn that reached no node reports what the extension recorded', async () => {
  const fake = fakeExtension();
  const session = await openSession(fake);
  fake.seedConversation([user('m1', 'hi')]);
  fake.turns.push([]); // delivered, and the store never moves
  fake.setState(fake.sessionKey('errors'), JSON.stringify({
    state: { errors: [{ status: 402, code: 'LimitExceeded', detail: 'mar 1001/1000' }] },
  }));

  await assert.rejects(() => session.send('compare', { timeoutMs: 900 }), (error) => {
    assert.match(error.message, /no tool call/i);
    assert.match(error.message, /402/, 'the status the extension recorded');
    assert.match(error.message, /LimitExceeded/, 'and its code');
    return true;
  });
  await session.close();
});

test('a silent turn with nothing recorded says exactly that, inventing no cause', async () => {
  const fake = fakeExtension();
  const session = await openSession(fake);
  fake.seedConversation([user('m1', 'hi')]);
  fake.turns.push([]);

  await assert.rejects(() => session.send('compare', { timeoutMs: 900 }), (error) => {
    assert.match(error.message, /no tool call/i);
    assert.doesNotMatch(error.message, /402|LimitExceeded/, 'no cause is invented');
    return true;
  });
  await session.close();
});

// A turn that DID run nodes needs no such lookup: the trace already says where it stopped, and reading a store
// on every stall would add a round trip to the path that is already slow.
test('a stalled turn is not made to carry an error store lookup', async () => {
  const fake = fakeExtension();
  const session = await openSession(fake);
  const seeded = [user('m1', 'hi')];
  fake.seedConversation(seeded);
  fake.setState(fake.sessionKey('errors'), JSON.stringify({ state: { errors: [{ status: 402 }] } }));
  fake.turns.push([[...seeded, user('m2', 'go'), assistant('m3', [
    toolPart('p1', 'shopping_search_stores', 'completed', { next: 'done' }),
    toolPart('p2', 'shopping_judge_relevance', 'pending', undefined),
  ], { completed: false })]]);

  await assert.rejects(() => session.send('go', { timeoutMs: 900 }), (error) => {
    assert.equal(error.stage, 'stalled');
    assert.doesNotMatch(error.message, /402/, 'a stall names its node, not the store');
    return true;
  });
  await session.close();
});
