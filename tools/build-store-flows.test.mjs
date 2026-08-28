import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { STORE_EXCLUDED_INTENTS, buildStoreFlows } from './build-store-flows.mjs';

/**
 * The store profile is the CWS single purpose as code (`store/single-purpose.md`): compare one product's
 * total cost across supported stores, add the offer the user picked, show the checkout review. The repo
 * keeps the service-quote and memory flows — CWS §1 prescribes *"better delivered as separate
 * extensions"*, not deletion — so the narrowing happens in the PACKAGE BUILD, and this pins what that
 * build owes.
 *
 * Every assertion here is about the shipped document, and the authored one must survive untouched: two
 * documents, one source, and the profile is the only difference.
 */

const authored = readFileSync(new URL('../_common/flows.yaml', import.meta.url), 'utf8');
const built = buildStoreFlows(authored);
const store = parseYaml(built.yaml);
const dev = parseYaml(authored);

const routableIntents = (document) => (document.router?.routes ?? []).map((route) => route.intent);
const entryFlowOf = (document, intent) => (document.router?.routes ?? [])
  .find((route) => route.intent === intent)?.entry?.split('.')[0];
const toolNamesOf = (document) => Object.keys(document.flowTools ?? {});
const modulesOf = (document) => new Set(Object.values(document.flowTools ?? {})
  .flatMap((tool) => tool?.execute?.modules ?? []));

test('the excluded intents are unroutable, and their flows are not in the document', () => {
  // Decided 2026-08-27: `community_script` joins them. The store package ROUTED it while the single-purpose
  // sentence does not mention it, and a reviewer finding a surface outside the sentence is the failure P0-3
  // exists to prevent; widening the sentence would risk the "narrow single purpose" judgement instead.
  assert.deepEqual(STORE_EXCLUDED_INTENTS, ['request_service_quote', 'memory', 'community_script']);
  for (const intent of STORE_EXCLUDED_INTENTS) {
    assert.ok(!routableIntents(store).includes(intent), `${intent} must not be routable`);
    assert.ok(!Object.hasOwn(store.flows ?? {}, intent), `the ${intent} flow must be gone`);
  }
  // The shopping surface the sentence promises is all still there.
  for (const kept of ['shopping_single_site', 'shopping_multi_store_total_cost', 'shopping_search_one_store',
    'checkout', 'unsupported_request', 'end_conversation']) {
    assert.ok(Object.hasOwn(store.flows ?? {}, kept), `${kept} must survive`);
  }
});

test('the capture hook is NEUTRALISED, because deleting it hands the turn to the app layer', () => {
  // Measured 2026-08-27 on the store package: with our `record_memory` flow deleted, the APP document's own
  // `hooks.beforeIntent: [record_memory]` (rev 126, line 91) still ran — and the app's version is a MODEL
  // node that asks for `memory_record`. The reply the user got was raw channel scaffolding:
  // `<|channel|>commentary to=functions.memory_record …`. An overlay cannot delete a key the app declares,
  // so whoever DEFINES the hook flow decides what it does: ours defines it as a respond-less terminal
  // (FLOWS.md §7.3) with no tools and no modules — no model call, no memory write, no user output.
  const hook = store.flows?.record_memory;
  assert.ok(hook, 'the store document still defines the hook flow');
  assert.deepEqual(store.hooks?.beforeIntent, ['record_memory'], 'and still names it, so the app cannot serve it');
  const nodes = Object.values(hook.nodes ?? {});
  assert.equal(nodes.length, 1, 'one node: there is nothing for a hook that records nothing to do');
  const [only] = nodes;
  assert.equal(only.kind, 'terminal');
  assert.ok(only.respond === undefined, 'a hook must produce no user-facing text');
  assert.ok(!Object.hasOwn(only, 'allowedTools') && only.run === undefined && only.id === undefined,
    'and must reach no tool');

  // the memory FLOW and its tools are still gone: this is a no-op, not a feature
  assert.ok(!Object.hasOwn(store.flows ?? {}, 'memory'));
  for (const tool of ['capture_memory_clause', 'write_captured_memory', 'set_memory']) {
    assert.ok(!Object.hasOwn(store.flowTools ?? {}, tool), `${tool} must be gone`);
  }
  // The authored document keeps the real hook: this is a profile, not a deletion.
  assert.deepEqual(dev.hooks?.beforeIntent, ['record_memory']);
  assert.ok(Object.keys(dev.flows.record_memory.nodes).length > 1);
});

