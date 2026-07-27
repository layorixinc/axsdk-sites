import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseCliArguments,
  parseReplInput,
  resolvePlaygroundOptions,
} from './cli.mjs';

test('defaults to managed repl and parses only declared playground flags', () => {
  assert.deepEqual(parseCliArguments([]), {
    command: 'repl',
    positionals: [],
    flags: {},
  });
  assert.deepEqual(parseCliArguments(['setup']), {
    command: 'setup',
    positionals: [],
    flags: {},
  });
  assert.deepEqual(parseCliArguments([
    'sync',
    '--root=fixtures/playground',
    '--port=9236',
    '--no-launch',
    '--timeout=45000',
  ]), {
    command: 'sync',
    positionals: [],
    flags: {
      root: 'fixtures/playground',
      port: 9236,
      launch: false,
      timeout: 45000,
    },
  });
  assert.throws(() => parseCliArguments(['--shell=rm']), /unknown flag/i);
  assert.throws(() => parseCliArguments(['unknown']), /unknown command/i);
});

test('keeps the playground profile and port separate unless explicitly overridden', () => {
  const options = resolvePlaygroundOptions({
    root: 'playground',
    port: 9235,
    profile: 'C:/Temp/AXSDKPlaygroundChromeProfile',
  });
  assert.equal(options.port, 9235);
  assert.equal(options.root.endsWith('playground'), true);
  assert.equal(options.home, 'https://axsdk.ai/');
  assert.equal(typeof options.chrome, 'string');
  assert.ok(options.chrome.length > 0);
  assert.equal(typeof options.extensionPath, 'string');
  assert.ok(options.extensionPath.length > 0);

  assert.throws(() => resolvePlaygroundOptions({ port: 9224 }), /live-harness port/i);
  assert.throws(
    () => resolvePlaygroundOptions({ profile: '%LOCALAPPDATA%/AXSDKSitesChromeDevProfile' }),
    /live-harness profile/i,
  );
  assert.doesNotThrow(() => resolvePlaygroundOptions({
    port: 9224,
    profile: '%LOCALAPPDATA%/AXSDKSitesChromeDevProfile',
    allowSharedProfile: true,
  }));
});

test('parses fixed REPL grammar without shell execution', () => {
  assert.deepEqual(parseReplInput('.reload'), { kind: 'sync' });
  assert.deepEqual(parseReplInput('.ext-reload'), { kind: 'extension-reload' });
  assert.deepEqual(parseReplInput('.open https://example.com/path'), {
    kind: 'open',
    url: 'https://example.com/path',
  });
  assert.deepEqual(parseReplInput('.send inspect this'), {
    kind: 'send',
    text: 'inspect this',
  });
  assert.deepEqual(parseReplInput('.call AX_echo {"value":"one"}'), {
    kind: 'call',
    command: 'AX_echo',
    args: { value: 'one' },
  });
  assert.deepEqual(parseReplInput('AX_echo {"value":"two"}'), {
    kind: 'run',
    command: 'AX_echo',
    args: { value: 'two' },
  });
  assert.deepEqual(parseReplInput('.quit'), { kind: 'quit' });
  assert.throws(() => parseReplInput('.open file:///etc/passwd'), /HTTP\(S\)/i);
  assert.throws(() => parseReplInput('.run echo nope'), /AX_/i);
  assert.throws(() => parseReplInput('.unknown'), /unknown REPL command/i);
  assert.throws(() => parseReplInput('rm -rf /'), /AX_/i);
});
