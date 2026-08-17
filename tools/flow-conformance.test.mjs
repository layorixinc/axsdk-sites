import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

import { buildRpcFlows } from './build-rpc-flows.mjs';
import { auditRpcAllow } from './rpc-allow.mjs';
import { buildSchema } from './build-schema.mjs';
import { deadLua } from './dead-lua.mjs';

const root = new URL('../', import.meta.url);

function read(path) {
  return readFileSync(new URL(path, root), 'utf8');
}

function parseFlow(path) {
  const document = parseDocument(read(path), { prettyErrors: true, strict: true });
  assert.deepEqual(document.errors, [], `${path} must be valid YAML`);
  return document.toJS();
}

function assertMutation(tool, name) {
  assert.ok(tool, `${name} must exist`);
  assert.equal(tool.effect, 'mutation', `${name}.effect`);
  assert.equal(tool.consent, 'required', `${name}.consent`);
  assert.equal(tool.idempotent, true, `${name}.idempotent`);
  assert.ok(tool.require && Object.keys(tool.require).length > 0, `${name}.require must be non-empty`);
}

function mutationIssue(adapter) {
  if (adapter.effect !== 'mutation') return 'mutation.effect.required';
  if (adapter.consent !== 'required') return 'mutation.consent.required';
  if (adapter.idempotent !== true) return 'mutation.idempotent.required';
  if (!adapter.require || Object.keys(adapter.require).length === 0) return 'mutation.require.nonempty';
  return null;
}

test('all production flow layers parse under flow document contract v1', () => {
  const common = parseFlow('_common/flows.yaml');
  const bluemoonsoft = parseFlow('bluemoonsoft/flows.yaml');
  const thumbtack = parseFlow('thumbtack/flows.yaml');

  assert.equal(common.extends, 'app');
  assert.equal(common.defaults?.mapping, 'legacy');
  assert.equal(bluemoonsoft.extends, 'app');
  assert.equal(thumbtack.extends, 'app');
});

test('production mutations use the current mutation contract', () => {
  const common = parseFlow('_common/flows.yaml');
  assertMutation(common.flowTools?.set_memory, 'set_memory');
  assertMutation(common.flowTools?.delete_memory, 'delete_memory');
  assertMutation(common.flowTools?.shopping_add_to_cart, 'shopping_add_to_cart');
  assertMutation(common.flowTools?.shopping_add_selected_store_offer, 'shopping_add_selected_store_offer');
  assert.deepEqual(common.flowTools.shopping_add_selected_store_offer.require, {
    cart_approval: 'user_selected_compared_offer',
    identity_approval: 'locked_product_identity',
    comparison_approval: 'current_comparison',
  });
  assertMutation(common.flowTools?.submit_quote, 'submit_quote');
});

test('thumbtack shortlisting ranks from site data, never from the model', () => {
  // The refinement loop is deterministic end to end. With a model node inside it, the same criterion was
  // re-sent on every pass (four rounds in one live turn) because the model kept seeing the user's
  // unchanged message; the browser now reads the reply itself and pauses on the rendered window.
  const commonFlow = parseFlow('_common/flows.yaml');
  const quote = commonFlow.flows.request_service_quote;
  assert.equal(quote.nodes.present_results.next.refine, 'browse_candidates');
  assert.equal(quote.nodes.browse_candidates.kind, 'action_contract');
  assert.equal(quote.nodes.browse_candidates.next.ask, 'browse_candidates', 'the browser must pause on its own window');
  assert.equal(quote.nodes.browse_candidates.next.done, 'prepare_refined_table');
  assert.equal(quote.nodes.browse_candidates.next.cancel, 'all_done');
  assert.ok(quote.nodes.browse_candidates.inputSelector.includes('requestText'));
  assert.equal(quote.nodes.refine_search, undefined, 'the model node in the refinement loop is gone');
  assert.equal(commonFlow.flowTools.refine_candidates, undefined);
  assert.equal(quote.nodes.confirm_quote.next.refine, 'browse_candidates');
  assert.equal(quote.nodes.quotes_done.next.more, 'browse_candidates');
  // Projection moved: a runtime tool receives the flow-state fields its PARAMETERS declare, and an
  // `input:` block on one is a compile error. The script reads `requestText` under its own name.
  assert.ok(
    commonFlow.flowTools.browse_service_candidates.parameters.properties.requestText,
    'the shortlist must be able to read the reply the user just typed',
  );
  assert.equal(commonFlow.flowTools.browse_service_candidates.output.question, 'result.question');
  // Live: a window sorted by reviews was shown, the user picked 1 and 2, and the selection resolved
  // against the DEFAULT ranking because the criterion had been cleared — they got #4 and #5.
  assert.equal(commonFlow.flowTools.browse_service_candidates.output.refine_request, 'result.refine_request',
    'the active criterion must survive the turn that renders it');
  assert.notEqual(commonFlow.flowTools.browse_service_candidates.output.view_page, null);

  const common = parseFlow('_common/flows.yaml');
  const flow = common.flows?.request_service_quote;
  const nodes = flow.nodes;

  // The searched pool must not reach a model node in the refinement or approval path. (`quotes_done`
  // does select `candidates`, but by then `select_pros` has replaced it with the approved shortlist.)
  assert.ok(!(nodes.confirm_quote.inputSelector || []).includes('candidates'),
    'the approval gate must not receive the searched pro list');
  assert.equal(nodes.select_pros.next.pick, 'pick_quote');
  // The shortlist ranks in the runtime now; what matters is still that it ranks deterministically and
  // that no model node sits inside the loop.
  assert.equal(common.flowTools.browse_service_candidates.execute.implementation, 'lua');
  assert.ok(!common.flowTools.browse_service_candidates.execute.rpc, 'ranking needs no browser op');
  assert.equal(common.flowTools.browse_service_candidates.output.refine_selected, 'result.refine_selected');
  assert.equal(common.flowTools.browse_service_candidates.output.shortlist_text, 'result.shortlist_text');
  for (const key of ['shortlist_text', 'view_page', 'view_pages', 'view_total', 'choice_numbers']) {
    assert.ok(Object.hasOwn(flow.state, key), `quote flow state must include ${key}`);
  }
});

test('multi-store shopping discovers and locks product identity before ranking', () => {
  const common = parseFlow('_common/flows.yaml');
  const flow = common.flows?.shopping_multi_store_total_cost;
  assert.ok(flow, 'shopping_multi_store_total_cost must exist');
  const nodes = flow.nodes;

  assert.equal(nodes.collect_request.next.done, 'prepare_identity');
  assert.equal(nodes.prepare_identity.id, 'shopping_prepare_product_identity');
  assert.equal(nodes.prepare_identity.next.discover, 'discover_products');
  assert.equal(nodes.prepare_identity.next.lock, 'lock_requested_identity');
  assert.equal(nodes.discover_products.id, 'shopping_discover_products');
  assert.equal(nodes.discover_products.next.done, 'build_product_options');
  assert.equal(nodes.build_product_options.id, 'shopping_build_product_options');
  assert.equal(nodes.build_product_options.next.choose, 'choose_product');
  assert.deepEqual(nodes.choose_product.allowedTools, ['choose_product_identity']);
  assert.equal(nodes.choose_product.next.select, 'resolve_product');
  assert.equal(nodes.resolve_product.id, 'shopping_resolve_product_option');
  assert.equal(nodes.resolve_product.next.lock, 'search_stores');
  assert.equal(nodes.choose_product.messagePolicy?.currentUserText, 'active_node_only');
  // Search feeds a two-stage relevance decision before anything is verified or ranked: the deterministic
  // recall list, one model verdict on it, then the cap. Every hop is enforced because a missing one would
  // silently restore token-only filtering (accessories in the comparison) or drop the fail-open path.
  assert.equal(nodes.search_stores.next.done, 'screen_offers');
  assert.equal(nodes.search_stores.next.partial, 'screen_offers');
  assert.equal(nodes.screen_offers.id, 'shopping_build_offer_screening');
  assert.equal(nodes.screen_offers.next.judge, 'judge_relevance');
  assert.equal(nodes.screen_offers.next.empty, 'no_results');
  assert.deepEqual(nodes.judge_relevance.allowedTools, ['screen_store_offers']);
  assert.equal(nodes.judge_relevance.next.done, 'apply_screening');
  assert.equal(nodes.apply_screening.id, 'shopping_apply_offer_screening');
  assert.equal(nodes.apply_screening.next.done, 'verify_offers');
  assert.equal(nodes.apply_screening.next.empty, 'no_results');
  // Precision is worth one model call; it is never worth the whole turn. Every way the judgement can go
  // wrong (stall, invalid answer, tool error) lands on apply_screening, which keeps every row.
  for (const exit of ['stalledNext', 'invalidNext', 'exhaustedNext']) {
    assert.equal(nodes.judge_relevance.fallback[exit], 'error', `${exit} must take the error branch`);
  }
  assert.equal(nodes.judge_relevance.next.error, 'apply_screening', 'the error branch keeps every row');
  assert.ok(!nodes.judge_relevance.inputSelector.includes('store_results'), 'only the rendered list may enter the prompt');
  assert.ok(nodes.judge_relevance.inputSelector.includes('screening_text'));
  assert.match(nodes.judge_relevance.prompt, /accessory/i);
  assert.match(nodes.judge_relevance.prompt, /never invent a row/i);
  // The verdict must land on the key apply reads: a passthrough that wrote `keep` made every row survive
  // while the model had rejected two of them, and the fail-open path made it look intentional.
  assert.equal(common.flowTools.screen_store_offers.output.screening_keep, 'tool.args.keep');
  assert.ok(
    common.flowTools.shopping_apply_offer_screening.parameters.properties.screening_keep,
    'the screening decision must be declared, or it is dropped before the script sees it',
  );
  assert.equal(common.flowTools.shopping_apply_offer_screening.output.screened_out, 'result.screened_out');
  assert.ok(nodes.normalize_rank.inputSelector.includes('screened_out'), 'the window must be able to say what was removed');
  // Selecting a key is not passing it: every one of these tools declares additionalProperties:false, so a
  // key missing from properties is dropped silently at the boundary and the window loses the sentence.
  assert.ok(common.flowTools.shopping_rank_store_offers.parameters.properties.screened_out);
  assert.ok(common.flowTools.shopping_rank_store_offers.parameters.properties.screened_out, 'screened_out must be declared to reach the script');
  assert.equal(nodes.verify_offers.id, 'shopping_verify_product_offers');
  assert.equal(nodes.verify_offers.next.done, 'normalize_rank');
  // The search used to branch `navigating` into a re-invoke node. A runtime script keeps its stack
  // across the reload, so the only remaining branches are the answer and the not-yet-ported site.
  assert.ok(!common.flows.shopping_search_one_store.nodes.search.next.unsupported_site,
    'every store is ported; nothing should still route to a durable reader');
  assert.equal(common.flows.shopping_search_one_store.nodes.search.next.done, 'normalize');
  // Ranking hands to the deterministic presenter, which renders the window, pauses on it, and reads the
  // answer. There is no model node in the loop: one that sat here re-sent the previous turn's "3번" when
  // the user typed "취소", and the offer went into a real cart.
  assert.equal(nodes.normalize_rank.next.done, 'present_offers');
  assert.equal(nodes.present_offers.next.ask, 'present_offers');
  assert.equal(nodes.present_offers.next.select, 'resolve_offer');
  for (const dead of ['offers', 'ambiguous_offers', 'excluded_offers', 'comparison_text']) {
    assert.ok(!nodes.present_offers.inputSelector.includes(dead), `${dead} must not ride into the presenter`);
  }
  // The last three durable tools are runtime now. What made them the last: the listing built in one turn
  // has to be paged in the next, and `state: session` is keyed by (session, TOOL), so `rank` had no
  // channel to `present`. Flow state is that channel, carrying one scalar no model node selects.
  assert.equal(common.flowTools.present_store_offers.execute.kind, 'runtime');
  assert.ok(
    common.flowTools.present_store_offers.parameters.properties.comparison_state,
    'the snapshot must be a declared property; undeclared state is dropped before the script sees it',
  );
  assert.equal(common.flowTools.present_store_offers.output.question, 'result.question');
  assert.equal(common.flowTools.shopping_present_store_offers, undefined);
  // The model-facing gate tool went with the node it served; leaving it declared invites a re-wire.
  assert.equal(common.flowTools.choose_store_offer, undefined);

  // Paging and refinement travel as presenter branches into one deterministic node, so no extra tool can
  // reach the approval turn and no offer payload is injected into any prompt.
  assert.equal(nodes.present_offers.next.page, 'browse_offers');
  assert.equal(nodes.present_offers.next.refine, 'browse_offers');
  assert.equal(nodes.browse_offers.id, 'shopping_refine_store_offers');
  assert.equal(nodes.browse_offers.next.ask, 'present_offers');
  assert.equal(nodes.browse_offers.next.research, 'collect_request');
  assert.ok(nodes.browse_offers.inputSelector.includes('comparison_state'),
    'the deterministic browsing node reads the listing from the snapshot, which is the only channel it travels on');
  // `offers`/`all_offers` were the second channel. No node selects them any more, so publishing them
  // writes state nothing reads — and a field that looks live is one someone wires a tool to next.
  for (const tool of ['shopping_rank_store_offers', 'shopping_refine_store_offers']) {
    for (const dead of ['offers', 'all_offers']) {
      assert.equal(common.flowTools[tool].output[dead], undefined, `${tool} still publishes ${dead}`);
    }
  }
  assert.equal(common.flowTools.shopping_refine_store_offers.execute.kind, 'runtime');
  assert.equal(
    common.flowTools.shopping_refine_store_offers.output.comparison_state, 'result.comparison_state',
    'a reissued listing must be written back, or the next turn pages the one before it',
  );
  assert.equal(common.flowTools.shopping_refine_store_offers.output.question, 'result.question');
  assert.equal(common.flowTools.shopping_refine_store_offers.output.comparison_id, 'result.comparison_id');
  // A browsing turn must reopen the presentation gate, otherwise the next approval turn would accept a
  // number against a window the user never saw.
  assert.equal(common.flowTools.shopping_refine_store_offers.output.choice_stage, null);
  for (const key of ['view_page', 'view_pages', 'view_total']) {
    assert.ok(Object.hasOwn(flow.state, key), `flow state must include ${key}`);
  }
  // The hop chain and the durable pair are both gone: every storefront reads in the runtime.
  assert.ok(!common.flows.shopping_search_one_store.nodes.search_bespoke);
  assert.ok(!common.flowTools.shopping_search_one_store_durable);
  // The durable re-entry chain is gone too. `open_selected_store → add → add_after_navigation →
  // confirm_after_navigation` existed only because each navigation destroyed the call; one runtime call
  // navigates, revalidates, adds and confirms.
  assert.equal(nodes.add_selected_offer.next.done, 'report_cart');
  assert.ok(!nodes.add_selected_offer.next.navigating, 'no navigating branch remains');
  assert.ok(!nodes.add_selected_offer_after_navigation);
  assert.ok(!nodes.confirm_selected_offer_after_navigation);
  assert.equal(common.flowTools.shopping_search_one_store.output.next, 'result.next');

  assert.equal(common.flows.shopping_search_one_store.nodes.normalize.id, 'shopping_normalize_store_result');
  // A store search reads up to its page budget: normalize hands each page to the collector, which either
  // asks for one more page or completes the worker. Collapsing this back to normalize -> complete would
  // silently cap every store at its first result page again.
  assert.equal(common.flows.shopping_search_one_store.nodes.normalize.next.done, 'collect');
  assert.equal(common.flows.shopping_search_one_store.nodes.collect.id, 'shopping_collect_store_page');
  assert.equal(common.flows.shopping_search_one_store.nodes.collect.next.more, 'search_next_page');
  assert.equal(common.flows.shopping_search_one_store.nodes.collect.next.done, 'complete');
  assert.equal(common.flows.shopping_search_one_store.nodes.search_next_page.next.done, 'normalize');

  assert.equal(common.flowTools.shopping_collect_store_page.execute.implementation, 'lua');
  // A store searched in the wrong language answers nothing. Before the worker gives up on it, the
  // collector hands back another wording and the search runs again from page one. Only a store that
  // found NOTHING pays for this, and the attempted wordings are remembered.
  assert.equal(common.flows.shopping_search_one_store.nodes.collect.next.retry_query, 'search_other_wording');

  assert.equal(common.flows.shopping_search_one_store.nodes.search_other_wording.next.done, 'normalize');
  assert.equal(common.flowTools.shopping_collect_store_page.output.query, 'result.query');
  assert.equal(common.flowTools.shopping_collect_store_page.output.tried_queries, 'result.tried_queries');
  assert.ok(common.flowTools.shopping_search_one_store.parameters.properties.query, 'query must be declared to reach the script');
  for (const key of ['query', 'tried_queries']) {
    assert.ok(Object.hasOwn(common.flows.shopping_search_one_store.state, key), `worker state must include ${key}`);
  }

  // Which words mean the same product is language knowledge, so the MODEL writes them: no equivalence
  // table exists in the Lua any more. The wordings reach every store worker through the map context, and
  // the brand spellings reach the matcher that decides whether a listing is the requested product.
  const collectTool = common.flowTools.collect_total_cost_request.parameters.properties;
  assert.ok(collectTool.query_variants, 'the request must be able to carry other wordings');
  assert.ok(collectTool.brand_aliases, 'the request must be able to carry the brand spellings');
  const shopping = common.flows.shopping_multi_store_total_cost;
  const collectPrompt = shopping.nodes.collect_request.prompt;
  assert.match(collectPrompt, /query_variants/);
  assert.match(collectPrompt, /brand_aliases/);
  assert.match(collectPrompt, /SAME product/, 'a variant must not be allowed to name another product');
  for (const key of ['query_variants', 'brand_aliases']) {
    assert.ok(Object.hasOwn(shopping.state, key), `shopping state must include ${key}`);
    assert.ok(shopping.nodes.collect_request.inputSelector.includes(key), `collect_request must see ${key}`);
    assert.ok(shopping.nodes.search_stores.inputSelector.includes(key), `search_stores must pass ${key}`);
    assert.ok(shopping.nodes.discover_products.inputSelector.includes(key), `discover_products must pass ${key}`);
    assert.ok(common.flowTools.shopping_search_stores.parameters.properties[key], `search map must accept ${key}`);
    assert.ok(common.flowTools.shopping_discover_products.parameters.properties[key], `discovery map must accept ${key}`);
  }
  // `brand_aliases` rides inside `context`. The runtime projects TOP-LEVEL properties only, and nested
  // extraction belongs to the script — so what has to be declared is the object that carries it.
  assert.ok(common.flowTools.shopping_normalize_store_result.parameters.properties.context);
  assert.equal(common.flowTools.shopping_collect_store_page.output.collected, 'result.collected');
  assert.equal(common.flowTools.shopping_collect_store_page.output.page, 'result.page');
  assert.equal(common.flowTools.shopping_collect_store_page.output.store_result, 'result.store_result');
  assert.ok(common.flowTools.shopping_search_one_store.parameters.properties.page, 'page must be declared to reach the script');
  for (const key of ['page', 'collected']) {
    assert.ok(Object.hasOwn(common.flows.shopping_search_one_store.state, key), `worker state must include ${key}`);
  }
  // The storefront search no longer names a browser command: it names the modules it runs in the runtime.
  assert.deepEqual(common.flowTools.shopping_search_one_store.execute.modules,
    ['_common.61_rpc_storefront', '_common.62_rpc_sites']);

  // Pure commands crossed into the runtime: they name modules and grant no ops, because they never
  // touch the browser.
  assert.equal(common.flowTools.shopping_normalize_store_result.execute.implementation, 'lua');
  assert.ok(!common.flowTools.shopping_normalize_store_result.execute.rpc, 'a pure command needs no ops');
  assert.ok(common.flowTools.shopping_discover_products.execute.task.budget.maxRemoteCalls >= 5);
  assert.ok(common.flowTools.shopping_search_stores.execute.task.budget.maxRemoteCalls >= 5);

  for (const key of ['identity_status', 'product_options', 'options_version', 'identity_id', 'identity_fingerprint', 'comparison_id']) {
    assert.ok(Object.hasOwn(flow.state, key), `flow state must include ${key}`);
  }

  for (const tool of [
    'shopping_prepare_product_identity',
    'shopping_discover_products',
    'shopping_build_product_options',
    'choose_product_identity',
    'shopping_resolve_product_option',
    'shopping_verify_product_offers',
  ]) {
    assert.ok(common.flowTools?.[tool], `${tool} flowTool must exist`);
  }
});

