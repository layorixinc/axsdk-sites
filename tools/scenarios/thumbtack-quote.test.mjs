import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cancellationContactedNobody,
  candidateSelectionPassed,
  collectionRetained,
  searchReachedCandidates,
  wizardStoppedBeforeSubmit,
} from './thumbtack-quote.mjs';

const call = (name, output, status = 'completed') => ({ name, status, output });
const searchCalls = () => [
  call('search_service', { next: 'done' }),
  call('prepare_service_results_table', { next: 'render' }),
  call('present_service_results', { next: 'ask' }),
];

test('a retained collection must resume its presenter instead of entering the flow again', () => {
  const first = { toolCalls: [call('present_quote_collection', { next: 'ask' })] };
  const second = {
    text: '```ax-widget\nprofessionals',
    toolCalls: [
      call('present_quote_collection', { next: 'resume' }),
      call('verify_request', { next: 'ok' }),
      ...searchCalls(),
    ],
  };

  assert.equal(collectionRetained(first, second), true);
  second.toolCalls.unshift(call('detect_cancellation', { next: 'continue' }));
  assert.equal(collectionRetained(first, second), false, 'a fresh entry discarded accumulated quote fields');
});

test('a successful search requires classified candidates and a paused visible listing', () => {
  const good = { text: '```ax-widget\n전문가 목록', toolCalls: searchCalls() };
  assert.equal(searchReachedCandidates(good), true);
  good.toolCalls[0].output = '{"next":"done","candidates":[... [4000 chars trimmed]';
  assert.equal(searchReachedCandidates(good), true, 'the complete window survives trimmed large tool output');
  assert.equal(searchReachedCandidates({ ...good, toolCalls: good.toolCalls.slice(0, 2) }), false);
  assert.equal(searchReachedCandidates({ ...good, toolCalls: [call('search_service', { next: 'no_results' })] }), false);
});

test('selection proves that a current number resolved into a refined approval list', () => {
  const ranked = {
    text: '전문가 10명 중 1-5번. 번호로 선택',
    toolCalls: [call('browse_service_candidates', '{"next":"ask",... [4000 chars trimmed]')],
  };
  const selected = {
    text: '```ax-widget\nSelected Thumbtack professionals (3)',
    toolCalls: [
      call('browse_service_candidates', { next: 'done' }),
      call('prepare_refined_results_table', { next: 'render' }),
      call('present_refined_results', { next: 'ask' }),
    ],
  };
  assert.equal(candidateSelectionPassed(ranked, selected), true);
  selected.toolCalls.splice(1, 1);
  assert.equal(candidateSelectionPassed(ranked, selected), false);
});

test('wizard proof requires the final safe boundary, positive progress, and no send tool', () => {
  const safe = {
    text: '최종 Submit 앞에서 멈췄으며 견적은 보내지 않았습니다.',
    toolCalls: [call('open_quote', { next: 'submit', quote_reached_submit: true, quote_steps: 6 })],
  };
  assert.equal(wizardStoppedBeforeSubmit(safe), true);
  assert.equal(wizardStoppedBeforeSubmit({
    text: '견적은 아직 전송되지 않았으며, 어떤 전문가에게도 연락되지 않았습니다.',
    toolCalls: [call('open_quote', {
      next: 'submit',
      quote_reached_submit: false,
      quote_advance_reason: 'contact_boundary',
      quote_steps: 8,
    })],
  }), true);
  assert.equal(wizardStoppedBeforeSubmit({
    ...safe,
    toolCalls: [...safe.toolCalls, call('submit_quote', { next: 'done' })],
  }), false);
});

test('cancel proof fails if any professional-opening or sending tool ran', () => {
  const safe = {
    text: '취소했습니다. 어떤 전문가에게도 연락하지 않았고 요청도 보내지 않았습니다.',
    toolCalls: [call('browse_service_candidates', { next: 'cancel' })],
  };
  assert.equal(cancellationContactedNobody(safe), true);
  assert.equal(cancellationContactedNobody({
    ...safe,
    toolCalls: [...safe.toolCalls, call('open_quote', { next: 'submit' })],
  }), false);
});
