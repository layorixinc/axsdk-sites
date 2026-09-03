#!/usr/bin/env node
// Narrows the authored flow document to the Chrome Web Store single purpose (`store/single-purpose.md`):
// compare one product's total cost across supported stores, add the offer the user picked, show the
// checkout review. Nothing is deleted from the repository — CWS §1 prescribes *"better delivered as
// separate extensions"* for the service-quote surface, so it stays authored and only the PACKAGE is
// narrowed. One source, two documents, and the profile is the only difference.
//
// The transform is a closure, not a hand-kept list: naming the intents decides the flows, the flows decide
// the tools, and the tools decide the modules. Anything it cannot resolve is a refusal, never an emitted
// document — a dangling reference fails the whole document at the extension (`AGENTS.md` §9), so the build
// is the last place that can notice.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/** The routable intents outside the sentence. Their flows, tools and modules follow from them. */
export const STORE_EXCLUDED_INTENTS = [
  'request_service_quote',
  'memory',
  // Decided 2026-08-27: the store package routed `community_script` while the single-purpose sentence
  // does not mention it, and a reviewer finding a surface outside the sentence is the failure mode P0-3
  // exists to prevent. Widening the sentence instead would risk the "narrow single purpose" judgement,
  // so the capability stays in the development build only.
  'community_script',
  'pack_task',
];

/**
 * Hook flows that must stop RECORDING without ceasing to EXIST.
 *
 * `record_memory` runs on every turn, so removing the `memory` intent alone would leave memory collection
 * alive under a purpose that never mentions contact details. But deleting the flow is worse: the hook list
 * belongs to the APP document (`hooks.beforeIntent: [record_memory]`, rev 126), an overlay cannot delete a
 * key the app declares, and the app's own `record_memory` is a MODEL node that asks for `memory_record`.
 * Measured on the store package with ours deleted, the user's reply was raw channel scaffolding:
 * `<|channel|>commentary to=functions.memory_record …`.
 *
 * So the profile REPLACES it with a respond-less terminal (FLOWS.md §7.3): no tools, no modules, no model
 * call, no user output — and the app's version never gets the turn, because ours still defines the name.
 */
const NEUTRALISED_HOOK_FLOWS = {
  record_memory: { nodes: { skip: { kind: 'terminal' } } },
};

/**
 * Sentences the authored prompt states about BOTH surfaces at once, rewritten for the store profile.
 *
 * The first attempt split these in the authored document so the unit/sentence rules could filter them. That
 * cost the live quote suite **5/7 → 2/7** with a healthy provider (three turns reached no node, three were
 * misrouted into shopping): reordering "A service quote, product purchase, checkout … is NEVER
 * out_of_scope." and hedging "a service quote … where those exist" changed how the planner reads its own
 * catalogue. **The document the dev path runs stays as it was measured**, and the profile pays for its own
 * narrowing here.
 *
 * Each key must match EXACTLY. A reworded authored sentence fails the build rather than silently missing.
 */
const STORE_PROMPT_OVERRIDES = [
  [
    ", e.g. the name/email/phone/ZIP given for a service quote)",
    ')',
  ],
  [
    '; saving several keys and deleting several exact keys is one memory intent.',
    '.',
  ],
  [
    'A service quote, product purchase, checkout, explicit memory request, or farewell is NEVER out_of_scope.'
    + ' Route explicit remember/save, forget/delete, list/show, exact-read questions, and memory-search requests to memory.',
    'A product purchase, a checkout, or a farewell is NEVER out_of_scope.',
  ],
  [
    'product category or a different task (service quote, checkout, memory, farewell).',
    'product category or a different task (checkout or farewell).',
  ],
];

/**
 * Prose that ENUMERATES the surfaces, which no rule can narrow: a list is not a sentence, so dropping the
 * items that left would rewrite the sentence rather than filter it.
 *
 * Measured 2026-08-27 on the shipped store package: asked for a quote it answered "…대신 서비스 견적,
 * 쇼핑, 결제 검토 및 명시적인 메모리 요청에 대해 도와드릴 수 있습니다." — advertising two features the
 * package does not carry, in the one sentence a reviewer is most likely to read. `verify` walks every
 * string in the emitted document, so the next unlisted one fails the build instead of shipping.
 */
const STORE_PURPOSE_RESPOND = [
  "Reply briefly in the user's language. This request is unsupported. State that you can help compare one",
  "product's total cost including shipping across supported stores, add the product the user picked to that",
  'store’s cart, and open its checkout page for review. Never claim an order was placed.',
].join('\n');

