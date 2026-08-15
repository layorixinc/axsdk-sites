// Unit tests for shopping.mjs pure step predicates (node --test). The live flow needs a browser;
// these cover the classification of each conversational step's tool trace + reply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasTool, refineAsksAfterSearch, addThenConfirmAsks, checkoutRunsNoOrder } from './shopping.mjs';

const step = (names, text = 'ok', err = null) => ({
  err,
  text,
  toolCalls: names.map(name => ({ name, status: 'done' })),
});

test('hasTool matches exact tool names only', () => {
  const calls = [{ name: 'shopping.checkout_confirm', status: 'done' }];
  assert.equal(hasTool(calls, 'shopping.checkout_confirm'), true);
  // legacy semantics: a bare "checkout" does NOT match "shopping.checkout_confirm"
  assert.equal(hasTool(calls, 'checkout'), false);
  assert.equal(hasTool(calls, 'checkout_confirm'), false);
});

test('step 1 passes only when refine asks after search with no cart mutation', () => {
  assert.equal(refineAsksAfterSearch(step(['search_product', 'shopping.refine_item'], '어떤 신발로 할까요?')), true);
  // an early add_to_cart is exactly the recorded failure — must fail the check
  assert.equal(refineAsksAfterSearch(step(['search_product', 'shopping.refine_item', 'add_to_cart'], 'asked')), false);
  assert.equal(refineAsksAfterSearch(step(['search_product'], 'asked')), false);
  assert.equal(refineAsksAfterSearch(step(['search_product', 'shopping.refine_item'], '')), false);
  assert.equal(refineAsksAfterSearch(step(['search_product', 'shopping.refine_item'], 'asked', 'timeout')), false);
});

test('step 2 passes when add_to_cart happened and checkout confirmation asks', () => {
  assert.equal(addThenConfirmAsks(step(['add_to_cart', 'shopping.checkout_confirm'], '체크아웃 할까요?')), true);
  assert.equal(addThenConfirmAsks(step(['add_to_cart', 'shopping.checkout_confirm'], 'anything else?')), false);
  assert.equal(addThenConfirmAsks(step(['shopping.checkout_confirm'], '체크아웃 할까요?')), false);
  assert.equal(addThenConfirmAsks(step(['add_to_cart'], '체크아웃 할까요?')), false);
});

test('step 3 passes when a checkout node ran and the reply talks checkout', () => {
  assert.equal(checkoutRunsNoOrder(step(['run_checkout'], '체크아웃 페이지입니다')), true);
  assert.equal(checkoutRunsNoOrder(step(['do_checkout'], 'checkout review reached')), true);
  assert.equal(checkoutRunsNoOrder(step(['checkout'], '결제 준비 완료')), true);
  assert.equal(checkoutRunsNoOrder(step(['search_product'], '체크아웃')), false);
  assert.equal(checkoutRunsNoOrder(step(['run_checkout'], 'hello'), ), false);
});
