// Unit tests for checkout.mjs pure verdict logic (node --test). The live flow needs a browser;
// these cover the classification that decides PASS/FAIL per entry case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkoutCasePassed, hitCheckout, recordCase, tally, toolLabels } from './checkout.mjs';

test('toolLabels formats name(status) in order', () => {
  assert.deepEqual(
    toolLabels([{ name: 'search_product', status: 'done' }, { name: 'run_checkout' }]),
    ['search_product(done)', 'run_checkout(undefined)'],
  );
});

test('hitCheckout recognizes checkout and open_site tools', () => {
  assert.equal(hitCheckout([{ name: 'shopping.run_checkout', status: 'done' }]), true);
  assert.equal(hitCheckout([{ name: 'open_site', status: 'done' }]), true);
  assert.equal(hitCheckout([{ name: 'AX_checkout', status: 'running' }]), true);
});

test('hitCheckout rejects a trace with no checkout routing', () => {
  assert.equal(hitCheckout([{ name: 'search_product', status: 'done' }, { name: 'add_to_cart', status: 'done' }]), false);
  assert.equal(hitCheckout([]), false);
});

test('checkoutCasePassed requires both the checkout node and an amazon url', () => {
  const trace = [{ name: 'run_checkout', status: 'done' }];
  assert.equal(checkoutCasePassed(trace, 'https://www.amazon.com/gp/cart'), true);
  // Cross-nav case that never left the origin site must FAIL even though checkout tools ran.
  assert.equal(checkoutCasePassed(trace, 'http://bluemoonsoft.com/'), false);
  // Landing on amazon without the checkout node is not a pass either.
  assert.equal(checkoutCasePassed([{ name: 'search_product', status: 'done' }], 'https://www.amazon.com/'), false);
});

test('tally counts passes and reports the exit verdict', () => {
  const { pass, total, allPassed } = tally([['a', true], ['b', false], ['c', true]]);
  assert.equal(pass, 2);
  assert.equal(total, 3);
  assert.equal(allPassed, false);
  assert.equal(tally([['a', true]]).allPassed, true);
});

// Measured live: `reset()` timed out at 60s inside the try, the throw left `main`, and the run printed NO
// verdict at all — three checks silently became no checks. A step that fails must cost ONE check and let the
// others report, which is the same rule the commerce sweep learned when dying on the first batch hid every later
// batch's cost.
test('a step that throws records a failed check and does not take the run down', async () => {
  const checks = [];
  await recordCase(checks, 'first', async () => true);
  await recordCase(checks, 'second', async () => { throw new Error('reset timed out'); });
  await recordCase(checks, 'third', async () => true);

  assert.equal(checks.length, 3, 'every case is accounted for');
  assert.deepEqual(checks.map(([, ok]) => ok), [true, false, true]);
  assert.match(String(checks[1][2] ?? ''), /reset timed out/, 'and the reason survives to the report');

  const { pass, total, allPassed } = tally(checks);
  assert.equal(pass, 2);
  assert.equal(total, 3);
  assert.equal(allPassed, false);
});

test('a case that answers false is a failure without an exception', async () => {
  const checks = [];
  await recordCase(checks, 'only', async () => false);
  assert.deepEqual(checks.map(([, ok]) => ok), [false]);
});
