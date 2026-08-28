import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';

import { loadLuaModules } from './harness.mjs';
import { installRpcStub, makePage } from './rpc-stub.mjs';

/**
 * Removing a line from the cart is a MUTATION, so it is tested the way the add is: mostly by what must not
 * happen. No press without the user's own approval marker, none on a store whose controls nobody measured,
 * and never a "removed" answer the cart page does not support — a claim that a line is gone while it is
 * still there is the same class of defect as the false `added = true` §13 records.
 */

const lua = loadLuaModules(['_common/rpc/62_rpc_sites.lua', '_common/rpc/67_rpc_cart.lua']);
after(() => lua.close());

const CART = 'https://www.amazon.com/gp/cart/view.html';

/**
 * A cart page holding one measured line. `dom` is the stub's one map: a selector that is present answers
 * its text, and a selector that is absent does not exist — which is how a removed row is expressed.
 */
const cartPage = ({ removes = true, dom = {} } = {}) => {
  const page = makePage({
    href: CART,
    dom: {
      '#sc-active-cart': 'cart',
      // The real row: measured live, amazon's cart lines ARE `.sc-list-item[data-asin]` and each carries
      // one `input[value="Delete"]`. A fixture that omits the scope would pass against a reader that
      // does not use it — the trap §13 records as "a fixture more permissive than the capability".
      //
      // Scoped to the cart's own container, because the same markup exists in "Saved for later" one screen
      // down (measured live) and the probe must not reach it.
      '#sc-active-cart .sc-list-item:has(input[value="Delete"])[data-asin="B0TEST"]': 'Logitech M185',
      '#sc-active-cart .sc-list-item[data-asin="B0TEST"]': 'Logitech M185',
      '#sc-active-cart .sc-list-item[data-asin="B0TEST"] input[value="Delete"]': 'Delete',
      'span.nav-cart-count': '2',
      ...dom,
    },
    // The site decides what a press does, never the op: a stub whose click changes nothing can only ever
    // prove the unconfirmed branch, which is why both directions are tested.
    onClick: (selector, live) => {
      if (!removes) return true;
      if (!String(selector).includes('Delete')) return true;
      delete live.dom['#sc-active-cart .sc-list-item:has(input[value="Delete"])[data-asin="B0TEST"]'];
      delete live.dom['#sc-active-cart .sc-list-item[data-asin="B0TEST"]'];
      delete live.dom['#sc-active-cart .sc-list-item[data-asin="B0TEST"] input[value="Delete"]'];
      live.dom['span.nav-cart-count'] = '1';
      return true;
    },
  });
  return page;
};

const remove = (page, args) => {
  installRpcStub(lua, page);
  return lua.call('AX_RPC_CART.remove_from_cart', args);
};

test('a removal with no approval marker touches nothing', () => {
  const page = cartPage();
  const answer = remove(page, { site: 'amazon', product_id: 'B0TEST' });

  assert.equal(answer.next, 'error');
  assert.equal(answer.error, 'approval_required');
  assert.equal(answer.removed, false);
  // and nothing was pressed, nor even read: a call that should not touch the page must not touch it
  assert.deepEqual(page.ops, []);
});

test('a store whose remove controls nobody measured is refused before it moves', () => {
  // gmarket on purpose: it HAS a cart url and no measured remove control, so the refusal has to come from
  // the control check rather than from a missing url. naver-shopping would pass either way — it has no
  // cart at all — and a test that cannot tell the two apart is not testing the guard.
  const page = cartPage();
  const answer = remove(page, {
    site: 'gmarket', product_id: 'X1', cart_approval: 'user_confirmed_removal',
  });

  assert.equal(answer.next, 'error');
  assert.equal(answer.error, 'remove_not_configured');
  assert.equal(answer.removed, false);
  // and it refused BEFORE moving: the same message can be reached later by a store with no cart url, so
  // the assertion that separates them is that the page was never touched.
  assert.deepEqual(page.ops.filter((op) => op.op.startsWith('nav.')), []);
});

test('an approved removal presses the row control and reports the cart it left', () => {
  // The row selector carries the id, which is the only way a specific line can be pressed: the runtime's
  // `query_all` answers `{ text }` with no per-element selector, so a control is reachable only by a CSS
  // selector the config can build.
  const page = cartPage();
  const answer = remove(page, {
    site: 'amazon', product_id: 'B0TEST', cart_approval: 'user_confirmed_removal',
  });

  assert.equal(answer.next, 'done');
  assert.equal(answer.removed, true);
  assert.equal(answer.product_id, 'B0TEST');
  assert.equal(answer.site, 'amazon');
  const clicked = page.ops.filter((op) => op.op === 'dom.click').map((op) => op.params.selector);
  assert.ok(clicked.some((selector) => selector.includes('B0TEST')), `pressed: ${clicked.join(', ')}`);
});

test('a line still on the page after the press is not a removal', () => {
  // The site is what decides, never our own click. §13: reading a tool's own status back is not
  // verification of a mutation.
  const page = cartPage({ removes: false }); // the row survives the press
  const answer = remove(page, {
    site: 'amazon', product_id: 'B0TEST', cart_approval: 'user_confirmed_removal',
  });

  assert.equal(answer.next, 'error');
  assert.equal(answer.removed, false);
  assert.equal(answer.error, 'remove_unconfirmed');
});

