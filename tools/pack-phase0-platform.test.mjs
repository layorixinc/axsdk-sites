import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizePlatformCapabilities } from './pack-phase0-platform.mjs';

test('ordinary app version metadata does not advertise Pack compilation', () => {
  assert.deepEqual(summarizePlatformCapabilities({ app: { version: 7 }, appUser: {} }), {
    topLevelKeys: ['app', 'appUser'],
    protocolPaths: [],
    compilePaths: [],
    ready: false,
  });
});

test('a generic capabilities container does not count as a Pack protocol', () => {
  assert.deepEqual(summarizePlatformCapabilities({
    app: { capabilities: { compileOnly: { version: 1 } } },
  }), {
    topLevelKeys: ['app'],
    protocolPaths: [],
    compilePaths: ['app.capabilities.compileOnly'],
    ready: false,
  });
});

test('an explicit Pack protocol plus compile-only contract is ready', () => {
  assert.deepEqual(summarizePlatformCapabilities({
    app: {
      capabilities: {
        packProtocolVersion: 2,
        compileOnly: { version: 1 },
      },
    },
  }), {
    topLevelKeys: ['app'],
    protocolPaths: ['app.capabilities.packProtocolVersion'],
    compilePaths: ['app.capabilities.compileOnly'],
    ready: true,
  });
});
