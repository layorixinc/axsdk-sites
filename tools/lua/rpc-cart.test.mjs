import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { loadLuaModules } from './harness.mjs';
import { installRpcStub, makePage } from './rpc-stub.mjs';

// The guarded cart is the one place in this repo where a mistake spends the user's money. So the tests here
// are mostly about what must NOT happen: no click without every approval marker, none after the product
// turned out to be a different model, none after the price went up, and never anything that orders.
//
// The durable adapter answered `pending: true, status: "navigating"` in THREE places, each time because a
// navigation destroyed its context and the flow had to call it again. A runtime script keeps its stack, so
// that answer does not exist here — and its absence is asserted.

const lua = loadLuaModules([
  '_common/rpc/61_rpc_storefront.lua',
  '_common/rpc/67_rpc_cart.lua',
]);
after(() => lua.close());

const PRODUCT = 'https://www.amazon.com/dp/B0TEST1234';
const CART = 'https://www.amazon.com/gp/cart/view.html';

// The config vocabulary is the one the GENERATED site data carries — `login_selector`, and
// `blocked_selectors` as { selector, error } rows. Inventing friendlier names here would test a shape no
// site actually has.
const CONFIG = {
  site: 'amazon',
  hosts: ['www.amazon.com', 'amazon.com'],
  product_url_prefix: 'https://www.amazon.com/dp/',
  product_id_patterns: ['/dp/([A-Z0-9]+)', '^([A-Z0-9]+)$'],
  product_title_selectors: ['#productTitle'],
  product_price_selectors: ['.a-price .a-offscreen'],
  add_selectors: ['#add-to-cart-button'],
  quantity_selectors: ['#quantity'],
  cart_url: CART,
  cart_url_markers: ['/gp/cart'],
  confirmation_selector: '#sw-atc-details-single-container',
  confirmation_text_selectors: ['#sw-atc-details-single-container'],
  default_currency: 'USD',
  login_selector: '#ap_email',
  blocked_selectors: [{ selector: 'form[action*="validateCaptcha"]', error: 'captcha_required' }],
};

const APPROVED = {
  site: 'amazon',
  product_id: 'B0TEST1234',
  quantity: 1,
  expected_unit_price: 29.99,
  expected_currency: 'USD',
  expected_identity_model: 'M185',
  identity_id: 'id-1',
  comparison_id: 'cmp-1',
  identity_approval: 'locked_product_identity',
  comparison_approval: 'current_comparison',
  cart_approval: 'user_selected_compared_offer',
};

/** A product page that becomes the cart page once the add button is clicked. */
function shop({ href = 'https://www.amazon.com/', title = 'Logitech M185 Wireless Mouse', price = '$29.99', extra = {}, onAdd } = {}) {
  const dom = {};
  const page = makePage({ href, dom, afterNavigate: dom });
  const productPage = () => {
    for (const key of Object.keys(dom)) delete dom[key];
    Object.assign(dom, {
      body: [{ text: 'Amazon' }],
      '#productTitle': [{ text: title }],
      '.a-price .a-offscreen': [{ text: price }],
      '#add-to-cart-button': [{ text: 'Add to Cart' }],
      '#quantity': [{ text: '1' }],
    }, extra);
    page.dom = dom;
    if (page.pendingHref !== undefined) page.pendingDom = dom;
  };
  page.showProduct = productPage;
  page.onClick = (selector) => {
    if (selector.includes('add-to-cart')) {
      if (onAdd) return onAdd(page, dom);
      // The site lands on its cart page with the item listed.
      for (const key of Object.keys(dom)) delete dom[key];
      Object.assign(dom, {
        body: [{ text: 'Cart' }],
        '#sw-atc-details-single-container': [{ text: 'Added to Cart' }],
      });
      page.href = CART;
      page.dom = dom;
    }
  };
  productPage();
  page.dom = dom;
  return page;
}

