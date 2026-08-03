import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { loadLuaModules } from './harness.mjs';
import { installRpcStub, makePage } from './rpc-stub.mjs';

// The checkout takes the user to a REVIEW page and stops. It exists so a person can look at the order
// total, the address and the payment method before deciding — so the one thing it must never do is decide
// for them. Every test here is ultimately about that: `#submitOrderButtonId` and its siblings are read to
// report whether the button is there, and never clicked.
//
// It lives in its own module so the cart module stays provably order-free: `check:flows` asserts the cart's
// code contains no checkout or order words at all, which only stays true if the checkout is elsewhere.

const lua = loadLuaModules([
  '_common/rpc/61_rpc_storefront.lua',
  '_common/rpc/68_rpc_checkout.lua',
]);
after(() => lua.close());

const CART = 'https://www.amazon.com/gp/cart/view.html';
const CHECKOUT = 'https://www.amazon.com/gp/buy/spc/handlers/display.html';

const CONFIG = {
  site: 'amazon',
  hosts: ['www.amazon.com', 'amazon.com'],
  cart_url: CART,
  cart_url_markers: ['/gp/cart/view.html'],
  cart_ready_selector: '#sc-active-cart, #sc-empty-cart',
  cart_empty_selector: '#sc-empty-cart',
  cart_item_selector: '.sc-list-item[data-asin]',
  cart_subtotal_selectors: ['#sc-subtotal-amount-activecart'],
  checkout_button_selectors: ['input[name="proceedToRetailCheckout"]', '#hlb-ptc-btn-native'],
  checkout_ready_selector: '#subtotals, #deliver-to-customer-text, #submitOrderButtonId',
  checkout_url_markers: ['/gp/buy/', '/checkout/'],
  checkout_summary_selector: '#subtotals',
  checkout_delivering_to_selector: '#deliver-to-customer-text',
  checkout_address_selector: '#deliver-to-address-text',
  checkout_payment_selectors: ['#checkout-payment-option-panel'],
  place_order_selectors: ['#submitOrderButtonId', 'input[name="placeYourOrder1"]'],
  login_selector: '#ap_email',
  blocked_selectors: [{ selector: 'form[action*="validateCaptcha"]', error: 'captcha_required' }],
};

/** A cart page that becomes the checkout review page when "proceed to checkout" is clicked. */
function shop({ href = 'https://www.amazon.com/', cart = {}, checkout = {}, advances = true } = {}) {
  const dom = {};
  const page = makePage({ href, dom, afterNavigate: dom });
  const cartPage = () => {
    for (const key of Object.keys(dom)) delete dom[key];
    Object.assign(dom, {
      body: [{ text: 'Cart' }],
      '#sc-active-cart': [{ text: 'Shopping Cart' }],
      '.sc-list-item[data-asin]': [{ text: 'Logitech M185' }],
      '#sc-subtotal-amount-activecart': [{ text: '$29.99' }],
      'input[name="proceedToRetailCheckout"]': [{ text: 'Proceed to checkout' }],
    }, cart);
    page.href = CART;
    page.dom = dom;
    if (page.pendingHref !== undefined) page.pendingDom = dom;
  };
  page.showCart = cartPage;
  page.onClick = (selector) => {
    if (!/proceedToRetailCheckout|ptc-btn/.test(selector) || !advances) return;
    for (const key of Object.keys(dom)) delete dom[key];
    Object.assign(dom, {
      body: [{ text: 'Review your order' }],
      '#subtotals': [{ text: 'Items: $29.99 Shipping & handling: $0.00 Estimated tax to be collected: $2.62 Order total: $32.61' }],
      '#deliver-to-customer-text': [{ text: 'Delivering to AX Tester' }],
      '#deliver-to-address-text': [{ text: '1 Market St, San Francisco, CA 94101' }],
      '#checkout-payment-option-panel': [{ text: 'Visa ending in 1111' }],
      '#submitOrderButtonId': [{ text: 'Place your order' }],
    }, checkout);
    page.href = CHECKOUT;
    page.dom = dom;
  };
  cartPage();
  page.href = href;
  return page;
}

const review = (page, args = {}) => {
  installRpcStub(lua, page);
  return lua.call('AX_RPC_CHECKOUT.review', { config: CONFIG, ...args });
};

const clicks = (page) => page.ops.filter((entry) => entry.op === 'dom.click').map((entry) => entry.params.selector);

test('the review page is reached and read', () => {
  const page = shop();
  const result = review(page);

  assert.equal(result.next, 'done');
  assert.equal(result.status, 'checkout');
  assert.match(result.checkout.order_summary.order_total, /32\.61/);
  assert.match(result.checkout.delivering_to, /AX Tester/);
  assert.match(result.checkout.payment_method, /Visa/);
});

