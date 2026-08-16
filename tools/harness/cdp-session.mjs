/**
 * Scenario driver for the shipping CDP extension (@axsdk/extension-cdp) — contract C3.
 *
 * Composes the SDK library (`scripts/browser-session.mjs` + `scripts/workspace.mjs`, plus the
 * config helpers next to them). No child processes, no stdout parsing: the same primitives the
 * harness CLI runs, called directly.
 *
 * Rules this driver enforces, each learned in a real debugging session:
 *
 * - `run`/`call` resolve the COMMAND PAYLOAD, not an envelope. The runtime answers
 *   `{ ok, value }`, and inside that a run carries `{ status, result }` (result a JSON string)
 *   while a call carries `{ ok, value }` again. Reading the envelope yields `undefined` and
 *   mimics an empty result — so the driver unwraps, once, here. A `{ status: 'pending' }` run
 *   record passes through untouched: mid-navigation pending is a value the caller acts on,
 *   never an error.
 * - `send` settles on a NEW assistant message (by `info.id`), never on a message count. The
 *   persisted chat can rehydrate right past a clear, and a stale count returns the previous
 *   turn's reply to a brand-new request.
 * - `reset()` MUST be called before any `send` that could hit a paused node. A paused
 *   comparison window reads a bare number as a SELECTION, and selection is the cart-approval
 *   turn — three unintended cart adds came from skipping this.
 * - A tool part carries its output at `state.output`; the terminal reply is a `type:"text"`
 *   part. Messages carry their role on `info` and have NO top-level `role` field.
 *
 * Long Lua turns: the CDP socket bounds every call at 30s, so `run`/`call`/`eval` never hold
 * one `Runtime.evaluate` open. The request is fired on the options page, its promise parked in
 * a page global, and settlement is polled with short reads — a durable adapter search may
 * legitimately run minutes.
 *
 * Deviations from C3, all additive:
 * - `run`/`call`/`eval` accept a trailing `{ timeoutMs }` options bag (default 180s).
 * - `readMemory()` / `writeMemory(entries)` expose the `axsdk:memory` store for the memory
 *   scenario, so no scenario evaluates raw expressions. `writeMemory` only reaches the RUNNING
 *   session after `reset()`: the worker reads the store when it spawns.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SDK_SCRIPTS = resolve(here, '..', '..', '..', 'axsdk-sdk-js', 'packages', 'axsdk-extension-cdp', 'scripts');

const DEFAULT_URL = 'https://axsdk.ai';
const DEFAULT_PORT = 9334;
const LUA_TIMEOUT_MS = 180_000;
const SEND_TIMEOUT_MS = 180_000;
const BACKEND_TIMEOUT_MS = 60_000;
const OPEN_SITE_TIMEOUT_MS = 30_000;
const POLL_MS = 400;

/** Mirror of the extension's session-owned key suffixes; everything else is the user's. */
const SESSION_OWNED_SUFFIXES = ['axsdk:chat', 'axsdk:sse-events', 'axsdk:debug-events', 'axsdk:errors'];

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

/** The real SDK library, loaded lazily so tests can hand in a fake and stay offline. */
async function realLibrary() {
  const load = (name) => import(pathToFileURL(join(SDK_SCRIPTS, name)).href);
  const [browserSession, workspace, harnessConfigModule, chromeLaunch] = await Promise.all([
    load('browser-session.mjs'), load('workspace.mjs'), load('harness-config.mjs'), load('chrome-launch.mjs'),
  ]);
  return {
    launchChrome: browserSession.launchChrome,
    ensureExtension: browserSession.ensureExtension,
    evaluate: browserSession.evaluate,
    writeConfig: browserSession.writeConfig,
    writeWorkspaceStores: browserSession.writeWorkspaceStores,
    resetWorkspaceStores: browserSession.resetWorkspaceStores,
    findSession: browserSession.findSession,
    clearPreviousSessions: browserSession.clearPreviousSessions,
    startSessionOn: browserSession.startSessionOn,
    loadWorkspace: workspace.loadWorkspace,
    storeEnvelopes: workspace.storeEnvelopes,
    workspaceDomainFor: workspace.workspaceDomainFor,
    profileName: harnessConfigModule.HARNESS_PROFILE,
    harnessConfig: harnessConfigModule.harnessConfig,
    credentialsFromEnv: chromeLaunch.credentialsFromEnv,
    workspaceEnvKeys: chromeLaunch.WORKSPACE_ENV_KEYS,
    extensionDir: resolve(SDK_SCRIPTS, '..', 'dist'),
    profileRoot: process.env.AXSDK_PROFILE_ROOT
      ?? `${process.env.LOCALAPPDATA ?? process.env.HOME ?? '.'}/AXSDKChromeProfiles`,
  };
}

