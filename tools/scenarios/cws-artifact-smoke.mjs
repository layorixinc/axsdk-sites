import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildRpcFlows, repoRoot } from '../build-rpc-flows.mjs';
import { buildCwsRelease } from '../build-cws-release.mjs';
import { packageHash } from '../rpc-package.mjs';
import { detectRawScaffolding, openCdpSession } from '../harness/cdp-session.mjs';
import { collectStoreResults, decode, isNormalizedCandidates } from './commerce-all-sites.mjs';
import { findToolCall, lastToolOutput } from './multi-store-total-cost.mjs';
import { checkoutRunsNoOrder } from './shopping.mjs';

const MUTATION_TOOLS = new Set([
  'shopping_add_selected_store_offer',
  'shopping_add_to_cart',
  'shopping_checkout_review',
  'shopping_do_checkout',
]);

function toolName(call) {
  const name = String(call?.name ?? '');
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
}

const turnEvidence = (turn) => ({
  text: String(turn?.text ?? '').slice(0, 500),
  tools: (turn?.toolCalls ?? []).map((call) => {
    const output = decode(call?.output);
    return {
      name: call?.name,
      status: call?.status,
      next: output?.next,
      cart_status: output?.cart_status,
      cart_confirmation: output?.cart_confirmation,
      comparison_id: output?.comparison_id,
      output: typeof output === 'string' ? output.slice(0, 500) : undefined,
      localState: call?.debug?.localState,
      error: output?.error,
    };
  }),
});


/** Tools that only exist for a surface the store profile removes. Reaching one means the wrong package. */
const OUTSIDE_PURPOSE_TOOLS = new Set([
  'search_service', 'open_quote', 'submit_quote', 'browse_service_candidates', 'present_service_results',
  'collect_quote_service', 'collect_quote_contact', 'finish_quote_request', 'recall_saved_contact',
  'plan_memory', 'set_memory', 'get_memory', 'search_memory', 'list_memory', 'delete_memory',
  'capture_memory_clause', 'write_captured_memory', 'present_memory_result',
]);

