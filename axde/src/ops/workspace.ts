/**
 * The workspace: this working copy's flows, Lua, runtime modules, site index and sitemaps, into one
 * profile's extension stores and back out again.
 *
 * Everything mechanical is the SDK's (`axsdk-extension-cdp/scripts/workspace.mjs`) — the merge, the
 * envelope shapes, the per-slot splitting, the digest, the refusals. Nothing here re-encodes any of
 * it: the slot arithmetic and the store shapes have been paid for once already, and a second copy
 * would agree with the first only until the next fix landed in one of them.
 *
 * What this module owns is the ORDER of the decisions, and one delivery-specific check the loader
 * cannot make: `_common/rpc/62_rpc_sites.lua` is GENERATED from the site configs, and delivering it
 * stale ships old store data with no symptom until a storefront reads the wrong selector. §13
 * records what that cost — a shipping fix that was committed, gated, live-tested and never once in
 * effect.
 *
 * The `browser` argument is the capability boundary: this module decides, the adapter performs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  describeWorkspace, encodeFlowLayers, loadWorkspace, storeEnvelopes,
} from '../../../../axsdk-sdk-js/packages/axsdk-extension-cdp/scripts/workspace.mjs';
import { readSiteConfigs, serializeSites } from '../../../tools/build-rpc-sites.mjs';

/** The one generated artifact a workspace can carry, and the command that regenerates it. */
export const GENERATED = '_common/rpc/62_rpc_sites.lua';
const GENERATED_BY = 'npm run build:rpc:sites';

const KiB = (value: number) => (value >= 1024
  ? `${(value / 1024).toFixed(1)} KiB`
  : `${value} B`);

/**
 * Is the committed generated module what the generator produces from these site configs right now?
 *
 * The comparison is `tools/build-rpc-sites.test.mjs`'s, restated rather than re-derived: LF-normalise
 * and trim, because the working tree mixes line endings (§13 — two gates once went red on a revert
 * with an EMPTY diff). Absent is not stale: axde's own workspace has no site configs to generate
 * from, and a check that refused every workspace without one would refuse the default.
 */
function generatedState(dir: string) {
  const target = join(dir, GENERATED);
  if (!existsSync(target)) return { name: GENERATED, state: 'absent' as const };
  const committed = readFileSync(target, 'utf8').replace(/\r\n/g, '\n').trim();
  try {
    const fresh = serializeSites(readSiteConfigs({ root: dir })).replace(/\r\n/g, '\n').trim();
    return committed === fresh
      ? { name: GENERATED, state: 'up-to-date' as const }
      : { name: GENERATED, state: 'stale' as const };
  } catch (error) {
    // The generator refusing IS an answer about this workspace, and its reason names the file.
    return { name: GENERATED, state: 'unreadable' as const, reason: String((error as Error)?.message ?? error) };
  }
}

/** Everything a receipt needs, computed from disk and nothing else. No browser, no writes. */
export async function inspectWorkspace(dir: string) {
  const workspace = await loadWorkspace(dir);
  const envelopes = storeEnvelopes(workspace);
  const slotsOf = (layers: Record<string, unknown>) => {
    const counts: Record<string, number> = {};
    for (const key of Object.keys(layers)) {
      const logical = key.replace(/\|\d+$/, '');
      counts[logical] = (counts[logical] ?? 0) + 1;
    }
    return counts;
  };
  const moduleLayers = envelopes['axsdk:lua-modules'] === undefined
    ? {}
    : JSON.parse(envelopes['axsdk:lua-modules']).state.lua;
  return {
    dir,
    workspace,
    envelopes,
    report: describeWorkspace(workspace),
    slots: { flows: slotsOf(encodeFlowLayers(workspace.flows ?? {})), modules: slotsOf(moduleLayers) },
    generated: generatedState(dir),
  };
}

const foreign = (verb: string, profile: string) =>
  `${verb} refused: axde did not create "${profile}" — its stores belong to whoever set that profile `
  + 'up; pass --force only if you mean to overwrite them';

/** The four fields that decide whether a stored layer is read at all. */
const SWITCHES: Record<string, boolean> = {
  remote_sites: false,
  storedFlowsEnabled: true,
  storedLuaEnabled: true,
  remoteSiteFlowsEnabled: false,
};

