// Unit tests for multi-store-total-cost.mjs pure logic (node --test): argument parsing (the
// --cancel read-only path and store selection), decode, and tool-trace lookup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseScenarioArgs,
  decode,
  findToolCall,
  lastToolOutput,
  discoveryChoiceSurface,
  sitesFromWindow,
} from './multi-store-total-cost.mjs';

test('defaults: amazon+ebay, exact product query, choice 1, mutating path', () => {
  const args = parseScenarioArgs([]);
  assert.deepEqual(args.requestedSites, ['amazon', 'ebay']);
  assert.equal(args.cancelOnly, false);
  assert.equal(args.discoveryMode, false);
  assert.equal(args.productChoice, '1');
  assert.match(args.requestText, /^Logitech M185를 Amazon, eBay에서 배송비 포함 총액으로 비교해줘$/);
});

test('--cancel keeps the read-only path selected', () => {
  assert.equal(parseScenarioArgs(['--cancel']).cancelOnly, true);
});

test('--discover switches to the broad discovery query', () => {
  const args = parseScenarioArgs(['--discover']);
  assert.equal(args.discoveryMode, true);
  assert.match(args.requestText, /^로지텍 무선 마우스를 /);
});

test('--stores picks labeled sites in order; unknown slugs fall back to the slug', () => {
  const args = parseScenarioArgs(['--stores=11st,walmart', '--product-choice=2']);
  assert.deepEqual(args.requestedSites, ['11st', 'walmart']);
  assert.equal(args.productChoice, '2');
  assert.match(args.requestText, /11번가, Walmart/);
  assert.match(parseScenarioArgs(['--stores=newegg']).requestText, /newegg/);
});

test('decode unwraps nested JSON strings and leaves objects alone', () => {
  assert.deepEqual(decode(JSON.stringify(JSON.stringify({ a: 1 }))), { a: 1 });
  assert.deepEqual(decode({ a: 1 }), { a: 1 });
  assert.equal(decode('not json'), 'not json');
});

test('findToolCall matches by exact name or dotted suffix and prefers the LAST match', () => {
  const calls = [
    { name: 'shopping.present_store_offers', output: { next: 'first' } },
    { name: 'shopping_search_one_store', output: '{}' },
    { name: 'present_store_offers', output: { next: 'ask' } },
  ];
  assert.equal(findToolCall(calls, 'present_store_offers').output.next, 'ask');
  assert.equal(findToolCall(calls.slice(0, 2), 'present_store_offers').output.next, 'first');
  assert.equal(findToolCall(calls, 'rank_store_offers'), undefined);
});

test('lastToolOutput decodes the matched output', () => {
  const calls = [
    { name: 'shopping_rank_store_offers', output: JSON.stringify({ offers: [{ site: 'amazon' }] }) },
  ];
  assert.deepEqual(lastToolOutput(calls, 'shopping_rank_store_offers'), { offers: [{ site: 'amazon' }] });
  assert.equal(lastToolOutput(calls, 'missing_tool'), null);
});

test('discovery choice proof requires a visible numbered list without internal fields', () => {
  const safe = {
    text: '비교 가능한 모델과 확인된 판매처:\n1. Logitech G304 — found at 11st',
    toolCalls: [{
      name: 'present_product_options',
      status: 'completed',
      output: {
        next: 'ask',
        question: '비교 가능한 모델과 확인된 판매처:\n1. Logitech G304 — found at 11st',
      },
    }],
  };
  assert.equal(discoveryChoiceSurface(safe), true);
  safe.toolCalls[0].output.question += '\nidentity_confidence: medium';
  assert.equal(discoveryChoiceSurface(safe), false);
});

test('comparison attribution reads offer tags and classified failure labels', () => {
  assert.deepEqual(
    sitesFromWindow('1. [11st] G304\n월마트(walmart): 검색 결과 없음', ['11st', 'walmart', 'amazon']),
    ['11st', 'walmart'],
  );
});