test('an unmatched utterance lands on a shopping flow, never on the removed quote flow', () => {
  // Measured before this profile existed: `defaultIntent` was `request_service_quote`, so a reviewer
  // typing anything unmatched entered the quote flow — the most common way a §1 mismatch is found.
  const fallthrough = store.router?.defaultIntent;
  assert.ok(routableIntents(store).includes(fallthrough), 'the default intent must be a route');
  assert.match(String(entryFlowOf(store, fallthrough)), /^shopping/);
  assert.equal(store.router?.fallbackIntent, 'unsupported_request');
  assert.ok(Object.hasOwn(store.flows ?? {}, 'unsupported_request'));
});

test('the tools and modules only those flows used are gone; the shared ones stay', () => {
  const gone = modulesOf(dev);
  const kept = modulesOf(store);
  for (const name of ['_common.64_rpc_thumbtack', '_common.65_rpc_quote', '_common.10_form_wizard',
    '_common.70_rpc_memory', '_common.71_rpc_zip',
    // The widget renderer goes with them: only the quote flow and the community flow ever declared it —
    // the shopping comparison window is TEXT, which is why dropping it costs the store profile nothing.
    '_common.69_rpc_widget', '_common.75_rpc_community']) {
    assert.ok(gone.has(name), `${name} is declared by the authored document`);
    assert.ok(!kept.has(name), `${name} must not be declared by the store document`);
  }
  for (const name of ['_common.61_rpc_storefront', '_common.62_rpc_sites', '_common.67_rpc_cart',
    '_common.68_rpc_checkout', '_common.66_rpc_navigate']) {
    assert.ok(kept.has(name), `${name} is shopping and must stay`);
  }
  assert.ok(toolNamesOf(store).length < toolNamesOf(dev).length, 'tools were dropped');
  assert.deepEqual(built.report.modules.dropped.sort(), [
    '_common.10_form_wizard', '_common.64_rpc_thumbtack', '_common.65_rpc_quote',
    '_common.69_rpc_widget', '_common.70_rpc_memory', '_common.71_rpc_zip', '_common.75_rpc_community',
  ]);
});

test('nothing in the store document references anything the profile removed', () => {
  // A dangling reference fails the WHOLE document at the extension (`AGENTS.md` §9), so the build has to
  // be the thing that notices. This is the same reference graph `check:flows` walks.
  const tools = store.flowTools ?? {};
  const problems = [];
  for (const [flowName, flow] of Object.entries(store.flows ?? {})) {
    const nodes = flow.nodes ?? {};
    for (const [nodeName, node] of Object.entries(nodes)) {
      for (const named of [node.run, node.id, ...(node.allowedTools ?? [])].filter(Boolean)) {
        if (!Object.hasOwn(tools, named)) problems.push(`${flowName}.${nodeName} names missing tool ${named}`);
      }
      for (const target of Object.values(node.next ?? {})) {
        const name = String(target);
        const [owner, inner] = name.includes('.') ? name.split('.') : [flowName, name];
        if (!Object.hasOwn(store.flows?.[owner]?.nodes ?? {}, inner)) {
          problems.push(`${flowName}.${nodeName} routes to missing node ${name}`);
        }
      }
    }
  }
  for (const route of store.router?.routes ?? []) {
    const [flowName, nodeName] = String(route.entry).split('.');
    if (!Object.hasOwn(store.flows?.[flowName]?.nodes ?? {}, nodeName)) {
      problems.push(`route ${route.intent} enters missing node ${route.entry}`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the planner can no longer name an intent the router does not carry', () => {
  // A next the enum does not carry is a next the model cannot emit (`AGENTS.md` §13). The same holds for
  // the planner's intent enum: leaving the removed names in it invites a schema violation per turn.
  const enums = [];
  const walk = (value) => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'enum' && Array.isArray(item) && item.includes('shopping_single_site')) enums.push(item);
      walk(item);
    }
  };
  walk(store.flowTools?.decide ?? {});
  assert.ok(enums.length > 0, 'the decide tool declares an intent enum');
  for (const list of enums) {
    for (const intent of STORE_EXCLUDED_INTENTS) {
      assert.ok(!list.includes(intent), `${intent} must not be an enum value`);
    }
    for (const value of list) {
      assert.ok(routableIntents(store).includes(value), `${value} must be a route`);
    }
  }
});