test('a cart that never held the line answers already_absent, without pressing', () => {
  const page = makePage({ href: CART, dom: { '#sc-active-cart': 'cart', 'span.nav-cart-count': '0' } });
  const answer = remove(page, {
    site: 'amazon', product_id: 'B0GONE', cart_approval: 'user_confirmed_removal',
  });

  assert.equal(answer.next, 'done');
  assert.equal(answer.removed, false);
  assert.equal(answer.status, 'already_absent');
  assert.equal(page.ops.filter((op) => op.op === 'dom.click').length, 0);
});

test('nothing in the removal can order, and nothing in it adds', () => {
  // The same assertion the checkout module carries (§13): a module that cannot express an order cannot
  // place one by accident, and this one must not grow an add path either.
  const source = readFileSync(new URL('../../_common/rpc/67_rpc_cart.lua', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('function R.remove_from_cart'));
  assert.ok(body.length > 200, 'the removal exists');
  for (const forbidden of ['checkout', 'place_order', 'buy_now', 'add_selectors']) {
    assert.ok(!new RegExp(forbidden, 'i').test(body), `the removal must not mention ${forbidden}`);
  }
});


test('the press cannot reach a row outside the ACTIVE cart', () => {
  // The live defect this exists for, measured 2026-08-27: amazon renders "Saved for later" with the SAME
  // `.sc-list-item[data-asin]` markup and its own Delete control, so an unscoped selector pressed the wrong
  // list — the page's own announcements read "<title> was removed from Saved for Later." A removal the user
  // asked for in their cart must not touch a list they did not name.
  const page = makePage({
    href: CART,
    dom: {
      '#sc-active-cart': [{ text: 'cart' }],
      '#nav-cart-count': [{ text: '0' }],
      // ONLY the saved list holds this id — and it satisfies every UNSCOPED form the probe can ask for,
      // including the active-line one, because a saved row carries its own Delete control too. That is what
      // made this pressable: the scope, not the control, is what separates the two lists.
      '.sc-list-item[data-asin="B0SAVED"]': [{ text: 'Logitech M185 Save for later' }],
      '.sc-list-item[data-asin="B0SAVED"] input[value="Delete"]': [{ text: 'Delete' }],
    },
  });

  const answer = remove(page, {
    site: 'amazon', product_id: 'B0SAVED', cart_approval: 'user_confirmed_removal',
  });
  // Nothing of ours is in the cart, so there is nothing to remove — and no press may have happened.
  assert.equal(answer.removed, false);
  assert.equal(answer.status, 'already_absent');
  assert.deepEqual(page.ops.filter((op) => op.op === 'dom.click'), []);
});

test('the listing shows the cart, not another list on the same page', () => {
  const page = makePage({
    href: CART,
    dom: {
      '#sc-active-cart': [{ text: 'cart' }],
      '#nav-cart-count': [{ text: '1' }],
      '#sc-active-cart .sc-list-item[data-asin]:has(input[value="Delete"])': [
        { text: 'Anker 충전기 Delete', 'data-asin': 'B0CART' },
      ],
      // The saved list, same markup, one page down. Measured live: three such rows while the cart was EMPTY.
      '.sc-list-item[data-asin]': [
        { text: 'Anker 충전기 Delete', 'data-asin': 'B0CART' },
        { text: 'Logitech M185 was removed from Saved for Later', 'data-asin': 'B0SAVED' },
      ],
    },
  });
  installRpcStub(lua, page);
  const read = lua.call('AX_RPC_CART.read_cart', { site: 'amazon' });
  assert.equal(read.next, 'ok');
  assert.deepEqual(read.lines.map((line) => line.product_id), ['B0CART']);
});

test('the undo panel amazon leaves behind is not the line still being there', () => {
  // Measured live 2026-08-27, inside `#sc-active-cart` right after a removal that worked: the id is still
  // present, `input[value="Delete"]` is 0, and one `Undo` has appeared. Reading the id alone reported
  // `remove_unconfirmed` for three removals out of three.
  const page = makePage({
    href: CART,
    dom: {
      '#sc-active-cart': [{ text: 'cart' }],
      '#nav-cart-count': [{ text: '1' }],
      '#sc-active-cart .sc-list-item:has(input[value="Delete"])[data-asin="B0TEST"]': [{ text: 'Logitech M185' }],
      '#sc-active-cart .sc-list-item[data-asin="B0TEST"]': [{ text: 'Logitech M185' }],
      '#sc-active-cart .sc-list-item[data-asin="B0TEST"] input[value="Delete"]': [{ text: 'Delete' }],
    },
    onClick: (selector, live) => {
      if (!String(selector).includes('Delete')) return true;
      // The panel: the row and its id stay, the control goes, Undo appears.
      delete live.dom['#sc-active-cart .sc-list-item:has(input[value="Delete"])[data-asin="B0TEST"]'];
      delete live.dom['#sc-active-cart .sc-list-item[data-asin="B0TEST"] input[value="Delete"]'];
      live.dom['#sc-active-cart .sc-list-item[data-asin="B0TEST"]'] = [{ text: 'Logitech M185 Undo' }];
      live.dom['#nav-cart-count'] = [{ text: '0' }];
      return true;
    },
  });

  const answer = remove(page, {
    site: 'amazon', product_id: 'B0TEST', cart_approval: 'user_confirmed_removal',
  });
  assert.equal(answer.next, 'done');
  assert.equal(answer.removed, true);
  assert.equal(answer.error, undefined);
  assert.equal(answer.previous_cart_count, 1);
  assert.equal(answer.cart_count, 0);
});