test('the order button is reported, never pressed', () => {
  // The whole point of the review: the user decides. Reporting that the button exists is the service;
  // pressing it is the thing that must not happen.
  const page = shop();
  const result = review(page);

  assert.equal(result.checkout.place_order_available, true);
  for (const selector of clicks(page)) {
    assert.ok(
      !/submitOrder|placeYourOrder|bottomSubmit/i.test(selector),
      `nothing that places an order may be clicked, saw ${selector}`,
    );
  }
});

test('an empty cart is reported instead of proceeding', () => {
  const page = shop({ cart: { '#sc-active-cart': [], '#sc-empty-cart': [{ text: 'Your Amazon Cart is empty' }], '.sc-list-item[data-asin]': [] } });
  const result = review(page);

  assert.equal(result.status, 'cart_empty');
  assert.equal(result.error, 'cart_empty');
  assert.deepEqual(clicks(page), []);
});

test('a cart with no checkout control is reported by name', () => {
  const page = shop({ cart: { 'input[name="proceedToRetailCheckout"]': [] } });
  const result = review(page);

  assert.equal(result.error, 'checkout_unavailable');
  assert.deepEqual(clicks(page), []);
});

test('a login wall stops the review', () => {
  const page = shop({ cart: { '#ap_email': [{ text: '' }] } });
  const result = review(page);

  assert.equal(result.login_required, true);
  assert.deepEqual(clicks(page), []);
});

test('a bot wall stops the review', () => {
  const page = shop({ cart: { 'form[action*="validateCaptcha"]': [{ text: 'Enter the characters' }] } });
  const result = review(page);

  assert.equal(result.error, 'captcha_required');
  assert.deepEqual(clicks(page), []);
});

test('already being on the review page does not go back to the cart', () => {
  // The durable version guarded this with a re-entry check, because a replay that re-navigated to the cart
  // would undo the progress. One call cannot replay, but it can still be invoked while already there.
  const page = shop();
  page.onClick = () => {};
  page.href = CHECKOUT;
  page.dom = {
    body: [{ text: 'Review your order' }],
    '#subtotals': [{ text: 'Order total: $32.61' }],
    '#submitOrderButtonId': [{ text: 'Place your order' }],
  };
  const result = review(page);

  assert.equal(result.status, 'checkout');
  assert.deepEqual(page.ops.filter((entry) => entry.op === 'nav.navigate'), [], 'no navigation at all');
});

test('a checkout that never arrives is pending, not a review', () => {
  // Reporting a review that was never reached would have the flow tell the user to look at a total nobody
  // read.
  const page = shop({ advances: false });
  const result = review(page);

  assert.equal(result.status, 'checkout_pending');
  assert.ok(!result.checkout, 'nothing may be reported as read');
});

test('the summary keeps the labels the page used', () => {
  const page = shop();
  const summary = review(page).checkout.order_summary;

  assert.match(summary.items, /29\.99/);
  assert.match(summary.shipping_handling, /0\.00/);
  assert.match(summary.estimated_tax, /2\.62/);
});

test('a payment panel padded with script source is cut at the script', () => {
  // Measured on a partially loaded checkout: `dom.get_text` is textContent, so inline <script> source
  // arrives inside the panel's text. Reporting that to the user as their payment method is nonsense.
  const page = shop({
    checkout: { '#checkout-payment-option-panel': [{ text: 'Visa ending in 1111//<![CDATA[ (function(){PaymentsPortal.init()})()' }] },
  });
  const result = review(page);

  assert.equal(result.checkout.payment_method, 'Visa ending in 1111');
});

test('a panel that has not resolved yet reads as unknown, not as an answer', () => {
  // Measured live on amazon's current checkout: the payment panel answered
  // "Payment method Setting your payment method... Payment method" — its own label plus a loading sentence.
  // Printing that to the user as their payment method is worse than saying nothing, because it looks like
  // an answer. A value nobody read is nil.
  for (const text of [
    'Payment method Setting your payment method... Payment method',
    'Setting your payment method...',
    'Loading...',
  ]) {
    const page = shop({ checkout: { '#checkout-payment-option-panel': [{ text }] } });
    assert.equal(review(page).checkout.payment_method, undefined, `for ${JSON.stringify(text)}`);
  }

  // A resolved panel still reads.
  const good = shop();
  assert.match(review(good).checkout.payment_method, /Visa/);
});

test('a summary nothing could be read from is absent, not an empty object', () => {
  // Measured live on amazon's current checkout pipeline: there is no `#subtotals`, so every field came back
  // nil and the tool reported `order_summary: {}`. An empty object reads downstream as "a summary exists",
  // and the terminal then has nothing to say about a total it never saw. Absent says the truth.
  const page = shop({ checkout: { '#subtotals': [] } });
  const result = review(page);

  assert.equal(result.status, 'checkout');
  assert.equal(result.checkout.order_summary, undefined);
});

test('a summary with even one field keeps it', () => {
  const page = shop({ checkout: { '#subtotals': [{ text: 'Order total: $32.61' }] } });
  const summary = review(page).checkout.order_summary;

  assert.match(summary.order_total, /32\.61/);
  assert.equal(summary.items, undefined);
});
