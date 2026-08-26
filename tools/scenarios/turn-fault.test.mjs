// One rule for "this turn says nothing about the product", shared by every live runner.
//
// `cart-live` learned it first: a turn fails because the backend never opened a session, because the
// engine answered with NO node, or because the planner routed the message into another flow — and all
// three used to be reported as a product failure, which sends an investigation to the wrong repo. Seven
// other runners had no attribution at all. The rule is the same everywhere; only the set of tools that
// mean "the flow under test ran" changes, so the caller passes it.
import assert from 'node:assert/strict';
import test from 'node:test';

import { turnFault } from './turn-fault.mjs';

const SINGLE_SITE = ['shopping_single_site', 'shopping_search_product', 'shopping_add_to_cart', 'enter_shopping_site'];

test('a session that never opened is a harness fault, and worth one retry', () => {
  const fault = turnFault({ toolCalls: [], failure: 'Timed out after 60000ms waiting for the backend to open a fresh session' },
    { expects: SINGLE_SITE });

  assert.equal(fault.kind, 'session');
  assert.equal(fault.retry, true);
});

test('a turn that reached no node at all is named as such', () => {
  const fault = turnFault({ toolCalls: [], failure: null }, { expects: SINGLE_SITE });

  assert.equal(fault.kind, 'no-node');
  assert.equal(fault.retry, true);
});

test('a turn routed into another flow is a misroute', () => {
  const fault = turnFault({
    toolCalls: [{ name: 'capture_memory_clause' }, { name: 'shopping_prefill_total_cost_request' }],
    failure: null,
  }, { expects: SINGLE_SITE });

  assert.equal(fault.kind, 'misroute');
  assert.equal(fault.retry, true);
  assert.match(fault.detail, /prefill/);
});

test('the flow under test running is not a fault', () => {
  const fault = turnFault({
    toolCalls: [{ name: 'capture_memory_clause' }, { name: 'shopping_single_site.refine_item' }],
    failure: null,
  }, { expects: SINGLE_SITE });

  assert.equal(fault, null);
});

test('a stalled turn is reported and NEVER retried — its evidence is the point', () => {
  const fault = turnFault({
    toolCalls: [{ name: 'shopping_single_site.collect_shopping' }],
    failure: 'Timed out after 240000ms waiting for the assistant to answer',
  }, { expects: SINGLE_SITE });

  assert.equal(fault.kind, 'stalled');
  assert.equal(fault.retry, false);
});

test('a caller that names no expected tool never reports a misroute', () => {
  // A runner that has not said which tools mean "my flow ran" must not have flows guessed for it: the
  // hook that runs on EVERY turn (`capture_memory_clause`) would otherwise look like the flow under test
  // on one runner and like a misroute on another.
  const fault = turnFault({ toolCalls: [{ name: 'capture_memory_clause' }], failure: null }, {});

  assert.equal(fault, null);
});

test('the hook alone is a misroute when the runner named its flow', () => {
  const fault = turnFault({ toolCalls: [{ name: 'capture_memory_clause' }], failure: null },
    { expects: SINGLE_SITE });

  assert.equal(fault.kind, 'misroute');
});
