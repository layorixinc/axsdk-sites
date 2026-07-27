import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';

import {
  CREDENTIAL_ENV_KEYS,
  buildExtensionCredentialPatch,
  describeExtensionCredentialPatch,
  envFileCandidates,
  loadExtensionCredentials,
  parseEnvFile,
  selectCredentialValues,
} from './credentials.mjs';

function missingFileReader() {
  return async () => {
    const error = new Error('not found');
    error.code = 'ENOENT';
    throw error;
  };
}

test('parses assignments while ignoring comments, blank lines, and export prefixes', () => {
  const values = parseEnvFile([
    '# comment',
    '',
    'AXSDK_BASE_URL=https://local.axsdk.ai',
    'export AXSDK_APP_ID = browser-extension ',
    'AXSDK_API_KEY="quoted-secret"',
    "AXSDK_SITES_URL='git+https://example.com/sites.git'",
    'AXSDK_EXTENSION_DEBUG=false',
    'MALFORMED',
    '=novalue',
  ].join('\r\n'));

  assert.deepEqual(values, {
    AXSDK_BASE_URL: 'https://local.axsdk.ai',
    AXSDK_APP_ID: 'browser-extension',
    AXSDK_API_KEY: 'quoted-secret',
    AXSDK_SITES_URL: 'git+https://example.com/sites.git',
    AXSDK_EXTENSION_DEBUG: 'false',
  });
});

test('keeps separators that belong to the value', () => {
  assert.equal(parseEnvFile('AXSDK_API_KEY=a=b=c').AXSDK_API_KEY, 'a=b=c');
});

test('environment variables override the env file', () => {
  const selected = selectCredentialValues({
    file: { AXSDK_API_KEY: 'file-key', AXSDK_APP_ID: 'file-app', AXSDK_BASE_URL: 'https://file' },
    env: { AXSDK_API_KEY: 'env-key', AXSDK_BASE_URL: '   ' },
  });

  assert.deepEqual(selected, {
    apiKey: 'env-key',
    appId: 'file-app',
    baseUrl: 'https://file',
  });
});

test('builds a debug-enabled patch and reports missing required fields', () => {
  const complete = buildExtensionCredentialPatch({
    apiKey: 'secret',
    appId: 'browser-extension',
    baseUrl: 'https://local.axsdk.ai',
    sitesSource: 'git+https://example.com/sites.git',
  });
  assert.deepEqual(complete.missing, []);
  assert.deepEqual(complete.patch, {
    enabled: true,
    debug: true,
    apiKey: 'secret',
    appId: 'browser-extension',
    baseUrl: 'https://local.axsdk.ai',
    sitesSource: 'git+https://example.com/sites.git',
  });

  const partial = buildExtensionCredentialPatch({ appId: 'browser-extension' });
  assert.deepEqual(partial.missing, ['apiKey', 'baseUrl']);
});

test('honors explicit false flags and omits an unset sites source', () => {
  const { patch } = buildExtensionCredentialPatch({
    apiKey: 'secret',
    appId: 'browser-extension',
    baseUrl: 'https://local.axsdk.ai',
    enabled: 'FALSE',
    debug: '0',
  });

  assert.equal(patch.enabled, false);
  assert.equal(patch.debug, false);
  assert.ok(!Object.hasOwn(patch, 'sitesSource'));
});

test('receipts never expose the api key', () => {
  const receipt = describeExtensionCredentialPatch({
    enabled: true,
    debug: true,
    apiKey: 'super-secret-value',
    appId: 'browser-extension',
    baseUrl: 'https://local.axsdk.ai',
  });

  assert.equal(receipt.apiKey, 'set');
  assert.equal(JSON.stringify(receipt).includes('super-secret-value'), false);
  assert.equal(describeExtensionCredentialPatch({ apiKey: '' }).apiKey, 'missing');
});

test('searches the working directory, workspace root, and workspace parent', () => {
  assert.deepEqual(envFileCandidates({ root: '/repo/playground', cwd: '/repo' }), [
    resolve('/repo/.env'),
    resolve('/repo/playground/.env'),
  ]);
  assert.deepEqual(envFileCandidates({ root: '/elsewhere/playground', cwd: '/repo' }), [
    resolve('/repo/.env'),
    resolve('/elsewhere/playground/.env'),
    resolve('/elsewhere/.env'),
  ]);
});

test('loads the first readable env file and reports its path', async () => {
  const attempted = [];
  const result = await loadExtensionCredentials({
    root: '/repo/playground',
    cwd: '/repo',
    env: {},
    readEnvFile: async (path) => {
      attempted.push(path);
      if (path !== resolve('/repo/.env')) {
        const error = new Error('not found');
        error.code = 'ENOENT';
        throw error;
      }
      return [
        `${CREDENTIAL_ENV_KEYS.apiKey}=secret`,
        `${CREDENTIAL_ENV_KEYS.appId}=browser-extension`,
        `${CREDENTIAL_ENV_KEYS.baseUrl}=https://local.axsdk.ai`,
      ].join('\n');
    },
  });

  assert.deepEqual(attempted, [resolve('/repo/.env')]);
  assert.equal(result.envFile, resolve('/repo/.env'));
  assert.deepEqual(result.missing, []);
  assert.equal(result.patch.appId, 'browser-extension');
});

test('falls back to the environment when no env file exists', async () => {
  const result = await loadExtensionCredentials({
    root: '/repo/playground',
    cwd: '/repo',
    env: {
      [CREDENTIAL_ENV_KEYS.apiKey]: 'secret',
      [CREDENTIAL_ENV_KEYS.appId]: 'browser-extension',
      [CREDENTIAL_ENV_KEYS.baseUrl]: 'https://local.axsdk.ai',
    },
    readEnvFile: missingFileReader(),
  });

  assert.equal(result.envFile, null);
  assert.deepEqual(result.missing, []);
  assert.equal(result.patch.debug, true);
});

test('reports missing fields when neither source supplies credentials', async () => {
  const result = await loadExtensionCredentials({
    root: '/repo/playground',
    cwd: '/repo',
    env: {},
    readEnvFile: missingFileReader(),
  });

  assert.deepEqual(result.missing, ['apiKey', 'appId', 'baseUrl']);
});
