import { classifyCommandSources, sleep } from '../harness/cdp.mjs';

function commandList(snapshot) {
  const commands = snapshot?.runtime?.commands;
  return Array.isArray(commands) ? commands : [];
}

function activeDomain(snapshot) {
  const domain = snapshot?.runtime?.currentSite?.domain;
  return typeof domain === 'string' && domain !== '' ? domain : null;
}

function hasStoredSiteLayer(commands, domain) {
  return commands.some((command) => command?.scriptId === `stored-lua:${domain}`);
}

function hasStoredCommonLayer(commands) {
  return commands.some((command) => command?.scriptId === 'stored-lua:');
}

/**
 * Inspects a fresh runtime snapshot after a navigation. Lua becomes available before the async
 * local-site refresh finishes, so command availability alone is not a site-ready signal.
 */
export function inspectStoredActivation(snapshot, {
  expectedDomain = null,
  requireCommonLua = false,
  requireSiteLua = false,
} = {}) {
  const commands = commandList(snapshot);
  const sources = classifyCommandSources(commands);
  const domain = activeDomain(snapshot);

  if (domain !== expectedDomain) {
    return { ready: false, activeDomain: domain, reason: 'site_domain', sources };
  }
  if (sources.remote.length > 0 || sources.local.length > 0) {
    return { ready: false, activeDomain: domain, reason: 'command_source', sources };
  }
  if (requireCommonLua && !hasStoredCommonLayer(commands)) {
    return { ready: false, activeDomain: domain, reason: 'common_lua', sources };
  }
  if (requireSiteLua && (!expectedDomain || !hasStoredSiteLayer(commands, expectedDomain))) {
    return { ready: false, activeDomain: domain, reason: 'site_lua', sources };
  }
  return { ready: true, activeDomain: domain, sources };
}

/**
 * Polls runtime state to the target site/domain and stored Lua layer. The caller provides the
 * snapshot reader so this stays deterministic in unit tests and does not duplicate CDP plumbing.
 */
export async function waitForStoredActivation(readSnapshot, {
  expectedDomain = null,
  requireCommonLua = false,
  requireSiteLua = false,
  timeoutMs = 20_000,
  intervalMs = 200,
  now = Date.now,
  delay = sleep,
} = {}) {
  if (typeof readSnapshot !== 'function') throw new Error('Activation reader must be a function');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('Activation timeout must be nonnegative');
  if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new Error('Activation interval must be nonnegative');

  const deadline = now() + timeoutMs;
  let last;
  do {
    last = inspectStoredActivation(await readSnapshot(), { expectedDomain, requireCommonLua, requireSiteLua });
    if (last.ready) return last;
    if (now() >= deadline) break;
    await delay(Math.min(intervalMs, Math.max(0, deadline - now())));
  } while (now() < deadline);

  throw new Error(
    `Timed out waiting for local ${expectedDomain ?? 'common-only'} activation `
    + `(active=${last?.activeDomain ?? 'none'}, reason=${last?.reason ?? 'unknown'})`,
  );
}