/**
 * Whose credentials a run uses. The environment wins as an explicit override; otherwise the
 * workspace's own `.env`, because the run is about that workspace.
 */
function credentials(lib, workspaceRoot) {
  if (process.env.AXSDK_API_KEY && process.env.AXSDK_APP_ID) {
    return {
      from: 'the environment',
      apiKey: process.env.AXSDK_API_KEY,
      appId: process.env.AXSDK_APP_ID,
      baseUrl: process.env.AXSDK_BASE_URL ?? '',
    };
  }
  const file = join(workspaceRoot, '.env');
  if (existsSync(file)) {
    const found = lib.credentialsFromEnv(readFileSync(file, 'utf-8'), lib.workspaceEnvKeys);
    if (found) return { from: file.replace(/\\/g, '/'), ...found };
  }
  throw new Error(
    `No credentials. Set AXSDK_API_KEY and AXSDK_APP_ID, or put AXSDK_* in ${workspaceRoot}/.env.`,
  );
}

/** Polls `check` until it answers something other than `undefined`, or the deadline passes. */
async function poll(check, label, timeoutMs, intervalMs = POLL_MS) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.`);
    await delay(Math.min(intervalMs, left));
  }
}

/**
 * `poll`, but a timeout carries the caller's own account of where the wait was when it ran out.
 *
 * A bare "timed out waiting for X" is the least useful sentence a long live run can end on: the sweep
 * already survives a hang and records it, and locating one still cost a whole repeat run because the
 * evidence — which node had answered, which had not — was read on every poll and then discarded.
 * `diagnose` is called only on the timeout path, so an ordinary wait pays nothing for it.
 */
async function pollWithDiagnosis(check, label, timeoutMs, diagnose, intervalMs = POLL_MS) {
  try {
    return await poll(check, label, timeoutMs, intervalMs);
  } catch (error) {
    let account = '';
    try { account = String(diagnose() ?? ''); } catch { account = ''; }
    if (account === '') throw error;
    throw new Error(`${error.message} ${account}`, { cause: error });
  }
}

/**
 * The payload of a durable run. `AXSDK.lua.run` answers `{ status, result, deferId }` with the
 * result serialised as JSON; a completed run resolves to that parsed value, a failed one throws,
 * and pending passes through so the caller can retry or await the deferId. A payload that is not
 * a run record at all (no `status`) is already bare and passes through.
 */
function payloadOfRun(record) {
  if (typeof record !== 'object' || record === null || typeof record.status !== 'string') return record;
  if (record.status === 'failed') {
    throw new Error(String(record.result ?? record.error ?? 'the run failed'));
  }
  if (record.status !== 'completed') return record; // pending: the caller's to see, not an error
  const { result } = record;
  if (typeof result !== 'string' || result === '') return result ?? null;
  try { return JSON.parse(result); } catch { return result; }
}

/**
 * The payload of a single Lua turn. `AXSDK.lua.call` answers `{ ok, value | error, reason }`;
 * a bare payload (no boolean `ok`) passes through.
 */
function payloadOfCall(result) {
  if (typeof result !== 'object' || result === null || typeof result.ok !== 'boolean') return result;
  if (result.ok !== true) {
    throw new Error(String(result.error ?? result.reason ?? 'the command failed'));
  }
  return result.value;
}

/**
 * Brings the CDP profile up on a workspace and starts a session. Idempotent: a Chrome already
 * on the port, a build already running, settings and stores that already match, and a session
 * already open are all reused, not redone.
 *
 * `reuse: false` clears every previous session first, so the run starts on a conversation
 * nothing has touched. `reuse: true` (the default) adopts the running session wherever the
 * agent has taken it; scenarios `open()` the page they need.
 */
export async function openCdpSession(options = {}, lib = undefined) {
  const {
    workspace: workspaceRoot = process.cwd(),
    url = DEFAULT_URL,
    port = DEFAULT_PORT,
    reuse = true,
    provision = true,
  } = options ?? {};
  const sdk = lib ?? await realLibrary();

  // Read before Chrome is touched: a workspace that does not load is worth reporting before a
  // browser is on screen configured for it. Not read at all when not provisioning — reading it is how a
  // run gets a digest to write, and a workspace that fails to load must not stop a session that was
  // never going to use it.
  const loaded = provision
    ? await sdk.loadWorkspace(workspaceRoot)
    : { root: workspaceRoot, digest: '', domains: [] };

  // `chrome` and `reused` were both destructured away, and that is what made every long run look like it
  // hung: the launcher spawns Chrome ATTACHED on purpose, an attached child holds node's event loop, and
  // with the handle discarded nothing could ever release it. The sweep printed its full summary and then
  // sat until a 2400s bash timeout — the run had already finished both times.
  const { cdp, chrome: launched, reused } = await sdk.launchChrome({
    profileName: sdk.profileName, profileRoot: sdk.profileRoot, port,
  });
  const { extensionId, options: optionsPage, installed } = await sdk.ensureExtension(cdp, sdk.extensionDir);
  const optionsSession = optionsPage.sessionId;

  // `provision: false` drives what the PACKAGE installed. M1 needs a turn against stores the extension
  // wrote from its own `workspace-bundle.json`, and a write from here would prove this driver instead.
  // The build is still installed, because that is what carries the artifact.
  let settings = 'unchanged';
  let stores = 'unchanged';
  if (provision) {
    const found = credentials(sdk, loaded.root);
    const config = { ...sdk.harnessConfig(found, process.env, { local: true }), credentialsFrom: found.from };
    settings = await sdk.writeConfig(cdp, optionsSession, config, { overwrite: true });
    stores = await sdk.writeWorkspaceStores(cdp, optionsSession, sdk.storeEnvelopes(loaded));
  }

  // Only what those steps killed: an install or a write restarts the host, and the sessions it
  // ended are debris the next start would otherwise claim conversations back from.
  if (installed || settings === 'written' || stores === 'written') {
    await sdk.clearPreviousSessions(cdp, optionsSession);
  }

  let running = reuse ? await sdk.findSession(cdp, optionsSession) : undefined;
  if (!reuse) await sdk.clearPreviousSessions(cdp, optionsSession);
  if (running?.groupId === undefined) {
    running = await sdk.startSessionOn(cdp, optionsSession, url);
    if (running.groupId === undefined) {
      throw new Error(`Started no session on ${running.url} — the page may not be one Chrome can drive.`);
    }
  }
  const groupId = running.groupId;

  // ── plumbing, all through the options page ─────────────────────────────────────────────
  const sendToWorker = (payload) => sdk.evaluate(
    cdp, optionsSession, `chrome.runtime.sendMessage(${JSON.stringify(payload)})`,
  );
  const sendToWorkerQuiet = (payload) => sdk.evaluate(
    cdp, optionsSession, `chrome.runtime.sendMessage(${JSON.stringify(payload)}).catch(() => null)`,
  );
  const stateGet = async (key) => {
    const value = await sendToWorker({ type: 'axsdk.cdp.state', op: 'get', key });
    return typeof value === 'string' ? value : undefined;
  };
  const stateSet = (key, value) => sendToWorker({ type: 'axsdk.cdp.state', op: 'set', key, value });
  const stateRemove = (key) => sendToWorker({ type: 'axsdk.cdp.state', op: 'remove', key });

  const chatKey = () => `s${groupId}:axsdk:chat`;
  const readChat = async () => {
    const stored = await stateGet(chatKey());
    if (stored === undefined) return { sessionId: undefined, messages: [] };
    let state;
    try { state = JSON.parse(stored)?.state; } catch { state = undefined; }
    const messages = Array.isArray(state?.messages) ? state.messages : [];
    const id = state?.session?.id;
    return { sessionId: typeof id === 'string' && id !== '' ? id : undefined, messages };
  };

  const pageUrl = async () => {
    const answered = await sendToWorker({ type: 'axsdk.cdp.page-url', groupId });
    return typeof answered === 'string' ? answered : '';
  };

  /** Core's own answer, read back out of `axsdk:sites`, rather than any loader's guess. */
  const currentSite = async () => {
    const stored = await stateGet('axsdk:sites');
    if (stored === undefined) return undefined;
    let state;
    try { state = JSON.parse(stored)?.state; } catch { return undefined; }
    const domain = state?.currentSite?.domain;
    return typeof domain === 'string' && domain !== '' ? domain : undefined;
  };

  let luaSeq = 0;
  /**
   * One request to the session's Lua runtime. Fired on the options page and parked in a page
   * global, then polled: the CDP socket bounds each call at 30s, and a durable run outlives that.
   */
  const luaRequest = async (op, source, args, timeoutMs) => {
    const frame = JSON.stringify({ type: 'axsdk.cdp.run-lua', groupId, op, source, args: args ?? {} });
    luaSeq += 1;
    const slot = JSON.stringify(`r${luaSeq}_${Date.now().toString(36)}`);
    await sdk.evaluate(cdp, optionsSession, `(() => {
      const runs = globalThis.__axsdkCdpSessionRuns ?? (globalThis.__axsdkCdpSessionRuns = Object.create(null));
      runs[${slot}] = { done: false };
      chrome.runtime.sendMessage(${frame}).then(
        (value) => { runs[${slot}] = { done: true, value }; },
        (error) => { runs[${slot}] = { done: true, failure: String(error) }; },
      );
      return true;
    })()`);
    const settled = await poll(async () => {
      const state = await sdk.evaluate(cdp, optionsSession, `(() => {
        const runs = globalThis.__axsdkCdpSessionRuns;
        const found = runs ? runs[${slot}] : undefined;
        if (!found || !found.done) return null;
        delete runs[${slot}];
        return found;
      })()`);
      return state === null || state === undefined ? undefined : state;
    }, `the ${op} of ${source || '(status)'} to settle`, timeoutMs);
    if (settled.failure !== undefined) throw new Error(settled.failure);
    const answer = settled.value;
    if (answer === undefined || answer === null) throw new Error('The session host did not answer.');
    if (answer.ok !== true) throw new Error(String(answer.error ?? 'the runtime refused'));
    return answer.value;
  };

  // The backend session id only exists once `POST /sessions` was accepted — the difference
  // between "a worker is running" and "the extension is actually talking to the backend".
  const opened = await poll(async () => {
    const now = await readChat();
    return now.sessionId === undefined ? undefined : now;
  }, 'the backend to open a session (check the credentials and the base url)', BACKEND_TIMEOUT_MS);

  const session = {
    sessionId: opened.sessionId,
    extensionId,
    port,
    workspace: { root: loaded.root, digest: loaded.digest, domains: [...loaded.domains] },

    /** Move the session and re-resolve which site is current. */
    async open(target) {
      await this.run('AX_navigate', { url: target });
      const expected = sdk.workspaceDomainFor(loaded.indexMd, target);
      let site = await currentSite();
      if (expected !== undefined && site !== expected) {
        try {
          site = await poll(async () => {
            const now = await currentSite();
            return now === expected ? now : undefined;
          }, `the session to activate site ${expected}`, OPEN_SITE_TIMEOUT_MS);
        } catch {
          site = await currentSite(); // report the disagreement instead of hiding it in a throw
        }
      }
      return { url: await pageUrl(), site };
    },

    /** Where the session is + which site/layer is active. */
    async status() {
      const [url, site, answered] = [await pageUrl(), await currentSite(), await luaRequest('status', '', {}, 30_000)];
      const scripts = Array.isArray(answered?.status?.scripts)
        ? answered.status.scripts.map((script) => script?.id) : [];
      const commands = Array.isArray(answered?.commands) ? answered.commands : [];
      const owners = commands.map((entry) => entry?.overriddenBy ?? entry?.scriptId);
      const scriptIds = [...new Set([...scripts, ...owners])]
        .filter((id) => typeof id === 'string' && id !== '')
        .sort();
      return { url, site, scriptIds };
    },

    /** Durable-style run of an AX_* command; resolves the command payload, not an envelope. */
    run: (command, args, { timeoutMs = LUA_TIMEOUT_MS } = {}) =>
      luaRequest('run', command, args, timeoutMs).then(payloadOfRun),

    /** One Lua turn. */
    call: (command, args, { timeoutMs = LUA_TIMEOUT_MS } = {}) =>
      luaRequest('call', command, args, timeoutMs).then(payloadOfCall),

    /** Evaluate Lua source in the session runtime. */
    eval: (source, { timeoutMs = LUA_TIMEOUT_MS } = {}) =>
      luaRequest('eval', source, {}, timeoutMs),

    /**
     * A real user turn through the flow engine.
     *
     * Settles on a NEW assistant message — one whose `info.id` was not in the store before the
     * send — that has finished (`info.time.completed`), and only once the store has stopped
     * moving, so a multi-message turn is not cut off after its first message. Never a count:
     * a rehydrated store makes a count lie.
     *
     * MUST be preceded by `reset()` in any scenario that could hit a paused node.
     */
    async send(text, { timeoutMs = SEND_TIMEOUT_MS } = {}) {
      // What the turn actually cost. The sweep's bound was `max(300000, sites * 120000)` and had never
      // been measured; §13's own finding is that latency here is LLM-dominated and swings ~4x for the same
      // request, so a bound can only come from a distribution. Nothing was recording one.
      const startedAt = Date.now();
      const before = await readChat();
      const known = new Set(
        before.messages.map((message) => message?.info?.id).filter((id) => typeof id === 'string'),
      );
      const beforeCount = before.messages.length;

      const handed = await sendToWorker({ type: 'axsdk.cdp.send-message', groupId, text });
      if (handed?.delivered !== true) {
        throw new Error(`The send was not delivered: ${handed?.reason ?? 'the session host did not answer'}.`);
      }

      let previousShape = '';
      const partsOf = (message) => (Array.isArray(message?.parts) ? message.parts : []);
      const parseOutput = (value) => {
        if (typeof value !== 'string') return value;
        try { return JSON.parse(value); } catch { return value; }
      };
      /** The question a paused flow is waiting on, when it has one. */
      const pausedQuestion = (message) => {
        for (const part of partsOf(message)) {
          if (part?.type !== 'tool') continue;
          const output = parseOutput(part.state?.output);
          if (output !== null && typeof output === 'object'
            && output.next === 'ask' && typeof output.question === 'string') return output.question;
        }
        return undefined;
      };
      /** The last trace the poll saw, so a timeout can say WHERE the turn stopped. */
      let seen = [];
      const turn = await pollWithDiagnosis(async () => {
        const now = await readChat();
        const fresh = now.messages.filter((message, index) => {
          const id = message?.info?.id;
          return typeof id === 'string' ? !known.has(id) : index >= beforeCount;
        });
        const answer = [...fresh].reverse().find((message) => message?.info?.role === 'assistant');
        seen = fresh.flatMap((message) => partsOf(message).filter((part) => part?.type === 'tool'));
        const done = answer !== undefined
          && (answer.info?.time?.completed !== undefined || answer.info?.finish !== undefined
            // A turn is also answered when the flow PAUSES on a question. The comparison loop has no
            // model node by design: the presenter renders a window, pauses and reads the next reply, so
            // its message never closes. Measured live — a three-store comparison ran 19 tool parts to
            // completion and ended on present_offers with next:"ask", and waiting for time.completed
            // spent the whole bound on a turn that had finished. The window is the answer.
            || pausedQuestion(answer) !== undefined);
        if (!done) { previousShape = ''; return undefined; }
        const shape = JSON.stringify(now.messages);
        if (shape !== previousShape) { previousShape = shape; return undefined; }
        return { fresh, answer, last: now.messages[now.messages.length - 1] };
      }, 'the agent to answer', timeoutMs, () => {
        // A stop must say where it was. All of this was already in the snapshot the poll just read; the
        // timeout simply threw it away, so every hang cost a whole repeat run to locate. No tool part at
        // all is a DIFFERENT fact — the turn never reached a node — and naming it as a stall points the
        // next reader at the flow instead of at delivery.
        if (seen.length === 0) return 'The turn ran no tool call at all — it never reached a node.';
        const finished = seen.filter((part) => part.state?.status === 'completed').length;
        const stopped = seen[seen.length - 1];
        return `The turn ran ${seen.length} tool call(s), ${finished} completed;`
          + ` it stopped on ${stopped.tool ?? '(unnamed)'} (${stopped.state?.status ?? 'no status'}).`;
      });

      const asked = pausedQuestion(turn.answer);
      const toolCalls = [];
      for (const message of turn.fresh) {
        for (const part of partsOf(message)) {
          if (part?.type !== 'tool') continue;
          toolCalls.push({ name: part.tool, status: part.state?.status, output: parseOutput(part.state?.output) });
        }
      }
      const spoken = partsOf(turn.answer)
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
      // A paused flow renders its window through the tool, not a text part, so the question is the reply
      // the caller has to read. A turn that has both keeps the spoken text.
      const text_ = spoken !== '' ? spoken : (asked ?? '');
      return { text: text_, parts: partsOf(turn.last), toolCalls, elapsedMs: Date.now() - startedAt };
    },

    /**
     * Start a clean conversation: messages + session state + a new backend session.
     *
     * The paused flow survives in the messages, the session state, and the journalled deferred
     * calls — all under the session-scoped keys — so those are removed FIRST, then the host is
     * restarted: the respawned worker rehydrates nothing and opens a fresh backend session.
     * Removing the keys after (or not at all) revives the old conversation verbatim.
     */
    async reset() {
      const beforeId = this.sessionId;
      for (const suffix of SESSION_OWNED_SUFFIXES) {
        await stateRemove(`s${groupId}:${suffix}`);
      }
      await sendToWorkerQuiet({ type: 'axsdk.cdp.restart-host' });
      const fresh = await poll(async () => {
        const now = await readChat();
        if (now.sessionId === undefined || now.sessionId === beforeId) return undefined;
        return now;
      }, 'the backend to open a fresh session after reset', BACKEND_TIMEOUT_MS);
      this.sessionId = fresh.sessionId;
      return { remaining: fresh.messages.length };
    },

    /** Clear the workspace stores from the profile. */
    async resetStores() {
      await sdk.resetWorkspaceStores(cdp, optionsSession);
    },

    /**
     * The `axsdk:memory` documents (`g/<key>` global, `s/<domain>/<key>` per-site), read from
     * the persisted store — the worker writes it through on every change.
     */
    async readMemory() {
      const stored = await stateGet('axsdk:memory');
      if (stored === undefined) return {};
      let state;
      try { state = JSON.parse(stored)?.state; } catch { return {}; }
      const memory = state?.memory;
      if (typeof memory !== 'object' || memory === null || Array.isArray(memory)) return {};
      return { ...memory };
    },

    /**
     * Replace the memory documents wholesale. Enforces the persist contract up front — string
     * ids, non-blank markdown strings — because a wrong shape rehydrates as an EMPTY store and
     * reports nothing. The running session only sees the write after `reset()`.
     */
    async writeMemory(entries) {
      if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
        throw new Error('Memory must be a map of document id -> markdown string.');
      }
      for (const [key, value] of Object.entries(entries)) {
        if (key.trim() === '') throw new Error('Memory keys must be non-empty strings.');
        if (typeof value !== 'string' || value.trim() === '') {
          throw new Error(`Memory value for ${JSON.stringify(key)} must be a non-blank string.`);
        }
      }
      await stateSet('axsdk:memory', JSON.stringify({ state: { memory: entries }, version: 1 }));
    },

    /**
     * Closes the debugger channel and RELEASES the browser this session launched — it does not kill it.
     *
     * Killing would relaunch and re-provision Chrome on every CLI call, and leaving it up for the next run
     * to reuse is the whole reason the launcher attaches rather than detaches. `unref` is the third option:
     * node stops counting the child, so the process can exit, and the browser lives on. A browser that was
     * already running is not ours — `reused` says so — and is never touched.
     */
    async close() {
      cdp.close();
      if (reused !== true && launched !== undefined) launched.unref?.();
    },
  };

  return session;
}
