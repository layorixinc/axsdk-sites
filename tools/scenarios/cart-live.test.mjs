// The decision layer of the live cart proof, tested away from the browser.
//
// The single-site flow could only ever reach amazon until the store resolver landed, so eight of the nine
// cart-capable stores have a mutation path nobody has ever exercised. What this runner must not do is
// believe the tool: §13 records the false positive where `added = true` was reported for a cart holding
// something else, and its lesson — "reading a tool's own status back is not verification of a mutation".
// So a store passes only when the SITE says the product is there, and every other outcome has to be
// CLASSIFIED rather than counted as a failure: a login wall is an honest answer, an unverified claim is not.
//
// The fixtures carry the shape a LIVE trace showed. The first cut asserted on the Lua return
// (`added: true`) and every store came back `unknown`: a flow tool publishes what its `output:` block
// maps, and `shopping_add_to_cart` maps `add_status` ("added"/"failed"), `add_error`, `add_confirmation`.
// The product id is not published there at all — the pick node (`refine_item`, `output: tool.args`) carries
// it. §13: when a live scenario and its unit tests disagree with the product, suspect the fixtures.
import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyAdd, pickedProductId, parseStores, storeVerdict } from './cart-live.mjs';

const call = (name, status, output) => ({ name, status, output });
const cartCall = (output) => call('shopping_add_to_cart', 'completed', { next: 'done', ...output });
const pickCall = (productId) => call('shopping_single_site.refine_item', 'completed', {
  next: 'add', product_id: productId, quantity: 1, cart_approval: 'user_picked_searched_product',
});

test('added plus site evidence is the only pass', () => {
  const outcome = classifyAdd({
    toolCalls: [pickCall('X1'), cartCall({ add_status: 'added', add_confirmation: '장바구니에 담김' })],
    text: '장바구니에 담겼습니다',
    siteEvidence: { productId: 'X1', onCartPage: true, mentionsProduct: true },
  });
  assert.equal(outcome.label, 'added');
  assert.equal(storeVerdict(outcome).pass, true);
});

test('added while the cart page does not mention the product FAILS', () => {
  // The defect class that once reported a cart line that did not exist. It must be the loudest outcome in
  // the matrix, never folded in with "the store refused".
  const outcome = classifyAdd({
    toolCalls: [pickCall('X1'), cartCall({ add_status: 'added' })],
    text: '장바구니에 담겼습니다',
    siteEvidence: { productId: 'X1', onCartPage: true, mentionsProduct: false },
  });
  assert.equal(outcome.label, 'claimed_unverified');
  assert.equal(storeVerdict(outcome).pass, false);
  assert.match(storeVerdict(outcome).reason, /cart page/i);
});

test('site evidence that could not be read is not evidence of absence', () => {
  // A refused op is not a page fact (§13). Calling it "claimed_unverified" would accuse the product of a
  // false positive because OUR probe failed.
  const outcome = classifyAdd({
    toolCalls: [pickCall('X1'), cartCall({ add_status: 'added' })],
    text: '담겼습니다',
    siteEvidence: { productId: 'X1', mentionsProduct: false, evidenceError: 'rpc_timeout' },
  });
  assert.equal(outcome.label, 'unverifiable');
  assert.equal(storeVerdict(outcome).pass, false);
  assert.match(storeVerdict(outcome).reason, /could not be read|rpc_timeout/i);
});

test('an unconfirmed click is classified, not failed — it claims nothing', () => {
  const outcome = classifyAdd({
    toolCalls: [pickCall('X1'), cartCall({ add_status: 'failed', add_error: 'add_to_cart_pending' })],
    text: '담기를 눌렀지만 확인하지 못했습니다',
    siteEvidence: { productId: 'X1', onCartPage: false, mentionsProduct: false },
  });
  assert.equal(outcome.label, 'pending');
  assert.equal(storeVerdict(outcome).pass, true);
});

test('a wall the user must clear is its own outcome', () => {
  for (const [error, label] of [
    ['login_required', 'login_required'],
    ['security_verification_required', 'access_denied'],
    ['captcha_required', 'access_denied'],
    ['required_option', 'required_option'],
  ]) {
    const outcome = classifyAdd({
      toolCalls: [pickCall('X1'), cartCall({ next: 'error', add_status: 'failed', add_error: error })],
      text: '',
      siteEvidence: { productId: 'X1', onCartPage: false, mentionsProduct: false },
    });
    assert.equal(outcome.label, label, `${error} -> ${outcome.label}`);
    assert.equal(storeVerdict(outcome).pass, true, `${error} must be an answer, not a failure`);
  }
});

