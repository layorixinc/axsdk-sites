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
  assert.equal(nodes.choose_offer.messagePolicy?.currentUserText, 'active_node_only');
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
  assert.equal(nodes.normalize_rank.next.done, 'choose_offer');
  assert.deepEqual(nodes.choose_offer.allowedTools, ['present_store_offers', 'choose_store_offer']);
  assert.ok(!nodes.choose_offer.inputSelector.includes('comparison_text'));
  assert.ok(!nodes.choose_offer.inputSelector.includes('offers'), 'offer approval must not inject the full ranked-offer payload into the model prompt');
  assert.ok(!nodes.choose_offer.inputSelector.includes('ambiguous_offers'));
  assert.ok(!nodes.choose_offer.inputSelector.includes('excluded_offers'));
  assert.equal(nodes.choose_offer.next.ask, 'choose_offer');
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
  assert.equal(Object.hasOwn(common.flowTools.choose_store_offer.parameters.properties, 'choice_stage'), false);

  // Browsing a comparison stays inside the two approved tools: paging and refinement travel as
  // `choose_store_offer` branches into one deterministic node, so no extra tool can reach the approval
  // turn and no offer payload is injected into the prompt.
  assert.deepEqual(
    common.flowTools.choose_store_offer.parameters.properties.next.enum,
    ['ask', 'select', 'cancel', 'page', 'refine'],
  );
  for (const key of ['page_command', 'page_number', 'refine_request']) {
    assert.ok(Object.hasOwn(common.flowTools.choose_store_offer.parameters.properties, key), `choose_store_offer must accept ${key}`);
  }
  assert.equal(nodes.choose_offer.next.page, 'browse_offers');
  assert.equal(nodes.choose_offer.next.refine, 'browse_offers');
  assert.equal(nodes.browse_offers.id, 'shopping_refine_store_offers');
  assert.equal(nodes.browse_offers.next.ask, 'choose_offer');
  assert.equal(nodes.browse_offers.next.research, 'collect_request');
  assert.ok(nodes.browse_offers.inputSelector.includes('offers'),
    'the deterministic browsing node reads the listing from state; only the model prompt must stay free of it');
  assert.ok(common.flowTools.shopping_refine_store_offers.parameters.properties.offers, 'offers must be declared to reach the script');
  assert.equal(common.flowTools.shopping_refine_store_offers.output.all_offers, 'result.all_offers');
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
  assert.equal(common.flowTools.shopping_rank_store_offers.output.all_offers, 'result.all_offers');
  // The approval prompt may see the one-line status (it is short and actionable) but still never the offers.
  assert.ok(flow.nodes.choose_offer.inputSelector.includes('store_status'));
  assert.ok(!flow.nodes.choose_offer.inputSelector.includes('offers'));
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

test('the approval node cannot narrate work it did not do', () => {
  // A live turn answered "무료배송만 보여주었습니다" through next="ask" while the listing was untouched.
  // Only the deterministic tools change the list, so the prompt has to forbid claiming otherwise.
  const common = parseFlow('_common/flows.yaml');
  const prompt = common.flows.shopping_multi_store_total_cost.nodes.choose_offer.prompt;

  assert.match(prompt, /next="ask" NEVER performs anything/);
  assert.match(prompt, /next="refine" or next="page"/);
  assert.match(prompt, /never restate,\s*\n?\s*summarize, or re-order the offers/i);
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
  assert.equal(quote.nodes.entry_guard.next.continue, 'collect_request');
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