// A model that keeps answering the same way, or a tool that keeps returning the same error, used to burn
// the whole step budget in silence: one live turn spent 176s repeating choose_offer -> browse_offers
// seven times and told the user nothing. Every LLM node must have a way out that the user can see.
function assertStallGuard(flow, flowName, nodeName) {
  const node = flow.nodes[nodeName];
  const guard = node.fallback || {};
  assert.ok(guard.maxStalledSteps >= 1 && guard.maxStalledSteps <= 3,
    `${flowName}.${nodeName}.fallback.maxStalledSteps must be 1-3, got ${guard.maxStalledSteps}`);
  assert.ok(guard.stalledNext, `${flowName}.${nodeName}.fallback.stalledNext must be set`);
  const target = node.next?.[guard.stalledNext];
  assert.ok(target, `${flowName}.${nodeName}.next must declare ${guard.stalledNext}`);
  assert.notEqual(target, nodeName, `${flowName}.${nodeName} must not stall into itself`);
}

test('every model-driven node can exit a stall into something the user sees', () => {
  const common = parseFlow('_common/flows.yaml');
  for (const flowName of ['shopping_multi_store_total_cost', 'request_service_quote']) {
    const flow = common.flows[flowName];
    const llmNodes = Object.entries(flow.nodes)
      .filter(([, node]) => node.kind === 'action_unit')
      .map(([name]) => name);
    assert.ok(llmNodes.length > 0, `${flowName} must have model nodes`);
    for (const nodeName of llmNodes) assertStallGuard(flow, flowName, nodeName);
  }
});

test('a lost comparison ends in an explanation, never a retry loop', () => {
  const common = parseFlow('_common/flows.yaml');
  const flow = common.flows.shopping_multi_store_total_cost;

  assert.equal(flow.nodes.browse_offers.next.error, 'comparison_lost');
  const terminal = flow.nodes.comparison_lost;
  assert.equal(terminal.kind, 'terminal');
  assert.match(terminal.respond, /장바구니|cart/, 'the recovery message must state that nothing was bought');
  assert.ok(terminal.respond.length > 40, 'the recovery message must tell the user what to do next');
});

test('store outcomes reach the user, not just the log', () => {
  const common = parseFlow('_common/flows.yaml');
  const flow = common.flows.shopping_multi_store_total_cost;

  assert.ok(Object.hasOwn(flow.state, 'store_status'));
  assert.equal(common.flowTools.shopping_rank_store_offers.output.store_status, 'result.store_status');
  // `all_offers` used to ride here as a second copy of the listing; the snapshot carries it now.
  assert.equal(common.flowTools.shopping_rank_store_offers.output.comparison_state, 'result.comparison_state');
  // The window itself names the failing stores now — the snapshot carries the notes, so every page after
  // the first says the same thing the first one did. No prompt needs the offers to say it.
  assert.ok(!flow.nodes.present_offers.inputSelector.includes('offers'));
  for (const terminalName of ['no_results', 'report_cart']) {
    assert.ok(flow.nodes[terminalName].inputSelector.includes('store_status'),
      `${terminalName} must be able to report which stores failed`);
  }
});

test('the user is told a multi-store search takes time before it starts', () => {
  const common = parseFlow('_common/flows.yaml');
  const prompt = common.flows.shopping_multi_store_total_cost.nodes.collect_request.prompt;
  assert.match(prompt, /분|minute/, 'the clarifying question must set the duration expectation');
  assert.match(prompt, /검색|search/);
});

test('task research names the current canonical and SDK reference flows', () => {
  const research = read('AXSDK_CHROME_EXTENSION_AGENTIC_TASKS.md');
  assert.doesNotMatch(research, /\.\.\/axsdk-agents\/apps\/browser-extension/);
  assert.match(research, /_common\/flows\.yaml/);
  assert.match(research, /axsdk-sdk-js\/packages\/axsdk-react\/apps\/browser-extension\/flows\.yaml/);
  assert.match(research, /legacy/i);
});

test('shared v1 fixtures encode compiler mutation acceptance and rejection', () => {
  const fixture = JSON.parse(read('tools/fixtures/flow-conformance-v1.json'));
  assert.equal(fixture.fixtureId, 'axsdk-flow-conformance-v1');
  assert.equal(fixture.flowContractVersion, 1);
  for (const scenario of fixture.mutationCases) {
    const issue = mutationIssue(scenario.adapter);
    assert.equal(issue === null, scenario.valid, scenario.name);
    if (!scenario.valid) assert.equal(issue, scenario.issue, scenario.name);
  }
});

test('compatibility record is present', () => {
  assert.equal(existsSync(new URL('FLOW_CONFORMANCE.md', root)), true);
});

test('nothing in the comparison loop can narrate work it did not do', () => {
  // A live turn answered "무료배송만 보여주었습니다" through next="ask" while the listing was untouched, and
  // the guard for it was a paragraph in a prompt. The prompt is gone: every node in the loop is
  // deterministic, so the only text the user sees is the window a tool rendered from the snapshot.
  const flow = parseFlow('_common/flows.yaml').flows.shopping_multi_store_total_cost;
  const loop = ['present_offers', 'browse_offers', 'resolve_offer'];

  for (const id of loop) {
    const node = flow.nodes[id];
    assert.equal(node.kind, 'action_contract', `${id} must not be able to write its own answer`);
    assert.equal(node.prompt, undefined, `${id} still carries a prompt`);
    assert.equal(node.allowedTools, undefined, `${id} still lets a model pick a tool`);
  }
});

test('the user can decline at the quote approval gate', () => {
  // Live: "아니요, 견적 요청은 취소할게요" at the approval gate came back as "out of scope" — the gate had
  // no cancel branch at all, so a refusal had nowhere to go. Saying no to a mutation must always work.
  const common = parseFlow('_common/flows.yaml');
  const quote = common.flows.request_service_quote;

  assert.equal(quote.nodes.confirm_quote.next.cancel, 'quote_cancelled');
  // The router may restart the flow instead of resuming it, so the entry itself has to recognise a
  // refusal — otherwise "취소할게요" is answered with "which service do you want?".
  assert.equal(quote.nodes.entry_guard.id, 'detect_cancellation');
  assert.equal(quote.nodes.entry_guard.next.cancel, 'quote_cancelled');
  // The continue path must REACH the collection gate, not necessarily BE it: a deterministic hop may sit in
  // between (the saved-contact recall does). A MODEL node on that path would be a place a refusal could get
  // lost, so only `action_contract` hops are allowed to intervene.
  let hop = quote.nodes.entry_guard.next.continue;
  for (let step = 0; step < 4 && hop !== 'collect_request'; step += 1) {
    const node = quote.nodes[hop];
    assert.ok(node !== undefined, `entry_guard continues to ${hop}, which does not exist`);
    assert.equal(node.kind, 'action_contract', `${hop} sits between the guard and the gate and must be deterministic`);
    hop = node.next?.done ?? node.next?.continue;
  }
  assert.equal(hop, 'collect_request', 'the continue path must reach the collection gate');
  // The guard only runs on a fresh entry; a flow already parked on the collection question must accept a
  // refusal too (live: a greeting had parked it there, and "취소할게요" was answered with another question).
  assert.equal(quote.nodes.collect_request.next.cancel, 'quote_cancelled');
  const collectTools = quote.nodes.collect_request.allowedTools.map((entry) => (typeof entry === 'string' ? entry : entry.tool));
  assert.ok(collectTools.includes('cancel_quote_request'));
  assert.equal(common.flowTools.cancel_quote_request.output.next, 'cancel');
  assert.equal(common.flowTools.detect_cancellation.execute.implementation, 'lua');
  assert.deepEqual(common.flowTools.confirm_quote_decision.parameters.properties.next.enum,
    ['ask', 'proceed', 'refine', 'cancel']);
  assert.match(quote.nodes.confirm_quote.prompt, /cancel/);
  const terminal = quote.nodes.quote_cancelled;
  assert.equal(terminal.kind, 'terminal');
  assert.match(terminal.respond, /견적|quote/);
  // The planner must keep a refusal inside the flow rather than treating it as a new topic.
  assert.match(common.planner.prompt, /취소|declin|cancel/);
});