const add = (page, args = {}) => {
  installRpcStub(lua, page);
  return lua.call('AX_RPC_CART.add_to_cart', { config: CONFIG, ...APPROVED, ...args });
};

const clicks = (page) => page.ops.filter((entry) => entry.op === 'dom.click').map((entry) => entry.params.selector);

test('a confirmed add reports the confirmation the site showed', () => {
  const page = shop();
  const result = add(page);

  assert.equal(result.added, true);
  assert.equal(result.next, 'done');
  assert.match(result.confirmation, /Added to Cart/);
  assert.match(result.cart_url, /\/gp\/cart/);
});

test('there is no navigating answer at all', () => {
  // The durable adapter had three. Each existed because the call died on a navigation.
  const page = shop();
  const result = add(page);

  assert.equal(result.pending, undefined);
  assert.notEqual(result.status, 'navigating');
});

test('nothing is clicked without the cart approval', () => {
  const page = shop();
  const result = add(page, { cart_approval: null });

  assert.equal(result.added, false);
  assert.equal(result.error, 'approval_required');
  assert.deepEqual(clicks(page), []);
});

test('nothing is clicked without the identity and comparison approvals', () => {
  for (const missing of [
    { identity_approval: null }, { comparison_approval: null },
    { identity_id: null }, { comparison_id: null },
  ]) {
    const page = shop();
    const result = add(page, missing);
    assert.equal(result.error, 'identity_approval_required', `for ${JSON.stringify(missing)}`);
    assert.deepEqual(clicks(page), []);
  }
});

test('a product that is no longer the approved model is not added', () => {
  // The user approved one model out of a comparison. A page that now shows another is a different product,
  // whatever its id says.
  const page = shop({ title: 'Logitech M240 Silent Wireless Mouse' });
  const result = add(page);

  assert.equal(result.added, false);
  assert.equal(result.error, 'identity_changed');
  assert.match(result.current_product_title, /M240/);
  assert.deepEqual(clicks(page), []);
});

test('a title element with nothing in it is a failed revalidation, not a pass', () => {
  // The title is also how a product page is recognised, so an ABSENT element means we never landed on one
  // (`product_navigation_failed`). An element that is there and says nothing is the case where identity
  // cannot be rechecked — and it must not fall through as approval.
  const blank = shop({ extra: { '#productTitle': [{ text: '' }] } });
  assert.equal(add(blank).error, 'identity_revalidation_failed');
  assert.deepEqual(clicks(blank), []);

  const missing = shop({ extra: { '#productTitle': [] } });
  assert.equal(add(missing).error, 'product_navigation_failed');
  assert.deepEqual(clicks(missing), []);
});

test('a price above the approved one is not added', () => {
  const page = shop({ price: '$34.99' });
  const result = add(page);

  assert.equal(result.added, false);
  assert.equal(result.error, 'price_changed');
  assert.equal(result.current_price, 34.99);
  assert.deepEqual(clicks(page), []);
});

test('a price below the approved one is fine', () => {
  // The guard is against paying MORE than what was compared.
  const page = shop({ price: '$24.99' });
  assert.equal(add(page).added, true);
});

test('a different currency is not added', () => {
  const page = shop({ price: '€29.99' });
  const result = add(page);

  assert.equal(result.error, 'currency_changed');
  assert.deepEqual(clicks(page), []);
});

test('a price the page will not show is a failed revalidation', () => {
  const page = shop({ extra: { '.a-price .a-offscreen': [] } });
  const result = add(page);

  assert.equal(result.error, 'price_revalidation_failed');
  assert.deepEqual(clicks(page), []);
});

test('a required variation stops the add', () => {
  const page = shop({ extra: { '#variation_color_name select': [{ text: '' }] } });
  const result = add(page, { config: { ...CONFIG, required_option_selectors: ['#variation_color_name select'] } });

  assert.equal(result.error, 'variation_required');
  assert.deepEqual(clicks(page), []);
});

test('a quantity above one is set before the add', () => {
  const page = shop();
  add(page, { quantity: 3 });

  assert.deepEqual(page.filled.map((entry) => entry.value), ['3']);
});

