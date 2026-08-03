import assert from 'node:assert/strict';
import test from 'node:test';

import { uploadModules } from './rpc-modules.mjs';

// A document that names modules nobody uploaded fails at the first turn, inside the runtime, with no
// file to point at. The upload is therefore the other half of a registry build and has to report
// exactly which module the server refused — a half-loaded session reads as a missing function.

function recorder(responses = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const name = JSON.parse(init.body).name;
    const reply = responses[name];
    if (reply) return reply;
    return { ok: true, status: 200, json: async () => ({ name, exports: [], injectedAt: 'now' }) };
  };
  return { calls, fetchImpl };
}

const MODULES = { '_common.helpers': 'HELPERS = {}\n', '_common.reader': 'READER = {}\n' };
const TARGET = { baseUrl: 'https://backend.test', headers: { 'x-app-user-session-id': 'ses_1' } };

test('every module is posted to the session registry with its name and source', async () => {
  const { calls, fetchImpl } = recorder();
  await uploadModules({ modules: MODULES, ...TARGET, fetchImpl });

  assert.deepEqual(calls.map((call) => call.url), [
    'https://backend.test/axsdk/v2/lua',
    'https://backend.test/axsdk/v2/lua',
  ]);
  assert.deepEqual(calls.map((call) => call.body.name), ['_common.helpers', '_common.reader']);
  assert.equal(calls[0].body.source, 'HELPERS = {}\n');
  assert.equal(calls[0].init.headers['x-app-user-session-id'], 'ses_1');
});

test('the result names what was uploaded, in declaration order', async () => {
  const { fetchImpl } = recorder();
  const result = await uploadModules({ modules: MODULES, ...TARGET, fetchImpl });
  assert.deepEqual(result.uploaded, ['_common.helpers', '_common.reader']);
  assert.equal(result.bytes, Buffer.byteLength('HELPERS = {}\nREADER = {}\n', 'utf8'));
});

test('a refused module names itself and what the server said', async () => {
  const { fetchImpl } = recorder({
    '_common.reader': { ok: false, status: 400, json: async () => ({ code: 'lua_module_invalid', message: "lua module name '_common.reader' must match ..." }) },
  });

  await assert.rejects(
    () => uploadModules({ modules: MODULES, ...TARGET, fetchImpl }),
    (error) => /_common\.reader/.test(error.message) && /lua_module_invalid/.test(error.message),
  );
});

test('an upload that fails reports the modules already in the session', async () => {
  const { fetchImpl } = recorder({
    '_common.reader': { ok: false, status: 500, json: async () => ({ message: 'boom' }) },
  });

  // Re-running the build is safe, but knowing the session is holding a partial set is the difference
  // between "retry" and "this session is poisoned".
  await assert.rejects(
    () => uploadModules({ modules: MODULES, ...TARGET, fetchImpl }),
    (error) => Array.isArray(error.uploaded) && error.uploaded.length === 1 && error.uploaded[0] === '_common.helpers',
  );
});

test('nothing to upload is not an error', async () => {
  const { calls, fetchImpl } = recorder();
  const result = await uploadModules({ modules: {}, ...TARGET, fetchImpl });
  assert.deepEqual(result.uploaded, []);
  assert.equal(calls.length, 0);
});