test('the planner prompt says nothing about what the profile removed', () => {
  // The prompt is the one place prose and routing can disagree in silence: a catalogue entry for an
  // intent the router lacks is an instruction to emit something that cannot resolve.
  const prompt = String(store.planner?.prompt ?? '');
  assert.ok(prompt.length > 500, 'the prompt survives');
  for (const forbidden of [...STORE_EXCLUDED_INTENTS, 'record_memory', 'memory', '견적']) {
    assert.ok(!prompt.includes(forbidden), `the store prompt still says "${forbidden}"`);
  }
  // Every action the planner may take must still be DOCUMENTED. Narrowing prose by rule can drop a whole
  // bullet because its body mentions a removed surface — measured on the first implementation, three of the
  // four action bullets vanished and one sentence was cut mid-clause, which is a prompt that teaches the
  // model less than the enum allows.
  for (const action of ['continue_current', 'replace_current', 'clarify', 'out_of_scope']) {
    assert.ok(prompt.includes(`- ${action} —`), `the store prompt lost the ${action} bullet`);
  }
  // and the sentences that carry the shopping surface's own rules survive whole
  for (const sentence of [
    'Use replace_current only when the message names a DIFFERENT',
    'NEVER emit `shopping`; that inherited base intent runs a different flow.',
    'Also set conversationSummary',
  ]) {
    assert.ok(prompt.includes(sentence), `the store prompt lost: ${sentence}`);
  }

  // and it keeps the routing guidance the shopping surface depends on
  for (const kept of ['shopping_single_site', 'shopping_multi_store_total_cost', 'checkout',
    'PRODUCT ROUTING INVARIANT', 'COMPARISON BROWSING FOLLOW-UP', 'SINGLE-SITE SHOPPING FOLLOW-UP']) {
    assert.ok(prompt.includes(kept), `the store prompt lost "${kept}"`);
  }
});