test('a quantity that cannot be set is refused rather than adding one', () => {
  // Adding a single unit when three were approved is the wrong order, quietly.
  const page = shop({ extra: { '#quantity': [] } });
  const result = add(page, { quantity: 3 });

  assert.equal(result.error, 'quantity_unavailable');
  assert.deepEqual(clicks(page), []);
});

test('a store with no cart is refused by name', () => {
  const page = shop();
  const result = add(page, { config: { ...CONFIG, cart_supported: false } });

  assert.equal(result.error, 'add_to_cart_unsupported');
  assert.deepEqual(clicks(page), []);
});

test('a login wall is reported, not treated as a failed click', () => {
  const page = shop({ extra: { '#ap_email': [{ text: '' }] } });
  const result = add(page);

  assert.equal(result.login_required, true);
  assert.deepEqual(clicks(page), []);
});

test('a bot wall is reported as blocked', () => {
  const page = shop({ extra: { 'form[action*="validateCaptcha"]': [{ text: 'Enter the characters' }] } });
  const result = add(page);

  assert.equal(result.blocked, true);
  assert.deepEqual(clicks(page), []);
});

test('an add the site never confirmed is not reported as added', () => {
  // The click fired and the cart still does not list it. Saying "added" would tell the user an order line
  // exists that does not.
  const page = shop({ onAdd: () => {} });
  const result = add(page);

  assert.equal(result.added, false);
  assert.equal(result.error, 'add_to_cart_pending');
});

test('nothing that orders is ever clicked', () => {
  const page = shop();
  add(page);

  for (const selector of clicks(page)) {
    assert.ok(
      !/checkout|place-?order|buy-?now|proceed/i.test(selector),
      `refused: ${selector}`,
    );
  }
});

test('the protection-plan upsell is declined, and only it', () => {
  // Amazon's add lands on "Add a protection plan" before the confirmation. Nobody approved a second
  // product, so declining is the default — and the decline must be the only extra thing clicked.
  const withUpsell = { ...CONFIG, upsell_pane_selector: '#attach-warranty-pane', upsell_decline_selector: '#attachSiNoCoverage' };
  const page = shop({
    onAdd: (self, dom) => {
      for (const key of Object.keys(dom)) delete dom[key];
      Object.assign(dom, {
        body: [{ text: 'Add a protection plan' }],
        '#attach-warranty-pane': [{ text: 'Add a protection plan for $5.99' }],
        '#attachSiNoCoverage': [{ text: 'No thanks' }],
      });
      self.dom = dom;
      // Declining reveals the confirmation.
      self.onClick = (selector) => {
        if (!selector.includes('attachSiNoCoverage')) return;
        for (const key of Object.keys(dom)) delete dom[key];
        Object.assign(dom, { body: [{ text: 'Cart' }], '#sw-atc-details-single-container': [{ text: 'Added to Cart' }] });
        self.href = CART;
        self.dom = dom;
      };
    },
  });
  const result = add(page, { config: withUpsell });

  assert.equal(result.added, true);
  const clicked = clicks(page);
  assert.ok(clicked.some((selector) => selector.includes('attachSiNoCoverage')), `declined, saw ${clicked.join(' | ')}`);
  assert.ok(
    !clicked.some((selector) => /attachSiAddCoverage|addCoverage|yes/i.test(selector)),
    `nothing that accepts the plan may be clicked, saw ${clicked.join(' | ')}`,
  );
});

test("amazon's own generated config carries what the cart needs", () => {
  // The port's whole point: one implementation driven by data. If the generated config is missing a cart
  // key, the shared cart silently degrades to `add_to_cart_unavailable` on the biggest store we support.
  const sites = loadLuaModules(['_common/rpc/62_rpc_sites.lua']);
  sites.define('function __amazon_config() return RPC_SITES["amazon"] end', 'amazon config reader');
  const config = sites.call('__amazon_config');
  sites.close();

  for (const key of [
    'product_title_selectors', 'product_price_selectors', 'add_selectors', 'quantity_selectors',
    'confirmation_selector', 'cart_url', 'cart_url_markers', 'upsell_pane_selector', 'upsell_decline_selector',
  ]) {
    assert.ok(config[key], `amazon must declare ${key}`);
  }
});