const STORE_RESPOND_OVERRIDES = {
  'unsupported_request.reply': STORE_PURPOSE_RESPOND,
};

const identifiersOf = (value, into = new Set()) => {
  if (typeof value === 'string') { into.add(value); return into; }
  if (Array.isArray(value)) { for (const item of value) identifiersOf(item, into); return into; }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) { into.add(key); identifiersOf(item, into); }
  }
  return into;
};

/** Every tool a flow can reach: node `run`/`id`/`allowedTools` plus any tool a task table names. */
function toolsOfFlow(flow, toolNames) {
  const named = new Set();
  for (const node of Object.values(flow?.nodes ?? {})) {
    for (const direct of [node.run, node.id, ...(node.allowedTools ?? [])]) {
      if (typeof direct === 'string') named.add(direct);
    }
    for (const identifier of identifiersOf(node)) {
      if (toolNames.has(identifier)) named.add(identifier);
    }
  }
  return named;
}

/**
 * Prose the store profile must not carry.
 *
 * Units are what the authored prompt is made of: a `- ` bullet with its continuation lines, or a
 * `HEADING:` block ending at a blank line.
 *
 * What decides a whole-unit drop is its HEAD — a bullet's `- <name> —` label, a heading's title plus the
 * `activeFlow=` it keys on — never its body. Measured on the first implementation, which read the body:
 * three of the four action bullets vanished, because each mentions the memory clause somewhere inside
 * guidance that has nothing to do with memory, and one sentence was cut mid-clause. A prompt that teaches
 * the model less than the enum allows is worse than a longer one.
 *
 * A surviving unit loses only the sentences that name a removed surface. That is lossless only while no
 * sentence mixes one with guidance the shopping surface needs; when one does, the name survives and the
 * build FAILS with it quoted. The fix then is to split that sentence in the authored document — not to
 * loosen this.
 */
function narrowPrompt(prompt, forbidden, headForbidden) {
  const lines = String(prompt).split('\n');
  const units = [];
  for (const line of lines) {
    const startsBullet = /^\s*- /.test(line);
    const startsHeading = /^[A-Z][A-Z0-9 /·+-]{5,}:/.test(line);
    if (units.length === 0 || startsBullet || startsHeading || line.trim() === '') {
      units.push({ lines: [line], openable: line.trim() !== '' });
    } else {
      const current = units.at(-1);
      if (current.openable) current.lines.push(line);
      else units.push({ lines: [line], openable: true });
    }
  }

  const mentions = (text, names) => names.some((name) => text.includes(name));
  // A bullet's head is its label; a heading's head is its title and whatever `activeFlow=` it keys on.
  const headOf = (unit) => {
    const first = unit.lines[0];
    const bullet = first.match(/^\s*- ([^—]{1,80})—/);
    if (bullet) return bullet[1];
    const heading = first.match(/^([A-Z][A-Z0-9 /·+-]{5,}):/);
    if (heading) {
      const keyed = unit.lines.join(' ').match(/activeFlow=([A-Za-z_]+)/g) ?? [];
      return `${heading[1]} ${keyed.join(' ')}`;
    }
    return '';
  };

  const kept = [];
  for (const unit of units) {
    const text = unit.lines.join('\n');
    if (!mentions(text, forbidden)) { kept.push(text); continue; }
    if (mentions(headOf(unit), headForbidden)) continue; // the unit itself is about a removed surface
    // Sentences wrap across lines in the authored prompt, so surgery joins the unit first: filtering
    // line by line cut a sentence in half and left "…names a DIFFERENT" as the end of the prompt.
    const rebuilt = unit.lines
      .join(' ')
      .replace(/\s+/g, ' ')
      .split(/(?<=[.。])\s+/)
      .filter((sentence) => !mentions(sentence, forbidden))
      .join(' ')
      .trim();
    if (rebuilt.trim() !== '') kept.push(rebuilt);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}


function narrowEnums(value, excluded) {
  if (Array.isArray(value)) return value.map((item) => narrowEnums(item, excluded));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === 'enum' && Array.isArray(item)) {
      return [key, item.filter((entry) => !excluded.includes(entry))];
    }
    return [key, narrowEnums(item, excluded)];
  }));
}

/**
 * @param {string} source authored `_common/flows.yaml`
 * @returns {{ yaml: string, report: object }}
 */