export function artifactSmokeVerdict({
  workspaceStores, scriptIds, toolCalls, text, cancelToolCalls, cancelText, refinedComparison,
  guardedSelection, checkoutStep, outsideSurface, expectedSites = ['amazon', 'walmart'],
}) {
  const failures = [];
  if (workspaceStores !== 'unchanged') failures.push('harness wrote workspace stores');
  const scripts = new Set(scriptIds ?? []);
  if (!scripts.has('packaged-lua:')) failures.push('common package Lua is not active');
  if ([...scripts].some((id) => id.startsWith('stored-lua:'))) {
    failures.push('legacy persisted Lua source is active');
  }
  const mutation = [...(toolCalls ?? []), ...(cancelToolCalls ?? [])]
    .find((call) => MUTATION_TOOLS.has(toolName(call)));
  const pausedComparison = (toolCalls ?? []).some((call) =>
    ['present_store_offers', 'shopping_present_store_offers'].includes(toolName(call))
    && decode(call?.output)?.next === 'ask');
  if (!pausedComparison) failures.push('comparison window was not paused for a user choice');
  if (mutation) failures.push(`mutation tool ran: ${mutation.name}`);
  if (typeof text !== 'string' || text.trim() === '') failures.push('assistant reply is empty');
  for (const [label, reply] of [
    ['comparison', text], ['cancel', cancelText], ['refusal', outsideSurface?.text],
    ['cart', guardedSelection?.text], ['checkout', checkoutStep?.text], ['refined', refinedComparison?.text],
  ]) {
    if (typeof reply === 'string' && detectRawScaffolding(reply)) {
      failures.push(`the ${label} reply carries raw model scaffolding`);
    }
  }
  if (typeof cancelText !== 'string' || cancelText.trim() === '') failures.push('cancel reply is empty');
  const cancelled = (cancelToolCalls ?? []).some((call) => decode(call?.output)?.next === 'cancel');
  if (!cancelled) failures.push('cancel branch was not observed');
  const selectedCalls = guardedSelection?.toolCalls ?? [];
  const addOutput = lastToolOutput(selectedCalls, 'shopping_add_selected_store_offer');
  if (guardedSelection?.err
    || !findToolCall(selectedCalls, 'shopping_resolve_store_offer')
    || addOutput?.cart_status !== 'added'
    || typeof addOutput?.cart_confirmation !== 'string'
    || addOutput.cart_confirmation.trim() === '') {
    failures.push('guarded cart add lacks site confirmation');
  }
  if (!checkoutRunsNoOrder(checkoutStep ?? {})) failures.push('checkout did not prove that no order was placed');
  const refinedCalls = refinedComparison?.toolCalls ?? [];
  const refineOutput = refinedCalls
    .map((call) => ({ call, output: decode(call?.output) }))
    .find(({ call }) => toolName(call) === 'shopping_refine_store_offers')?.output;
  const refinedPresenter = refinedCalls
    .map((call) => ({ call, output: decode(call?.output) }))
    .findLast(({ call }) => toolName(call) === 'present_store_offers')?.output;
  const initialPresenter = (toolCalls ?? [])
    .map((call) => ({ call, output: decode(call?.output) }))
    .find(({ call }) => toolName(call) === 'present_store_offers')?.output;
  const refinedText = String(refinedComparison?.text ?? '');
  const initialHasOtherOffer = /\[(?!amazon\])[^[]+\]/i.test(String(text ?? ''));
  if (refinedComparison?.err
    || !refineOutput
    || refinedPresenter?.next !== 'ask'
    || refinedText === ''
    || !/\[amazon\]/i.test(refinedText)
    || /\[(?!amazon\])[^[]+\]/i.test(refinedText)
    || !refinedPresenter?.comparison_id
    || (initialHasOtherOffer && refinedPresenter.comparison_id === initialPresenter?.comparison_id)) {
    failures.push('refined comparison was not persisted and presented as an Amazon-only window');
  }

  const outcomes = collectStoreResults(toolCalls);
  for (const site of expectedSites) {
    const outcome = outcomes.get(site);
    if (!outcome) {
      failures.push(`${site} has no compact store outcome`);
      continue;
    }
    if (outcome.status === 'candidates') {
      if (!isNormalizedCandidates(site, outcome.candidates)) failures.push(`${site} sample is not normalized`);
    } else if (!['no_results', 'price_unavailable', 'access_denied', 'captcha_required', 'login_required'].includes(outcome.status ?? outcome.error)) {
      failures.push(`${site} outcome is not classified: ${outcome.status ?? outcome.error ?? '-'}`);
    }
  }
  if (![...outcomes.values()].some((outcome) => outcome.status === 'candidates')) {
    failures.push('the archive produced no comparable candidate');
  }

  // The store profile is only ever true of what SHIPS (`store/single-purpose.md`), so the artifact is
  // asked directly: a request for a removed surface must be ANSWERED and must reach none of its tools. A
  // run that never asked cannot claim it.
  if (outsideSurface === undefined) {
    failures.push('the run never asked whether a surface outside the single purpose is refused');
  } else {
    const reached = (outsideSurface.toolCalls ?? []).map((call) => toolName(call))
      .filter((name) => OUTSIDE_PURPOSE_TOOLS.has(name));
    if (reached.length > 0) {
      failures.push(`outside the single purpose: the package still reached ${reached.join(', ')}`);
    }
    if (typeof outsideSurface.text !== 'string' || outsideSurface.text.trim() === '') {
      failures.push('the refusal turn answered nothing');
    }
  }
  return { ok: failures.length === 0, failures };
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : undefined;
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!Number.isInteger(port)) throw new Error('could not reserve a Chrome debugger port');
  return port;
}

async function waitForChromeExit(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(250) });
    } catch {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`artifact-smoke Chrome on ${port} did not exit`);
}

/**
 * One named step of the live run.
 *
 * Six turns with 1,560 seconds of timeouts between them used to print nothing until the run was over, so
 * a hang left no evidence at all — the same failure shape the commerce sweep fixed by naming stages. A
 * start line with no end line IS the diagnosis, which is why both are printed rather than only the end.
 */
