import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { loadLuaModules } from './harness.mjs';
import { installRpcStub, makePage } from './rpc-stub.mjs';

/**
 * WHERE the add stopped, published as one field.
 *
 * `add_to_cart_pending` answers for four different facts: the control was never found, the click was
 * refused, the click landed and the store's own counter never moved, or the counter moved and the cart
 * never showed the line. §13 already records the same lesson one level up ("`add_to_cart_pending` used to
 * answer for three different facts") — and live, on a store where a plain click on the same button lands
 * the item every time, `pending` is all the flow could say (`TODO.md` §19).
 *
 * The stage costs no round trip: every milestone is a fact the script already established.
 */

const lua = loadLuaModules(['_common/rpc/61_rpc_storefront.lua', '_common/rpc/67_rpc_cart.lua']);
after(() => lua.close());

const PRODUCT = 'https://www.amazon.com/dp/B0TEST1234';
const CART = 'https://www.amazon.com/gp/cart/view.html';

const CONFIG = {
  site: 'amazon',
  hosts: ['www.amazon.com', 'amazon.com'],
  product_url_prefix: 'https://www.amazon.com/dp/',
  product_id_patterns: ['/dp/([A-Z0-9]+)', '^([A-Z0-9]+)$'],
  product_title_selectors: ['#productTitle'],
  product_price_selectors: ['.a-price .a-offscreen'],
  add_selectors: ['#add-to-cart-button'],
  cart_url: CART,
  cart_url_markers: ['/gp/cart'],
  cart_item_scopes: ['#sc-active-cart .sc-list-item'],
  cart_active_line_filters: [':has([data-action="delete-active"])'],
  cart_count_selectors: ['#nav-cart-count'],
  confirmation_selector: '#sw-atc-details-single-container',
  confirmation_text_selectors: ['#sw-atc-details-single-container'],
  default_currency: 'USD',
};

const APPROVED = {
  site: 'amazon',
  product_id: 'B0TEST1234',
  expected_unit_price: 29.99,
  expected_currency: 'USD',
  expected_identity_model: 'M185',
  identity_id: 'id-1',
  comparison_id: 'cmp-1',
  identity_approval: 'locked_product_identity',
  comparison_approval: 'current_comparison',
  cart_approval: 'user_selected_compared_offer',
};

/** A product page. `onAdd` decides what the STORE does with the press — that is never the op's answer. */
const productPage = ({ addControl = true, onAdd = null, count = '1' } = {}) => {
  const dom = {
    body: [{ text: 'Amazon' }],
    '#productTitle': [{ text: 'Logitech M185 Wireless Mouse' }],
    '.a-price .a-offscreen': [{ text: '$29.99' }],
    '#nav-cart-count': [{ text: count }],
  };
  if (addControl) dom['#add-to-cart-button'] = [{ text: 'Add to Cart' }];
  const page = makePage({ href: PRODUCT, dom });
  page.onClick = (selector, live) => {
    if (!String(selector).includes('add-to-cart')) return true;
    if (!onAdd) return false;          // the site ignored it
    return onAdd(live);
  };
  return page;
};

const add = (page, args = {}) => {
  installRpcStub(lua, page);
  return lua.call('AX_RPC_CART.add_to_cart', { config: CONFIG, ...APPROVED, ...args });
};

test('the control was never there', () => {
  const answer = add(productPage({ addControl: false }));
  assert.equal(answer.added, false);
  assert.equal(answer.error, 'add_to_cart_unavailable');
  assert.equal(answer.stage, 'control_missing');
});

test('the control was there and the click was refused', () => {
  // `dom.click` answers whether it FOUND something; a page that refuses is a different fact from a page
  // that has no button, and both used to arrive as one word.
  const page = productPage();
  page.rejectClick = ['#add-to-cart-button'];
  const answer = add(page);
  assert.equal(answer.added, false);
  assert.equal(answer.error, 'click_failed');
  assert.equal(answer.stage, 'click_refused');
});

test('the click landed and the store never moved its own counter', () => {
  const answer = add(productPage({ onAdd: () => true }));
  assert.equal(answer.added, false);
  assert.equal(answer.stage, 'clicked');
});

test('the counter moved and the cart still does not name the line', () => {
  const answer = add(productPage({
    onAdd: (live) => {
      live.dom['#nav-cart-count'] = [{ text: '2' }];
      return true;
    },
  }));
  assert.equal(answer.added, false);
  assert.equal(answer.stage, 'count_moved');
});

test('a confirmed add says so, and the stage is the last thing that happened', () => {
  const answer = add(productPage({
    onAdd: (live) => {
      live.dom['#nav-cart-count'] = [{ text: '2' }];
      live.dom['#sw-atc-details-single-container'] = [{ text: 'Added to Cart' }];
      return true;
    },
  }));
  assert.equal(answer.added, true);
  assert.equal(answer.next, 'done');
  assert.equal(answer.stage, 'confirmed');
});

test('a call refused before it touches the page names the guard, not a page step', () => {
  // The approval markers are checked first and cost no round trip; the stage must say that rather than
  // implying the page was read.
  const page = productPage();
  const answer = add(page, { cart_approval: undefined });
  assert.equal(answer.added, false);
  assert.equal(answer.stage, 'not_approved');
  assert.deepEqual(page.ops, []);
});