export async function upWorkspace(browser, {
  profile, port, dist, kind = 'axde', force = false, inspected,
}) {
  if (kind !== 'axde' && !force) throw new Error(foreign('up', profile));
  if (inspected.generated.state === 'stale') {
    // Before any browser: a workspace known to be stale is not delivered, and it is not repaired
    // here either — a delivery command that edits your working copy is a surprise.
    throw new Error(
      `up refused: ${inspected.generated.name} is stale — the site configs changed since it was `
      + `generated. Run \`${GENERATED_BY}\`.`,
    );
  }
  if (inspected.generated.state === 'unreadable') {
    throw new Error(`up refused: ${inspected.generated.name} could not be checked: ${inspected.generated.reason}`);
  }

  const opened = await browser.open({ profile, port, dist });
  try {
    if (!opened.present) {
      throw new Error(
        `up refused: no extension in "${profile}" — the stores live in its origin, so run `
        + '`/install` first',
      );
    }
    const switches = await browser.sourceSwitches();
    for (const [field, wanted] of Object.entries(SWITCHES)) {
      if (switches[field] === wanted) continue;
      // Storing a workspace that will not be read is worse than refusing to store it. `install`
      // stays the single writer of this config; two writers of one setting is how a setting stops
      // meaning anything.
      throw new Error(
        `up refused: ${field} is ${JSON.stringify(switches[field])} in "${profile}", so a stored `
        + `layer would not be read. \`/install ${profile}\` writes the whole set.`,
      );
    }

    const wrote = await browser.writeWorkspace(inspected.envelopes);
    // The read-back is the proof: the answer of the call that wrote is not evidence that the store
    // holds it.
    const readBack = await browser.readWorkspace();
    return { profile, wrote, restarted: wrote === 'written', readBack };
  } finally {
    await browser.finish();
  }
}

export async function downWorkspace(browser, { profile, port, dist, kind = 'axde', force = false }) {
  if (kind !== 'axde' && !force) throw new Error(foreign('down', profile));
  await browser.open({ profile, port, dist });
  try {
    const { removed } = await browser.clearWorkspace();
    return { profile, removed };
  } finally {
    await browser.finish();
  }
}

/**
 * The receipt. Four of its lines exist because of a measured trap: the slot count (a layer over
 * 256 KiB is SPLIT, and a reader who does not know cannot tell a chunked layer from a truncated
 * one), the read-back, `host restarted` (a write that did not restart the host is a write the
 * running session has not read), and `not run` — because the most expensive failure in this repo's
 * history is a green instrument mistaken for a green product.
 */
export function receipt({ inspected, wrote, restarted, readBack, checked }) {
  const { report, slots, generated } = inspected;
  const lines = [
    `workspace  ${report.root}   digest ${report.digest}   sites ${report.sites}`,
  ];
  // Sized to the widest key present, not to a guess: a fixed column ran `:aliexpress` straight into
  // `lua 3.1 KiB`, and two facts with no space between them read as one.
  const column = Math.max(...report.layers.map((layer) => layer.key.length), 7) + 2;
  for (const layer of report.layers) {
    const parts: string[] = [];
    if (layer.flows > 0) {
      const count = slots.flows[layer.key] ?? 1;
      parts.push(`flows ${KiB(layer.flows)}${count > 1 ? ` (${count} slots)` : ''}`);
    }
    if (layer.lua > 0) parts.push(`lua ${KiB(layer.lua)}`);
    if (layer.sitemap > 0) parts.push(`sitemap ${KiB(layer.sitemap)}`);
    if (layer.modules > 0) {
      const count = slots.modules[layer.key] ?? 1;
      parts.push(`modules ${layer.modules}${count > 1 ? ` (${count} slots)` : ''}`);
    }
    lines.push(`  ${layer.key.padEnd(column, ' ')}${parts.join('   ')}`);
  }
  if (generated.state !== 'absent') lines.push(`  generated  ${generated.name} ${generated.state}`);
  lines.push(`  stores     ${wrote}${restarted ? ' · host restarted' : ''}`);
  const back = Object.entries(readBack.bytes ?? {}).map(([key, value]) => `${key} ${KiB(value as number)}`);
  if (back.length > 0) lines.push(`  read back  ${back.join(' · ')}`);
  if ((readBack.moduleNames ?? []).length > 0) {
    lines.push(`  modules    ${readBack.moduleNames.join(' ')}`);
  }
  lines.push(`  ${checked === 'pass' ? 'checked    check:flows pass' : 'not run    check:flows (pass --check)'}`
    + ' · script ids need a session (stage 2d)');
  return lines;
}
