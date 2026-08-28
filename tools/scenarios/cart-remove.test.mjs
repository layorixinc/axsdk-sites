import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CART_TOOLS, activeCartRegion, asinsIn, cancelCasePassed, cartBodyRendered, listingCasePassed,
  listingLooksNumbered, pressedRemoval, removalCasePassed, tally, unmeasuredCasePassed,
} from './cart-remove.mjs';

/**
 * The runner's decisions, tested without a browser — importing this file must not drive one.
 *
 * §13: a live scenario that cannot fail at what it exists to prove is worse than none. `shopping.mjs`
 * asserted a cart add SUCCEEDED for as long as the add reported success without clicking, so these tests
 * are mostly the failure shapes: a tool that claims a removal on an unchanged cart, one that removes two
 * lines from one approval, and a listing nobody could answer.
 */

const call = (name, status = 'completed') => ({ name, status });
const ids = (...values) => new Set(values);

test('the runner expects the tools this flow actually runs', () => {
  assert.deepEqual(CART_TOOLS, ['cart_open_lines', 'cart_present_lines', 'cart_remove_line']);
});

test('the cart page states its own lines', () => {
  const html = '<div class="sc-list-item" data-asin="B0F34DXKZH"><a href="/dp/B0F34DXKZH">x</a></div>'
    + '<div class="sc-list-item" data-asin="B0DGJ7HYG1"></div>'
    // the same row rendered twice, and a recommendation rail naming a THIRD product
    + '<div class="sc-list-item" data-asin="B0DGJ7HYG1"></div>';
  assert.deepEqual([...asinsIn(html)].sort(), ['B0DGJ7HYG1', 'B0F34DXKZH']);
  assert.equal(asinsIn('').size, 0);
  assert.equal(asinsIn(undefined).size, 0);
  // The harness answers `{ url, html }`; passing the envelope in reads as an empty cart, which is how the
  // first live run reported two blocked cases and no defect.
  assert.equal(asinsIn({ html }).size, 0, 'the envelope is not the document');
});

test('a listing is answerable only when it is numbered and says so', () => {
  assert.ok(listingLooksNumbered('Amazon 장바구니 2건\n1. Logitech M185\n2. Anker\n지울 항목의 번호를 알려주세요.'));
  // A reply that lists nothing, or lists without telling the user what to answer, is not a listing.
  assert.ok(!listingLooksNumbered('장바구니를 확인했습니다.'));
  assert.ok(!listingLooksNumbered('1. Logitech M185'));
});

test('the listing turn ran both read tools and pressed nothing', () => {
  const reply = '1. Logitech M185\n2. Anker\n지울 항목의 번호를 알려주세요.';
  assert.ok(listingCasePassed({
    calls: [call('cart_open_lines'), call('cart_present_lines')], reply,
  }));
  // A listing turn that already pressed something is a defect, however good the text looks.
  assert.ok(!listingCasePassed({
    calls: [call('cart_open_lines'), call('cart_present_lines'), call('cart_remove_line')], reply,
  }));
  // Only the presenter ran: nothing was read, so the numbers are from somewhere else.
  assert.ok(!listingCasePassed({ calls: [call('cart_present_lines')], reply }));
});

test('cancel is only cancel when the cart is untouched', () => {
  const before = ids('A1', 'A2');
  assert.ok(cancelCasePassed({ calls: [call('cart_present_lines')], before, after: ids('A1', 'A2') }));
  // The mutation ran despite the refusal — the exact failure §13 measured twice on the offers window.
  assert.ok(!cancelCasePassed({ calls: [call('cart_remove_line')], before, after: ids('A1', 'A2') }));
  // Nothing pressed by us, but a line is gone: the check must still fail, because the claim is that the
  // cart was untouched.
  assert.ok(!cancelCasePassed({ calls: [call('cart_present_lines')], before, after: ids('A1') }));
});

test('a removal counts only when the PAGE lost exactly the one line', () => {
  const calls = [call('cart_present_lines'), call('cart_remove_line')];
  assert.ok(removalCasePassed({ calls, before: ids('A1', 'A2'), after: ids('A2') }));
  // The tool claimed a removal and the cart still states every line — the add path's false positive,
  // pointing the other way.
  assert.ok(!removalCasePassed({ calls, before: ids('A1', 'A2'), after: ids('A1', 'A2') }));
  // One approval, two lines gone.
  assert.ok(!removalCasePassed({ calls, before: ids('A1', 'A2', 'A3'), after: ids('A3') }));
  // A line APPEARED: whatever happened, it was not this removal.
  assert.ok(!removalCasePassed({ calls, before: ids('A1', 'A2'), after: ids('A2', 'A9') }));
  // The line vanished on its own and the mutation never ran: not a removal we performed.
  assert.ok(!removalCasePassed({ calls: [call('cart_present_lines')], before: ids('A1'), after: ids() }));
});

test('an unmeasured store must not press and must not lose a line', () => {
  assert.ok(unmeasuredCasePassed({ calls: [call('cart_open_lines')], before: ids('A1'), after: ids('A1') }));
  assert.ok(!unmeasuredCasePassed({ calls: [call('cart_remove_line')], before: ids('A1'), after: ids('A1') }));
  assert.ok(!unmeasuredCasePassed({ calls: [call('cart_open_lines')], before: ids('A1'), after: ids() }));
});

test('pressedRemoval reads the tool NAME, not the reply prose', () => {
  assert.ok(pressedRemoval([call('cart_remove_line', 'error')]));
  assert.ok(!pressedRemoval([call('cart_open_lines'), call('cart_present_lines')]));
  assert.ok(!pressedRemoval([]));
  assert.ok(!pressedRemoval(undefined));
});

test('an empty run is not a green run', () => {
  assert.deepEqual(tally([]), { pass: 0, total: 0, allPassed: false });
  assert.equal(tally([['a', true], ['b', false]]).allPassed, false);
});

test('the cart SHELL is not the cart', () => {
  // Measured live: a 128 KiB shell states `nav-cart-count: 5` and `sc-active-cart` (in its scripts) while
  // carrying no rows at all. Counting ids there reports an empty cart for a full one.
  const shell = '<div id="nav-cart-count">5</div><script>sc-active-cart</script>';
  assert.ok(!cartBodyRendered(shell));
  assert.ok(cartBodyRendered('<input value="Delete" data-asin="A1">'));
  assert.ok(cartBodyRendered('<div id="sc-empty-cart">Your Amazon Cart is empty</div>'));
  assert.ok(!cartBodyRendered(''));
});

test('the evidence is the cart, not the list under it', () => {
  // Measured live: three "Saved for later" rows carrying ids and Delete controls sat below a cart holding
  // ONE line. A page-wide count called that four lines, so a removal of the one line read as 4 → 3 and the
  // runner could not tell which list had changed.
  const html = '<div id="sc-active-cart"><div class="sc-list-item" data-asin="B0CART">'
    + '<input value="Delete"></div></div>'
    + '<div class="sc-list-caption">Saved for later</div>'
    + '<div class="sc-list-item" data-asin="B0SAVED"><input value="Delete"></div>';
  assert.deepEqual([...asinsIn(activeCartRegion(html))], ['B0CART']);
  assert.equal(asinsIn(html).size, 2, 'page-wide counts both lists — which is the trap');
  assert.equal(activeCartRegion('<div>no cart here</div>'), '');
});