/** Applies `STORE_RESPOND_OVERRIDES` to one flow, leaving every other node untouched. */
function withRespondOverrides(flowName, flow) {
  const nodes = Object.entries(flow?.nodes ?? {});
  const touched = nodes.some(([nodeName]) => STORE_RESPOND_OVERRIDES[`${flowName}.${nodeName}`] !== undefined);
  if (!touched) return flow;
  return {
    ...flow,
    nodes: Object.fromEntries(nodes.map(([nodeName, node]) => {
      const override = STORE_RESPOND_OVERRIDES[`${flowName}.${nodeName}`];
      return [nodeName, override === undefined ? node : { ...node, respond: override }];
    })),
  };
}

/** Applies `STORE_PROMPT_OVERRIDES`, refusing when an authored sentence has been reworded. */
function applyPromptOverrides(prompt) {
  let text = String(prompt);
  for (const [from, to] of STORE_PROMPT_OVERRIDES) {
    if (!text.includes(from)) {
      throw new Error(`the store profile cannot narrow this prompt: it no longer says "${from.slice(0, 60)}…"`);
    }
    text = text.split(from).join(to);
  }
  return text;
}

export function buildStoreFlows(source) {
  const document = parseYaml(source);
  const routes = document.router?.routes ?? [];
  const flows = document.flows ?? {};
  const tools = document.flowTools ?? {};
  const toolNames = new Set(Object.keys(tools));

  const entryFlowOf = (intent) => String(routes.find((route) => route.intent === intent)?.entry ?? '')
    .split('.')[0];
  const excludedRoutes = routes
    .filter((route) => STORE_EXCLUDED_INTENTS.includes(route.intent))
    .map((route) => {
      const [flowName, nodeName] = String(route.entry).split('.');
      if (!flowName || !nodeName) throw new Error(`the store profile cannot shadow malformed entry ${route.entry}`);
      return { intent: route.intent, flowName, nodeName };
    });
  const routeShadows = {};
  for (const { flowName, nodeName } of excludedRoutes) {
    const shadow = routeShadows[flowName] ?? { nodes: {} };
    shadow.nodes[nodeName] = { kind: 'terminal', respond: STORE_PURPOSE_RESPOND };
    routeShadows[flowName] = shadow;
  }
  const neutralised = Object.keys(NEUTRALISED_HOOK_FLOWS).filter((name) => Object.hasOwn(flows, name));
  const removedFlows = new Set([
    ...excludedRoutes.map(({ flowName }) => flowName),
    ...neutralised,
  ]);
  const keptFlowNames = Object.keys(flows).filter((name) => !removedFlows.has(name));

  const toolsKept = new Set();
  for (const name of keptFlowNames) for (const tool of toolsOfFlow(flows[name], toolNames)) toolsKept.add(tool);
  toolsKept.add('decide'); // the planner's own tool is named by the planner, not by a flow
  const toolsRemoved = [...toolNames].filter((name) => !toolsKept.has(name));

  const modulesOf = (names) => new Set(names.flatMap((name) => tools[name]?.execute?.modules ?? []));
  const modulesKept = modulesOf([...toolsKept]);
  const modulesDropped = [...modulesOf([...toolNames])].filter((name) => !modulesKept.has(name));

  const shoppingDefault = routes
    .map((route) => route.intent)
    .find((intent) => !STORE_EXCLUDED_INTENTS.includes(intent) && entryFlowOf(intent).startsWith('shopping'));
  if (shoppingDefault === undefined) throw new Error('no shopping route to carry the default intent');

  // Identifiers decide a whole-unit drop; the prose words only trigger sentence surgery, because a
  // sentence about the shopping surface can mention them in passing.
  const headForbidden = [...STORE_EXCLUDED_INTENTS, ...Object.keys(NEUTRALISED_HOOK_FLOWS), 'MEMORY'];
  const forbidden = [...headForbidden, ...toolsRemoved,
    'memory', 'service quote', '견적', '기억해'];
  const narrowed = {
    ...document,
    planner: {
      ...document.planner,
      ...(document.planner?.prompt === undefined
        ? {}
        : { prompt: narrowPrompt(applyPromptOverrides(document.planner.prompt), forbidden, headForbidden) }),
    },
    router: {
      ...document.router,
      defaultIntent: shoppingDefault,
      routes: routes.filter((route) => !STORE_EXCLUDED_INTENTS.includes(route.intent)),
    },
    flows: Object.fromEntries([
      ...keptFlowNames.map((name) => [name, withRespondOverrides(name, flows[name])]),
      ...neutralised.map((name) => [name, NEUTRALISED_HOOK_FLOWS[name]]),
      ...Object.entries(routeShadows),
    ]),
    flowTools: narrowEnums(
      Object.fromEntries([...toolsKept].filter((name) => Object.hasOwn(tools, name)).map((name) => [name, tools[name]])),
      STORE_EXCLUDED_INTENTS,
    ),
  };
  const problems = verify(narrowed, forbidden);
  if (problems.length > 0) {
    throw new Error(`the store profile cannot emit this document:\n  ${problems.join('\n  ')}`);
  }

  return {
    yaml: stringifyYaml(narrowed, { lineWidth: 0 }).trimEnd(),
    report: {
      intents: { dropped: [...STORE_EXCLUDED_INTENTS], defaultIntent: shoppingDefault },
      flows: {
        dropped: [...removedFlows].filter((name) => !neutralised.includes(name)).sort(),
        shadowed: Object.keys(routeShadows).sort(),
        neutralised: [...neutralised].sort(),
        kept: keptFlowNames.length + Object.keys(routeShadows).length + neutralised.length,
      },
      tools: { dropped: toolsRemoved.length, kept: toolsKept.size },
      modules: { dropped: modulesDropped.sort(), kept: [...modulesKept].sort() },
    },
  };
}