test('every branch names a node that exists', () => {
  // A dangling target does not fail one flow, it fails the whole document: the engine refuses to compile
  // and every intent answers "플로우 설정을 불러오지 못했습니다". Live is a slow place to learn that.
  for (const file of ['_common/flows.yaml', 'playground/_common/flows.yaml']) {
    const doc = parseFlow(file);
    for (const [flowName, flow] of Object.entries(doc.flows || {})) {
      const names = new Set(Object.keys(flow.nodes || {}));
      for (const [nodeName, node] of Object.entries(flow.nodes || {})) {
        for (const [branch, target] of Object.entries(node.next || {})) {
          if (typeof target !== 'string') continue;
          assert.ok(names.has(target),
            `${file}: ${flowName}.${nodeName}.next.${branch} -> missing node ${target}`);
        }
      }
    }
    for (const route of doc.router?.routes || []) {
      const [flowName, nodeName] = String(route.entry || '').split('.');
      assert.ok(doc.flows?.[flowName]?.nodes?.[nodeName], `${file}: entry ${route.entry} names no node`);
    }
  }
});

test('no route enters a flow through a remote call', () => {
  // A router entry's FIRST step cannot be a remote command. The extension receives it, runs it, and PUTs
  // the result with HTTP 200 in about a second; the engine never consumes that result, retries roughly
  // every 30s, and fails the node on its deadline — measured identically at timeoutMs 15000 and 60000, on
  // both the production and Playground profiles. It killed the whole Thumbtack quote flow, checkout,
  // bluemoonsoft, and both Playground diagnostics. An entry must be a model node or an in-engine
  // (`kind: runtime`) tool; the first remote call belongs one hop later.
  for (const file of ['_common/flows.yaml', 'playground/_common/flows.yaml']) {
    const doc = parseFlow(file);
    for (const route of doc.router?.routes || []) {
      const [flowName, nodeName] = String(route.entry || '').split('.');
      const node = doc.flows?.[flowName]?.nodes?.[nodeName];
      assert.ok(node, `${file}: ${route.entry} names no node`);
      const tool = doc.flowTools?.[node.id || node.run];
      assert.notEqual(tool?.execute?.kind, 'remote',
        `${file}: ${route.entry} enters through remote tool ${node.id || node.run}`);
    }
  }
});

test('a shortlist reply reaches the deterministic browser verbatim', () => {
  // The browser reads the user's reply from state.requestText. On a follow-up turn the planner must copy
  // it there: without the rule the criterion never arrived and the window silently kept the old ranking.
  const common = parseFlow('_common/flows.yaml');
  const prompt = common.planner.prompt;

  assert.match(prompt, /request_service_quote/);
  assert.match(prompt, /browse_candidates/);
  assert.match(prompt, /state\.requestText/);
});

test('browsing a live comparison resumes it instead of starting a new search', () => {
  // "3만원 이하만 보여줘" while a comparison was on screen was routed as a NEW shopping request: the
  // planner replaced the active flow and the user lost the list they were looking at.
  const common = parseFlow('_common/flows.yaml');
  const prompt = common.planner.prompt;

  assert.match(prompt, /shopping_multi_store_total_cost/);
  assert.match(prompt, /continue_current/);
  assert.match(prompt, /무료배송만|3만원 이하|평점 높은 순/, 'the planner must recognise refinement phrasing');
  assert.match(prompt, /다음|이전/, 'the planner must recognise paging phrasing');
  assert.ok(common.planner.inputSelector.includes('active.activeNode'));
  assert.ok(common.planner.inputSelector.includes('active.intent'));
});

test('every RPC tool is granted exactly the ops its code calls', () => {
  // The runtime refuses a disallowed op mid-run, on a live page, one op at a time — the most expensive
  // place to discover a typo. Both mistakes the platform guide warns about are mechanical: a wait helper
  // is not a wire op (`dom.wait_for_selector` polls `dom.exists`), and a grant nobody calls is a
  // capability nobody asked for — on a storefront, the difference between reading and buying.
  const built = buildRpcFlows({ root: fileURLToPath(new URL('playground/', root)), delivery: 'registry' });
  const issues = auditRpcAllow(parseFlow('playground/_common/flows.yaml'), { moduleSources: built.__report.moduleSources });

  assert.deepEqual(issues, [], issues.map((issue) => `${issue.tool}: ${issue.code} ${issue.op}`).join('\n'));
});

test('every shipped flow document declares a contexts section', () => {
  // `contexts` is a document section, not an app column: a document without one leaves the session
  // config with `contexts: undefined`, and the extension then fails to render the binding at all
  // (`binding:render-failed`, no `session:ensure`, an empty reply after the full timeout). Measured on
  // the sandbox app — the failure looks like a flow that produced nothing, so it is worth a test.
  for (const path of ['_common/flows.yaml', 'playground/_common/flows.yaml']) {
    const document = parseFlow(path);
    assert.ok(document.contexts && typeof document.contexts === 'object',
      `${path} must declare a contexts section`);
  }
});

test('the storefront search runs in the runtime, not as a durable browser call', () => {
  // The whole migration in one assertion: the tool that touches a storefront is a runtime script over
  // RPC, and it names its modules instead of carrying their source.
  const common = parseFlow('_common/flows.yaml');
  const execute = common.flowTools?.shopping_search_one_store?.execute ?? {};

  assert.equal(execute.implementation, 'lua');
  assert.notEqual(execute.kind, 'remote');
  assert.ok(Array.isArray(execute.modules) && execute.modules.includes('_common.61_rpc_storefront'),
    'the reader travels as a module name, not as inlined source');
  assert.ok(Array.isArray(execute.rpc?.allow) && execute.rpc.allow.length > 0, 'ops must be granted explicitly');
});

test('the search hops that only existed to survive a navigation are gone', () => {
  // A durable call died on every page load, so each search needed a re-invoke node behind it: seven
  // nodes for three searches. An RPC script keeps its stack across the reload, so the hops have nothing
  // left to do — and a `navigating` branch has nothing left to mean.
  const common = parseFlow('_common/flows.yaml');
  const nodes = common.flows?.shopping_search_one_store?.nodes ?? {};
  const searchNodes = Object.entries(nodes).filter(([, node]) => node?.id === 'shopping_search_one_store');

  assert.ok(searchNodes.length > 0, 'the worker must still search');
  for (const [name, node] of searchNodes) {
    assert.ok(!node.next?.navigating, `${name} must not branch on navigating`);
    assert.ok(!node.next?.unsupported_site, `${name} must not still route to a durable reader`);
  }
  assert.deepEqual(Object.keys(nodes).filter((name) => name.includes('after_navigation')), [],
    'no node should exist only to be called again after a navigation');
});

test('single-site shopping reads every store in the runtime', () => {
  // Every storefront is ported, so the durable sibling that carried amazon is gone and nothing routes to
  // it. A branch left behind here would be a path no store can reach and nobody would notice it rot.
  const common = parseFlow('_common/flows.yaml');
  const nodes = common.flows?.shopping_single_site?.nodes ?? {};

  assert.ok(!nodes.search_item.next.unsupported_site);
  assert.ok(!nodes.search_item_bespoke);
  assert.ok(!common.flowTools.shopping_search_product_durable);
  assert.equal(common.flowTools.shopping_search_product.execute.implementation, 'lua');
});

test('the service search reads in the runtime and stops re-invoking itself', () => {
  // The `read: search` self-loop was the durable pattern: the call died on the results navigation and the
  // flow called it again. A runtime script keeps its stack, so a loop back into the same node would only
  // re-run a search that already finished.
  const common = parseFlow('_common/flows.yaml');
  const search = common.flows?.request_service_quote?.nodes?.search ?? {};
  const tool = common.flowTools?.search_service?.execute ?? {};

  assert.equal(tool.implementation, 'lua');
  assert.ok(Array.isArray(tool.modules) && tool.modules.includes('_common.64_rpc_thumbtack'));
  assert.ok(Array.isArray(tool.rpc?.allow) && tool.rpc.allow.length > 0);
  assert.ok(!search.next.read, 'a finished search must not loop back into itself');
  assert.equal(search.next.done, 'prepare_results_table');
});

test('a rejected postcode is answered as a postcode problem', () => {
  // Thumbtack answers a bad ZIP with a banner and an empty list. Folding that into `no_results` sends the
  // user looking for another service when the ZIP is what was disliked.
  const common = parseFlow('_common/flows.yaml');
  const search = common.flows?.request_service_quote?.nodes?.search ?? {};
  assert.equal(search.next.invalid_zip, 'collect_request');
  assert.equal(common.flowTools.search_service.output.next, 'result.next');
});

test('every branch the search script can answer is a branch the node routes', () => {
  // Live, the script answered `next: "ok"` while the node enumerated `done`. The word fell through
  // `invalidNext`, so ten real pros were read and the user was told the request had failed — a passing
  // suite on both sides of a vocabulary that never matched. The keys are enumerable, so pin them.
  const common = parseFlow('_common/flows.yaml');
  const routed = Object.keys(common.flows?.request_service_quote?.nodes?.search?.next ?? {});
  const source = read('_common/rpc/64_rpc_thumbtack.lua');
  const answered = [...source.matchAll(/next = "([a-z_]+)"/g)].map((match) => match[1]);

  assert.ok(answered.length >= 4, 'the script must answer more than one branch');
  for (const branch of new Set(answered)) {
    assert.ok(routed.includes(branch), `the script answers "${branch}" but the node routes ${routed.join(', ')}`);
  }
});

test('the quote dialog is driven in the runtime, with no step-by-step self-loop', () => {
  // The dialog is a same-context overlay, yet the durable design re-entered `answer_quote` once per step
  // (maxSelfSteps: 16) because each call died on its own. One runtime call walks the whole form, so the
  // node and its self-loop are the artifact — and their absence is the assertion.
  const common = parseFlow('_common/flows.yaml');
  const nodes = common.flows?.request_service_quote?.nodes ?? {};
  const tool = common.flowTools?.open_quote?.execute ?? {};

  assert.equal(tool.implementation, 'lua');
  for (const module of ['_common.00_base', '_common.10_form_wizard', '_common.65_rpc_quote']) {
    assert.ok(tool.modules?.includes(module), `open_quote must declare ${module}`);
  }
  assert.ok(Array.isArray(tool.rpc?.allow) && tool.rpc.allow.includes('dom.click'));
  assert.equal(common.flowTools.open_quote.output.next, 'result.next');

  assert.ok(!nodes.answer_quote, 'the per-step node must be gone');
  assert.ok(!common.flowTools.answer_quote, 'and so must its tool');
  assert.equal(nodes.open_quote.next.submit, 'submit_quote');
  assert.equal(nodes.open_quote.next.error, 'pick_quote');
});

test('sending the request stays a separate, confirmed node', () => {
  // Driving a form and contacting a person are different acts. Collapsing the submit into the driver
  // would remove the only place the flow can still stop.
  const common = parseFlow('_common/flows.yaml');
  const tool = common.flowTools?.submit_quote ?? {};

  assert.equal(tool.execute?.implementation, 'lua');
  assert.ok(tool.execute?.modules?.includes('_common.65_rpc_quote'));
  assert.equal(common.flows.request_service_quote.nodes.submit_quote.next.done, 'pick_quote');
  const source = read('_common/rpc/65_rpc_quote.lua');
  assert.match(source, /args\.confirm ~= true/, 'the confirmation gate lives in the script, not the prompt');
});

test('every branch the quote script can answer is a branch its node routes', () => {
  const common = parseFlow('_common/flows.yaml');
  const nodes = common.flows?.request_service_quote?.nodes ?? {};
  const routed = new Set([...Object.keys(nodes.open_quote?.next ?? {}), ...Object.keys(nodes.submit_quote?.next ?? {})]);
  const answered = [...read('_common/rpc/65_rpc_quote.lua').matchAll(/next = "([a-z_]+)"/g)].map((match) => match[1]);

  assert.ok(answered.length >= 3);
  for (const branch of new Set(answered)) {
    assert.ok(routed.has(branch), `the script answers "${branch}" but the nodes route ${[...routed].join(', ')}`);
  }
});

test('no runtime tool asks for more time than the platform grants', () => {
  // The deploy endpoint refuses the whole document with "deadlineMs must be an integer between 1 and
  // 120000". A single tool over the ceiling therefore takes every flow down, and the failure arrives at
  // push time with no hint of which tool caused it.
  const common = parseFlow('_common/flows.yaml');
  for (const [name, tool] of Object.entries(common.flowTools ?? {})) {
    const deadline = tool.execute?.rpc?.deadlineMs;
    if (deadline === undefined) continue;
    assert.ok(deadline >= 1 && deadline <= 120000, `${name} asks for ${deadline}ms`);
  }
});

test('opening a store before a runtime search is not a step', () => {
  // The durable adapters only existed once the browser was on their domain, so every search needed a
  // separate node to get there first. A runtime search navigates to the search URL itself — the reader
  // holds every site's config regardless of the current page — so the open is a whole page load spent to
  // arrive somewhere the next call leaves immediately.
  const common = parseFlow('_common/flows.yaml');

  // The opener itself is NOT gone — three flows genuinely need to BE on a site before their next step
  // (the checkout's cart, a same-site page navigation, a search of whichever store is open). What is gone is
  // opening a store before a search that navigates to its own URL.
  //
  // One entry tool per calling flow. A runtime tool is INLINED by the flow that names it with `id:`, and
  // an inline action cannot be shared — three flows on one entry tool compiles to "inline action duplicates
  // existing action". `run:` is not the way out: it resolves only against `kind: remote` actions, so it
  // answers "references missing action" for a runtime tool. Both were measured against the compiler.
  for (const name of ['enter_shopping_site', 'enter_checkout_site', 'enter_bluemoonsoft']) {
    assert.equal(common.flowTools[name]?.execute?.implementation, 'lua', `${name} runs in the runtime`);
  }
  assert.ok(!common.flowTools.open_site, 'the shared opener is gone');
  assert.ok(!common.flowTools.shopping_open_mapped_store, 'and so is the per-store opener');

  const quote = common.flows.request_service_quote.nodes;
  assert.ok(!quote.open_site, 'the quote flow opens nothing');
  assert.equal(quote.verify_request.next.ok, 'search', 'a verified request searches directly');

  const worker = common.flows.shopping_search_one_store.nodes;
  assert.ok(!worker.open, 'the worker opens nothing');
  assert.equal(Object.keys(worker)[0], 'search', 'and starts at its search');
});

