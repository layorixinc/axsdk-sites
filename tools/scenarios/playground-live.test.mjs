import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseDocument } from 'yaml';

import { recognizedAccessOutcomes } from './commerce-all-sites.mjs';
import { SCENARIOS, judge, summarise, unresolvedModules } from './playground-live.mjs';

const authored = new URL('../../playground/_common/flows.yaml', import.meta.url);
const scenario = (flow) => SCENARIOS.find((item) => item.flow === flow);
const turn = (reply, tools = []) => ({
  reply,
  parts: tools.map(([tool, next, extra = {}]) => ({
    type: 'tool', tool, status: 'completed', output: { next, ...extra },
  })),
});

// The precondition nothing in the playground tooling checks. `loadWorkspace` reads flows.yaml verbatim, so
// syncing the AUTHORED root delivers a document whose `execute.modules` are still names — measured 25,533 B with
// 12 module-name lines against the built 230,618 B with none. AGENTS.md records what that looks like from the
// outside: `RPC SEARCH EMPTY` with a blank href in ~6s, which reads like a selector failure and is a delivery
// failure.
test('the authored workspace is refused as a sync root, the built one is not', () => {
  const unresolved = unresolvedModules(readFileSync(authored, 'utf8'));

  assert.ok(unresolved.length > 0, 'the authored document still names its modules');
  assert.ok(unresolved.includes('_common.19_rpc_playground_search'),
    `expected the search module among ${unresolved.join(', ')}`);
  assert.deepEqual(unresolvedModules('flows:\n  x:\n    nodes: {}\n'), [],
    'a document that names no module is ready to sync');
});

// Measured live and it cost a false failure: the `shopping` terminal's respond is an INSTRUCTION to the model
// ("Reply in the user's language"), so a Korean utterance answers `Amazon 검색이 완료되었습니다` while the flow
// took its `done` branch with real candidates. Prose is a rendering; the branch is the fact.
test('a model-rendered terminal is judged by the flow’s branch, not by its language', () => {
  const shopping = scenario('shopping');

  assert.equal(judge(turn('Amazon 검색이 완료되었습니다. 결과를 확인해 주세요.',
    [['playground_search_shopping', 'done']]), shopping).ok, true, 'Korean rendering of a done branch passes');
  assert.equal(judge(turn('Amazon search completed. Inspect the tool result.',
    [['playground_search_shopping', 'done']]), shopping).ok, true, 'and so does the English one');

  const failed = judge(turn('Amazon search did not complete. Check the tool’s rpc.allow.',
    [['playground_search_shopping', 'error']]), shopping);
  assert.equal(failed.ok, false, 'an error branch fails whatever language it is rendered in');
  assert.match(failed.reason, /error/i);
});

// The trap the flow inventory flagged: `defaultIntent: playground_durable_checkpoint`, so ANY unmatched utterance
// still gets a confident answer. A suite that accepted it would report six passing flows while five never ran.
test('an answer from the default intent fails a scenario that wanted another flow', () => {
  const fixture = judge(turn('RPC checkpoint passed: the declared op answered.',
    [['playground_durable_checkpoint', 'done']]), scenario('playground_amazon_search'));

  assert.equal(fixture.ok, false, 'the checkpoint flow’s tool is not the Amazon fixture’s');
  assert.match(fixture.reason, /playground_search_amazon_fixture/,
    'and the reason names the tool that never ran, not just "no match"');

  assert.equal(judge(turn('RPC checkpoint passed: the declared op answered.',
    [['playground_durable_checkpoint', 'done']]), scenario('playground_durable_checkpoint')).ok, true,
    'the same turn is the pass for the flow that owns it');
});

// Both edges of rpc_nav_only land on `done`, so its branch carries no health signal — the stage timings do, and
// its respond is "reply with exactly this line and nothing else".
test('a flow whose branches converge is judged by its exact line', () => {
  const nav = scenario('rpc_nav_only');
  const line = 'NAV href=391ms navigate=395ms wait=3721ms(moved=true) body=1043ms total=5550ms · href=https://search.11st.co.kr/';

  assert.equal(judge(turn(line, [['rpc_navigate_probe', 'done']]), nav).ok, true);
  assert.equal(judge(turn('이동을 완료했습니다.', [['rpc_navigate_probe', 'done']]), nav).ok, false,
    'a done branch is not enough when the contract is a fixed line');
});

test('a partial fan-out is a pass, an empty one is not', () => {
  const multi = scenario('playground_multi_site_search');
  const tools = (next) => [['shopping_search_sites', next], ['playground_search_worker', 'done']];

  assert.equal(judge(turn('일부 사이트 검색만 완료했습니다.', tools('partial')), multi).ok, true,
    'stores behind an access wall still answered — that is the classified result, not a failure');
  assert.equal(judge(turn('다중 사이트 검색을 완료했습니다.', tools('done')), multi).ok, true);
  assert.equal(judge(turn('검색 결과가 없습니다.', tools('empty')), multi).ok, false,
    'nothing found across every store is not proof the fan-out works');
});

test('the map-only subflow is proven by its worker in a parent turn', () => {
  const multi = scenario('playground_multi_site_search');
  const withoutWorker = judge(turn('다중 사이트 검색을 완료했습니다.',
    [['shopping_search_sites', 'done']]), multi);

  assert.equal(withoutWorker.ok, false, 'the parent branch alone does not prove the subflow ran');
  assert.match(withoutWorker.reason, /playground_search_worker/);
});