export async function stage(name, run, { log = (line) => console.log(line) } = {}) {
  log(`→ ${name}`);
  const started = Date.now();
  try {
    const value = await run();
    log(`✓ ${name} ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return value;
  } catch (error) {
    log(`✗ ${name} ${((Date.now() - started) / 1000).toFixed(1)}s`);
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export async function runArtifactSmoke() {
  const temp = await mkdtemp(join(tmpdir(), 'axsdk-cws-artifact-smoke-'));
  const archivePath = join(temp, 'candidate.zip');
  const extracted = join(temp, 'extension');
  const profileRoot = join(temp, 'profiles');
  const distDir = resolve(repoRoot, '..', 'axsdk-sdk-js', 'packages', 'axsdk-extension-cdp', 'dist');
  const archiveModulePath = resolve(repoRoot, '..', 'axsdk-sdk-js', 'packages', 'axsdk-extension-cdp', 'scripts', 'cws-archive.mjs');
  const archiveApi = await import(pathToFileURL(archiveModulePath).href);
  const built = buildRpcFlows({ root: repoRoot, delivery: 'registry' });
  const moduleSources = built.__report.moduleSources;
  const backend = {
    appId: 'local-artifact-smoke',
    revision: 0,
    hash: {
      luaModules: Object.fromEntries(
        Object.entries(moduleSources).map(([name, source]) => [name, packageHash(source)]),
      ),
    },
  };
  const previousProfileRoot = process.env.AXSDK_PROFILE_ROOT;
  const port = await availablePort();
  let session;
  try {
    const release = await stage('build the candidate archive', () => buildCwsRelease({ distDir, archivePath, backend, archiveApi }));
    await stage('extract it', () => archiveApi.extractCwsArchive({ archivePath, outDir: extracted }));
    process.env.AXSDK_PROFILE_ROOT = profileRoot;
    session = await stage('install it in a fresh profile and open a session', () => openCdpSession({
      workspace: repoRoot,
      extensionDir: extracted,
      provision: 'config-only',
      reuse: false,
      port,
      url: 'https://www.amazon.com/',
    }));
    const runningRelease = await stage('read the running release id', () => session.releaseInfo());
    if (runningRelease?.releaseId !== release.manifest.releaseId) {
      throw new Error(
        `running release mismatch: archive ${release.manifest.releaseId}, runtime ${runningRelease?.releaseId ?? '-'}`,
      );
    }
    const packageStatus = await stage('read the loaded scripts', () => session.status());
    await stage('start a clean conversation', () => session.reset());
    const requestText = 'Compare the Logitech M185 wireless mouse total cost at Amazon and eBay';
    const turn = await stage('compare amazon and ebay', () => session.send(requestText, { timeoutMs: 360_000 }));
    const cancelled = await stage('cancel the paused window', () => session.send('취소', { timeoutMs: 120_000 }));

    await stage('start a second clean conversation', () => session.reset());
    await stage('open amazon again', () => session.open('https://www.amazon.com/'));
    const guardedComparison = await stage('compare again, for the cart path', () => session.send(requestText, { timeoutMs: 360_000 }));
    const refinedTurn = await stage('refine to amazon only', () => session.send('amazon만 보여줘', { timeoutMs: 120_000 }));
    const refinedComparison = { err: null, text: refinedTurn.text, toolCalls: refinedTurn.toolCalls };
    const selectedTurn = await stage('select offer 1 and add it to the cart', () => session.send('1번', { timeoutMs: 300_000 }));
    const guardedSelection = { err: null, text: selectedTurn.text, toolCalls: selectedTurn.toolCalls };
    const checkoutTurn = await stage('review checkout without ordering', () => session.send('체크아웃 해줘', { timeoutMs: 300_000 }));
    const checkoutStep = { err: null, text: checkoutTurn.text, toolCalls: checkoutTurn.toolCalls };
    const status = await stage('read the scripts once more', () => session.status());
    // The store profile is a claim about what SHIPS, so the artifact is asked directly. A fresh
    // conversation first: a paused window would read the next message as a selection.
    await stage('start a third clean conversation', () => session.reset());
    const outsideTurn = await stage('ask for a surface outside the single purpose',
      () => session.send('샌프란시스코 청소 견적 받아줘', { timeoutMs: 180_000 }));
    const outsideSurface = { text: outsideTurn.text, toolCalls: outsideTurn.toolCalls };
    const verdict = artifactSmokeVerdict({
      workspaceStores: session.workspace.stores,
      scriptIds: packageStatus.scriptIds,
      toolCalls: turn.toolCalls,
      text: turn.text,
      cancelToolCalls: cancelled.toolCalls,
      cancelText: cancelled.text,
      guardedSelection,
      refinedComparison,
      expectedSites: ['amazon', 'ebay'],
      checkoutStep,
      outsideSurface,
    });
    if (!verdict.ok) {
      throw new Error(
        `CWS artifact smoke failed: ${verdict.failures.join('; ')}\n`
        + JSON.stringify({
          comparison: turnEvidence(turn),
          cancel: turnEvidence(cancelled),
          guardedComparison: turnEvidence(guardedComparison),
          refinement: turnEvidence(refinedTurn),
          selection: turnEvidence(selectedTurn),
          packageStatus,
          checkout: turnEvidence(checkoutTurn),
        }),
      );
    }
    return {
      releaseId: release.manifest.releaseId,
      archiveDigest: release.archive.digest,
      archiveSize: release.archive.size,
      entries: release.archive.entries.length,
      moduleCount: release.manifest.runtime.moduleCount,
      runningRelease,
      workspaceStores: session.workspace.stores,
      scriptIds: packageStatus.scriptIds,
      finalScriptIds: status.scriptIds,
      outcomes: Object.fromEntries([...collectStoreResults(turn.toolCalls)].map(([site, outcome]) => [site, outcome.status ?? outcome.error])),
    refusal: String(outsideSurface.text ?? '').replace(/\s+/g, ' ').slice(0, 120),
      elapsedMs: turn.elapsedMs,
      cancelElapsedMs: cancelled.elapsedMs,
      refineElapsedMs: refinedTurn.elapsedMs,
      guardedElapsedMs: selectedTurn.elapsedMs,
      checkoutElapsedMs: checkoutTurn.elapsedMs,
    };
  } finally {
    if (session) {
      await session.shutdown().catch(() => {});
    }
    // Nothing to reap by hand: `openCdpSession` kills a dedicated browser it launched when the open
    // fails (a temporary profile is nobody's to reuse). The previous version launched Chrome again in
    // order to close it and hung there, which is how two runs never printed their failure at all.
    // Cleanup must not replace the failure that brought us here. A browser that will not confirm its exit
    // is worth reporting; it is not worth losing the diagnosis for, and this masked one for a whole run.
    await waitForChromeExit(port).catch((error) => {
      console.error(`WARN ${error instanceof Error ? error.message : String(error)}`);
    });
    if (previousProfileRoot === undefined) delete process.env.AXSDK_PROFILE_ROOT;
    else process.env.AXSDK_PROFILE_ROOT = previousProfileRoot;
    await rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch((error) => {
      console.error(`WARN could not remove ${temp}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

function dirnameOf(path) {
  return path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  // A dedicated temporary browser that will not confirm its exit keeps node's event loop alive, and the
  // failure then never reaches the terminal — one run spent 50 minutes proving that. So the report is
  // printed here and the process leaves rather than waiting for a handle it already gave up on.
  try {
    const result = await runArtifactSmoke();
    console.log(`CWS ARTIFACT SMOKE PASS ${result.releaseId}`);
    console.log(`  archive ${result.archiveDigest} ${(result.archiveSize / 1024 / 1024).toFixed(2)} MiB · ${result.entries} entries`);
    console.log(`  modules ${result.moduleCount} · stores ${result.workspaceStores} · ${result.scriptIds.join(',')}`);
    console.log(`  outcomes ${Object.entries(result.outcomes).map(([site, status]) => `${site}:${status}`).join(', ')}`);
    console.log(`  compare ${(result.elapsedMs / 1000).toFixed(1)}s · refine ${(result.refineElapsedMs / 1000).toFixed(1)}s · cancel ${(result.cancelElapsedMs / 1000).toFixed(1)}s · no mutation`);
    console.log(`  cart ${(result.guardedElapsedMs / 1000).toFixed(1)}s · checkout ${(result.checkoutElapsedMs / 1000).toFixed(1)}s · no order`);
  // What the shipped package answers when asked for a surface the single purpose does not carry: the
  // §1 claim is only as good as this sentence, so every run records it.
  console.log(`  refused "${result.refusal}"`);
    process.exit(0);
  } catch (error) {
    console.error(`CWS ARTIFACT SMOKE FAIL ${error instanceof Error ? error.message : String(error)}`);
    for (let cause = error?.cause, depth = 0; cause !== undefined && depth < 4; cause = cause?.cause, depth += 1) {
      console.error(`  caused by ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}`);
    }
    process.exit(1);
  }
}
