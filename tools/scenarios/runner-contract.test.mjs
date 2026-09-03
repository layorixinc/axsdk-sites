// The contract every live scenario runner owes, checked from its SOURCE rather than by importing it — because
// importing is precisely the hazard: `crosssite.mjs` called `main()` at module scope, so the moment its unit
// tests imported it for a pure function, the test run drove a real three-site journey. Measured: a 5-assertion
// test file took 174 seconds. §13 already records the softer version of this ("a module that does work at import
// time edits the repo when something imports it"); a runner that does it drives a browser.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const root = new URL('./', import.meta.url);
const collect = (dir, keep) => readdirSync(dir)
  .filter(keep)
  .map((name) => ({ name, source: readFileSync(new URL(name, dir), 'utf8') }));

// 2026-09-04: `axde/live/` is a SECOND home for browser-driving runners, and the same two rules
// apply there — a runner that starts on import drives a browser, and one that cannot fail through
// its exit code is an instrument nobody can gate on. A rule that knows one directory is the
// hand-maintained list this file exists to refuse.
const runners = [
  ...collect(root, (name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs')),
  ...collect(new URL('../../axde/live/', import.meta.url),
    (name) => name.endsWith('.ts') && !name.endsWith('.test.ts')),
];

test('there are runners to check', () => {
  assert.ok(runners.length >= 5, `expected the scenario runners, found ${runners.length}`);
});

test('a runner never starts its journey just because something imported it', () => {
  const unguarded = [];
  for (const { name, source } of runners) {
    if (!/\basync function main\b/.test(source)) continue;
    // Every idiom in the two directories is accepted: `pathToFileURL(process.argv[1])`, a direct
    // `import.meta.url === ...argv[1]` build, and bun's own `import.meta.main`.
    const guarded = /import\.meta\.url\s*===/.test(source)
      || /pathToFileURL\(\s*process\.argv\[1\]/.test(source)
      || /import\.meta\.main/.test(source);
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
test('every test suite under tools/ and axde/ is reachable from an npm script', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const commands = Object.values(pkg.scripts ?? {}).join(' ');
  const orphans = [];
  // Both runners live here: `node --test` over `.test.mjs` and `bun test` over `.test.ts`. A gate that
  // knows one extension is the hand-maintained list in another costume — the Pack suites are TypeScript.
  const walk = (dir) => {
    for (const entry of readdirSync(new URL(`${dir}/`, new URL('../../', import.meta.url)), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { walk(path); continue; }
      const suffix = ['.test.mjs', '.test.ts'].find((candidate) => entry.name.endsWith(candidate));
      if (suffix === undefined) continue;
      // `bun test <dir>` is RECURSIVE, so a suite is reachable when the command names it or any of
      // its ancestors — `bun test axde` really does run `axde/packs/*.test.ts`. A gate that demanded
      // the exact directory reported a false orphan the moment axde grew a subdirectory.
      const ancestors = dir.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'));
      const reachable = commands.includes(path)
        || commands.includes(`${dir}/*${suffix}`)
        || ancestors.some((candidate) => new RegExp(
          `(?:^|\\s)bun test [^&|]*${candidate.replaceAll('/', '\\/')}(?:\\s|$)`,
        ).test(commands));
      if (!reachable) orphans.push(path);
    }
  };
  walk('tools');
  // 2026-09-03: `axde/` (the dev environment) is a second tree, and a bun-only one — its suites run
  // under `bun test axde`. Adding the root here is cheaper than rediscovering the orphan-suite
  // lesson in a new directory.
  walk('axde');
  assert.deepEqual(orphans, [], 'suites no npm script runs — they are green because nothing looks at them');
});
