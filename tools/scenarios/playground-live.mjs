/**
 * Live scenario sweep for the `playground` workspace.
 *
 * Nothing exercised a playground FLOW live until this file: `npm run test:playground` is 50 offline tests, and
 * `tools/playground/cli.test.mjs` asserts the live-harness port is REFUSED. The only live path was a human
 * typing `.send` in the REPL.
 *
 * Two properties of the workspace shape every decision here.
 *
 * 1. **The router has a `defaultIntent`** (`playground_durable_checkpoint`), so an utterance that matches
 *    nothing still gets a confident answer. A sweep that accepted any non-empty reply would report six passing
 *    flows while five of them never ran. Every scenario therefore carries its own success signal, and a reply
 *    that is the default intent's is reported as exactly that.
 * 2. **The synced root must be the BUILD output.** `loadWorkspace` reads flows.yaml verbatim, and the authored
 *    document still names its modules — measured 25,533 B with 12 module-name lines against the built
 *    230,618 B with none. Syncing the authored root answers `RPC SEARCH EMPTY` with a blank href in ~6s, which
 *    reads like a selector failure and is a delivery failure. Nothing in the playground tooling checks this, so
 *    this runner does, before it touches Chrome.
 *
 * Read-only by construction, not by convention: the whole workspace's `rpc.allow` union is five ops
 * (`nav.navigate` plus four `dom` reads), so no click, input or submit op is grantable and no cart, checkout or
 * order step exists to reach. Live navigations to real storefronts DO happen.
 *
 * The  flake this gate found on day one is FIXED (see AGENTS.md §13): the arrival wait
 * needed the target, because a navigation that commits faster than the baseline read can never look like a
 * change. Both multi-site scenarios answered  before the fix and  after — the fan-out had been
 * losing a store to it.
 *
 * Usage: `node tools/scenarios/playground-live.mjs [--only=<name,name>] [--no-sync] [--timeout=<ms>]`
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { recognizedAccessOutcomes } from './commerce-all-sites.mjs';

const repoRoot = new URL('../../', import.meta.url);
const BUILT_ROOT = 'dist/playground';
const PLAYGROUND_PORT = 9235;

/**
 * Module names a flow document still carries unresolved. The built document inlines each module's Lua, so a
 * non-empty answer means this root cannot serve the tools that declare them.
 */
export function unresolvedModules(flowsYaml) {
  const text = typeof flowsYaml === 'string' ? flowsYaml : '';
  const names = new Set();
  for (const [, name] of text.matchAll(/^\s+-\s+(_common\.[A-Za-z0-9_.]+)\s*$/gm)) names.add(name);
  return [...names].sort();
}

/**
 * One scenario per user-routable router intent, plus the coverage that only a parent turn can give.
 *
 * `utterance` is quoted from the route's own `examples` in `playground/_common/flows.yaml` — an invented phrase
 * would test the planner's generosity instead of the route.
 *
 * **A flow is judged by the BRANCH it took, not by the prose it rendered.** Measured live, and it cost a false
 * failure: the `shopping` terminal's respond is an instruction to the model ("Reply in the user's language"), so
 * a Korean utterance answered `Amazon 검색이 완료되었습니다` while the tool trace carried
 * `{"next":"done","site":"amazon","candidates":[…]}`. An English regex called that a failure. `expect` survives
 * only for the two flows whose respond is "reply with exactly this line and nothing else", where the line IS the
 * contract — and for `rpc_nav_only`, whose ok and error edges both land on `done`, it is the only signal there is.
 */
export const SCENARIOS = [
  {
    name: 'rpc-probe',
    flow: 'rpc_probe',
    utterance: 'rpc probe',
    // "Reply with exactly this line and nothing else: RPC OK · heading={heading} · href={href} · documents={n}"
    expect: /RPC OK\s*·\s*heading=/i,
    branch: { tool: 'rpc_read_page', accept: ['ok'] },
    note: 'read ops only, no navigation: proves the RPC channel on whatever page the profile is on',
  },
  {
    name: 'rpc-nav-only',
    flow: 'rpc_nav_only',
    utterance: 'rpc nav only',
    // Both the ok and the error edge land on `done`, so the STAGES are the health signal and the branch is not.
    expect: /NAV\b[\s\S]*href=/i,
    note: 'navigates to a hardcoded live 11st search URL and times each stage',
  },
  {
    name: 'durable-checkpoint',
    flow: 'playground_durable_checkpoint',
    utterance: 'run playground durable checkpoint test',
    // `grant_required` is a real answer about a missing op grant, not a pass.
    branch: { tool: 'playground_durable_checkpoint', accept: ['done'] },
    note: 'the op-grant diagnostic, and the router’s defaultIntent',
  },
  {
    name: 'amazon-fixture',
    flow: 'playground_amazon_search',
    utterance: 'run playground Amazon durable search test',
    branch: { tool: 'playground_search_amazon_fixture', accept: ['done'] },
    note: 'fixed query "wireless trackball mouse"; real navigation to www.amazon.com',
  },
  {
    name: 'shopping-from-request',
    flow: 'shopping',
    utterance: '무선 트랙볼 마우스 찾아줘',
    branch: { tool: 'playground_search_shopping', accept: ['done'] },
    note: 'the query is trimmed out of requestText by pure Lua — no model call on the path',
  },
  {
    name: 'multi-site-two-stores',
    flow: 'playground_multi_site_search',
    utterance: 'wireless trackball mouse를 Amazon과 Walmart에서 찾아줘',
    // `partial` is a pass: a store behind a bot wall answered with a classified refusal, which is the result.
    // `empty` is not — nothing found across every store proves nothing about the fan-out.
    branch: { tool: 'shopping_search_sites', accept: ['done', 'partial'] },
    // The map-only subflow has no router route and a respond-less terminal, so the ONLY way to prove it ran is
    // its worker tool appearing in a parent turn's trace.
    expectTools: ['playground_search_worker'],
    note: 'flow.map fan-out, concurrency 1, two live storefronts',
  },
  {
    name: 'multi-site-korean-stores',
    flow: 'playground_multi_site_search',
    utterance: '쿠팡과 네이버 쇼핑에서 무선 마우스 찾아줘',
    branch: { tool: 'shopping_search_sites', accept: ['done', 'partial'] },
    expectTools: ['playground_search_worker'],
    note: 'the same fan-out against two stores that answer with access walls — a classified refusal is a pass',
  },
];