test('the single-site flow has its own approval shape, and it is still an approval', () => {
  // Two callers, two gates. The multi-store flow approves a compared OFFER (identity + comparison + cart
  // markers). The single-site flow has no comparison at all: its gate is `refine_item`, where the user
  // picks one product out of the searched list. Requiring the comparison markers there would break a flow
  // that never had a comparison; requiring nothing would leave the biggest guard off for half the callers.
  const page = shop();
  const result = add(page, {
    identity_id: null, comparison_id: null, identity_approval: null, comparison_approval: null,
    cart_approval: 'user_picked_searched_product',
  });

  assert.equal(result.added, true);
});

test('no approval of any shape adds nothing', () => {
  for (const shape of [{ cart_approval: null }, { cart_approval: 'something_else' }]) {
    const page = shop();
    const result = add(page, {
      identity_id: null, comparison_id: null, identity_approval: null, comparison_approval: null, ...shape,
    });
    assert.equal(result.error, 'approval_required', `for ${JSON.stringify(shape)}`);
    assert.deepEqual(clicks(page), []);
  }
});

// ── the cart must contain THIS product, not merely be a cart ──────────────────
//
// Found by re-basing the offline commerce gate off the durable adapter. `cart_contains` took a
// `product_id` and, on its first branch, never used it: any match for `confirmation_selector` answered
// true. That was written for a post-add confirmation PANEL, which is per-add evidence. But amazon's
// generated selector has since grown cart-page STRUCTURE — `#sc-active-cart, .sc-list-item[data-asin]` —
// which is present on any rendered amazon cart whatever it holds. So the guarded cart could report
// `added = true` for a cart containing something else entirely. This is the one path in this repo where
// a wrong answer spends the user's money, so it fails closed or not at all.
const STRUCTURAL_CONFIRM = {
  ...CONFIG,
  // Verbatim shape from the generated site data for amazon.
  confirmation_selector: '#sw-atc-confirmation, #sc-active-cart, .sc-list-item[data-asin]',
};

test('a cart page holding a DIFFERENT product does not confirm the approved one', () => {
  const page = shop({ href: CART, extra: {
    // The cart rendered, and it lists someone else's item. Both of these match the site's structural
    // confirmation selector.
    '#sc-active-cart': 'Shopping Cart',
    '.sc-list-item[data-asin]': 'Some Other Thing',
    'a[href*="B0OTHER9999"]': 'Some Other Thing',
  } });
  installRpcStub(lua, page);

  const confirmed = lua.call('AX_RPC_CART.cart_contains', STRUCTURAL_CONFIRM, 'B0TEST1234');

  assert.equal(confirmed, false, 'a cart is not evidence that THIS product is in it');
});

test('a cart page listing the approved product does confirm it', () => {
  const page = shop({ href: CART, extra: {
    '#sc-active-cart': 'Shopping Cart',
    '.sc-list-item[data-asin]': 'Logitech M185',
    'a[href*="B0TEST1234"]': 'Logitech M185 Wireless Mouse',
  } });
  installRpcStub(lua, page);

  assert.equal(lua.call('AX_RPC_CART.cart_contains', STRUCTURAL_CONFIRM, 'B0TEST1234'), true);
});

test('an asin declared on the row confirms it too', () => {
  // Amazon carries the id in `data-asin`, which the id probe did not ask for — so on the one site whose
  // cart page states the id most precisely, the check could only fall back to an href match.
  const page = shop({ href: CART, extra: {
    '#sc-active-cart': 'Shopping Cart',
    '[data-asin="B0TEST1234"]': 'Logitech M185',
  } });
  installRpcStub(lua, page);

  assert.equal(lua.call('AX_RPC_CART.cart_contains', STRUCTURAL_CONFIRM, 'B0TEST1234'), true);
});

