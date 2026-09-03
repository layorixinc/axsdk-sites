import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');

/**
 * X3 (EXTERNAL_PACK_TASK_PLAN): the Pack task executor document. The injector requires the landed
 * URL to EQUAL the approved target, and a reviewer who opens the page must be able to read what it
 * is. Inert by construction: the page itself ships no script and reaches no third party — every
 * executable byte arrives through `chrome.userScripts.execute` from a digest-verified release.
 */
describe('pack executor document', () => {
  const load = () => readFile(resolve(ROOT, 'docs/pack-executor.html'), 'utf8');

  test('exists at the exact published filename', async () => {
    expect((await load()).length).toBeGreaterThan(0);
  });

  test('is inert: no script, no event handlers, no third-party resource', async () => {
    const html = (await load()).toLowerCase();
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
    expect(html).not.toMatch(/\son[a-z]+\s*=/);
    // No fetchable third-party reference of any kind: the only URLs allowed are same-repo docs.
    for (const url of html.match(/(?:src|href)\s*=\s*"([^"]+)"/g) ?? []) {
      expect(url).not.toMatch(/https?:\/\//);
    }
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<link');
    expect(html).not.toContain('<img');
  });

  test('states honestly what it is, in words a reviewer can read', async () => {
    const html = await load();
    expect(html).toContain('AXSDK Pack task executor');
    expect(html).toMatch(/extension|확장/i);
    expect(html).toMatch(/no script|carries no script/i);
  });
});