test('an empty or missing reply is a failure, never a pass', () => {
  for (const item of SCENARIOS) {
    assert.equal(judge(turn('', []), item).ok, false, `${item.name} must not pass on an empty reply`);
    assert.equal(judge({ parts: [] }, item).ok, false, `${item.name} must not pass on a missing reply`);
  }
});

// A turn whose branch is perfect and whose reply is empty is the case that makes the guard above load-bearing:
// the flow worked and the USER got nothing, which is a failure of the turn even though every tool succeeded.
// Without this the guard was redundant — every fixture failed for another reason first.
test('a flow that took the right branch and said nothing still fails', () => {
  const checkpoint = scenario('playground_durable_checkpoint');
  const good = turn('RPC checkpoint passed: the declared op answered.',
    [['playground_durable_checkpoint', 'done']]);
  assert.equal(judge(good, checkpoint).ok, true, 'the same turn with a reply passes');

  const silent = { ...good, reply: '   ' };
  const verdict = judge(silent, checkpoint);
  assert.equal(verdict.ok, false, 'a whitespace-only reply is no reply');
  assert.match(verdict.reason, /no reply/i);
});

// Coverage is derived from the document, not from a list kept beside it: a new router intent must either get a
// scenario or be declared unreachable by a user turn, which is the one case the inventory found
// (`playground_search_one_site` has no route and a respond-less terminal).
test('every user-routable playground flow has a scenario', () => {
  const document = parseDocument(readFileSync(authored, 'utf8')).toJS();
  const routed = new Set((document.router?.routes ?? []).map((route) => route.intent ?? route.flow));
  const covered = new Set(SCENARIOS.map((item) => item.flow));

  assert.deepEqual([...routed].filter((intent) => intent !== undefined && !covered.has(intent)), [],
    'router intents with no live scenario');
  assert.deepEqual([...covered].filter((flow) => !routed.has(flow)), [],
    'scenarios naming a flow the router cannot reach');
});

test('every scenario declares how it will be judged', () => {
  for (const item of SCENARIOS) {
    assert.ok(item.branch !== undefined || item.expect !== undefined,
      `${item.name} must name a branch or an exact line`);
    if (item.branch !== undefined) {
      assert.ok(Array.isArray(item.branch.accept) && item.branch.accept.length > 0,
        `${item.name} branch needs accepted values`);
      assert.equal(typeof item.branch.tool, 'string', `${item.name} branch needs the deciding tool`);
    }
  }
});

test('summarise counts pass, fail and skip without inventing a total', () => {
  const summary = summarise([{ ok: true }, { ok: false }, { ok: false }, { skipped: true }]);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 2);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.total, 4);
  assert.equal(summarise([]).total, 0, 'nothing run is nothing claimed');
});

// I made the same mistake here that the flow gates caught earlier in the document: a branch KEY is not a node
// name. `rpc_probe.read` routes `{ok: done, error: failed}`, so its deciding tool answers `next="ok"` and the
// live sweep called a perfect `RPC OK · heading=…` reply a failure because the scenario accepted "done" — the
// TARGET node's name. Derived from the document so it cannot be guessed wrong again.
test('every accepted branch is a real branch key of the node that decides it', () => {
  const document = parseDocument(readFileSync(authored, 'utf8')).toJS();
  const wrong = [];
  for (const item of SCENARIOS) {
    if (item.branch === undefined) continue;
    const nodes = document.flows?.[item.flow]?.nodes ?? {};
    const deciding = Object.entries(nodes)
      .find(([, node]) => (node?.id ?? (node?.allowedTools ?? [])[0]) === item.branch.tool);
    assert.ok(deciding !== undefined,
      `${item.name}: no node in ${item.flow} runs ${item.branch.tool}`);
    const keys = Object.keys(deciding[1].next ?? {});
    for (const accepted of item.branch.accept) {
      if (!keys.includes(accepted)) wrong.push(`${item.name}: ${accepted} is not a branch of ${deciding[0]} (${keys.join('|')})`);
    }
  }
  assert.deepEqual(wrong, [], 'scenarios accepting something the node does not route');
});

// A live store refusing is the store ANSWERING, and the sweep's own ordering provokes it: the Amazon fixture
// searches Amazon ~15s before the shopping flow does, and the second of two consecutive searches is sometimes
// refused. Isolated, shopping answered `done` with 19 candidates three runs in a row. So a CLASSIFIED wall is a
// pass — and the classification set is imported from the commerce sweep rather than written a second time, since
// two statements of one rule drift and the drift is invisible.
//
// `rpc_unavailable` is the exception §13 names: our own op channel failing is not a store answering, and
// accepting it would hide a real failure behind a green run.
test('a classified access wall passes, an unclassified failure and rpc_unavailable do not', () => {
  const shopping = scenario('shopping');
  const refused = (code) => turn('Amazon 검색을 완료하지 못했습니다.',
    [['playground_search_shopping', 'error', { search_error: code }]]);

  for (const code of recognizedAccessOutcomes) {
    const verdict = judge(refused(code), shopping);
    assert.equal(verdict.ok, true, `${code} is the store answering: ${verdict.reason}`);
    assert.match(verdict.reason, new RegExp(code));
  }

  assert.equal(judge(refused('rpc_unavailable'), shopping).ok, false,
    'our op channel failing is not the store answering');
  assert.equal(judge(refused('navigation_stuck'), shopping).ok, false,
    'an unclassified failure stays a failure');
  assert.equal(judge(turn('Amazon 검색을 완료하지 못했습니다.',
    [['playground_search_shopping', 'error']]), shopping).ok, false,
    'an error with no classification at all is a failure');
});