test('a same-site navigation runs in the runtime', () => {
  // `AX_navigate` builds a URL from a link plus params and confirms arrival against an expected URL. That
  // is `nav.navigate` + `nav.wait_for_navigation` + `dom.get_location_href` — the combination the search
  // and quote paths already run. It was never a platform-owned command.
  const common = parseFlow('_common/flows.yaml');
  const tool = common.flowTools?.navigate_page?.execute ?? {};

  assert.equal(tool.implementation, 'lua');
  assert.ok(tool.modules?.includes('_common.66_rpc_navigate'));
  assert.ok(tool.rpc?.allow?.includes('nav.navigate'));
  assert.equal(common.flowTools.navigate_page.output.next, 'result.next');
});

test('the guarded cart runs in the runtime, and its guards live in the script', () => {
  // A cart that spends money must not depend on a prompt for its approvals. The markers are checked in the
  // script, before any op, so a call that should not touch the page does not touch it.
  const common = parseFlow('_common/flows.yaml');
  for (const name of ['shopping_add_selected_store_offer', 'shopping_add_to_cart']) {
    const tool = common.flowTools?.[name] ?? {};
    assert.equal(tool.execute?.kind, 'runtime', `${name} must run in the runtime`);
    assert.ok(tool.execute?.modules?.includes('_common.67_rpc_cart'), `${name} must declare the cart module`);
    assert.equal(tool.effect, 'mutation', `${name} stays a declared mutation`);
    assert.equal(tool.consent, 'required');
  }

  const source = read('_common/rpc/67_rpc_cart.lua');
  assert.match(source, /approval ~= "user_selected_compared_offer"/);
  assert.match(source, /approval ~= "user_picked_searched_product"/);
  assert.match(source, /args\.identity_approval ~= "locked_product_identity"/);
  // Comments are stripped: the prose says "never checks out", and the point is that no CODE does. A
  // checkout selector or a config key naming one would be the real leak.
  const code = source.replace(/^\s*--.*$/gm, '');
  assert.ok(
    !/checkout|place_?order|buy_?now|proceed_?to/i.test(code),
    'the cart script must not know how to order',
  );
});

test('opening the store before the runtime cart is not a step either', () => {
  // Same reason as the search: the cart navigates to the product page itself, and the reader holds every
  // site's config regardless of which page is open.
  const common = parseFlow('_common/flows.yaml');
  assert.ok(!common.flowTools.shopping_open_selected_store, 'the opener tool is gone');
  const nodes = Object.values(common.flows).flatMap((flow) => Object.keys(flow.nodes ?? {}));
  assert.ok(!nodes.includes('open_selected_store'), 'and so is its node');
});

test('every node action resolves to a tool that exists', () => {
  // Removing a tool leaves any node that still names it dangling, and the failure arrives as
  // "flow document failed to compile" at the extension — after a push, with the whole document dead. The
  // reference graph is right here in the document, so check it here.
  const common = parseFlow('_common/flows.yaml');
  const tools = new Set(Object.keys(common.flowTools ?? {}));
  const missing = [];

  for (const [flowName, flow] of Object.entries(common.flows ?? {})) {
    for (const [nodeName, node] of Object.entries(flow.nodes ?? {})) {
      // `allowedTools` holds either a bare name or `{ tool, when }` — a tool offered only when the state
      // satisfies a condition. Both name a tool that has to exist.
      const named = (node.allowedTools ?? []).map((entry) => (typeof entry === 'string' ? entry : entry?.tool));
      // `kind: action` names its tool with `run:` rather than `id:` — the shape the compiler complained
      // about ("nodes.open_amazon.run references missing action"), and the one this check first missed.
      for (const id of [node.id, node.run, ...named]) {
        if (id && !tools.has(id)) missing.push(`${flowName}.${nodeName} -> ${id}`);
      }
    }
  }

  assert.deepEqual(missing, [], `dangling references: ${missing.join(' | ')}`);
});

test('every node a flow routes to exists', () => {
  // The other half of the same graph: a `next` pointing at a deleted node is just as fatal, and just as
  // checkable without a browser.
  const common = parseFlow('_common/flows.yaml');
  const dangling = [];

  for (const [flowName, flow] of Object.entries(common.flows ?? {})) {
    const nodes = new Set(Object.keys(flow.nodes ?? {}));
    for (const [nodeName, node] of Object.entries(flow.nodes ?? {})) {
      for (const target of Object.values(node.next ?? {})) {
        if (typeof target === 'string' && !nodes.has(target)) {
          dangling.push(`${flowName}.${nodeName} -> ${target}`);
        }
      }
    }
  }

  assert.deepEqual(dangling, [], `dangling routes: ${dangling.join(' | ')}`);
});

test('a tool shared ACROSS flows is referenced, not inlined', () => {
  // Measured against the compiler, in four steps:
  //   1. a `flowTools` entry plus nodes using `kind: action` + `run:`   -> compiles
  //   2. removing the entry                                             -> "references missing action"
  //   3. keeping it and switching to `action_contract` + `id:` in three
  //      DIFFERENT flows                                                -> "inline action duplicates
  //                                                                         existing action"
  //   4. three nodes in the SAME flow sharing an `id:`                  -> compiles (shopping_search_one_store)
  //
  // So `id:` inlines the action once per flow, and a tool used from more than one FLOW has to be referenced
  // with `run:`. [INFERENCE] the scoping is per flow — that is what these four observations fit, and the
  // compiler's internals are not ours to read.
  const common = parseFlow('_common/flows.yaml');
  const flowsById = new Map();

  for (const [flowName, flow] of Object.entries(common.flows ?? {})) {
    for (const node of Object.values(flow.nodes ?? {})) {
      if (!node.id) continue;
      flowsById.set(node.id, new Set([...(flowsById.get(node.id) ?? []), flowName]));
    }
  }

  const shared = [...flowsById].filter(([, flows]) => flows.size > 1)
    .map(([id, flows]) => `${id}: ${[...flows].join(', ')}`);
  assert.deepEqual(shared, [], `these must use run: instead of id: ${shared.join(' | ')}`);
});

test('the checkout reviews and cannot order', () => {
  // The checkout exists so a person can read the total, the address and the payment method and then decide.
  // Its grant carries no form submit, and the place-order selectors appear only as something to READ.
  const common = parseFlow('_common/flows.yaml');
  for (const name of ['checkout', 'run_checkout']) {
    const tool = common.flowTools?.[name] ?? {};
    assert.equal(tool.execute?.implementation, 'lua', `${name} runs in the runtime`);
    assert.ok(tool.execute?.modules?.includes('_common.68_rpc_checkout'));
    const allow = tool.execute?.rpc?.allow ?? [];
    assert.ok(!allow.includes('dom.submit_form'), `${name} must not be able to submit a form`);
    assert.ok(!allow.includes('page.eval'), `${name} must not be able to run arbitrary script`);
  }

  const source = read('_common/rpc/68_rpc_checkout.lua');
  const code = source.replace(/^\s*--.*$/gm, '');
  // The place-order selectors may be read (`first_existing`), and must never be handed to a click.
  assert.match(code, /place_order_selectors/);
  assert.ok(
    !/click\([^)]*place_order/.test(code),
    'the place-order selectors must never reach a click',
  );
});

test('the cart module stays free of any way to order', () => {
  // This is why the checkout is a separate module. If the two ever merge, this assertion is what notices.
  const code = read('_common/rpc/67_rpc_cart.lua').replace(/^\s*--.*$/gm, '');
  assert.ok(
    !/checkout|place_?order|buy_?now|proceed_?to/i.test(code),
    'the cart script must not know how to order',
  );
});

test('the sitemap search reads the SITE\'s sitemap, not the app package\'s', () => {
  // The runtime's own `implementation: sitemap.search` reads the APP PACKAGE's sitemap. Measured live on
  // production that is the extension's own pages (`/`, `/settings`, `/help`), so adopting it returned an
  // empty hit list for every request and the flow fell back to the home page in silence — the worst
  // shape a wrong answer can take. The tool stayed remote until the CLIENT shipped
  // `sitemap.search_site`, which reads `sitesStore.currentSitemap`: the sitemap of the domain the tab is
  // on. Same intent, right document. What this pins is WHICH op, because the names differ by one word.
  const common = parseFlow('_common/flows.yaml');
  const tool = common.flowTools?.sitemap_search ?? {};

  assert.equal(tool.execute?.kind, 'runtime');
  assert.deepEqual(tool.execute?.rpc?.allow, ['sitemap.search_site']);
  assert.ok(
    !JSON.stringify(tool.execute).includes('"sitemap.search"'),
    'the app-package sitemap op must not come back',
  );
  assert.equal(tool.output?.sitemap_hits, 'result.chunks');
});

test('every node action reference resolves to a tool that exists', () => {
  // A whole site was dead and every gate was green. The navigation port replaced the shared `open_site`
  // remote tool with one thin runtime entry per flow, and `bluemoonsoft/flows.yaml` — which owns its
  // `bluemoonsoft` flow outright, so the base's corrected node never reaches that domain — kept
  // `run: open_site`. Live, every request on bluemoonsoft.com answered:
  //
  //   flows.bluemoonsoft.nodes.enter.run references missing action: open_site
  //
  // Nothing here checked references, so the suite passed 89/89 over a document that cannot compile. The
  // site overlays are exactly where this hides: they replace a flow wholesale, so a base fix skips them.
  const files = ['_common/flows.yaml', 'bluemoonsoft/flows.yaml', 'thumbtack/flows.yaml']
    .filter((path) => existsSync(new URL(path, root)));

  const defined = new Set(Object.keys(parseFlow('_common/flows.yaml').flowTools ?? {}));
  for (const path of files) {
    const document = parseFlow(path);
    for (const name of Object.keys(document.flowTools ?? {})) defined.add(name);
  }

  const missing = [];
  for (const path of files) {
    const document = parseFlow(path);
    for (const [flowId, flow] of Object.entries(document.flows ?? {})) {
      for (const [nodeId, node] of Object.entries(flow?.nodes ?? {})) {
        // `run:` names a shared remote action; `id:` inlines a runtime one. Both must exist.
        for (const key of ['run', 'id']) {
          const reference = node?.[key];
          if (typeof reference === 'string' && !defined.has(reference)) {
            missing.push(`${path} flows.${flowId}.nodes.${nodeId}.${key} -> ${reference}`);
          }
        }
      }
    }
  }

  assert.deepEqual(missing, [], `unresolvable action references:\n${missing.join('\n')}`);
});

test('the quote budget stays under the deadline the flow declares', () => {
  // Two numbers in two files that must agree, which is the shape every drift bug here has taken. The
  // module stops itself on `TIME_BUDGET_MS`; the platform kills the call at the node's `deadlineMs` with
  // `deadline exceeded before dom.exists`, a sentence that helps nobody. So the budget must be lower —
  // by enough margin to compose and return an answer, not merely lower by one millisecond.
  const source = readFileSync(new URL('_common/rpc/65_rpc_quote.lua', root), 'utf8');
  const budget = Number(/Q\.TIME_BUDGET_MS\s*=\s*(\d+)/.exec(source)?.[1]);
  assert.ok(Number.isFinite(budget), 'the module must declare a time budget');

  const common = parseFlow('_common/flows.yaml');
  // Only the tool that RUNS the wizard loop. `submit_quote` loads the same module for a handful of ops
  // and declares a much shorter deadline (90s); holding the driver's budget against that one would fail
  // for a tool that never consults it.
  const deadlines = Object.values(common.flowTools ?? {})
    .filter((tool) => String(tool.execute?.lua ?? '').includes('request_quote'))
    .map((tool) => tool.execute?.rpc?.deadlineMs)
    .filter((value) => typeof value === 'number');

  assert.ok(deadlines.length > 0, 'the driving quote tool must declare its deadline');
  for (const deadline of deadlines) {
    assert.ok(
      budget <= deadline - 15000,
      `budget ${budget}ms leaves no room under a ${deadline}ms deadline`,
    );
  }
});

test('SCHEMA.md is generated from the flows, not maintained beside them', () => {
  // SCHEMA.md is the list of tools the model may call, and a hand-kept mirror of a machine-readable
  // source drifts. This one had: 40 entries against 85 real tools, still advertising the entire durable
  // command set the RPC port replaced — `AX_open_quote`, `AX_search_service`, `AX_add_to_cart` and twenty
  // more that no flow can reach. Each was a promise to the model about a tool that is not there.
  //
  // The tools ARE the flow tools: `allowedTools` resolves to a `flowTools` entry and that entry's
  // `parameters` is the schema the model receives. So it is derivable, and deriving it is what keeps it
  // true. Same lesson as `run: open_site` — a document nothing checks is a document nothing maintains.
  const generated = `${JSON.stringify(buildSchema(), null, 2)}\n`;
  const current = readFileSync(new URL('SCHEMA.md', root), 'utf8');

  assert.equal(current, generated, 'SCHEMA.md is stale — run `npm run build:schema`');
});

test('every advertised tool names a real parameter schema', () => {
  // A generated document can still be empty or shapeless. What the model needs from each entry is a name
  // it can call and an object schema it can fill.
  const schema = buildSchema();
  assert.ok(schema.length > 50, `expected the full tool set, got ${schema.length}`);
  for (const tool of schema) {
    assert.match(tool.name, /^[a-z][a-z0-9_]*$/, `tool names are flow-tool ids: ${tool.name}`);
    assert.equal(tool.parameters?.type, 'object', `${tool.name} must take an object`);
    assert.ok(tool.description.length > 0, `${tool.name} must say what it does`);
  }
});

test('thumbtack is fully ported: no durable Lua left behind it', () => {
  // The quote wizard, the search, the results filter and the page detector all became runtime tools. The
  // durable scripts they replaced stayed on disk — 4,053 lines across eight Lua files and their harnesses
  // — advertised by SCHEMA.md, reachable by nothing. Dead code that still looks live is worse than
  // absent: the next reader has to prove it is unused before touching anything near it, and we just spent
  // a session doing exactly that.
  //
  // Verified before removal: no `_common/rpc/*` module touches the durable `AX_THUMBTACK` global (the
  // runtime module defines its own `AX_RPC_THUMBTACK`), and `_common/scripts/00_navigate.lua` mentions
  // `AX_search_service` only in a comment.
  const directory = new URL('thumbtack/scripts/', root);
  if (!existsSync(directory)) return;

  const left = readdirSync(directory).filter((name) => name.endsWith('.lua'));
  assert.deepEqual(left, [], `thumbtack still ships durable Lua: ${left.join(', ')}`);
});

