import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { element, loadCommands, PACKS_ROOT } from '../../tools/packs/test-harness.ts';
import { validateLuaPackSource, wrapLuaSource } from '../../tools/packs/wrap-lua.mjs';

/**
 * The development sample packs (`axde/packs/src`). They exist so that, while debugging a pack, a
 * failure is attributable to the ENVIRONMENT rather than to the pack under test — which only holds
 * if these two are themselves proven to run through the real wrapper and the real prelude.
 */
const ECHO = 'axde/packs/src/dev-echo/task.lua';
const PROBE = 'axde/packs/src/dev-probe/provider.lua';

describe('dev sample packs are publishable Lua', () => {
  test('both sources pass the wrapper static gate and wrap deterministically', async () => {
    for (const path of [ECHO, PROBE]) {
      const source = await readFile(resolve(PACKS_ROOT, path), 'utf8');
      expect(() => validateLuaPackSource(source), path).not.toThrow();
      expect(wrapLuaSource(source, { name: path })).toBe(wrapLuaSource(source, { name: path }));
    }
  });

  test('neither sample names a write, a click or a navigation of its own', async () => {
    for (const path of [ECHO, PROBE]) {
      const source = await readFile(resolve(PACKS_ROOT, path), 'utf8');
      expect(source, path).not.toMatch(/dom\.click|dom\.submit|dom\.set_value|nav\./);
    }
  });
});

describe('dev-echo task', () => {
  test('echo answers the marshaling shapes a caller gets wrong', async () => {
    const commands = await loadCommands(ECHO);
    const out = await commands.echo({ say: '  hello   there ', number: 42 }) as any;
    expect(out.said).toBe('hello there');
    expect(out.number).toBe(42);
    // The distinction the whole runtime keeps tripping over, provable in one call.
    expect(Array.isArray(out.empty_list)).toBe(true);
    expect(Array.isArray(out.empty_object)).toBe(false);
    expect(out.korean).toBe('무료배송 · 배송비 미확인');
  });

  test('describe_surface reports the prelude API that is actually present', async () => {
    const commands = await loadCommands(ECHO);
    const surface = await commands.describe_surface() as any;
    expect(surface).toMatchObject({
      json: 'table', text: 'table', url: 'table', clock: 'table', dom: 'table', page: 'table',
      now_is_number: true,
    });
    expect(surface.surface_keys).toEqual(['json', 'text', 'url', 'clock', 'dom', 'page']);
  });

  test('fail raises a NAMED reason that crosses to the caller', async () => {
    const commands = await loadCommands(ECHO);
    expect(() => commands.fail({ reason: 'dev_probe_refused' })).toThrow('dev_probe_refused');
    expect(() => commands.fail({})).toThrow('dev_echo_failed');
  });
});

describe('dev-probe provider', () => {
  const doc = (nodes: readonly unknown[], title?: string) => ({
    querySelector: (selector: string) => (selector === 'title' && title !== undefined ? element(title) : null),
    querySelectorAll: (selector: string) => (selector === '.card' ? nodes : []),
  });

  test('it reads the page it stands on: url parts, match count and bounded samples', async () => {
    const nodes = [
      { textContent: ' first ', getAttribute: (name: string) => (name === 'id' ? 'a1' : null), querySelector: () => null },
      { textContent: 'second', getAttribute: () => null, querySelector: () => null },
      { textContent: 'third', getAttribute: () => null, querySelector: () => null },
      { textContent: 'fourth', getAttribute: () => null, querySelector: () => null },
    ];
    const commands = await loadCommands(PROBE, doc(nodes, 'Dev Page'), 'https://example.test/a/b?x=1');
    const out = await commands.read_page({ selector: '.card' }) as any;
    expect(out).toMatchObject({
      href: 'https://example.test/a/b?x=1',
      origin: 'https://example.test',
      pathname: '/a/b',
      selector: '.card',
      matched: 4,
      title: 'Dev Page',
    });
    expect(out.samples).toHaveLength(3);
    expect(out.samples[0]).toEqual({ text: 'first', id: 'a1' });
    // An attribute the node does not carry stays ABSENT rather than becoming an empty string.
    expect(out.samples[1]).not.toHaveProperty('id');
  });

  test('a selector that matches nothing is zero matches, NOT a failure — and no title is absent', async () => {
    const commands = await loadCommands(PROBE, doc([]), 'https://example.test/');
    const out = await commands.read_page({ selector: '.absent' }) as any;
    expect(out.matched).toBe(0);
    expect(out.samples).toEqual([]);
    expect(out).not.toHaveProperty('title');
  });

  test('it defaults to h1 when no selector is given', async () => {
    const commands = await loadCommands(PROBE, doc([]), 'https://example.test/');
    expect((await commands.read_page({}) as any).selector).toBe('h1');
  });
});
