import assert from 'node:assert/strict';
import test from 'node:test';

import { artifactSmokeVerdict } from './cws-artifact-smoke.mjs';

const toolCalls = [{
  name: 'shopping_build_offer_screening',
  status: 'completed',
  output: {
    store_outcomes: [
      {
        site: 'amazon', status: 'candidates', candidate_count: 2,
        sample: { site: 'amazon', product_id: 'A1', name: 'M185', price: 10, currency: 'USD', url: 'https://amazon.com/dp/A1' },
      },
      {
        site: 'walmart', status: 'candidates', candidate_count: 1,
        sample: { site: 'walmart', product_id: 'W1', name: 'M185', price: 11, currency: 'USD', url: 'https://walmart.com/ip/W1' },
      },
    ],
  },
}, {
  name: 'present_store_offers',
  status: 'completed',
  output: { next: 'ask', comparison_id: 'cmp-1', question: 'comparison window' },
}];

const guardedSelection = {
  err: null,
  text: 'Amazon 상품을 장바구니에 추가했습니다.',
  toolCalls: [
    { name: 'shopping_resolve_store_offer', status: 'completed', output: { next: 'add' } },
    {
      name: 'shopping_add_selected_store_offer',
      status: 'completed',
      output: { next: 'done', cart_status: 'added', cart_confirmation: 'Added to cart' },
    },
  ],
};

const refinedComparison = {
  text: '총 2개 중 1-2번\n1. [amazon] Logitech M185\n2. [amazon] Logitech M185 Mouse',
  toolCalls: [
    { name: 'present_store_offers', status: 'completed', output: { next: 'refine', comparison_id: 'cmp-1' } },
    { name: 'shopping_refine_store_offers', status: 'completed', output: { next: 'present', comparison_id: 'cmp-2' } },
    { name: 'present_store_offers', status: 'completed', output: { next: 'ask', comparison_id: 'cmp-2' } },
  ],
};

const checkoutStep = {
  err: null,
  text: '체크아웃을 진행할 수 없고 주문이 이루어지지 않았습니다.',
  toolCalls: [{ name: 'run_checkout', status: 'completed', output: { next: 'done', status: 'checkout' } }],
};

test('an extracted package passes only with untouched stores and verified package assets', () => {
  const verdict = artifactSmokeVerdict({
    workspaceStores: 'unchanged',
    scriptIds: ['axsdk-default-form-tools', 'packaged-lua:'],
    toolCalls,
    text: 'comparison window',
    cancelToolCalls: [{ name: 'shopping_present_store_offers', status: 'completed', output: { next: 'cancel' } }],
    cancelText: '비교를 취소했습니다. 장바구니에는 아무것도 추가하지 않았습니다.',
    guardedSelection,
    refinedComparison,
    checkoutStep,
  });

  assert.deepEqual(verdict, { ok: true, failures: [] });
});

test('the exact artifact must cancel its paused comparison without reaching a mutation', () => {
  const missing = artifactSmokeVerdict({
    workspaceStores: 'unchanged',
    scriptIds: ['axsdk-default-form-tools', 'packaged-lua:'],
    toolCalls,
    text: 'comparison window',
    cancelToolCalls: [],
    cancelText: '',
    guardedSelection,
    refinedComparison,
    checkoutStep,
  });
  assert.equal(missing.ok, false);
  assert.match(missing.failures.join('\n'), /cancel/i);

  const cancelled = artifactSmokeVerdict({
    workspaceStores: 'unchanged',
    scriptIds: ['axsdk-default-form-tools', 'packaged-lua:'],
    toolCalls,
    text: 'comparison window',
    cancelToolCalls: [{ name: 'shopping_present_store_offers', status: 'completed', output: { next: 'cancel' } }],
    cancelText: '비교를 취소했습니다. 장바구니에는 아무것도 추가하지 않았습니다.',
    guardedSelection,
    refinedComparison,
    checkoutStep,
  });
  assert.deepEqual(cancelled, { ok: true, failures: [] });
});

test('the exact artifact must prove a site-confirmed add and an order-free checkout review', () => {
  const verdict = artifactSmokeVerdict({
    workspaceStores: 'unchanged',
    scriptIds: ['axsdk-default-form-tools', 'packaged-lua:'],
    toolCalls,
    text: 'comparison window',
    cancelToolCalls: [{ name: 'shopping_present_store_offers', status: 'completed', output: { next: 'cancel' } }],
    cancelText: '비교를 취소했습니다.',
    guardedSelection: { err: null, text: '장바구니', toolCalls: [] },
    refinedComparison,
    checkoutStep,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures.join('\n'), /cart/i);
});

test('candidate outcomes without a paused comparison window are not a usable shopping result', () => {
  const verdict = artifactSmokeVerdict({
    workspaceStores: 'unchanged',
    scriptIds: ['axsdk-default-form-tools', 'packaged-lua:'],
    toolCalls: toolCalls.filter((call) => call.name !== 'present_store_offers'),
    text: '상품을 찾았습니다.',
    cancelToolCalls: [{ name: 'shopping_present_store_offers', status: 'completed', output: { next: 'cancel' } }],
    cancelText: '비교를 취소했습니다.',
    guardedSelection,
    refinedComparison,
    checkoutStep,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures.join('\n'), /comparison window/i);
});

test('the exact artifact must preserve and re-present an Amazon-only refined snapshot', () => {
  const verdict = artifactSmokeVerdict({
    workspaceStores: 'unchanged',
    scriptIds: ['axsdk-default-form-tools', 'packaged-lua:'],
    toolCalls,
    text: 'comparison window',
    cancelToolCalls: [{ name: 'shopping_present_store_offers', status: 'completed', output: { next: 'cancel' } }],
    cancelText: '비교를 취소했습니다.',
    refinedComparison: { text: '비교 내용을 읽을 수 없습니다.', toolCalls: [] },
    guardedSelection,
    checkoutStep,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.failures.join('\n'), /refin/i);
});
test('store provisioning or a mutation makes the artifact smoke fail', () => {
  const verdict = artifactSmokeVerdict({
    workspaceStores: 'written',
    scriptIds: ['packaged-lua:', 'stored-lua:amazon'],
    toolCalls: [...toolCalls, { name: 'shopping_add_selected_store_offer', status: 'completed', output: {} }],
    text: '',
  });

  assert.equal(verdict.ok, false);
  assert.match(verdict.failures.join('\n'), /workspace stores|persisted Lua|mutation|reply/i);
});
