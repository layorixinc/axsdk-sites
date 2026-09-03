/**
 * Stage 2a live gate: a headed browser that OUTLIVES the command, and a graceful stop.
 *
 * Offline tests cannot reach any of this. Whether a spawned Chrome survives its launcher, whether a
 * second `launch` adopts it instead of spawning beside it, and whether a graceful stop keeps the two
 * toggles on disk are all facts about a real browser — so they are measured here, through the same
 * subcommands a developer types, on a throwaway profile root.
 *
 * The regression this gate exists for was found by running the journey rather than by reading it
 * (2026-09-04): `profile ls` reported a row as `up` and then CLOSED the browser `launch` had
 * deliberately left running, so the next launch found a dead port and quietly spawned a second
 * Chrome. The first version of the journey printed that outcome instead of asserting it, and passed.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

type Run = { code: number; out: string };

let profileRoot = '';

async function axde(...args: string[]): Promise<Run> {
  const child = Bun.spawn([process.execPath, 'axde/src/cli.ts', ...args], {
    cwd: SITES_ROOT,
    env: { ...process.env, AXSDK_PROFILE_ROOT: profileRoot },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, out: `${stdout}${stderr}`.trim() };
}

const checks: string[] = [];

function ok(what: string, condition: unknown, evidence: string) {
  if (!condition) throw new Error(`${what}\n  observed: ${evidence}`);
  checks.push(what);
  console.log(`  ok  ${what}`);
}

async function expectOk(...args: string[]): Promise<string> {
  const { code, out } = await axde(...args);
  if (code !== 0) throw new Error(`axde ${args.join(' ')} exited ${code}\n  observed: ${out}`);
  return out;
}

const recordedPort = () => JSON.parse(
  readFileSync(join(profileRoot, 'packdev', 'axde-profile.json'), 'utf8'),
).port as number;

const recordedRun = () => JSON.parse(
  readFileSync(join(profileRoot, 'packdev', 'axde-profile.json'), 'utf8'),
).running as { pid?: number; port?: number } | undefined;

const answers = async (port: number) =>
  fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok).catch(() => false);

const pages = async (port: number) => {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()) as
    { type: string; url: string }[];
  return list.filter((one) => one.type === 'page').map((one) => one.url);
};

async function main() {
  profileRoot = join(mkdtempSync(join(tmpdir(), 'axde-stage2a-')), 'profiles');
  let port = 0;
  try {
    console.log('profile new + ext install');
    await expectOk('profile', 'new', 'packdev');
    port = recordedPort();
    const installed = await expectOk('ext', 'install', 'packdev');
    ok('the build installs and user scripts come up', /user scripts on/.test(installed), installed);

    console.log(`launch --url (port ${port})`);
    const startedAt = Date.now();
    const first = await expectOk('launch', 'packdev', '--url', 'https://example.com/');
    const elapsed = Date.now() - startedAt;
    ok('launch reports a launch with a pid', /launched on :\d+ pid \d+/.test(first), first);
    ok('the extension and user scripts are READ and named',
      /extension up · user scripts on/.test(first), first);
    ok('the command RETURNS instead of holding the browser open', elapsed < 30_000, `${elapsed}ms`);

    // The point of the whole stage: a NEW process finds it and can see its page.
    ok('the browser outlived the command', await answers(port), `port ${port}`);
    const open = await pages(port);
    ok('the --url tab is there, so the flag is not a lie',
      open.some((url) => url.includes('example.com')), JSON.stringify(open));

    const listed = await expectOk('profile', 'ls');
    ok('the inventory reports it up, with the recorded pid',
      new RegExp(`chrome up :${port} pid \\d+`).test(listed), listed);
    // The regression. A read that destroys what it reports on is not a read.
    ok('a read did NOT take the browser down', await answers(port), `port ${port} after profile ls`);

    const status = await expectOk('ext', 'status', 'packdev');
    ok('status reads user scripts on the running browser', /userScripts\s+true/.test(status), status);
    ok('status did NOT take the browser down either', await answers(port), `port ${port} after status`);

    const pidBefore = recordedRun()?.pid;
    const again = await expectOk('launch', 'packdev');
    ok('a second launch ADOPTS the running browser', /already-running/.test(again), again);
    ok('and never spawns beside it', !/pid \d+/.test(again), again);
    ok('so the recorded pid is left alone', recordedRun()?.pid === pidBefore,
      `${pidBefore} -> ${recordedRun()?.pid}`);

    const stopped = await expectOk('stop', 'packdev');
    ok('stop reports a stop', /stopped/.test(stopped), stopped);
    ok('and the port goes quiet', !(await answers(port)), `port ${port}`);
    ok('the record is cleared', recordedRun() === undefined, JSON.stringify(recordedRun()));

    const twice = await expectOk('stop', 'packdev');
    ok('stopping a quiet browser says so', /already-stopped/.test(twice), twice);

    // The reason `stop` is graceful: Chrome writes Preferences during shutdown, and both toggles
    // live there. This launches once more to read them back.
    const after = await expectOk('ext', 'status', 'packdev');
    ok('the graceful stop kept developer mode and the user-scripts row',
      /userScripts\s+true/.test(after), after);

    const foreignRoot = join(profileRoot, 'someone-elses');
    Bun.spawnSync(['cmd', '/c', 'mkdir', foreignRoot.replaceAll('/', '\\')]);
    for (const verb of ['launch', 'stop']) {
      const refused = await axde(verb, 'someone-elses');
      ok(`${verb} on a foreign profile is refused BY NAME`,
        refused.code === 1 && /did not create "someone-elses"/.test(refused.out), refused.out);
    }

    await expectOk('profile', 'rm', 'packdev');
    ok('the inventory is empty again', !(await expectOk('profile', 'ls')).includes('packdev'),
      'profile ls');

    console.log(`\nAXDE STAGE 2A LIVE PASS — ${checks.length} checks`);
  } finally {
    // Never leave a browser this gate started: it is detached, so nothing else would reap it.
    if (port && await answers(port)) await axde('stop', 'packdev').catch(() => undefined);
    rmSync(profileRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`\nAXDE STAGE 2A LIVE FAIL after ${checks.length} checks`);
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  });
}

export { main };
