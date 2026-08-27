import assert from 'node:assert/strict';
import test from 'node:test';

import { CART_SITES, clearVerdict, nextAction } from './cart-clear.mjs';

/**
 * The two decisions this tool makes without a browser: when to stop pressing, and whether what happened is
 * what it claims. Both matter because the alternative is a loop that clicks forever on a page that will
 * not shrink, and a "cleared" report on a cart that still has five items in it.
 */

test('a cart with items and a control is pressed; anything else stops', () => {
  assert.deepEqual(nextAction({ items: 5, controls: 5, pressed: 0 }), { done: false, reason: 'press' });
  assert.deepEqual(nextAction({ items: 0, controls: 0, pressed: 3 }), { done: true, reason: 'empty' });
  // A page that shows items but offers no control is a refusal to report — often a login wall.
  assert.deepEqual(nextAction({ items: 5, controls: 0, pressed: 0 }), { done: true, reason: 'no_control' });
  // and the cap exists so a cart that never shrinks cannot spin
  assert.deepEqual(nextAction({ items: 5, controls: 5, pressed: 20 }), { done: true, reason: 'cap' });
  assert.deepEqual(nextAction({ items: 5, controls: 5, pressed: 3, cap: 3 }), { done: true, reason: 'cap' });
});

test('emptying is the only outcome reported as success', () => {
  assert.deepEqual(clearVerdict({ before: 5, after: 0, reason: 'empty' }), { ok: true, detail: '5 → 0' });

  const stuck = clearVerdict({ before: 5, after: 5, reason: 'no_control' });
  assert.equal(stuck.ok, false);
  assert.match(stuck.detail, /login/);

  const capped = clearVerdict({ before: 9, after: 2, reason: 'cap' });
  assert.equal(capped.ok, false);
  assert.match(capped.detail, /cap/);

  // partial progress is not success either
  assert.equal(clearVerdict({ before: 5, after: 1, reason: 'press' }).ok, false);
});

test('every configured store names a home page, a cart link, a tab marker and a remove label', () => {
  // A store whose config is half-written would look like an empty cart, which is the one failure that
  // reads as success. There is no row selector on purpose: a row is counted by the remove control it
  // carries, because coupang's row containers are `twc-*` build utilities (§10 forbids depending on those)
  // and the control is the one thing every row has exactly one of.
  for (const [site, config] of Object.entries(CART_SITES)) {
    assert.ok(config.home.startsWith('https://'), `${site} home`);
    assert.ok(config.cartHref.length > 0, `${site} cart link`);
    assert.ok(config.cartMarker.length > 0, `${site} tab marker`);
    assert.ok(config.removeLabels.length > 0, `${site} remove label`);
    assert.ok(Array.isArray(config.confirmLabels), `${site} confirm labels`);
    assert.ok(!Object.hasOwn(config, 'itemProbe'), `${site} must not carry a stale row selector`);
  }
});