test('off the cart page a confirmation panel is still per-add evidence', () => {
  // The original intent, preserved: a toast on the PRODUCT page appeared because this add happened.
  const page = shop({ href: PRODUCT, extra: { '#sw-atc-confirmation': 'Added to Cart' } });
  installRpcStub(lua, page);

  assert.equal(lua.call('AX_RPC_CART.cart_contains', STRUCTURAL_CONFIRM, 'B0TEST1234'), true);
});

// ── a foreign primary quote with a localized alternate ───────────────────────
//
// Measured live on an eBay item page (2026-08-15): the primary quote is the seller's currency and the
// buyer's localized approximation sits beside it.
//   .x-price-primary       -> "개당 US $5.34"
//   .x-price-approx__price -> "KRW7,559.73"
// The comparison approves whichever amount the WINDOW showed, which for a Korean shopper is the KRW one.
// Reading only the primary therefore refused a correct add with `currency_changed`, and the durable eBay
// adapter satisfied revalidation from the approximation. Approx is consulted ONLY when the primary is a
// different currency than the one approved — never to make a mismatched amount pass.
const APPROX_CONFIG = {
  ...CONFIG,
  product_price_selectors: ['.x-price-primary'],
  product_price_approx_selectors: ['.x-price-approx__price'],
};

test('the localized alternate satisfies revalidation when the primary is another currency', () => {
  const page = shop({ href: PRODUCT, extra: {
    '.x-price-primary': [{ text: '개당 US $5.34' }],
    '.x-price-approx__price': [{ text: 'KRW7,559.73' }],
  } });
  page.showProduct();
  installRpcStub(lua, page);

  const refusal = lua.call('AX_RPC_CART.price_error', APPROX_CONFIG,
    { expected_unit_price: 7559.73, expected_currency: 'KRW' }, 'ITEM1');

  assert.equal(refusal, null, 'the approved KRW amount is on the page, so nothing is wrong');
});

test('a localized alternate that is HIGHER than approved still blocks', () => {
  const page = shop({ href: PRODUCT, extra: {
    '.x-price-primary': [{ text: '개당 US $5.34' }],
    '.x-price-approx__price': [{ text: 'KRW9,900.00' }],
  } });
  page.showProduct();
  installRpcStub(lua, page);

  const refusal = lua.call('AX_RPC_CART.price_error', APPROX_CONFIG,
    { expected_unit_price: 7559.73, expected_currency: 'KRW' }, 'ITEM1');

  assert.equal(refusal?.error, 'price_changed', 'the guard is against paying more, in any currency');
});

test('without an approx selector a foreign primary still refuses', () => {
  // The fallback is opt-in per site. A site that declares no approximation must not start guessing.
  const page = shop({ href: PRODUCT, extra: { '.x-price-primary': [{ text: '개당 US $5.34' }] } });
  page.showProduct();
  installRpcStub(lua, page);

  const refusal = lua.call('AX_RPC_CART.price_error',
    { ...CONFIG, product_price_selectors: ['.x-price-primary'] },
    { expected_unit_price: 7559.73, expected_currency: 'KRW' }, 'ITEM1');

  assert.equal(refusal?.error, 'currency_changed');
});

test('a matching primary currency never consults the approximation', () => {
  // Otherwise a site showing both would have two sources of truth for one number.
  const page = shop({ href: PRODUCT, extra: {
    '.x-price-primary': [{ text: 'KRW 7,000' }],
    '.x-price-approx__price': [{ text: 'KRW99,999.00' }],
  } });
  page.showProduct();
  installRpcStub(lua, page);

  assert.equal(lua.call('AX_RPC_CART.price_error', APPROX_CONFIG,
    { expected_unit_price: 7559.73, expected_currency: 'KRW' }, 'ITEM1'), null);
});
