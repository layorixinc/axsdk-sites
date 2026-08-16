// The contract every live scenario runner owes, checked from its SOURCE rather than by importing it — because
// importing is precisely the hazard: `crosssite.mjs` called `main()` at module scope, so the moment its unit
// tests imported it for a pure function, the test run drove a real three-site journey. Measured: a 5-assertion
// test file took 174 seconds. §13 already records the softer version of this ("a module that does work at import
// time edits the repo when something imports it"); a runner that does it drives a browser.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const root = new URL('./', import.meta.url);
const runners = readdirSync(root)
  .filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
  .map((name) => ({ name, source: readFileSync(new URL(name, root), 'utf8') }));

test('there are runners to check', () => {
  assert.ok(runners.length >= 5, `expected the scenario runners, found ${runners.length}`);
});

test('a runner never starts its journey just because something imported it', () => {
  const unguarded = [];
  for (const { name, source } of runners) {
    if (!/\basync function main\b/.test(source)) continue;
    // The invocation must sit behind a "am I the entry point" comparison. Both idioms in this directory are
    // accepted: `pathToFileURL(process.argv[1])` and a direct `import.meta.url === ...argv[1]` build.
    const guarded = /import\.meta\.url\s*===/.test(source) || /pathToFileURL\(\s*process\.argv\[1\]/.test(source);
    const invokes = /^\s*main\(\)/m.test(source) || /\n\s*await main\(\)/.test(source);
    if (invokes && !guarded) unguarded.push(name);
  }
  assert.deepEqual(unguarded, [], 'runners that run on import — importing one for a unit test drives a browser');
});

test('a runner reports failure through the exit code, not only on screen', () => {
  const silent = runners
    .filter(({ source }) => /\basync function main\b/.test(source))
    .filter(({ source }) => !/process\.exitCode/.test(source))
    .map(({ name }) => name);
  assert.deepEqual(silent, [], 'runners whose failures cannot be seen by a caller');
});

// §13: "A hand-maintained test file list means a new suite never runs" — recorded when `test:lua` named its
// fourteen files and a written, green, committed suite reported nothing. It recurred here: `checkout.test.mjs`,
// `commerce-all-sites.test.mjs` and `multi-store-total-cost.test.mjs` were in NO npm script at all, and
// `checkout.test.mjs` was carrying two real failures while every gate was green. Globs are the fix; this is the
// check that keeps them honest.
test('every test suite under tools/ is reachable from an npm script', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const commands = Object.values(pkg.scripts ?? {}).join(' ');
  const orphans = [];
  const walk = (dir) => {
    for (const entry of readdirSync(new URL(`${dir}/`, new URL('../../', import.meta.url)), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.name.endsWith('.test.mjs')) continue;
      const glob = `${dir}/*.test.mjs`;
      if (!commands.includes(path) && !commands.includes(glob)) orphans.push(path);
    }
  };
  walk('tools');
  assert.deepEqual(orphans, [], 'suites no npm script runs — they are green because nothing looks at them');
});