test('no Lua ships that nothing can reach', () => {
  // There are four ways into a Lua file and a check that knows fewer than all of them proposes deletions
  // that break things. Counting `AX_*` definitions alone called `10_form_wizard.lua` dead while the quote
  // tool loads it every step; adding runtime modules still called every storefront config dead, because
  // registration is a load-time SIDE EFFECT nothing references; and the dev CLI is an entry point too —
  // `ax page` is `AX_read_page`. `deadLua` knows all four, which is what makes its answer actionable.
  const { dead } = deadLua();
  assert.deepEqual(
    dead.map((file) => file.id), [],
    `unreachable Lua:\n  ${dead.map((file) => `${file.id} (${file.lines}L)`).join('\n  ')}`,
  );
});

test('a runtime tool never declares input:, because the runtime refuses it', () => {
  // The runtime compiles this document, and an `input:` on a runtime implementation is now a COMPILE
  // ERROR — the whole flow stops loading:
  //   "flowTools.<name>.input is only applied to remote tools, so it would be silently ignored here;
  //    a runtime implementation receives the flow-state fields its parameters schema declares"
  // It was always ignored; the error only made that visible. Projection is `parameters.properties`, and
  // ours read raw state names already, which is why the blocks were vestigial.
  const common = parseFlow('_common/flows.yaml');
  const offenders = Object.entries(common.flowTools ?? {})
    .filter(([, tool]) => tool?.execute?.kind === 'runtime' && tool.input)
    .map(([name]) => name);

  assert.deepEqual(offenders, [], `runtime tools still declaring input:\n  ${offenders.join('\n  ')}`);
});

test('every state field a runtime tool reads is declared in its parameters', () => {
  // The runtime projects an `action_contract`'s arguments through `parameters.properties`. A field the
  // schema does not declare is DROPPED — it never reaches the script — and `input:` is not a second
  // projection: it applies to remote adapters only and is silently ignored on a runtime tool.
  //
  // Traced live: `localState` showed `query` and `tried_queries` set at the node while a probe inside the
  // tool printed `q=nil tried=nil`, and multi-store discovery re-asked one store the same question until
  // `subflow node budget exhausted`. `item`, `context` and `page` arrived because they happen to be
  // declared; the two the loop updates were not.
  //
  // So the `input:` blocks are the inventory of what each tool needs, and every root they name must be a
  // declared property. An accumulator must NOT be `required` — the first pass carries null.
  const common = parseFlow('_common/flows.yaml');
  const missing = [];
  for (const [name, tool] of Object.entries(common.flowTools ?? {})) {
    if (tool?.execute?.kind !== 'runtime' || !tool.input) continue;
    const declared = new Set(Object.keys(tool.parameters?.properties ?? {}));
    for (const path of Object.values(tool.input)) {
      if (typeof path !== 'string') continue;
      const root = /^tool\.args\.([A-Za-z0-9_]+)/.exec(path)?.[1];
      if (root && !declared.has(root)) missing.push(`${name}.${root}`);
    }
  }

  assert.deepEqual(
    [...new Set(missing)], [],
    `these tools read state their schema never declares, so it arrives nil:\n  ${[...new Set(missing)].join('\n  ')}`,
  );
});

test('a fan-out publishes the store result, not the envelope around it', () => {
  // `flow.map` reads each item's result from `resultFrom: store_result` and validates it against
  //   required: [site]
  // Live, both stores failed with `site: expected string, received undefined`, and the reason was one
  // word in a mapping: `store_result: result` publishes the SCRIPT'S WHOLE RETURN — `{next, store_result}`
  // — so the fields the schema wants sat one level down. The searcher publishes `result.store_result` and
  // is fine; the normalizer published `result`.
  const common = parseFlow('_common/flows.yaml');
  const wrong = [];
  for (const [name, tool] of Object.entries(common.flowTools ?? {})) {
    if (tool?.execute?.kind !== 'runtime') continue;
    if (tool.output?.store_result === 'result') wrong.push(name);
  }

  assert.deepEqual(
    wrong, [],
    `these publish the envelope instead of the store result:\n  ${wrong.join('\n  ')}`,
  );
});

test('a runtime tool never answers a branch its node cannot route', () => {
  // `invalidNext` is silent until it fires, and then it throws away everything the turn had done. Live:
  // the comparison was searched across two stores, screened, judged, verified and issued an id — and the
  // user got "요청을 처리하는 중 문제가 발생했습니다", because the tool answered `ask` where the node
  // routes `done | partial | empty | error`.
  //
  // Only literals are checkable: a tool that passes `result.next` through picks the command's vocabulary,
  // and that is the arrangement this exists to protect.
  const common = parseFlow('_common/flows.yaml');
  const wrong = [];
  for (const [flowId, flow] of Object.entries(common.flows ?? {})) {
    for (const [nodeId, node] of Object.entries(flow?.nodes ?? {})) {
      const tool = node?.id && common.flowTools?.[node.id];
      if (!tool || tool.execute?.kind !== 'runtime') continue;
      const branches = new Set(Object.keys(node.next ?? {}));
      if (branches.size === 0) continue;
      const literal = typeof tool.output?.next === 'string' && !tool.output.next.startsWith('result.')
        && !tool.output.next.includes('.') ? tool.output.next : null;
      if (literal && !branches.has(literal)) {
        wrong.push(`${flowId}.${nodeId} -> ${node.id} answers "${literal}", routes [${[...branches].join(', ')}]`);
      }
    }
  }

  assert.deepEqual(wrong, [], `branches no node routes:\n  ${wrong.join('\n  ')}`);
});

test('the comparison window is rendered deterministically, not by a model call', () => {
  // `present_store_offers` sat in `allowedTools`, so its arguments were the MODEL's — and a model-called
  // tool cannot be handed flow state. The snapshot lives there by design, so the tool answered
  // `comparison_unreadable` after two live store searches had already built the comparison.
  //
  // Same shape as the Thumbtack shortlist, which has no model node in its loop at all: a contract node
  // reads the snapshot through `inputSelector`, renders, and pauses on its own window.
  const common = parseFlow('_common/flows.yaml');

  for (const [flowId, flow] of Object.entries(common.flows ?? {})) {
    for (const [nodeId, node] of Object.entries(flow?.nodes ?? {})) {
      assert.ok(
        !(node?.allowedTools ?? []).includes('present_store_offers'),
        `${flowId}.${nodeId} lets a model call the presentation, which cannot reach the snapshot`,
      );
    }
  }

  const presenter = Object.entries(common.flows?.shopping_multi_store_total_cost?.nodes ?? {})
    .find(([, node]) => node?.id === 'present_store_offers');
  assert.ok(presenter, 'a deterministic node must render the comparison');
  const [, node] = presenter;
  assert.equal(node.kind, 'action_contract');
  assert.ok(
    (node.inputSelector ?? []).includes('comparison_state'),
    'the presenter must select the snapshot, or it has nothing to render',
  );
});

/** Every production flow layer: the shared base plus each site overlay that has one. */
function productionFlowLayers() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const sites = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !['node_modules', 'tools', 'dist', 'playground'].includes(entry.name))
    .map((entry) => `${entry.name}/flows.yaml`)
    .filter((path) => existsSync(new URL(`../${path}`, import.meta.url)));
  return ['_common/flows.yaml', ...sites];
}

/** The module that DEFINES an `AX_RPC_*` global, read from the files rather than a second list. */
function rpcModuleFor(global) {
  const root = fileURLToPath(new URL('../_common/rpc', import.meta.url));
  for (const name of readdirSync(root).filter((file) => file.endsWith('.lua'))) {
    const source = readFileSync(`${root}/${name}`, 'utf8');
    if (new RegExp(`^\\s*${global}\\s*=`, 'm').test(source) || new RegExp(`\\b_G\\.${global}\\s*=`).test(source)) {
      return `_common.${name.replace(/\.lua$/, '')}`;
    }
  }
  return null;
}

/**
 * What a module says it needs, read from the guard it raises: every RPC module opens with
 * `error("_common/scripts/X.lua must be loaded before ...")`. That guard is the dependency list, and it
 * is the one statement that cannot drift from the code, because the code is what raises it.
 */
function moduleDependencies(moduleId) {
  // A module id names no directory (`_common.73_rpc_offers`), and the files live in two: `rpc/` and
  // `scripts/`. Guessing one silently returns "no dependencies", which is how this gate passed while the
  // live comparison was dying on a missing module.
  const name = moduleId.replace(/^_common\./, '');
  const file = ['rpc', 'scripts']
    .map((directory) => fileURLToPath(new URL(`../_common/${directory}/${name}.lua`, import.meta.url)))
    .find((candidate) => existsSync(candidate));
  if (!file) return [];
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(/error\("(_common\/[a-z]+\/[\w.]+)\.lua must be loaded before/g)]
    .map((match) => match[1].replace(/\//g, '.').replace('_common.scripts.', '_common.').replace('_common.rpc.', '_common.'));
}

test('every tool declares the modules its Lua actually calls, and what those need', () => {
  // `AX_RPC_OFFERS.resolve` was wired into a tool whose `modules:` list did not include
  // `_common.73_rpc_offers`, so live it read `attempt to index a nil value (global 'AX_RPC_OFFERS')` —
  // one turn before a cart approval, and the user got a re-ask about which product they meant.
  //
  // Then the same gate passed while three tools loaded that module WITHOUT the reply classifier it needs,
  // and the whole comparison died with `lua module '_common.73_rpc_offers' error`. A dependency of a
  // dependency is still a dependency: follow the guards the modules themselves raise.
  const missing = [];

  for (const layer of productionFlowLayers()) {
    const doc = parseFlow(layer);
    for (const [toolId, tool] of Object.entries(doc.flowTools ?? {})) {
      const execute = tool?.execute;
      const declared = new Set(execute?.modules ?? []);
      const wanted = new Set();

      if (typeof execute?.lua === 'string') {
        for (const global of new Set(execute.lua.match(/\bAX_RPC_[A-Z_]+/g) ?? [])) {
          // A global no module defines is a different bug, and `rpcModuleFor` reports it as such.
          const owner = rpcModuleFor(global);
          if (owner) wanted.add(owner);
        }
      }
      for (const declaredModule of declared) wanted.add(declaredModule);
      for (const moduleId of [...wanted]) for (const need of moduleDependencies(moduleId)) wanted.add(need);

      for (const need of wanted) {
        if (!declared.has(need)) missing.push(`${layer} ${toolId}: needs ${need}`);
      }
    }
  }

  assert.deepEqual(missing, [], `undeclared modules:\n  ${missing.join('\n  ')}`);
});

test('browsing reads the snapshot and comes back through the one renderer', () => {
  // Paging and filtering rebuild the window, so they need the listing — and the listing lives in the
  // snapshot. `offers`/`all_offers` are absent state fields now: selecting them hands the tool nothing.
  //
  // And the new window has to reach the user. Routing `ask` at the model gate leaves it with a question
  // it has no tool to present, which is the same dead end the first pass had. One renderer: browsing
  // clears `choice_stage`, so the presenter renders the reissued listing and pauses on it.
  const nodes = parseFlow('_common/flows.yaml').flows.shopping_multi_store_total_cost.nodes;
  const browse = nodes.browse_offers;

  assert.ok(browse.inputSelector.includes('comparison_state'), 'browsing must read the snapshot');
  for (const dead of ['offers', 'all_offers']) {
    assert.ok(!browse.inputSelector.includes(dead), `${dead} is not carried between turns any more`);
  }
  assert.equal(browse.next.ask, 'present_offers', 'the reissued window needs the renderer, not the gate');

  // Saying no must work at every gate that can hold the user, and this one holds them on a listing.
  assert.equal(nodes.present_offers.next.cancel, 'cancelled');
});

test('the planner names every node that can hold the user on a comparison', () => {
  // `requestText` is NOT refreshed on a resumed turn unless the planner copies the reply into it, and the
  // rule that does the copying lists the nodes it applies to BY NAME. Moving the pause to `present_offers`
  // moved it out of that list: live, "취소" resumed the flow and `choose_offer` re-sent the PREVIOUS turn's
  // "싼 순서로 보여줘" — the user asked to stop and was shown the listing again.
  const common = parseFlow('_common/flows.yaml');
  const flow = common.flows.shopping_multi_store_total_cost;
  const planner = String(common.planner?.rules ?? common.planner?.prompt ?? '');
  const browsing = planner.slice(planner.indexOf('COMPARISON BROWSING FOLLOW-UP'));
  assert.ok(planner.includes('COMPARISON BROWSING FOLLOW-UP'), 'the browsing follow-up rule must exist');
  // A node holds the user exactly when something routes `ask` to it. The flow's ENTRY is exempt: a reply
  // there is the request itself, and both `continue_current` and `replace_current` set `requestText` from
  // the message. Every other holder is showing a NUMBERED window, where "3번" reads like a new request
  // and the planner has to be told otherwise — by name.
  const holders = new Set();
  for (const node of Object.values(flow.nodes ?? {})) {
    if (typeof node?.next?.ask === 'string') holders.add(node.next.ask);
  }
  // The flow declares no `entry:` — the first node IS the entry, which is how the runtime reads it.
  holders.delete(Object.keys(flow.nodes)[0]);

  const unnamed = [...holders].filter((id) => !planner.includes(id));
  assert.deepEqual(unnamed, [], `the planner cannot refresh the reply for: ${unnamed.join(', ')}`);
  assert.ok(browsing.includes('present_offers'), 'the presenter is what holds the user on the comparison now');
});

test('no model node stands between the comparison and the cart', () => {
  // Live, twice: "취소" added an offer to a real cart, because an `action_unit` in this loop re-sent the
  // previous turn's "3번". `currentUserText: active_node_only` gives it the text of the turn IT was active
  // for, and the flow pauses at the deterministic presenter — so the gate never saw the word "취소".
  //
  // The Thumbtack shortlist has no model node in its loop for exactly this reason. Neither does this one.
  const flow = parseFlow('_common/flows.yaml').flows.shopping_multi_store_total_cost;
  const presenter = flow.nodes.present_offers;

  assert.equal(presenter.kind, 'action_contract');
  assert.ok(presenter.inputSelector.includes('requestText'), 'the pausing node must read the reply');
  assert.deepEqual(
    { select: presenter.next.select, cancel: presenter.next.cancel, page: presenter.next.page, refine: presenter.next.refine },
    { select: 'resolve_offer', cancel: 'cancelled', page: 'browse_offers', refine: 'browse_offers' },
  );

  // Reachability, not just absence: a node left in the file but unrouted is still a node someone re-wires.
  const reachable = new Set(['collect_request']);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [id, node] of Object.entries(flow.nodes)) {
      if (!reachable.has(id)) continue;
      for (const target of Object.values(node.next ?? {})) {
        if (typeof target === 'string' && !reachable.has(target)) { reachable.add(target); changed = true; }
      }
    }
  }
  assert.ok(!reachable.has('choose_offer'), 'the model gate must be gone from the loop, not merely bypassed');
});

test('every field a contract node selects is one its tool declares', () => {
  // Undeclared state is DROPPED: a runtime tool is projected by `parameters.properties`, so a field in
  // `inputSelector` that the schema never names simply does not arrive. Live, the presenter selected
  // `requestText` and declared only `choice_stage`/`comparison_id`/`view_page` — the user typed "취소" and
  // the window came back, because the node was reading a field it had asked for and never received.
  //
  // Silent on both sides: the selector looks right, the schema looks right, and nothing errors.
  const dropped = [];

  for (const layer of productionFlowLayers()) {
    const doc = parseFlow(layer);
    for (const [flowId, flow] of Object.entries(doc.flows ?? {})) {
      for (const [nodeId, node] of Object.entries(flow?.nodes ?? {})) {
        if (node?.kind !== 'action_contract') continue;
        const tool = doc.flowTools?.[node.id];
        const declared = tool?.parameters?.properties;
        if (!declared) continue;
        for (const field of node.inputSelector ?? []) {
          if (!Object.hasOwn(declared, field)) dropped.push(`${layer} ${flowId}.${nodeId}: selects ${field}, ${node.id} never declares it`);
        }
      }
    }
  }

  assert.deepEqual(dropped, [], `state selected but dropped:\n  ${dropped.join('\n  ')}`);
});

/** The keys a Lua function hands back, read from the `return { ... }` tables in its body. */
function returnedKeys(file, functionName) {
  const source = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
  const start = source.indexOf(`function ${functionName}(`);
  if (start < 0) return [];
  const end = source.indexOf('\nend', start);
  const body = source.slice(start, end < 0 ? undefined : end);
  const keys = new Set();
  for (const table of body.matchAll(/return\s*\{([^}]*)\}/g)) {
    for (const key of table[1].matchAll(/(\w+)\s*=/g)) keys.add(key[1]);
  }
  return [...keys];
}

test('a branch value the presenter computes actually reaches the next node', () => {
  // `AX_RPC_OFFERS.present` reads the reply and answers `page`/`select`/`refine` WITH the payload that
  // makes the branch mean something — which page, which number, which words. The tool published only
  // `next`, so `browse_offers` was told to page and given nothing to page with, and `resolve_offer` was
  // told to select with no index. A field a script computes and the flow never publishes is a field the
  // script did not compute.
  const common = parseFlow('_common/flows.yaml');
  const published = new Set(Object.keys(common.flowTools.present_store_offers.output ?? {}));
  // `ok` is the script's own success flag and no node routes on it.
  const computed = returnedKeys('_common/rpc/73_rpc_offers.lua', 'O.present').filter((key) => key !== 'ok');

  const lost = computed.filter((key) => !published.has(key));
  assert.deepEqual(lost, [], `computed but never published: ${lost.join(', ')}`);
});

/** The module file and dotted name a tool's entry Lua dispatches to, or null when it is not a single call. */
function entryTarget(tool) {
  const body = typeof tool?.execute?.lua === 'string' ? tool.execute.lua : '';
  const call = body.match(/\b(AX_RPC_[A-Z_]+)\.(\w+)\s*\(/);
  if (!call) return null;
  const [, global, fn] = call;
  for (const directory of ['rpc', 'scripts']) {
    const dir = fileURLToPath(new URL(`../_common/${directory}/`, import.meta.url));
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.lua')) continue;
      const source = readFileSync(dir + name, 'utf8');
      if (!source.includes(`${global} = ${global} or {}`)) continue;
      const alias = source.match(new RegExp(`local (\\w+) = ${global}\\b`));
      const dotted = `${alias ? alias[1] : global}.${fn}`;
      if (!source.includes(`function ${dotted}(`)) return null;
      return { file: `_common/${directory}/${name}`, name: dotted, source };
    }
  }
  return null;
}

/** The body of one Lua function, for asking whether an identifier is produced there at all. */
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const end = source.indexOf('\nend', start);
  return source.slice(start, end < 0 ? undefined : end);
}

