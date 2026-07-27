import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  initializePlaygroundProfile,
  waitForUserExtensionSetup,
} from './setup.mjs';

test('initializes a dedicated profile without deleting its existing contents', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'axsdk-playground-'));
  const profile = join(parent, 'nested', 'profile');
  try {
    assert.deepEqual(await initializePlaygroundProfile(profile), {
      profile,
      created: true,
    });
    const marker = join(profile, 'user-installed-extension-marker');
    await writeFile(marker, 'preserve me', 'utf8');

    assert.deepEqual(await initializePlaygroundProfile(profile), {
      profile,
      created: false,
    });
    assert.equal(await readFile(marker, 'utf8'), 'preserve me');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('waits for user confirmation and retries runtime readiness without writing configuration', async () => {
  const prompts = [];
  const notices = [];
  let attempts = 0;
  const runtime = await waitForUserExtensionSetup({
    prompt: async (message) => {
      prompts.push(message);
      return '';
    },
    prepareRuntime: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('runtime still unavailable');
      return { available: true };
    },
    report: (message) => notices.push(message),
  });

  assert.deepEqual(runtime, { available: true });
  assert.equal(prompts.length, 2);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /runtime is still unavailable/i);
});

test('allows a user to cancel setup before a runtime check', async () => {
  await assert.rejects(
    () => waitForUserExtensionSetup({
      prompt: async () => 'quit',
      prepareRuntime: async () => {
        throw new Error('must not run');
      },
    }),
    /cancelled/i,
  );
});
