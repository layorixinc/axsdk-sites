// Unit tests for checkout.mjs pure verdict logic (node --test). The live flow needs a browser;
// these cover the classification that decides PASS/FAIL per entry case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolLabels, hitCheckout, checkoutCasePassed, tally } from './checkout.mjs';

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