test('refusals measured live are classified, not "unknown"', () => {
  // Measured 2026-08-26: eBay answered `product_navigation_failed` because the pick was eBay's own
  // "Shop on eBay" promo tile (§13) — the cart refused to click on a page that is not a product, which is
  // the guard working. A refusal the tool MAKES is an answer; only a code nobody has seen is unknown.
  for (const [error, label] of [
    ['product_navigation_failed', 'product_unreachable'],
    ['product_page_unreadable', 'product_unreachable'],
    // Measured on an Etsy made-to-order listing: the configured add control matched nothing, so the tool
    // refused instead of clicking something else. `click_failed` is the same family one step later.
    ['add_to_cart_unavailable', 'add_control_missing'],
    ['click_failed', 'add_control_missing'],
    ['cart_unavailable', 'store_unsupported'],
    ['site_not_ported', 'store_unsupported'],
  ]) {
    const outcome = classifyAdd({
      toolCalls: [pickCall('X1'), cartCall({ next: 'error', add_status: 'failed', add_error: error })],
      text: '',
      siteEvidence: { productId: 'X1', mentionsProduct: false },
    });
    assert.equal(outcome.label, label, `${error} -> ${outcome.label}`);
    assert.equal(storeVerdict(outcome).pass, true, `${error} is an answer the user can act on`);
  }
});

test('a turn that never reached the cart tool is a flow failure, and says what did run', () => {
  const noSearch = classifyAdd({ toolCalls: [], text: '무엇을 살지 확인하지 못했습니다', siteEvidence: {} });
  assert.equal(noSearch.label, 'no_add_call');
  assert.equal(storeVerdict(noSearch).pass, false);

  const searchedOnly = classifyAdd({
    toolCalls: [call('shopping_search_product', 'completed', { next: 'ok' })],
    text: '결과가 없습니다',
    siteEvidence: {},
  });
  assert.equal(searchedOnly.label, 'no_add_call');
  assert.match(searchedOnly.detail, /shopping_search_product/);
});

test('an errored cart tool with no classified reason is unknown, and unknown fails', () => {
  // A new wire code must be visible, not absorbed: the sweep's rule, applied to mutation.
  const outcome = classifyAdd({
    toolCalls: [pickCall('X1'), call('shopping_add_to_cart', 'error', { next: 'error', add_error: 'weird_new_code' })],
    text: '',
    siteEvidence: {},
  });
  assert.equal(outcome.label, 'unknown');
  assert.equal(outcome.detail, 'weird_new_code');
  assert.equal(storeVerdict(outcome).pass, false);
});

test('the cancel path must reach no cart tool at all', () => {
  const outcome = classifyAdd({
    toolCalls: [call('shopping_search_product', 'completed', { next: 'ok' })],
    text: '취소했습니다. 장바구니에 담지 않았습니다.',
    siteEvidence: {},
    expect: 'cancel',
  });
  assert.equal(outcome.label, 'cancelled');
  assert.equal(storeVerdict(outcome).pass, true);

  const mutated = classifyAdd({
    toolCalls: [pickCall('X1'), cartCall({ add_status: 'added' })],
    text: '담았습니다',
    siteEvidence: { mentionsProduct: true, onCartPage: true, productId: 'X1' },
    expect: 'cancel',
  });
  assert.equal(mutated.label, 'cancel_mutated');
  assert.equal(storeVerdict(mutated).pass, false);
});

test('the product id comes from the pick, because the cart tool does not publish one', () => {
  assert.equal(pickedProductId([pickCall('B0TEST'), cartCall({ add_status: 'added' })]), 'B0TEST');
  // The last pick wins: a refine that re-picked is the one the cart acted on.
  assert.equal(pickedProductId([pickCall('first'), pickCall('second')]), 'second');
  assert.equal(pickedProductId([cartCall({ add_status: 'added' })]), undefined);
});

test('stores come from the argument, and naver-shopping is refused with its reason', () => {
  assert.deepEqual(parseStores(['--stores=coupang,11st']).stores, ['coupang', '11st']);
  const refused = parseStores(['--stores=naver-shopping,coupang']);
  assert.deepEqual(refused.stores, ['coupang']);
  assert.match(refused.skipped.join(' '), /naver-shopping/);
  // An unpublished slug is a caller mistake, not something to guess at.
  assert.throws(() => parseStores(['--stores=nowhere']), /nowhere/);
  // The default set is small on purpose: every run leaves real items in real carts.
  assert.ok(parseStores([]).stores.length >= 1);
  assert.ok(parseStores([]).stores.length <= 3);
});
