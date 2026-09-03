import assert from 'node:assert/strict';
import test from 'node:test';

import { loadLuaModules } from './harness.mjs';

/**
 * X5 (EXTERNAL_PACK_TASK_PLAN): the generic pack_task bridge. The catalog is the SINGLE WRITER of
 * identity, version, and effect — structurally, because `pack.invoke` takes only the catalog-issued
 * `binding_id` plus the model's `arguments_json`. The model never names a pack.
 *
 * The stub mirrors `ops/packs.ts` semantics faithfully (the optimistic-stub lesson): blank binding_id
 * and non-object arguments_json are `bad_params`, an empty composition answers
 * `{pack_set_digest: null, commands: [], routes: []}`.
 */
const MODULES = ['_common/rpc/76_rpc_pack.lua'];

const CATALOG = {
  pack_set_digest: 'sha256:abc',
  commands: [
    {
      binding_id: 'b-compare',
      pack_id: 'layorix.service-quotes',
      version: '1.0.0',
      command: 'rank_service_estimates',
      effect: 'read',
      requires_confirmation: false,
      input_schema: { type: 'object', required: ['candidates'] },
    },
    {
      binding_id: 'b-mutate',
      pack_id: 'layorix.fixture',
      version: '1.0.0',
      command: 'add_to_basket',
      effect: 'cart_mutation',
      requires_confirmation: true,
      input_schema: { type: 'object' },
    },
  ],
  routes: [{
    intent: 'service_quote_compare',
    description: 'Compare published service rates.',
    examples: ['청소 업체 공개 가격 비교해줘'],
  }],
};

function harness({ catalog = CATALOG, invoke } = {}) {
  const h = loadLuaModules(MODULES);
  const calls = [];
  // The runtime provides `json` (the widget suite's convention); the stub mirrors it.
  h.expose({ json: { encode: (value) => JSON.stringify(value), decode: (text) => JSON.parse(String(text)) } });
  h.expose({
    pack: {
      catalog: () => catalog,
      invoke: (bindingId, argumentsJson) => {
        const params = { binding_id: bindingId, arguments_json: argumentsJson };
        calls.push(params);
        if (typeof params?.binding_id !== 'string' || params.binding_id.trim() === '') {
          throw new Error('bad_params: binding_id');
        }
        if (params.arguments_json !== undefined && params.arguments_json !== null) {
          if (typeof params.arguments_json !== 'string') throw new Error('bad_params: arguments_json');
          const decoded = JSON.parse(params.arguments_json);
          if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
            throw new Error('bad_params: arguments_json');
          }
        }
        return invoke ? invoke(params) : { ok: true, value: { echoed: true }, provenance: [] };
      },
    },
  });
  return { h, calls };
}

test('read_catalog renders the installed commands and carries the catalog as ONE scalar', () => {
  const { h } = harness();
  const out = h.call('AX_RPC_PACK.read_catalog', {});
  assert.equal(out.next, 'ok');
  assert.equal(typeof out.pack_catalog_json, 'string');
  assert.match(out.pack_catalog_text, /rank_service_estimates/);
  assert.match(out.pack_catalog_text, /\[read\]/);
  assert.match(out.pack_catalog_text, /layorix\.service-quotes@1\.0\.0/);
  // The catalog text names each command's effect so a reply can, but the MODEL never restates them.
  assert.equal(out.pack_command_count, 2);
});

test('an empty composition is an honest none, not an error', () => {
  const { h } = harness({ catalog: { commands: [], routes: [] } });
  const out = h.call('AX_RPC_PACK.read_catalog', {});
  assert.equal(out.next, 'none');
  assert.match(out.pack_answer_reason, /no_packs_installed/);
});

test('a refused catalog op is a channel outcome, never a pack claim', () => {
  const h = loadLuaModules(MODULES);
  h.expose({ json: { encode: (value) => JSON.stringify(value), decode: (text) => JSON.parse(String(text)) } });
  h.expose({ pack: { catalog: () => { throw new Error('command_unresolved'); }, invoke: () => ({}) } });
  const out = h.call('AX_RPC_PACK.read_catalog', {});
  assert.equal(out.next, 'error');
  assert.match(out.pack_answer_reason, /pack_channel_unavailable/);
  assert.match(out.pack_answer_reason, /command_unresolved/);
});

