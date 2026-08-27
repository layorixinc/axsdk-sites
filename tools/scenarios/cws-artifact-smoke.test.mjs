import assert from 'node:assert/strict';
import test from 'node:test';

import { artifactSmokeVerdict, stage } from './cws-artifact-smoke.mjs';

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

const passingVerdictInput = () => ({
  workspaceStores: 'unchanged',
  scriptIds: ['axsdk-default-form-tools', 'packaged-lua:'],
  toolCalls,
  text: 'comparison window',
  cancelToolCalls: [{ name: 'present_store_offers', status: 'completed', output: { next: 'cancel' } }],
  cancelText: '취소했습니다. 장바구니는 그대로입니다.',
  refinedComparison,
  guardedSelection,
  checkoutStep,
  outsideSurface: {
    text: '이 요청은 도와드릴 수 없어요. 쇼핑 비교와 장바구니, 결제 검토를 도와드릴 수 있습니다.',
    toolCalls: [],
  },
});

test('an extracted package passes only with untouched stores and verified package assets', () => {
  const verdict = artifactSmokeVerdict(passingVerdictInput());

  assert.deepEqual(verdict, { ok: true, failures: [] });
});

test('the exact artifact must cancel its paused comparison without reaching a mutation', () => {
  const missing = artifactSmokeVerdict({ ...passingVerdictInput(), cancelToolCalls: [], cancelText: '' });
  assert.equal(missing.ok, false);
  assert.match(missing.failures.join('\n'), /cancel/i);

  const cancelled = artifactSmokeVerdict({
    ...passingVerdictInput(),
    cancelToolCalls: [{ name: 'shopping_present_store_offers', status: 'completed', output: { next: 'cancel' } }],
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
    outsideSurface: {
      text: '이 요청은 도와드릴 수 없어요. 쇼핑을 도와드릴 수 있습니다.',
      toolCalls: [],
    },
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

/**
 * A run of six live turns with 1,560 seconds of timeouts between them printed nothing until it was over.
 * When it hung, the only evidence was a cleanup warning — so which turn stalled was unattributable, and
 * the honest fix is the same one this repo already made for the commerce sweep: name the stage.
 */
test('a stage reports its name and how long it took', async () => {
  const lines = [];
  const value = await stage('comparison', async () => 'answered', { log: (line) => lines.push(line) });

  assert.equal(value, 'answered');
  assert.equal(lines.length, 2, 'one line when it starts, one when it ends — a start with no end IS the evidence');
  assert.match(lines[0], /^→ comparison$/);
  assert.match(lines[1], /^✓ comparison \d+\.\ds$/);
});

test('a stage that throws carries its name into the failure', async () => {
  const lines = [];
  await assert.rejects(
    stage('checkout', async () => { throw new Error('deadline exceeded'); }, { log: (line) => lines.push(line) }),
    /checkout: deadline exceeded/,
  );
  assert.match(lines.at(-1), /^✗ checkout \d+\.\ds/);
});

test('the failure keeps the original error rather than wrapping it away', async () => {
  const original = new Error('rpc_timeout');
  const caught = await stage('selection', async () => { throw original; }, { log: () => {} }).catch((error) => error);
  assert.equal(caught.cause, original);
});

test('the exact artifact must prove that a surface outside the single purpose is refused', () => {
  // The store profile is only true of what SHIPS, so the artifact has to be asked. A quote request must
  // reach no quote tool and must still be answered — a silent turn would prove nothing, and a turn that
  // reached a quote tool would mean the package was built from the development profile.
  const base = passingVerdictInput();
  assert.ok(artifactSmokeVerdict({
    ...base,
    outsideSurface: {
      text: '이 요청은 도와드릴 수 없어요. 쇼핑 비교와 장바구니, 결제 검토를 도와드릴 수 있습니다.',
      toolCalls: [],
    },
  }).ok);

  const reachedQuote = artifactSmokeVerdict({
    ...base,
    outsideSurface: {
      text: '견적을 준비했습니다',
      toolCalls: [{ name: 'search_service', output: JSON.stringify({ next: 'done' }) }],
    },
  });
  assert.equal(reachedQuote.ok, false);
  assert.match(reachedQuote.failures.join(' '), /outside the single purpose|quote/i);

  const silent = artifactSmokeVerdict({ ...base, outsideSurface: { text: '', toolCalls: [] } });
  assert.equal(silent.ok, false);

  // and the check must be present at all: a run that never asked cannot claim it
  const { outsideSurface: _asked, ...withoutTheQuestion } = base;
  const neverAsked = artifactSmokeVerdict(withoutTheQuestion);
  assert.equal(neverAsked.ok, false);
  assert.match(neverAsked.failures.join(' '), /outside the single purpose|not asked/i);
});

test('a reply carrying raw model scaffolding fails, whichever turn it came from', () => {
  // Measured 2026-08-27 on the store package: with the memory hook deleted, the refusal turn answered
  // `<|channel|>commentary to=functions.memory_record <|constrain|>json<|message|>{ "intent": …` — the
  // model tried to call a function the narrowed document no longer carries and the raw harmony text became
  // the user-facing reply. The old check passed it: the text was non-empty and named none of the tools it
  // was watching for. A reviewer would have read that.
  const base = passingVerdictInput();
  const leak = '<|channel|>commentary to=functions.memory_record <|constrain|>json<|message|>{}';
  for (const field of ['text', 'cancelText']) {
    const verdict = artifactSmokeVerdict({ ...base, [field]: leak });
    assert.equal(verdict.ok, false, `${field} leaked raw scaffolding and passed`);
    assert.match(verdict.failures.join(' '), /raw model|scaffolding|channel/i);
  }
  for (const turn of ['outsideSurface', 'guardedSelection', 'checkoutStep', 'refinedComparison']) {
    const verdict = artifactSmokeVerdict({
      ...base,
      [turn]: { ...base[turn], text: leak },
    });
    assert.equal(verdict.ok, false, `${turn} leaked raw scaffolding and passed`);
  }
});