/**
 * Where to look for the key a tool publishes. Three sources, in order of how directly they answer:
 *
 * 1. The tool's OWN entry lua. Some entries are a `function run(args)` wrapper that calls a module and then
 *    assembles their answer — `capture_memory_clause` adds `confirmed`, `recall_saved_contact` builds
 *    `recalled_contact`. Scoping past the wrapper reported both as impossible when the wrapper produces them.
 * 2. The dispatched function's body, which is the whole truth when it returns literal tables.
 * 3. Every declared module, but ONLY when the function hands a table straight back (`return shown`,
 *    `return result`) — the keys then belong to whatever it wrapped, and scoping to its own body reported
 *    `question` and `selected_offer` missing while both are produced one call away.
 *
 * A gate that cries wolf is one nobody reads, so each widening here is a measured false positive removed.
 */
function producedIn(tool, target) {
  const entry = typeof tool.execute?.lua === 'string' ? tool.execute.lua : '';
  const body = functionBody(target.source, target.name);
  if (!/return\s+[A-Za-z_]\w*\s*$/m.test(body)) return [entry, body].join('\n');
  const modules = [...moduleSources(tool.execute?.modules ?? []).values()];
  return [entry, body, ...modules].join('\n');
}

// A shared dispatcher answers the UNION of every command routed through it, so each tool publishing only
// its own subset is by design — `AX_RPC_PURE.run` returns `command`/`error` for all eight. Direction A is
// therefore a judgement call and stays a targeted test (the presenter, above). Direction B is not: a key
// the map names and the script cannot produce is ALWAYS NULL, and no design choice makes that fine.
const UNION_DISPATCHERS = ['P.run'];

test('a field the flow publishes is a field its script can actually produce', () => {
  // The one-tool, one-DIRECTION version of this sat right above and passed while three fields were dropped
  // one wrapper up. `output` is a projection: only mapped `result.*` keys reach state, so a key the map
  // names and the script never returns is null on every turn, silently. Each of these has cost a live turn
  // — `view_sort` reverted the user's chosen sort on every refine, `page_stop_reason` was null on every
  // page, `failures` starved the line that names which store hit a wall.
  //
  // Only single-dispatch tools are checkable (`return AX_RPC_X.y(args)`) and only `result.<one segment>`
  // mappings; the checked count is asserted so shrinking coverage fails here instead of going unnoticed.
  const common = parseFlow('_common/flows.yaml');
  const nulls = [];
  let checked = 0;
  let skipped = 0;

  for (const [id, tool] of Object.entries(common.flowTools ?? {})) {
    if (tool?.execute?.kind !== 'runtime' || typeof tool.output !== 'object' || tool.output === null) continue;
    const target = entryTarget(tool);
    if (!target || UNION_DISPATCHERS.includes(target.name)) { skipped += 1; continue; }
    checked += 1;
    const scope = producedIn(tool, target);
    // When the dispatched function returns only literal tables AND the entry does not assemble the key
    // itself, the tool's answer IS those tables, so membership is decidable exactly. That catches the
    // RENAME case the identifier scan cannot: `page_stop_reason: result.stop_reason` mentioned
    // `stop_reason` in the body — on the right-hand side of the rename the entry had already applied.
    const body = functionBody(target.source, target.name);
    const entry = typeof tool.execute?.lua === 'string' ? tool.execute.lua : '';
    const exact = !/return\s+[A-Za-z_]\w*\s*$/m.test(body) ? new Set(returnedKeys(target.file, target.name)) : null;
    for (const [key, value] of Object.entries(tool.output)) {
      if (typeof value !== 'string' || !/^result\.\w+$/.test(value)) continue;
      const source = value.slice('result.'.length);
      const assembled = new RegExp(`\\b${source}\\s*=`).test(entry);
      if (exact && !assembled && !exact.has(source)) {
        nulls.push(`${id}.output.${key} reads result.${source}, ${target.name} returns [${[...exact].join(', ')}]`);
      } else if (!new RegExp(`\\b${source}\\b`).test(scope)) {
        nulls.push(`${id}.output.${key} reads result.${source}, ${target.name} never produces it`);
      }
    }
    // A branch expression reads the same result, and there is no model to be forgiving about a wrong path:
    // `find_delete_candidates` routed on `{var: result.keys.0}` while its script answers
    // `memory_result.matches`, so every successful search took the `not_found` branch. Only the FIRST
    // segment is checkable — the rest is the op's own payload shape — and that is exactly the segment that
    // was wrong.
    const vars = new Set();
    const collect = (value) => {
      if (Array.isArray(value)) return value.forEach(collect);
      if (typeof value !== 'object' || value === null) return;
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'var' && typeof inner === 'string' && inner.startsWith('result.')) {
          vars.add(inner.slice('result.'.length).split('.')[0]);
        } else collect(inner);
      }
    };
    collect(tool.output);
    collect(tool.next);
    for (const source of vars) {
      if (!new RegExp(`\\b${source}\\b`).test(scope) && !new RegExp(`\\b${source}\\s*=`).test(entry)) {
        nulls.push(`${id} branches on result.${source}, ${target.name} never produces it`);
      }
    }
  }

  assert.deepEqual(nulls, [], `published but never computed (always null):\n  ${nulls.join('\n  ')}`);
  assert.ok(checked >= 15, `only ${checked} tools were checkable (skipped ${skipped}) — coverage shrank`);
});

/** Every module file a tool loads, as source text keyed by module id. */
function moduleSources(moduleIds) {
  const sources = new Map();
  for (const moduleId of moduleIds) {
    const name = moduleId.replace(/^_common\./, '');
    const file = ['rpc', 'scripts']
      .map((directory) => fileURLToPath(new URL(`../_common/${directory}/${name}.lua`, import.meta.url)))
      .find((candidate) => existsSync(candidate));
    if (file) sources.set(moduleId, readFileSync(file, 'utf8'));
  }
  return sources;
}

/**
 * Hosts fetched from a function the tool's entry can actually reach.
 *
 * A bare `https://` literal is not evidence — storefront URLs are navigation targets, and granting egress
 * for those would be wrong. Neither is loading a module: `00_base` ships a geocode fetch behind
 * `resolve_zip`, and the store tools load it without ever calling that. So: walk names from the entry.
 */
