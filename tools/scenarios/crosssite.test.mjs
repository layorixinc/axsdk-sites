// Unit tests for the cross-site journey's verdict logic. The live journey needs three real sites; these cover
// what a leg's outcome MEANS and when the run may call itself green.
import assert from 'node:assert/strict';
import test from 'node:test';

import { journeyOutcome, legVerdict } from './crosssite.mjs';

const leg = (over = {}) => ({ target: 'thumbtack.com', endUrl: 'https://www.thumbtack.com/k/x', ...over });

test('a leg that reached its target with no forbidden error passes', () => {
  assert.equal(legVerdict(leg(), { forbidden: null }), 'PASS');
});

test('a forbidden cross-nav error fails the leg whatever the url says', () => {
  assert.equal(legVerdict(leg(), { forbidden: 'search: discarded because the active site changed' }),
    'FAIL(cross-nav)');
});

// The whole point of this runner is that each leg FORCES a cross-origin navigation and the SDK's
// complete-on-arrival survives it. A leg that never reached the other site did not produce that proof, so it
// cannot be a shade of success — the previous edition scored it `PARTIAL` and excluded it from the failure
// count, which meant a journey where NO leg ever crossed still exited 0.
test('a leg that never reached the other site is a failure, not a shade of success', () => {
  const verdict = legVerdict(leg({ endUrl: 'https://www.amazon.com/' }), { forbidden: null });
  assert.match(verdict, /^FAIL/, `expected a failure, got ${verdict}`);
  assert.match(verdict, /cross|target|reach/i, 'and it says what did not happen');
});

test('a leg whose turn threw is a failure', () => {
  assert.equal(legVerdict(leg(), { error: 'timeout' }), 'ERROR');
});

test('the journey is green only when every leg crossed and nothing was forbidden', () => {
  const green = journeyOutcome([{ verdict: 'PASS' }, { verdict: 'PASS' }]);
  assert.equal(green.ok, true);
  assert.equal(green.passed, 2);

  const uncrossed = journeyOutcome([{ verdict: 'PASS' }, { verdict: 'FAIL(no-cross)' }]);
  assert.equal(uncrossed.ok, false, 'a leg that never crossed keeps the run red');
  assert.equal(uncrossed.failed, 1);

  const forbidden = journeyOutcome([{ verdict: 'PASS', forbidden: 'x' }]);
  assert.equal(forbidden.ok, false, 'a forbidden error is red even on a leg that reached its target');

  assert.equal(journeyOutcome([]).ok, false, 'a journey with no legs proved nothing');
});
