/**
 * The fixed zero-logic wrapper that carries Lua source inside a signed userScript artifact
 * (`LUA_PACK_DESIGN.md`). The artifact stays `application/javascript` because `chrome.userScripts`
 * executes JavaScript only; the Lua rides as a string literal and the packaged prelude
 * (`lua-prelude.mjs` here; the extension bundles its own copy of the same contract) executes it.
 *
 * Review reads the LUA. The wrapper is trusted only because `verifyLuaArtifact` recomputes
 * `wrap(unwrap(artifact))` and refuses any byte that is not the template's — so the JS half can never
 * grow logic that review did not read.
 */

export const LUA_WRAPPER_VERSION = 'axsdk-lua-wrapper@1';

const PREFIX = `(() => {
  'use strict';
  const run = globalThis.__AXSDK_LUA_RUN__;
  if (typeof run !== 'function') throw new Error('lua_prelude_unavailable');
  run(`;
const SUFFIX = `);
})();
`;

/**
 * Textual refusal, mirroring `FORBIDDEN_SOURCE` for JS artifacts: conservative word-boundary tokens,
 * refused even in comments or strings (a reviewer should never have to argue about whether a `load`
 * was reachable). The sandbox removes these globals anyway; the static check keeps them out of the
 * reviewed text entirely.
 */
const FORBIDDEN_LUA_TOKENS = [
  'load',
  'loadstring',
  'loadfile',
  'dofile',
  'require',
  'collectgarbage',
  'io',
  'os',
  'debug',
  'coroutine',
  'package',
  '_ENV',
];
const FORBIDDEN_LUA_PATTERN = new RegExp(`(?<![\\w.])(?:${FORBIDDEN_LUA_TOKENS.join('|')})\\b`, 'u');

export function validateLuaPackSource(source) {
  if (typeof source !== 'string' || source === '') {
    throw new TypeError('lua_source_required');
  }
  const match = FORBIDDEN_LUA_PATTERN.exec(source);
  if (match) {
    throw new Error(`forbidden_lua_source: ${match[0]}`);
  }
  return source;
}

export function wrapLuaSource(source, { name }) {
  validateLuaPackSource(source);
  if (typeof name !== 'string' || name === '') throw new TypeError('lua_artifact_name_required');
  // Fixed key order; JSON.stringify of strings is deterministic, so the whole artifact is.
  const payload = JSON.stringify({ wrapper: LUA_WRAPPER_VERSION, name, source });
  return `${PREFIX}${payload}${SUFFIX}`;
}

/** Returns the embedded payload, or null when the code is not a Lua wrapper at all. */
export function unwrapLuaArtifact(artifactCode) {
  if (typeof artifactCode !== 'string') return null;
  if (!artifactCode.startsWith(PREFIX) || !artifactCode.endsWith(SUFFIX)) return null;
  const body = artifactCode.slice(PREFIX.length, artifactCode.length - SUFFIX.length);
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const keys = Object.keys(payload);
  if (keys.length !== 3 || payload.wrapper !== LUA_WRAPPER_VERSION
    || typeof payload.name !== 'string' || typeof payload.source !== 'string') return null;
  return payload;
}

/**
 * The review gate: an artifact is accepted only when it is byte-exactly the template around its own
 * embedded source. Any drift — an added statement, a reordered key, one flipped byte — is refused.
 */
export function verifyLuaArtifact(artifactCode) {
  const payload = unwrapLuaArtifact(artifactCode);
  if (payload === null) {
    if (typeof artifactCode === 'string' && artifactCode.includes('__AXSDK_LUA_RUN__')) {
      throw new Error('lua_wrapper_drift: artifact is not the fixed template around its source');
    }
    throw new Error('lua_wrapper_missing: not a Lua wrapper artifact');
  }
  const expected = wrapLuaSource(payload.source, { name: payload.name });
  if (expected !== artifactCode) {
    throw new Error('lua_wrapper_drift: artifact is not the fixed template around its source');
  }
  return { name: payload.name, source: payload.source };
}