/** Every reference the extension would resolve, plus every name the profile promised to remove. */
function verify(document, forbidden) {
  const problems = [];
  const flows = document.flows ?? {};
  const tools = document.flowTools ?? {};
  for (const [flowName, flow] of Object.entries(flows)) {
    for (const [nodeName, node] of Object.entries(flow.nodes ?? {})) {
      const where = `${flowName}.${nodeName}`;
      for (const named of [node.run, node.id, ...(node.allowedTools ?? [])]) {
        if (typeof named === 'string' && !Object.hasOwn(tools, named)) {
          problems.push(`${where} names missing tool ${named}`);
        }
      }
      for (const target of Object.values(node.next ?? {})) {
        const name = String(target);
        const [owner, inner] = name.includes('.') ? name.split('.') : [flowName, name];
        if (!Object.hasOwn(flows[owner]?.nodes ?? {}, inner)) {
          problems.push(`${where} routes to missing node ${name}`);
        }
      }
    }
  }
  for (const route of document.router?.routes ?? []) {
    const [flowName, nodeName] = String(route.entry).split('.');
    if (!Object.hasOwn(flows[flowName]?.nodes ?? {}, nodeName)) {
      problems.push(`route ${route.intent} enters missing node ${route.entry}`);
    }
  }
  // Every string a user or a model can read, not just the planner prompt: a terminal `respond` shipped a
  // sentence advertising two removed features before this walked the whole document.
  const walk = (value, path) => {
    if (typeof value === 'string') {
      for (const name of forbidden) {
        if (value.includes(name)) problems.push(`${path || 'document'} still says "${name}"`);
      }
      return;
    }
    if (Array.isArray(value)) { value.forEach((item, index) => walk(item, `${path}[${index}]`)); return; }
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) walk(item, path === '' ? key : `${path}.${key}`);
    }
  };
  // The neutralised hook keeps its NAME so the app's version cannot serve it; the flow behind it is a no-op.
  const promising = { ...(document.flows ?? {}) };
  for (const name of Object.keys(NEUTRALISED_HOOK_FLOWS)) delete promising[name];
  walk({ ...document, flows: promising, hooks: undefined }, '');
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const built = buildStoreFlows(readFileSync(resolve(root, '_common', 'flows.yaml'), 'utf8'));
  const out = process.argv[2];
  if (out) writeFileSync(resolve(out), `${built.yaml}\n`);
  const bytes = Buffer.byteLength(built.yaml, 'utf8');
  console.log(`store profile: ${built.report.flows.kept} flows, ${built.report.tools.kept} tools`);
  console.log(`  dropped flows   ${built.report.flows.dropped.join(', ')}`);
  console.log(`  neutralised     ${built.report.flows.neutralised.join(', ')} (hook kept as a no-op)`);
  console.log(`  shadowed flows  ${built.report.flows.shadowed.join(', ')} (app copies replaced by terminals)`);
  console.log(`  dropped modules ${built.report.modules.dropped.join(', ')}`);
  console.log(`  default intent  ${built.report.intents.defaultIntent}`);
  console.log(`  document        ${(bytes / 1024).toFixed(1)} KiB${out ? ` → ${out}` : ''}`);
}