test('classify proposes only a command the catalog lists, by its exact name', () => {
  const { h } = harness();
  const out = h.call('AX_RPC_PACK.classify', {
    pack_catalog_json: JSON.stringify(CATALOG),
    requestText: 'rank_service_estimates 실행해줘',
  });
  assert.equal(out.next, 'propose');
  assert.equal(out.pack_named_command, 'rank_service_estimates');
  assert.equal(out.pack_binding_id, 'b-compare');
});

test('classify falls back to route-example overlap when no command is named', () => {
  const { h } = harness();
  const out = h.call('AX_RPC_PACK.classify', {
    pack_catalog_json: JSON.stringify(CATALOG),
    requestText: '청소 업체 공개 가격 비교해줘',
  });
  // One read command reachable through the matched route's pack → proposed deterministically.
  assert.equal(out.next, 'propose');
  assert.equal(out.pack_binding_id, 'b-compare');
});

test('classify answers honestly on no match and never guesses between two', () => {
  const { h } = harness();
  const none = h.call('AX_RPC_PACK.classify', {
    pack_catalog_json: JSON.stringify(CATALOG),
    requestText: '오늘 날씨 알려줘',
  });
  assert.equal(none.next, 'answer');
  assert.match(none.pack_answer_reason, /no_match/);

  const twin = structuredClone(CATALOG);
  twin.commands.push({ ...CATALOG.commands[0], binding_id: 'b-two', command: 'rank_service_offers' });
  const ambiguous = h.call('AX_RPC_PACK.classify', {
    pack_catalog_json: JSON.stringify(twin),
    requestText: 'rank_service_estimates 그리고 rank_service_offers',
  });
  assert.equal(ambiguous.next, 'answer');
  assert.match(ambiguous.pack_answer_reason, /ambiguous/);
});

test('the current message can cancel at classification', () => {
  const { h } = harness();
  const out = h.call('AX_RPC_PACK.classify', {
    pack_catalog_json: JSON.stringify(CATALOG),
    requestText: '취소',
  });
  assert.equal(out.next, 'cancelled');
});

test('propose validates against the catalog and refuses a non-read effect BY NAME', () => {
  const { h } = harness();
  const ok = h.call('AX_RPC_PACK.propose', {
    pack_catalog_json: JSON.stringify(CATALOG),
    command: 'rank_service_estimates',
    arguments_json: '{"candidates":[{"name":"A"}]}',
  });
  assert.equal(ok.next, 'invoke');
  assert.equal(ok.pack_binding_id, 'b-compare');
  assert.equal(ok.pack_effect, 'read');
  assert.equal(ok.pack_pack_id, 'layorix.service-quotes');
  // The consent gate's writer: the deterministic validator, and ONLY it, emits the approval marker
  // the mutation adapter requires (two writers of one approval is how it stops meaning anything).
  assert.equal(ok.pack_dispatch_approval, 'catalog_validated_read_command');

  const unknown = h.call('AX_RPC_PACK.propose', {
    pack_catalog_json: JSON.stringify(CATALOG),
    command: 'invented_command',
    arguments_json: '{}',
  });
  assert.equal(unknown.next, 'error');
  assert.match(unknown.pack_answer_reason, /command_not_in_catalog/);

  const mutation = h.call('AX_RPC_PACK.propose', {
    pack_catalog_json: JSON.stringify(CATALOG),
    command: 'add_to_basket',
    arguments_json: '{}',
  });
  assert.equal(mutation.next, 'error');
  assert.match(mutation.pack_answer_reason, /effect_not_invocable/);
  assert.match(mutation.pack_answer_reason, /cart_mutation/);
  assert.equal(mutation.pack_dispatch_approval, undefined, 'a refusal must not emit the approval');

  const badJson = h.call('AX_RPC_PACK.propose', {
    pack_catalog_json: JSON.stringify(CATALOG),
    command: 'rank_service_estimates',
    arguments_json: 'not json',
  });
  assert.equal(badJson.next, 'error');
  assert.match(badJson.pack_answer_reason, /arguments_invalid/);
});