/** Every tool part of a turn, as `{ tool, status, next }`. `cdp.mjs` puts these at the part's top level. */
function traceOf(turn) {
  return (turn?.parts ?? [])
    .filter((part) => part?.type === 'tool')
    .map((part) => ({ tool: part.tool, status: part.status, next: part.output?.next, search_error: part.output?.search_error }));
}

/**
 * Whether a turn satisfies the scenario. A missing deciding tool is reported BY NAME because the router's
 * `defaultIntent` means an unmatched utterance still answers confidently — "no match" would send the next reader
 * looking for a broken selector instead of a route that never matched.
 */
export function judge(turn, scenario) {
  const text = typeof turn?.reply === 'string' ? turn.reply.trim() : '';
  if (text === '') return { ok: false, reason: 'no reply' };
  const trace = traceOf(turn);

  if (scenario.branch !== undefined) {
    const deciding = trace.filter((part) => part.tool === scenario.branch.tool).at(-1);
    if (deciding === undefined) {
      return { ok: false, reason: `${scenario.branch.tool} never ran — ${scenario.flow} was not the flow that answered` };
    }
    if (!scenario.branch.accept.includes(deciding.next)) {
      // A live store refusing is the store ANSWERING, and this sweep's own ordering provokes it: the Amazon
      // fixture searches Amazon ~15s before the shopping flow does, and the second of two consecutive searches
      // is sometimes refused. Isolated, shopping answered `done` with 19 candidates three runs running. The
      // classification set is IMPORTED from the commerce sweep, never restated — two statements of one rule
      // drift and the drift is invisible. `rpc_unavailable` is excluded there by design: our own op channel
      // failing is not a store answering, and accepting it would hide a real failure behind a green run.
      const classified = deciding.search_error;
      if (typeof classified === 'string' && recognizedAccessOutcomes.has(classified)) {
        return { ok: true, reason: `the store answered with ${classified}` };
      }
      return {
        ok: false,
        reason: `${scenario.branch.tool} answered next=${String(deciding.next)}`
          + (typeof classified === 'string' ? ` (${classified})` : ''),
      };
    }
  }

  if (scenario.expect !== undefined && !scenario.expect.test(text)) {
    return { ok: false, reason: 'the reply is not the exact line this flow’s terminal contracts to' };
  }

  const missing = (scenario.expectTools ?? []).filter((tool) => !trace.some((part) => part.tool === tool));
  if (missing.length > 0) return { ok: false, reason: `the trace never ran ${missing.join(', ')}` };

  return { ok: true, reason: scenario.branch ? `${scenario.branch.tool} answered next=${trace.filter((p) => p.tool === scenario.branch.tool).at(-1).next}` : 'matched the flow’s exact line' };
}

export function summarise(results) {
  const rows = Array.isArray(results) ? results : [];
  return {
    total: rows.length,
    passed: rows.filter((row) => row?.ok === true).length,
    failed: rows.filter((row) => row?.ok === false).length,
    skipped: rows.filter((row) => row?.skipped === true).length,
  };
}

