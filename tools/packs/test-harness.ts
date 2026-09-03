/**
 * Shared pack-artifact execution harness for the offline suites.
 *
 * Executes an artifact the way the USER_SCRIPT world does: the JS file is imported with the pack
 * register global present. A `.lua` path is wrapped through the REAL emitter first and executed
 * through the REAL prelude, so the unit under test is wrapper + prelude + Lua as one artifact.
 *
 * Provider calls run under throwing effect stubs (`fetch`/`XHR`/`WebSocket`/`sendBeacon`/`location`
 * writes), so a provider that attempts ANY side effect fails its own call.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { installLuaPrelude } from '../../../axsdk-sdk-js/packages/axsdk-extension-cdp/src/packs/lua-prelude.ts';
import { wrapLuaSource } from './wrap-lua.mjs';

export const PACKS_ROOT = resolve(import.meta.dir, '../..');
const SCRIPT_GLOBAL = '__AXSDK_PACK_REGISTER__';

export type CommandTable = Record<string, (input?: any) => unknown | Promise<unknown>>;

export async function loadCommands(
  relativePath: string,
  documentValue?: unknown,
  currentUrl?: string,
): Promise<CommandTable> {
  let commands: CommandTable | undefined;
  const globals = globalThis as Record<string, unknown>;
  const original = {
    fetch: Object.getOwnPropertyDescriptor(globalThis, 'fetch'),
    location: Object.getOwnPropertyDescriptor(globalThis, 'location'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    XMLHttpRequest: Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest'),
    WebSocket: Object.getOwnPropertyDescriptor(globalThis, 'WebSocket'),
  };
  let effects = 0;
  const restore = () => {
    for (const [name, descriptor] of Object.entries(original)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globals[name];
    }
    delete globals.document;
  };
  const install = () => {
    if (documentValue === undefined) return;
    const refused = () => {
      effects += 1;
      throw new Error('forbidden_provider_effect');
    };
    const location = {
      get href() { return currentUrl ?? ''; },
      set href(_value: string) { refused(); },
      assign: refused,
      replace: refused,
    };
    globals.document = { ...(documentValue as object), location };
    Object.defineProperty(globalThis, 'location', { configurable: true, value: location });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { sendBeacon: refused },
    });
    globals.fetch = refused;
    globals.XMLHttpRequest = function XMLHttpRequest() { refused(); };
    globals.WebSocket = function WebSocket() { refused(); };
  };
  globals[SCRIPT_GLOBAL] = (value: CommandTable) => { commands = value; };
  let importPath = resolve(PACKS_ROOT, relativePath);
  let disposePrelude: (() => void) | undefined;
  let tempDir: string | undefined;
  if (relativePath.endsWith('.lua')) {
    const wrapped = wrapLuaSource(await readFile(importPath, 'utf8'), { name: relativePath });
    tempDir = await mkdtemp(join(tmpdir(), 'axsdk-lua-artifact-'));
    importPath = join(tempDir, 'artifact.mjs');
    await writeFile(importPath, wrapped);
    disposePrelude = installLuaPrelude(globalThis);
  }
  install();
  try {
    await import(`${importPath}?test=${crypto.randomUUID()}`);
  } finally {
    delete globals[SCRIPT_GLOBAL];
    disposePrelude?.();
    restore();
    if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true });
  }
  if (commands === undefined) throw new Error(`${relativePath} did not register Pack commands`);
  if (documentValue === undefined) return commands;
  return Object.fromEntries(Object.entries(commands).map(([name, command]) => [
    name,
    async (input: unknown) => {
      effects = 0;
      install();
      try {
        const result = await command(input);
        if (effects !== 0) throw new Error('provider artifact attempted a forbidden effect');
        return result;
      } finally {
        restore();
      }
    },
  ]));
}

export function element(text: string, attributes: Record<string, string> = {}) {
  return {
    textContent: text,
    getAttribute: (name: string) => attributes[name] ?? null,
  };
}