test('invoke carries only the catalog-issued binding id plus the argument text', () => {
  const { h, calls } = harness({
    invoke: () => ({ ok: true, value: { rows: [{ name: 'A' }], comparisonText: '1. A' }, provenance: [] }),
  });
  const out = h.call('AX_RPC_PACK.invoke', {
    pack_binding_id: 'b-compare',
    pack_arguments_json: '{"candidates":[{"name":"A"}]}',
  });
  assert.equal(out.next, 'present');
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0]).sort(), ['arguments_json', 'binding_id']);
  assert.equal(typeof out.pack_result_json, 'string');
  assert.match(out.pack_result_json, /comparisonText/);
});

test('a classified refusal and an uncertain outcome stay distinct and named', () => {
  const refused = harness({ invoke: () => ({ ok: false, code: 'no_executor_document', message: 'no doc' }) });
  const out = refused.h.call('AX_RPC_PACK.invoke', {
    pack_binding_id: 'b-compare', pack_arguments_json: '{}',
  });
  assert.equal(out.next, 'error');
  assert.match(out.pack_answer_reason, /no_executor_document/);

  const uncertain = harness({
    invoke: () => ({ ok: false, uncertain: true, effect: 'read', code: 'timeout', message: 'late' }),
  });
  const shaky = uncertain.h.call('AX_RPC_PACK.invoke', {
    pack_binding_id: 'b-compare', pack_arguments_json: '{}',
  });
  assert.equal(shaky.next, 'error');
  assert.match(shaky.pack_answer_reason, /uncertain/);
  assert.match(shaky.pack_answer_reason, /timeout/);
});

test('present renders the Pack result deterministically, preferring its own text', () => {
  const { h } = harness();
  const withText = h.call('AX_RPC_PACK.present', {
    pack_result_json: JSON.stringify({ comparisonText: '1. A — KRW 99,000' }),
    pack_command: 'rank_service_estimates',
    pack_pack_id: 'layorix.service-quotes',
  });
  assert.equal(withText.next, 'report');
  assert.match(withText.pack_reply, /1\. A — KRW 99,000/);
  assert.match(withText.pack_reply, /layorix\.service-quotes/);

  const generic = h.call('AX_RPC_PACK.present', {
    pack_result_json: JSON.stringify({ query: 'house cleaning', limit: 6 }),
    pack_command: 'prepare_service_query',
    pack_pack_id: 'layorix.service-quotes',
  });
  assert.equal(generic.next, 'report');
  assert.match(generic.pack_reply, /house cleaning/);
});

test('without the sugar table, the generic rpc(op, params) path carries the SAME frames', () => {
  const h = loadLuaModules(MODULES);
  h.expose({ json: { encode: (value) => JSON.stringify(value), decode: (text) => JSON.parse(String(text)) } });
  const frames = [];
  // The real global is a CALLABLE TABLE (type 'table' — callability is not a type() question, the
  // request-22 misreading); the stub exposes a callable, which is the property the module may rely on.
  h.expose({ rpc: (op, params) => {
    frames.push({ op, params: params ?? null });
    if (op === 'pack.catalog') return CATALOG;
    if (op === 'pack.invoke') return { ok: true, value: { echoed: true }, provenance: [] };
    throw new Error('unknown op ' + op);
  } });
  const catalog = h.call('AX_RPC_PACK.read_catalog', {});
  assert.equal(catalog.next, 'ok');
  assert.equal(catalog.pack_command_count, 2);
  const invoked = h.call('AX_RPC_PACK.invoke', {
    pack_binding_id: 'b-compare', pack_arguments_json: '{"candidates":[]}',
  });
  assert.equal(invoked.next, 'present');
  assert.deepEqual(frames[0], { op: 'pack.catalog', params: {} });
  assert.deepEqual(frames[1], { op: 'pack.invoke', params: { binding_id: 'b-compare', arguments_json: '{"candidates":[]}' } });
});

test('with NEITHER channel the refusal still carries its raw reason', () => {
  const h = loadLuaModules(MODULES);
  h.expose({ json: { encode: (value) => JSON.stringify(value), decode: (text) => JSON.parse(String(text)) } });
  const out = h.call('AX_RPC_PACK.read_catalog', {});
  assert.equal(out.next, 'error');
  assert.match(out.pack_answer_reason, /pack_channel_unavailable/);
});
