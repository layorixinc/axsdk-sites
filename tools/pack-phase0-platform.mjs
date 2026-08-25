#!/usr/bin/env node
/**
 * Phase 0 Pack protocol/compile capability probe.
 *
 * Reads authenticated app-info without creating a session or model turn. It never prints response
 * values, credentials, source, or payloads: only HTTP status and capability-shaped key paths. An
 * absent advertised Pack protocol/compile contract is a blocking result, not permission to guess an
 * endpoint path.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseEnvFile } from './playground/credentials.mjs';

export function summarizePlatformCapabilities(payload) {
  const topLevelKeys = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.keys(payload).sort()
    : [];
  const protocolPaths = [];
  const compilePaths = [];
  const visit = (value, path = '') => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
    for (const key of Object.keys(value)) {
      const next = path === '' ? key : `${path}.${key}`;
      if (/compile|compos/i.test(key)) compilePaths.push(next);
      if ((/pack/i.test(key) && /protocol|version/i.test(key))
        || (/protocol/i.test(key) && /pack/i.test(path))) {
        protocolPaths.push(next);
      }
      visit(value[key], next);
    }
  };
  visit(payload);
  protocolPaths.sort();
  compilePaths.sort();
  return {
    topLevelKeys,
    protocolPaths,
    compilePaths,
    ready: protocolPaths.length > 0 && compilePaths.length > 0,
  };
}

export async function runPlatformProbe() {
  const env = {
    ...parseEnvFile(readFileSync(resolve('.env'), 'utf8')),
    ...process.env,
  };
  const apiKey = env.AXSDK_API_KEY;
  const appId = env.AXSDK_APP_ID;
  const baseUrl = String(env.AXSDK_BASE_URL ?? 'https://api.axsdk.ai').replace(/\/$/, '');
  if (!apiKey || !appId) throw new Error('Phase 0 platform probe requires AXSDK_API_KEY and AXSDK_APP_ID');

  const response = await fetch(`${baseUrl}/axsdk`, {
    headers: {
      'x-api-key': apiKey,
      'x-app-id': appId,
      'x-app-user-id': 'axsdk-pack-phase0-probe',
      'x-app-user-name': 'Phase 0 probe',
      origin: 'http://localhost:3334',
    },
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = payload?.error;
    const code = typeof error?.code === 'string' ? error.code : 'unknown';
    const detail = typeof error?.detail === 'string' ? error.detail : 'none';
    console.error(`PACK PHASE 0 PLATFORM ERROR status:${response.status} code:${code} detail:${detail}`);
    return 1;
  }

  const summary = summarizePlatformCapabilities(payload);
  console.log(`PACK PHASE 0 PLATFORM status:${response.status}`);
  console.log(`  app-info keys:${summary.topLevelKeys.join(',') || 'none'}`);
  console.log(`  Pack protocol:${summary.protocolPaths.join(',') || 'not_advertised'}`);
  console.log(`  compile-only:${summary.compilePaths.join(',') || 'not_advertised'}`);
  if (!summary.ready) {
    console.error('PACK PHASE 0 PLATFORM BLOCKED: no versioned Pack protocol and compile-only contract is advertised; no endpoint was guessed.');
    return 2;
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await runPlatformProbe();
}