function reachableFetchHosts(execute) {
  const sources = moduleSources(execute.modules ?? []);
  const reachable = new Set();
  let frontier = [...(execute.lua ?? '').matchAll(/AX_RPC_[A-Z_]+\.(\w+)\s*\(/g)].map((match) => match[1]);

  while (frontier.length) {
    const fn = frontier.pop();
    if (reachable.has(fn)) continue;
    reachable.add(fn);
    for (const source of sources.values()) {
      const start = source.search(new RegExp(`function\\s+(?:[\\w.]+\\.)?${fn}\\s*\\(`));
      if (start < 0) continue;
      const end = source.indexOf('\nend', start);
      const body = source.slice(start, end < 0 ? undefined : end);
      // Both shapes: `C.fetch_fx_rates(...)` through a module table, and a bare global `AX_collect_...(`.
      for (const call of body.matchAll(/\b(?:[A-Z][\w]*\.)?(\w+)\s*\(/g)) frontier.push(call[1]);
    }
  }

  const hosts = new Set();
  for (const source of sources.values()) {
    for (const call of source.matchAll(/\bfetch\(\s*(?:"https:\/\/([\w.-]+)|([\w.]+)\s*\.\.)/g)) {
      // Which function holds this fetch: the last one opened before it.
      const before = source.slice(0, call.index);
      const owner = [...before.matchAll(/function\s+(?:[\w.]+\.)?(\w+)\s*\(/g)].pop();
      if (!owner || !reachable.has(owner[1])) continue;
      if (call[1]) { hosts.add(call[1]); continue; }
      const constant = source.match(new RegExp(`${call[2].replace('.', '\\.')}\\s*=\\s*"https://([\\w.-]+)`));
      if (constant) hosts.add(constant[1]);
    }
  }
  return [...hosts];
}



test('a tool that fetches over the network declares the host it reaches', () => {
  // `rpc.allow` grants OPS; network egress is a SEPARATE `net:` block on the tool's `execute`, and a
  // capability declared in the wrong place is indistinguishable from a missing one. Without it the runtime
  // has no `net` table at all, so the code takes its own "no fetch available" path and says so quietly.
  //
  // Live, every offer: `cost_error: "fx_fetch_unavailable"` — no `price_base`, so no total, so a
  // total-cost comparison that never showed a total. Six rows of "총 미확인" with the shipping cost printed
  // right next to the price.
  const common = parseFlow('_common/flows.yaml');
  const unreachable = [];

  for (const [toolId, tool] of Object.entries(common.flowTools ?? {})) {
    const execute = tool?.execute;
    if (execute?.kind !== 'runtime' || typeof execute.lua !== 'string') continue;
    const allowed = new Set(execute.net?.allow ?? []);
    for (const host of reachableFetchHosts(execute)) {
      if (!allowed.has(host)) unreachable.push(`${toolId}: fetches ${host}, not in net.allow`);
    }
  }

  assert.deepEqual(unreachable, [], `hosts reached but never granted:\n  ${unreachable.join('\n  ')}`);
});

test('the planner may not ask what to compare while a comparison is on screen', () => {
  // Live: "미확인 포함" — a phrase the rule already lists by name, printed by the window itself as the way
  // to unfold rows — came back as "어떤 제품을 비교하고 싶으신가요?". The rule told the planner to continue
  // the flow but never told it not to CLARIFY, and clarifying throws the listing away just as replacing it
  // does. A window that advertises a way out has to have one.
  //
  // This gate can only check that the instruction is present; whether the model obeys is measured live.
  const doc = parseFlow('_common/flows.yaml');
  const planner = String(doc.planner?.rules ?? doc.planner?.prompt ?? '');
  const rule = planner.slice(planner.indexOf('COMPARISON BROWSING FOLLOW-UP'));

  assert.match(rule, /never ask for clarification/i, 'the rule must forbid the failure that actually happened');
  assert.match(rule, /names no product/i, 'and give the planner a decidable test, not a list of examples');
});

/** Tools in a flow document that would execute through the durable path. */
function durableTools(doc) {
  return Object.entries(doc.flowTools ?? {})
    .filter(([, tool]) => tool?.execute?.kind === 'remote')
    .map(([id]) => id);
}

test('no production flow tool executes durably, and the check can say so', () => {
  // Durable execution is gone from production on purpose: a cross-nav resume measured 12–21s, and every
  // page tool is re-entrant instead. This locks it — the entry-only check above would let a remote tool
  // in one hop later, which is exactly where they used to live.
  //
  // Playground keeps three deliberately (`AX_playground_durable_checkpoint`, `AX_playground_open_site`,
  // `AX_search_product`): it is the durable-vs-runtime demo, and that is the whole point of it.
  for (const layer of productionFlowLayers()) {
    assert.deepEqual(durableTools(parseFlow(layer)), [], `${layer} still executes durably`);
  }

  // A check that cannot fail is not a check: prove this one flags a remote tool before trusting the pass.
  assert.deepEqual(
    durableTools({ flowTools: { legacy: { execute: { kind: 'remote', tool: 'AX_legacy' } } } }),
    ['legacy'],
  );
});

test('the playground has no durable tools left either', () => {
  // The playground was the last place durable survived, and it was not a clean split: the checkpoint
  // flow genuinely verified durable state, while three tools still reached `AX_search_product` through
  // the durable path even though a runtime twin (`rpc_storefront_search`) already sat beside them.
  //
  // Two paths doing the same job is the drift this repo keeps paying for, so the playground runs the
  // same runtime path production does.
  const doc = parseFlow('playground/_common/flows.yaml');
  assert.deepEqual(durableTools(doc), []);
});

test('the playground no longer tells the user about a durable grant', () => {
  // The terminals explained a failure in terms of `lua.operations` grants for commands that are gone:
  // "the host must register AX_search_product in lua.operations". A user following that would go looking
  // for a grant nothing asks for any more, and the goal text still promised a "durable-v2 entry command".
  //
  // Wording that survives the mechanism it describes is a wrong answer with a long half-life.
  // Checked on the parsed document, not the raw text: a comment recording why durable was removed is
  // history worth keeping, while a `goal`, `description` or `respond` the user reads is a promise.
  const doc = parseFlow('playground/_common/flows.yaml');
  const stale = [];
  const visit = (node, path) => {
    if (typeof node === 'string') {
      // Case-insensitive: "Durable checkpoint fixture completed" slipped past a case-sensitive pattern
      // and shipped as the terminal the user reads.
      if (/durable|lua\.operations|AX_search_product|AX_playground_/i.test(node)) stale.push(path);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (['goal', 'description', 'respond', 'prompt'].includes(key) || typeof value === 'object') {
        visit(value, `${path}.${key}`);
      }
    }
  };
  visit(doc.flows ?? {}, 'flows');
  visit(doc.router ?? {}, 'router');

  assert.deepEqual(stale, [], `playground text still promises durable:\n  ${stale.join('\n  ')}`);
});

test('the playground ships no durable command and asks for no durable grant', () => {
  // The flows stopped executing durably first; the command layer behind them kept shipping. A command
  // nothing calls is not harmless here — `PLAYGROUND_LUA_OPERATIONS` writes a `lua.operations` GRANT for
  // each one into the extension config, so the profile kept requesting durable capabilities for a
  // mechanism no flow reaches.
  //
  // The two pings stay: they are how the CLI proves the common and site Lua layers actually loaded, and
  // neither touches durable.
  const scripts = fileURLToPath(new URL('../playground/_common/scripts', import.meta.url));
  const shipped = [];
  for (const name of readdirSync(scripts).filter((file) => file.endsWith('.lua'))) {
    const source = readFileSync(`${scripts}/${name}`, 'utf8');
    for (const [, command] of source.matchAll(/^function (AX_[A-Za-z0-9_]+)\(/gm)) shipped.push(command);
  }
  assert.deepEqual(shipped.sort(), ['AX_playground_common_ping']);

  const durableGrants = readFileSync(fileURLToPath(new URL('../tools/playground/store.mjs', import.meta.url)), 'utf8')
    .match(/PLAYGROUND_LUA_OPERATIONS = Object\.freeze\(\[([\s\S]*?)\]\)/)?.[1] ?? '';
  assert.equal(durableGrants.trim(), '', 'a durable grant for a mechanism no flow reaches is a grant nobody audits');
});

test('a fallback names a branch its node declares, not a node', () => {
  // `invalidNext`/`exhaustedNext`/`stalledNext` take a BRANCH KEY, and the resemblance to a node name is
  // the trap: the worker routed `next: { complete: complete }`, so `invalidNext: complete` read fine —
  // until the branches became `done`/`error` and the whole document stopped compiling with
  // `actions.playground_search_worker.fallback references undeclared next: complete`.
  //
  // A whole-document compile failure answers EVERY intent with "플로우 설정을 불러오지 못했습니다", so
  // this is worth catching before a live turn does.
  const broken = [];
  for (const layer of productionFlowLayers().concat(['playground/_common/flows.yaml'])) {
    const doc = parseFlow(layer);
    for (const [flowId, flow] of Object.entries(doc.flows ?? {})) {
      for (const [nodeId, node] of Object.entries(flow?.nodes ?? {})) {
        for (const key of ['invalidNext', 'exhaustedNext', 'stalledNext']) {
          const branch = node?.fallback?.[key];
          if (branch && !(node.next ?? {})[branch]) {
            broken.push(`${layer} ${flowId}.${nodeId}.${key} -> ${branch}`);
          }
        }
      }
    }
  }
  assert.deepEqual(broken, [], `fallbacks naming undeclared branches:\n  ${broken.join('\n  ')}`);
});

/** The affiliate program a site config declares, read from the generated site data. */
function affiliatePrograms() {
  const source = readFileSync(fileURLToPath(new URL('../_common/rpc/62_rpc_sites.lua', import.meta.url)), 'utf8');
  const found = {};
  let site = null;
  for (const line of source.split('\n')) {
    const header = line.match(/^RPC_SITES\["([\w-]+)"\]/);
    if (header) { site = header[1]; continue; }
    const program = line.match(/^\s*program = "([\w-]+)"/);
    if (program && site) found[site] = program[1];
  }
  return found;
}

/** One site block of the generated site data, keyed by site. */
function siteBlocks() {
  const source = readFileSync(fileURLToPath(new URL('../_common/rpc/62_rpc_sites.lua', import.meta.url)), 'utf8');
  const blocks = {};
  let site = null;
  for (const line of source.split('\n')) {
    const header = line.match(/^RPC_SITES\["([\w-]+)"\]/);
    if (header) { site = header[1]; blocks[site] = []; continue; }
    if (site) blocks[site].push(line);
  }
  return Object.fromEntries(Object.entries(blocks).map(([key, lines]) => [key, lines.join('\n')]));
}

// A cart drawer holding SOMEONE ELSE'S item is not evidence that this add happened. Measured 2026-08-16:
// `cart_contains` consults `confirmation_selector` OFF the cart page, where the only honest evidence is a
// per-add panel — and amazon, walmart, etsy and coupang each listed cart STRUCTURE there
// (`#sc-active-cart, .sc-list-item[data-asin]`, `[data-testid="cart-drawer"] [data-testid="cart-item"]`,
// `[data-cart-listing-id]`, `[data-cart-item-id]`).
// A persistent mini-cart therefore made the probe true on ARRIVAL, `add_to_cart` skipped its whole block
// (67_rpc_cart.lua guards it with `if not cart_contains(...)`), and the tool reported `added = true` with
// no click. That is the same defect the id-probe fix closed in the code, coming back through the config.
//
// `confirmation_text_selectors` is held to the same rule: on the cart page it is the fallback consulted
// when the id does NOT match, so a structural or generic selector there confirms a cart holding anything.
// A name that says SUCCESS is per-add and stays allowed — gmarket's `[data-cart-layer="success"]` and
// ssg's `[data-layer-name="cart_success"]` are the panels this branch was written for. What is banned is a
// selector naming a cart's CONTENTS or its container, plus a generic live region that exists page-wide.
const CART_STRUCTURE = [
  /cart-item/i, /cart_item/i, /cart-listing/i, /cart-line/i,
  /cart-drawer/i, /sc-list-item/i, /sc-active-cart/i, /aria-live/i,
];

test('an off-cart confirmation selector names a per-add panel, never cart structure', () => {
  const offenders = [];
  for (const [site, block] of Object.entries(siteBlocks())) {
    for (const key of ['confirmation_selector', 'confirmation_text_selectors']) {
      // Either a single string or a table; both end at the next top-level key of the site block.
      const at = block.indexOf(`${key} = `);
      if (at < 0) continue;
      const rest = block.slice(at + key.length + 3);
      const value = rest.startsWith('{') ? rest.slice(0, rest.indexOf('}') + 1) : rest.slice(0, rest.indexOf('\n'));
      for (const pattern of CART_STRUCTURE) {
        if (pattern.test(value)) offenders.push(`${site}.${key} matches ${pattern} in ${value.replace(/\s+/g, ' ').trim()}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `cart structure used as per-add evidence:\n  ${offenders.join('\n  ')}`);
});

test('only a site with a real program carries one, and never amazon', () => {
  // Amazon's Operating Agreement forbids Special Links in client-side software (browser extensions
  // included, with an Approved Mobile App carve-out). Its offers still appear in the comparison — they
  // just must never be monetised from the extension, and the way to guarantee that is to make it
  // impossible to declare rather than remembering not to.
  //
  // Naver Shopping is excluded for a different reason: its adapter answers `access_denied` by design,
  // so there is no listing to link to.
  const programs = affiliatePrograms();

  assert.equal(programs.amazon, undefined, 'an Amazon affiliate link may not exist in the extension');
  assert.equal(programs['naver-shopping'], undefined, 'a bot-walled store has no offer to monetise');
  assert.deepEqual(Object.keys(programs).sort(), ['coupang'], 'PoC monetises Coupang only');
  for (const [site, program] of Object.entries(programs)) {
    assert.equal(program, 'coupang', `${site} declares an unknown program: ${program}`);
  }
});

test('the affiliate tool cannot navigate, and reaches only our own server', () => {
  // Two policy rules made structural instead of remembered. Coupang forbids forced redirects, so the
  // tool is granted no `nav.*` and therefore cannot move the tab at all. And the signing keys live
  // server-side, so the extension's only egress is our conversion endpoint — a key in the bundle is a
  // key anyone can lift and earn on.
  const tool = parseFlow('_common/flows.yaml').flowTools.shopping_affiliate_link;

  for (const op of tool.execute.rpc.allow) {
    assert.doesNotMatch(op, /^nav\./, `a link tool granted ${op} can force a redirect`);
  }
  assert.deepEqual(tool.execute.net.allow, ['api.axsdk.ai'], 'the extension never calls an affiliate API directly');
  assert.equal(tool.execute.net.maxCalls, 1);
});

test('an affiliate link is only reachable after the user picked an offer', () => {
  // CWS requires the link to follow a user action and to attach to a direct benefit at that moment. The
  // action is the number typed at the comparison window, so every path into the tool must pass the
  // presenter's `select` branch — reachability, not a comment saying so.
  const flow = parseFlow('_common/flows.yaml').flows.shopping_multi_store_total_cost;
  const holder = Object.entries(flow.nodes).find(([, n]) => n.id === 'shopping_affiliate_link');
  assert.ok(holder, 'the affiliate node must exist');
  const [affiliateNode] = holder;

  const feeders = Object.entries(flow.nodes)
    .filter(([, n]) => Object.values(n.next ?? {}).includes(affiliateNode))
    .map(([id]) => id);
  assert.deepEqual(feeders, ['resolve_offer'], 'only the resolved pick may reach it');
  assert.equal(flow.nodes.present_offers.next.select, 'resolve_offer');
});

test('the terminal cannot show a link without its disclosure', () => {
  // A link without the disclosure is the violation. The Lua produces the two together, and the terminal
  // that renders them is instructed to print the disclosure verbatim — checked here because the wording
  // is the only place a reviewer would otherwise have to trust.
  const flow = parseFlow('_common/flows.yaml').flows.shopping_multi_store_total_cost;
  const terminal = flow.nodes.report_link;

  assert.equal(terminal.kind, 'terminal');
  assert.ok(terminal.inputSelector.includes('affiliate_disclosure'));
  assert.match(terminal.respond, /disclosure/i);
  assert.match(terminal.respond, /verbatim/i);
  // It must never claim a purchase: the user opens the link themselves and buys on the store.
  assert.match(terminal.respond, /Never claim anything was purchased/i);
});

test('a store with no program still reaches the cart path it had before', () => {
  // Nine of the ten stores are not monetisable. The affiliate hop must be transparent for them, or this
  // feature quietly removes a working one.
  const flow = parseFlow('_common/flows.yaml').flows.shopping_multi_store_total_cost;
  const node = Object.values(flow.nodes).find((n) => n.id === 'shopping_affiliate_link');

  assert.equal(node.next.no_program, 'add_selected_offer');
  assert.equal(node.fallback.invalidNext, 'no_program', 'an unexpected answer must not strand the pick');
});

// A node that repeats `defaults.model` verbatim is 16 copies of one decision, and the copies are what
// drift: change the model and fifteen nodes keep the old one, silently, because each is valid on its own.
// Measured before the deletion: 16 node-level blocks, every one byte-identical to the default and to each
// other. `FLOWS_IMPROVEMENTS.md` item 1.
test('no node repeats the default model block', () => {
  const normalise = (text) => text.replace(/#[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  for (const path of ['_common/flows.yaml', 'playground/_common/flows.yaml']) {
    if (!existsSync(new URL(path, root))) continue;
    const source = read(path).replace(/\r\n/g, '\n');
    const defaults = /^defaults:\n(?:[ \t].*\n)*/m.exec(source);
    if (!defaults) continue;
    const fallback = /^ {2}model:\n((?: {4}.*\n)+)/m.exec(defaults[0]);
    if (!fallback) continue;
    const wanted = normalise(fallback[1]);

    const repeats = [...source.matchAll(/^([ \t]{3,})model:\n((?:\1[ \t].*\n)+)/gm)]
      .filter((match) => normalise(match[2]) === wanted);

    assert.equal(repeats.length, 0,
      `${path}: ${repeats.length} node(s) repeat defaults.model verbatim — delete them and let the default carry it`);
  }
});

// §13 recorded "Every model node has a stall guard" as settled, and it was not true: measured 14
// `action_unit` nodes with 6 guarded, 8 unguarded, and no `defaults.fallback` to cover them. The bug the
// guard exists for is on the record — a repeating tool error burned the step budget in silence, one live turn
// spending 176s repeating `choose_offer → browse_offers` seven times and saying nothing — and two of the
// unguarded nodes are gates that HOLD the user (`refine_item`, `checkout_confirm`). A false settled finding
// is worse than no finding, because nobody re-checks it.
test('every model node has a stall guard that names a real node', () => {
  const files = ['_common/flows.yaml', 'bluemoonsoft/flows.yaml', 'thumbtack/flows.yaml',
    'playground/_common/flows.yaml'];
  const missing = [];
  const dangling = [];
  for (const path of files) {
    if (!existsSync(new URL(path, root))) continue;
    const document = parseFlow(path);
    if (document.defaults?.fallback !== undefined) continue; // a document-wide guard covers its nodes
    for (const [flowName, flow] of Object.entries(document.flows ?? {})) {
      const nodes = flow?.nodes ?? {};
      for (const [nodeName, node] of Object.entries(nodes)) {
        if (node?.kind !== 'action_unit') continue;
        const target = node.fallback?.stalledNext;
        const where = `${path} ${flowName}.${nodeName}`;
        if (target === undefined || node.fallback?.maxStalledSteps === undefined) { missing.push(where); continue; }
        // A fallback target is a BRANCH KEY of this node's own `next` map, never a node name — measured
        // across every existing fallback in the document: all of them are branch keys and most name no node
        // at all (`invalidNext: done` where `next.done: shopping_done`). A guard pointing nowhere is worse
        // than none: it looks handled and fails the whole document.
        if (!Object.prototype.hasOwnProperty.call(node.next ?? {}, target)) {
          dangling.push(`${where} -> ${target}`);
        }
      }
    }
  }
  assert.deepEqual(missing, [], 'model nodes with no stall guard');
  assert.deepEqual(dangling, [], 'stall guards naming a node that does not exist');
});

// §13's worst live incident is this shape: the user typed 취소 and the offer was ADDED TO CART, because a
// model gate re-sent the previous turn's "3번". `messagePolicy: { currentUserText: active_node_only }` hands
// an `action_unit` the text of the turn IT was active for. The fix reached `choose_product` and the
// conformance test pinned that ONE node — while three approval gates kept the shape: `confirm_quote` (sends
// a quote), `checkout_confirm` (proceeds to checkout) and `refine_item` (leads to a cart add).
//
// So the gate is written the other way round: EVERY self-looping `action_unit` must either declare the policy
// or be listed here with the reason it must not. A new gate then fails until someone decides which it is,
// instead of inheriting the default that already cost a wrong cart mutation.
const COLLECTORS_WITHOUT_ACTIVE_NODE_ONLY = {
  // A collector is entered with the user's request and the ORIGINAL text is exactly what it must read;
  // withholding it after an automatic transition would starve the node that opens the flow.
  'request_service_quote.collect_request': true,
  'shopping_single_site.collect_shopping': true,
  'shopping_multi_store_total_cost.collect_request': true,
  // Navigation-only, no mutation behind it: the worst a stale text can do is open the wrong page, which the
  // next turn corrects. bluemoonsoft never fills or submits a form.
  'bluemoonsoft.assist': true,
};

test('every self-looping model gate has decided about active_node_only', () => {
  const files = ['_common/flows.yaml', 'bluemoonsoft/flows.yaml', 'thumbtack/flows.yaml',
    'playground/_common/flows.yaml'];
  const undecided = [];
  for (const path of files) {
    if (!existsSync(new URL(path, root))) continue;
    const document = parseFlow(path);
    if (document.defaults?.messagePolicy?.currentUserText === 'active_node_only') continue;
    for (const [flowName, flow] of Object.entries(document.flows ?? {})) {
      for (const [nodeName, node] of Object.entries(flow?.nodes ?? {})) {
        if (node?.kind !== 'action_unit') continue;
        const loops = Object.values(node.next ?? {}).some((target) => target === nodeName);
        if (!loops) continue;
        if (node.messagePolicy?.currentUserText === 'active_node_only') continue;
        if (COLLECTORS_WITHOUT_ACTIVE_NODE_ONLY[`${flowName}.${nodeName}`] === true) continue;
        undecided.push(`${path} ${flowName}.${nodeName}`);
      }
    }
  }
  assert.deepEqual(undecided, [],
    'self-looping model gates that neither declare active_node_only nor say why they must not');
});

// §13: "Saying no MUST work at every gate" — recorded for the quote flow, where cancel reaches
// `quote_cancelled` from three gates. Measured across the whole document: memory, the quote flow and the
// multi-store comparison all have cancel routes, and `shopping_single_site` — which pauses at three gates and
// mutates at `add_item`, `checkout_confirm` and `do_checkout` — had NONE. Live, in one session: at its
// `refine_item` gate a reply of "취소" was routed into the multi-store flow and answered "어떤 제품을 비교하고
// 싶으신가요?", starting a fresh comparison instead of stopping. The cart was not mutated, so it failed safe,
// but the user's no did nothing.
//
// The rule needs no allowlist: a flow that cannot mutate has nothing to cancel (bluemoonsoft pauses and only
// navigates), and a flow that never pauses never holds a user to say no.
test('every node that HOLDS the user in a mutating flow can be told no', () => {
  // This was written per FLOW — any one node with a cancel branch satisfied the whole document — and that is
  // one node protected, not a rule. Measured 2026-08-16: `shopping_multi_store_total_cost.collect_request`
  // holds the user with `enum: [ask, done]`, no `cancel` branch and no cancel instruction in its prompt,
  // while the planner prompt promises "the flow owns its own cancel path". A refusal routed back there can
  // only be answered `ask` (re-question) or `done` (start comparing) — the user's no does nothing. The flow
  // passed the old check because `choose_product` and `present_offers` do have cancel branches.
  //
  // A pausing node is one its own `next` map routes back to itself. No allowlist: a flow that cannot mutate
  // has nothing to cancel (bluemoonsoft pauses and only navigates), and a node that never pauses never holds
  // a user to say no.
  // Mutation is DECLARED (`effect: mutation`, which the compiler enforces), and this used to guess it from
  // node names: `/add_.*cart|submit_quote|checkout|…/`. The multi-store flow mutates through
  // `shopping_add_selected_store_offer` and matched none of those words, so the flow holding the actual gap
  // was never examined at all — and any rename would have taken another flow out of scope silently.
  const gaps = [];
  for (const path of ['_common/flows.yaml', 'bluemoonsoft/flows.yaml', 'thumbtack/flows.yaml']) {
    if (!existsSync(new URL(path, root))) continue;
    const document = parseFlow(path);
    const declaresMutation = (node) => [node?.id, ...(node?.allowedTools ?? [])]
      .filter(Boolean)
      .some((tool) => document.flowTools?.[tool]?.effect === 'mutation');
    for (const [flowName, flow] of Object.entries(document.flows ?? {})) {
      const nodes = flow?.nodes ?? {};
      if (!Object.values(nodes).some(declaresMutation)) continue;
      const cancelExit = (target) => Object.entries(nodes[target]?.next ?? {})
        .some(([branch, to]) => /^cancel/.test(branch) && nodes[to]?.kind === 'terminal');
      for (const [name, node] of Object.entries(nodes)) {
        const routes = Object.entries(node?.next ?? {});
        if (!routes.some(([, target]) => target === name)) continue;
        // One hop is enough, and it has to be: a renderer pauses on its own `ask` and hands the REPLY to a
        // classifier on the next pass — `present_results` routes `refine` to `browse_candidates`, which has
        // the cancel branch. That happens inside the same user turn, so the refusal is answered. What is not
        // answered is a node whose successors cannot cancel either, which is where the collector sat.
        const covered = cancelExit(name)
          || routes.some(([branch, target]) => target !== name && branch !== 'error' && cancelExit(target));
        if (!covered) gaps.push(`${path} ${flowName}.${name} holds the user and no cancel branch is reachable`);
      }
    }
  }
  assert.deepEqual(gaps, [], `nodes that hold the user before a mutation with no way to say no:\n  ${gaps.join('\n  ')}`);
});

// The other direction of the three-parallel-lists problem. Selected-but-not-declared is already gated (§13: a
// field selected but not DECLARED is dropped in silence). The reverse — a contract tool declaring state its
// node never selects — is not a schema error and never throws: the argument is simply always nil, so the
// declaration reads like a channel that exists.
//
// That is exactly how the two-channel bug got in. §13: "One channel for the listing, or two can disagree about
// which offers were numbered" — the pick read `offers` from its own state field while the listing lived in the
// snapshot, and live it answered `offers: Invalid input: expected array, received null` one turn before a cart
// approval. Measured here: `shopping_refine_store_offers` still declared `offers`/`all_offers` (its module
// rebuilds them from the restored snapshot) and `shopping_add_selected_store_offer` still declared
// `comparison_state` (its modules do not even load the one that restores a snapshot). Leaving them declared
// invites someone to write to the channel that was deliberately replaced.
//
// `action_unit` is excluded on purpose: its `parameters.properties` are the MODEL's arguments and have nothing
// to do with what the node selects.
// The playground's three search fixtures declare properties no single node selects, and it is NOT drift: the
// shared module accepts TWO envelopes on purpose, and says so in its own doc comment — "`site` may arrive flat
// or as the worker's `item.site`, `query` flat or as `context.query` — the same envelope the production fan-out
// uses, where reading only the flat key made every store refuse" (19_rpc_playground_search.lua). The code
// matches: `query = args.query` falling back to `context.query`, and `P.site_of` reading `args.site` else
// `args.item.site`. So the direct callers select `query` and the mapped caller selects the map carrier
// (`item`/`index`/`key`/`context`, which §13 says to declare), and each tool declares both shapes because
// either can arrive.
//
// They are listed rather than deleted because the declaration mirrors a contract instead of drifting from one —
// the opposite of production's three, which were proven dead by their modules (one rebuilds the fields from the
// restored snapshot, the other never loads the module that reads them). Reviewed 2026-08-16; an entry here needs
// the module's own contract to justify it, and `index`/`key` are read by no playground module at all — they are
// the platform's map envelope, carried faithfully.
const UNEXERCISED_PLAYGROUND_FIXTURES = {
  'playground_search_amazon_fixture.site': true,
  'playground_search_amazon_fixture.item': true,
  'playground_search_amazon_fixture.index': true,
  'playground_search_amazon_fixture.key': true,
  'playground_search_amazon_fixture.context': true,
  'playground_search_shopping.site': true,
  'playground_search_shopping.item': true,
  'playground_search_shopping.index': true,
  'playground_search_shopping.key': true,
  'playground_search_shopping.context': true,
  'playground_search_worker.query': true,
  'playground_search_worker.site': true,
};

test('a contract tool declares only state some node hands over', () => {
  const stray = [];
  for (const path of ['_common/flows.yaml', 'bluemoonsoft/flows.yaml', 'thumbtack/flows.yaml',
    'playground/_common/flows.yaml']) {
    if (!existsSync(new URL(path, root))) continue;
    const document = parseFlow(path);
    const tools = document.flowTools ?? {};
    // One tool may back several nodes, each selecting its own subset — the playground's search fixture is
    // shared by three — so the tool legitimately declares the UNION. What no node selects is what is always
    // nil, whoever calls it. Production's mapped node is the shape to copy: `shopping_search_one_store.search`
    // lists `item`/`index`/`key`/`context` in its own selector and its tool declares exactly those six.
    const selectedPerTool = new Map();
    for (const flow of Object.values(document.flows ?? {})) {
      for (const node of Object.values(flow?.nodes ?? {})) {
        if (node?.kind !== 'action_contract' || !Array.isArray(node.inputSelector)) continue;
        const toolId = node.id ?? (node.allowedTools ?? [])[0];
        if (toolId === undefined) continue;
        const seen = selectedPerTool.get(toolId) ?? new Set();
        for (const field of node.inputSelector) seen.add(field);
        selectedPerTool.set(toolId, seen);
      }
    }
    for (const [toolId, selected] of selectedPerTool) {
      for (const property of Object.keys(tools[toolId]?.parameters?.properties ?? {})) {
        if (selected.has(property)) continue;
        // The engine injects `userMessages` into EVERY action node's state, so a tool with
        // `additionalProperties: false` MUST declare it whether or not a node selects it — measured: an empty
        // properties map was rejected with `Unrecognized key: "userMessages"` before the script ran. Declaring
        // an engine-injected field is not the drift this check exists to catch.
        if (property === "userMessages") continue;
        if (UNEXERCISED_PLAYGROUND_FIXTURES[`${toolId}.${property}`] === true) continue;
        stray.push(`${path} ${toolId} declares ${property}`);
      }
    }
  }
  assert.deepEqual(stray, [], 'contract tools declaring state that is always nil');
});

// `require` compares an argument to the value given, BY EQUALITY — measured against the two shapes in the
// document. `shopping_add_selected_store_offer` names strings to match
// (`cart_approval: user_selected_compared_offer`) and adds to a real cart live, 12/12. `shopping_add_to_cart`
// named `product_id: true`, meaning "the id must be the boolean true", and `"B0F34DXKZH" ~= true` — so the
// single-site cart add could NEVER have succeeded. Live it answered `adapter requirement failed: product_id`
// with the id sitting right there in the node's selected state, and a probe inside the tool never ran at all:
// the requirement is checked before the script.
//
// Presence is what `parameters.required` states. A `require` demanding `true` of a property the same tool
// declares as a non-boolean is a contradiction the document can check for itself.
test('a require never demands true of a property declared as something else', () => {
  const contradictions = [];
  for (const path of ['_common/flows.yaml', 'bluemoonsoft/flows.yaml', 'thumbtack/flows.yaml',
    'playground/_common/flows.yaml']) {
    if (!existsSync(new URL(path, root))) continue;
    const tools = parseFlow(path).flowTools ?? {};
    for (const [id, tool] of Object.entries(tools)) {
      for (const [key, wanted] of Object.entries(tool.require ?? {})) {
        if (wanted !== true) continue;
        const declared = tool.parameters?.properties?.[key]?.type;
        if (declared === undefined) continue; // a state marker the tool does not take as an argument
        const types = Array.isArray(declared) ? declared : [declared];
        if (!types.includes('boolean')) {
          contradictions.push(`${path} ${id}.require.${key} wants true but declares ${types.join('|')}`);
        }
      }
    }
  }
  assert.deepEqual(contradictions, [], 'requirements that no value of the declared type can satisfy');
});
