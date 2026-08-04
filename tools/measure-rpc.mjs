#!/usr/bin/env node
// Measures what an RPC op actually costs IN THIS ENVIRONMENT, so a latency claim can name its source.
//
// The SDK measured 3ms server-side and asked us to check three candidates for our own 620-880ms
// observation: h2 vs http/1.1, the op's own workload, and debug logging with devtools attached. A wall
// clock around a whole tool call cannot separate those — it sums transport, execution and the site's
// own re-render. The client already times each frame (`rpc-channel.ts:120,151`), so this reads THAT:
//
//   durationMs   what executing the op cost the client
//   gap          the gap between one answer and the next frame arriving — transport plus runtime
//
// A large gap with a small duration is transport. A large duration is the op's workload, which is our
// problem, not theirs. Run it around a real flow turn; the numbers only mean something under real load.

import {
  CdpClient, DEFAULTS, callInAxContext, listTargets, pickPageTarget,
} from './harness/cdp.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((entry) => entry.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const port = Number(flag('port', DEFAULTS.port));
const extensionId = flag('extension-id', DEFAULTS.extensionId);
const cdpUrl = `http://127.0.0.1:${port}`;
const command = args.find((entry) => !entry.startsWith('--')) ?? 'report';

const targets = await listTargets(cdpUrl);
const target = pickPageTarget(targets, flag('match', undefined));
if (!target) throw new Error('no page target; run `node tools/ax.mjs open <site>` first');

const page = new CdpClient(target.webSocketDebuggerUrl);
await page.ready;
try {
  if (command === 'on' || command === 'off') {
    const enable = command === 'on';
    const result = await callInAxContext(page, { extensionId }, `function (on) {
      const sdk = globalThis._AXSDK;
      if (!sdk) return { error: 'no _AXSDK in this context' };
      sdk.config.debug = on;
      return { debug: sdk.config.debug === true };
    }`, [enable]);
    console.log(JSON.stringify(result));
  } else if (command === 'clear') {
    const result = await callInAxContext(page, { extensionId }, `function () {
      const sdk = globalThis._AXSDK;
      const store = sdk?.getDebugEventStore?.();
      if (!store) return { error: 'no debug event store on this build' };
      store.getState().clear?.();
      return { cleared: true };
    }`);
    console.log(JSON.stringify(result));
  } else {
    // Read the captured frames and reduce them here, where the numbers can be checked.
    const raw = await callInAxContext(page, { extensionId }, `function () {
      const sdk = globalThis._AXSDK;
      const store = sdk?.getDebugEventStore?.();
      if (!store) return { error: 'no debug event store on this build' };
      const events = store.getState().events ?? [];
      return {
        total: events.length,
        rpc: events
          .filter((entry) => String(entry.scope ?? '').includes('rpc') || String(entry.event ?? '').includes('rpc'))
          .map((entry) => ({
            t: entry.timestamp,
            event: entry.event,
            op: entry.details?.op ?? entry.details?.frame?.op ?? null,
            durationMs: entry.details?.durationMs ?? null,
          })),
      };
    }`);

    if (raw?.error) {
      console.log(JSON.stringify(raw));
    } else {
      const frames = (raw.rpc ?? []).filter((entry) => entry.durationMs !== null);
      const gaps = [];
      for (let index = 1; index < frames.length; index += 1) {
        const previous = Date.parse(frames[index - 1].t);
        const current = Date.parse(frames[index].t);
        if (Number.isFinite(previous) && Number.isFinite(current)) gaps.push(current - previous);
      }
      const stat = (values) => {
        if (values.length === 0) return null;
        const sorted = [...values].sort((left, right) => left - right);
        return {
          n: sorted.length,
          median: sorted[Math.floor(sorted.length / 2)],
          min: sorted[0],
          max: sorted[sorted.length - 1],
        };
      };
      // Which ops dominate. Reducing round trips means knowing WHICH ones to fold, and a list of the
      // first twelve says nothing about a run of ninety-five.
      const byOp = {};
      for (const entry of frames) {
        const key = entry.op ?? 'unknown';
        byOp[key] = byOp[key] ?? { n: 0, totalMs: 0 };
        byOp[key].n += 1;
        byOp[key].totalMs += entry.durationMs;
      }
      const histogram = Object.entries(byOp)
        .sort(([, left], [, right]) => right.n - left.n)
        .map(([op, entry]) => `${op} x${entry.n} (${Math.round(entry.totalMs / 1000)}s)`);

      console.log(JSON.stringify({
        capturedEvents: raw.total,
        rpcFrames: frames.length,
        // What executing the op cost the client.
        durationMs: stat(frames.map((entry) => entry.durationMs)),
        // Answer-to-next-frame. Transport and runtime, everything that is not our op.
        gapMs: stat(gaps),
        byOp: histogram,
      }, null, 1));
    }
  }
} finally {
  await page.close();
}