/** `node tools/playground.mjs sync --root=dist/playground`, bounded — a misconfigured profile can block. */
async function syncBuiltWorkspace(timeoutMs) {
  const cli = fileURLToPath(new URL('tools/playground.mjs', repoRoot));
  const child = spawn(process.execPath, [cli, 'sync', `--root=${BUILT_ROOT}`, `--timeout=${timeoutMs}`],
    { cwd: fileURLToPath(repoRoot), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 60_000);
  const code = await new Promise((done) => child.on('close', done));
  clearTimeout(killer);
  return { code, output };
}

async function main() {
  const argv = process.argv.slice(2);
  const only = argv.find((item) => item.startsWith('--only='))?.slice('--only='.length);
  const skipSync = argv.includes('--no-sync');
  const timeoutMs = Number(argv.find((item) => item.startsWith('--timeout='))?.slice('--timeout='.length))
    || 180_000;

  const builtFlows = new URL(`${BUILT_ROOT}/_common/flows.yaml`, repoRoot);
  if (!existsSync(builtFlows)) {
    console.error(`FAIL  ${BUILT_ROOT}/_common/flows.yaml is missing — run \`npm run build:rpc\` first.`);
    process.exitCode = 1;
    return;
  }
  const unresolved = unresolvedModules(readFileSync(builtFlows, 'utf8'));
  if (unresolved.length > 0) {
    console.error(`FAIL  ${BUILT_ROOT} still names its modules (${unresolved.join(', ')}).`
      + ' Syncing it would answer RPC SEARCH EMPTY with a blank href — run `npm run build:rpc`.');
    process.exitCode = 1;
    return;
  }
  console.log(`PASS  sync root carries resolved modules — ${BUILT_ROOT}`);

  if (!skipSync) {
    const { code, output } = await syncBuiltWorkspace(timeoutMs);
    const receipt = /fromStore["\s:]+(\d+)[\s\S]*?fromRemote["\s:]+(\d+)[\s\S]*?fromLocal["\s:]+(\d+)/.exec(output);
    const ok = code === 0 && receipt !== null && Number(receipt[1]) > 0
      && Number(receipt[2]) === 0 && Number(receipt[3]) === 0;
    console.log(`${ok ? 'PASS' : 'FAIL'}  playground sync — exit=${code}`
      + (receipt ? ` fromStore=${receipt[1]} fromRemote=${receipt[2]} fromLocal=${receipt[3]}` : ' (no receipt)'));
    if (!ok) {
      console.error(output.split('\n').slice(-25).join('\n'));
      process.exitCode = 1;
      return;
    }
  }

  const harness = await import('../harness/cdp.mjs');
  const options = harness.resolveOptions({
    port: PLAYGROUND_PORT,
    profile: `${process.env.LOCALAPPDATA ?? ''}/AXSDKPlaygroundChromeProfile`,
  });
  // The session shape the playground CLI builds (`attachPlaygroundSession`): `sendMessage` and friends read
  // `session.page` and `session.options`, and `ensureChrome` answers `{ cdpUrl, launched }`, not a URL. Chrome
  // is already up because the sync above launched it, so `launch: false` keeps this runner from starting a
  // second one on the shared port.
  const { cdpUrl } = await harness.ensureChrome(options, { launch: false });
  const { page } = await harness.attachActive(cdpUrl, options, { allowBlank: true });
  const session = { page, options, cdpUrl };
  await harness.waitForLuaRuntime(page, options, 20_000);

  const wanted = only ? new Set(only.split(',').map((item) => item.trim())) : null;
  const results = [];
  for (const scenario of SCENARIOS) {
    if (wanted && !wanted.has(scenario.name)) { results.push({ ...scenario, skipped: true }); continue; }
    const startedAt = Date.now();
    let turn;
    try {
      turn = await harness.sendMessage(session, scenario.utterance, { timeoutMs });
    } catch (error) {
      results.push({ ...scenario, ok: false, reason: error.message, elapsedMs: Date.now() - startedAt });
      console.log(`FAIL  ${scenario.name} — ${error.message}`);
      continue;
    }
    // `judge` owns the whole verdict — branch, exact line and expected tools — so the loop only reports it.
    const verdict = judge(turn, scenario);
    const tools = (turn.parts ?? []).filter((part) => part?.type === 'tool')
      .map((part) => `${part.tool}${part.output?.next === undefined ? '' : `:${part.output.next}`}`);
    const { ok, reason } = verdict;
    results.push({ ...scenario, ok, reason, elapsedMs: Date.now() - startedAt, tools });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${scenario.name} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`
      + ` — ${reason}`);
    console.log(`      reply: ${String(turn.reply ?? '').replace(/\s+/g, ' ').slice(0, 160)}`);
    if (tools.length > 0) console.log(`      tools: ${tools.join('|')}`);
  }

  // Close the debugger WebSocket, or the runner FINISHES and never exits — measured: the first live run printed
  // `6/7 PASS` and then sat for 25 minutes. The playground CLI encodes this in `withPlaygroundSession`'s
  // `finally`; a runner that attaches by hand owes the same cleanup. Same class as the sweep that looked like it
  // hung after already answering.
  try { page?.close(); } catch { /* best-effort */ }

  const summary = summarise(results);
  console.log(`\nPLAYGROUND LIVE: ${summary.passed}/${summary.total - summary.skipped} PASS`
    + (summary.skipped > 0 ? ` (${summary.skipped} skipped)` : ''));
  if (summary.failed > 0) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  await main();
}
