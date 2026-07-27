import { mkdir, stat } from 'node:fs/promises';

/** Creates the dedicated profile directory if needed, never clears user-installed extension state. */
export async function initializePlaygroundProfile(profile) {
  if (typeof profile !== 'string' || profile.trim() === '') {
    throw new Error('Playground profile path is required');
  }

  try {
    const existing = await stat(profile);
    if (!existing.isDirectory()) throw new Error(`Playground profile is not a directory: ${profile}`);
    return { profile, created: false };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  await mkdir(profile, { recursive: true });
  return { profile, created: true };
}

/**
 * Keeps the terminal attached to the human setup step. The caller owns all browser interaction;
 * this helper only coordinates confirmation and never reads or writes extension configuration.
 */
export async function waitForUserExtensionSetup({ prompt, prepareRuntime, report = () => {} }) {
  if (typeof prompt !== 'function') throw new Error('Setup prompt must be a function');
  if (typeof prepareRuntime !== 'function') throw new Error('Runtime preparation must be a function');

  for (;;) {
    const answer = String(await prompt('Press Enter after installing and configuring the extension, or type quit: ')).trim().toLowerCase();
    if (answer === 'quit' || answer === 'exit' || answer === 'cancel') {
      throw new Error('Extension setup cancelled by user');
    }

    try {
      return await prepareRuntime();
    } catch {
      report('AXSDK runtime is still unavailable. Complete extension installation, enable Debug logging, then press Enter to retry.');
    }
  }
}
