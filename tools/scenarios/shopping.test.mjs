// Unit tests for shopping.mjs pure step predicates (node --test). The live flow needs a browser; these cover
// the classification of each conversational step's tool trace + reply.
//
// Every fixture name below is COPIED FROM A LIVE TRACE (2026-08-16), not invented. The previous edition named
// `search_product`, `shopping.refine_item` and `add_to_cart` — the durable command names, which the RPC port
// replaced with `shopping_search_product`, `shopping_single_site.refine_item` and `shopping_add_to_cart`. Those
// fixtures passed while the live scenario reported 1/3 for reasons that had nothing to do with behaviour, which
// is §13's rule the hard way: a fixture must carry the shape that was measured.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { addThenConfirmAsks, checkoutRunsNoOrder, hasTool, refineAsksAfterSearch } from './shopping.mjs';

const step = (names, text = 'ok', err = null) => ({
  err,
  text,
  toolCalls: names.map((name) => (typeof name === 'string'
    ? { name, status: 'completed' }
    : { name: name[0], status: name[1] })),
});

// Measured live, step by step.
const SEARCH = ['shopping_single_site.collect_shopping', 'enter_shopping_site', 'next_product',
  'shopping_search_product', 'shopping_single_site.refine_item'];
const PICK = ['shopping_single_site.refine_item', 'shopping_add_to_cart', 'next_product',
  'shopping_single_site.checkout_confirm'];
const CHECKOUT = ['checkout_entry', 'enter_checkout_site', 'run_checkout'];

test('hasTool matches exact tool names only', () => {
  const calls = [{ name: 'shopping_single_site.checkout_confirm', status: 'completed' }];
  assert.equal(hasTool(calls, 'shopping_single_site.checkout_confirm'), true);
  // A bare `checkout` must not match the gate that only ASKS about checkout.
  assert.equal(hasTool(calls, 'checkout'), false);
  assert.equal(hasTool(calls, 'checkout_confirm'), false);
});

test('step 1 passes only when refine asks after search with no cart mutation', () => {
  assert.equal(refineAsksAfterSearch(step(SEARCH, '어떤 신발로 할까요?')), true);
  // An early add is exactly the recorded failure — it must fail the check.
  assert.equal(refineAsksAfterSearch(step([...SEARCH, 'shopping_add_to_cart'], 'asked')), false);
  assert.equal(refineAsksAfterSearch(step(['shopping_search_product'], 'asked')), false,
    'the search alone is not the gate asking');
  assert.equal(refineAsksAfterSearch(step(SEARCH, '')), false);
  assert.equal(refineAsksAfterSearch(step(SEARCH, 'asked', 'timeout')), false);
});

test('step 2 passes when the add SUCCEEDED and checkout confirmation asks', () => {
  assert.equal(addThenConfirmAsks(step(PICK, '장바구니에 담았습니다. 체크아웃 할까요?')), true);

  // Measured live and the old predicate called it a pass: the add answered `error` while the reply said both
  // "장바구니에 담았습니다" and "shoes는 추가되지 않았습니다". A tool that ran is not a tool that worked.
  const failedAdd = step([
    'shopping_single_site.refine_item', ['shopping_add_to_cart', 'error'], 'next_product',
    'shopping_single_site.checkout_confirm',
  ], '장바구니에 담았습니다. shoes는 추가되지 않았습니다. 체크아웃 할까요?');
  assert.equal(addThenConfirmAsks(failedAdd), false, 'an errored add is not an add');

  assert.equal(addThenConfirmAsks(step(PICK, 'anything else?')), false);
  assert.equal(addThenConfirmAsks(step(['shopping_single_site.checkout_confirm'], '체크아웃 할까요?')), false);
  assert.equal(addThenConfirmAsks(step(['shopping_add_to_cart'], '체크아웃 할까요?')), false);
});

test('step 3 passes when a checkout node ran and the reply talks checkout', () => {
  assert.equal(checkoutRunsNoOrder(step(CHECKOUT, '체크아웃 페이지입니다')), true);
  assert.equal(checkoutRunsNoOrder(step(['do_checkout'], 'checkout review reached')), true);
  assert.equal(checkoutRunsNoOrder(step(['shopping_search_product'], '체크아웃')), false);
  assert.equal(checkoutRunsNoOrder(step(CHECKOUT, 'hello')), false);
});