test('no paragraph in the store prompt ends mid-sentence', () => {
  // Sentences wrap across lines in the authored prompt, and the first narrowing filtered line by line — so
  // a sentence whose tail mentioned a removed surface lost that tail and its paragraph ended on
  // "…names a DIFFERENT". Prose that stops mid-clause teaches the model something no one wrote. Wrapping
  // inside a paragraph is normal; a paragraph ENDING mid-clause is the defect.
  const prompt = String(store.planner?.prompt ?? '');
  const unfinished = prompt.split(/\n\s*\n/)
    .map((paragraph) => paragraph.trimEnd())
    .filter((paragraph) => paragraph !== '' && !/[.。:)"”…\]]$/.test(paragraph))
    .map((paragraph) => paragraph.slice(-90));
  assert.deepEqual(unfinished, [], `paragraphs ending mid-sentence:\n${unfinished.join('\n')}`);
});

test('the store document is smaller than the limit the backend enforces, and than the authored one', () => {
  const canonical = (source) => Buffer.byteLength(stringifyYaml(parseYaml(source)).trimEnd(), 'utf8');
  const storeBytes = canonical(built.yaml);
  const devBytes = canonical(authored);
  assert.ok(storeBytes < devBytes, `store ${storeBytes} should be smaller than authored ${devBytes}`);
  assert.ok(storeBytes <= 256 * 1024, `store document is ${storeBytes} B`);
});

test('building is pure: the authored document is not touched', () => {
  const again = readFileSync(new URL('../_common/flows.yaml', import.meta.url), 'utf8');
  assert.equal(again, authored, 'the authored document must be byte-identical after a build');
  assert.notEqual(built.yaml, authored, 'and the store document must differ from it');
});

test('a reference into what the profile removed fails the build instead of shipping', () => {
  // The rule that matters is not "it removed things" but "it refuses to emit a document it broke". A
  // dangling reference fails the WHOLE document at the extension, so this build is the last place that can
  // notice. Note what is NOT a failure: a kept flow that names a quote tool KEEPS it — naming is what makes
  // a tool reachable, and the profile follows the graph rather than a list.
  const intoRemovedFlow = parseYaml(authored);
  intoRemovedFlow.flows.checkout.nodes.probe = {
    kind: 'action_contract',
    id: 'checkout_review',
    next: { ok: 'memory.plan_memory' },
  };
  assert.throws(() => buildStoreFlows(stringifyYaml(intoRemovedFlow)), /memory\.plan_memory/);

  const orphanRoute = parseYaml(authored);
  orphanRoute.router.routes.push({ intent: 'checkout_alias', entry: 'memory.plan_memory' });
  assert.throws(() => buildStoreFlows(stringifyYaml(orphanRoute)), /memory\.plan_memory/);
});

test('no tool in the store document declares a module the profile dropped', () => {
  const dropped = new Set(built.report.modules.dropped);
  const offenders = Object.entries(store.flowTools ?? {})
    .filter(([, tool]) => (tool?.execute?.modules ?? []).some((name) => dropped.has(name)))
    .map(([name]) => name);
  assert.deepEqual(offenders, [], offenders.join(', '));
});

test('no text the user can read promises a surface the profile removed', () => {
  // Measured 2026-08-27 on the shipped store package: asked for a quote, it answered "…대신 서비스 견적,
  // 쇼핑, 결제 검토 및 명시적인 메모리 요청에 대해 도와드릴 수 있습니다." — the refusal advertised two
  // features the package does not carry, in the one sentence a reviewer is most likely to read. Narrowing
  // the planner prompt was not enough: terminal `respond` directives are prose too.
  const forbidden = [...STORE_EXCLUDED_INTENTS, 'service quote', '서비스 견적', '견적', 'memory request',
    '메모리', '기억해'];
  const offenders = [];
  const walk = (value, path) => {
    if (typeof value === 'string') {
      for (const name of forbidden) {
        if (value.includes(name)) offenders.push(`${path}: ${name}`);
      }
      return;
    }
    if (Array.isArray(value)) { value.forEach((item, index) => walk(item, `${path}[${index}]`)); return; }
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) walk(item, path === '' ? key : `${path}.${key}`);
    }
  };
  // The neutralised hook keeps its NAME so the app's version cannot serve it (see the hook test); a name
  // is not a promise, and the flow behind it is pinned to be a no-op.
  const { record_memory: _neutral, ...promisingFlows } = store.flows ?? {};
  walk({ ...store, flows: promisingFlows, hooks: undefined }, '');
  assert.deepEqual(offenders, [], `the store document still promises:\n${offenders.join('\n')}`);
});

test('the AUTHORED prompt is never edited for the store profile\'s convenience', () => {
  // Measured 2026-08-27, A/B with a healthy provider: splitting three sentences in the authored planner
  // prompt so the store narrowing could filter them took the live quote suite from **5/7 to 2/7** — three
  // turns reached no node at all and three were misrouted into shopping. The store profile pays for its own
  // narrowing (`STORE_PROMPT_OVERRIDES`); the document the dev path runs stays as it was measured.
  const prompt = String(dev.planner?.prompt ?? '');
  for (const sentence of [
    'A service quote, product purchase, checkout, explicit memory request, or farewell is NEVER out_of_scope.',
    'e.g. the name/email/phone/ZIP given for a service quote',
    'product or a different task (a service quote, checkout, memory, farewell).',
  ]) {
    assert.ok(prompt.includes(sentence), `the authored prompt lost: ${sentence}`);
  }
  // and the store prompt still says none of it
  const storePrompt = String(store.planner?.prompt ?? '');
  for (const name of ['service quote', 'memory', 'request_service_quote']) {
    assert.ok(!storePrompt.includes(name), `the store prompt still says ${name}`);
  }
});
