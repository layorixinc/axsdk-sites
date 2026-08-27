#!/usr/bin/env node
/**
 * One question: does the extracted CWS archive open a session, and does adding the pinned `key` back
 * change the answer?
 *
 * The archive strips `key` because the store refuses it, so a local load gets a path-derived id. This
 * probe runs the same open twice — once as shipped, once with the key injected — so "the keyless load is
 * the cause" becomes a measurement instead of a hypothesis. Throwaway: delete it once the answer is in
 * `AGENTS.md`.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const pkg = resolve('..', 'axsdk-sdk-js', 'packages', 'axsdk-extension-cdp');
const archiveApi = await import(pathToFileURL(join(pkg, 'scripts', 'cws-archive.mjs')).href);
const { openCdpSession } = await import(pathToFileURL(resolve('tools', 'harness', 'cdp-session.mjs')).href);

const port = async () => new Promise((res) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port: chosen } = server.address();
    server.close(() => res(chosen));
  });
});

async function attempt(label, withKey, { useDist = false, provision = 'config-only' } = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'probe-open-'));
  let extracted = join(pkg, 'dist');
  if (!useDist) {
    extracted = join(temp, 'extension');
    await archiveApi.extractCwsArchive({
      archivePath: resolve('dist', 'axsdk-extension-cdp-cws.zip'),
      outDir: extracted,
    });
  }
  if (withKey) {
    const source = JSON.parse(await readFile(join(pkg, 'src', 'manifest.json'), 'utf8'));
    const shipped = JSON.parse(await readFile(join(extracted, 'manifest.json'), 'utf8'));
    await writeFile(join(extracted, 'manifest.json'), `${JSON.stringify({ ...shipped, key: source.key }, null, 2)}\n`);
  }
  process.env.AXSDK_PROFILE_ROOT = join(temp, 'profiles');
  const started = Date.now();
  let session;
  try {
    session = await openCdpSession({
      workspace: resolve('.'),
      extensionDir: extracted,
      provision,
      reuse: false,
      port: await port(),
      url: 'https://www.amazon.com/',
      backendTimeoutMs: 45_000,
    });
    console.log(`${label}: OPENED in ${((Date.now() - started) / 1000).toFixed(1)}s · session ${session.sessionId}`);
    return true;
  } catch (error) {
    console.log(`${label}: FAILED in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log(`  ${String(error?.message ?? error).slice(0, 400)}`);
    return false;
  } finally {
    if (session) await session.shutdown().catch(() => {});
  }
}

const which = process.argv[2] ?? 'all';
const results = {};
if (which === 'all' || which === 'archive') {
  results.archive = await attempt('archive, config-only', false);
}
if (which === 'all' || which === 'dist') {
  // The dev build in a FRESH profile: splits "the archive is the difference" from "a fresh profile is".
  results.distConfigOnly = await attempt('dev dist, config-only, fresh profile', false, { useDist: true });
  results.distProvisioned = await attempt('dev dist, full provision, fresh profile', false, { useDist: true, provision: true });
}
console.log(`\n${Object.entries(results).map(([name, ok]) => `${name} ${ok ? 'opened' : 'failed'}`).join(' · ')}`);
process.exit(0);
