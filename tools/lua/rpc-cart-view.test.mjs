import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';

import { loadLuaModules } from './harness.mjs';
import { installRpcStub, makePage } from './rpc-stub.mjs';

/**
 * The surface the user actually chooses from. Everything here defends one property: the number the user
 * types resolves to the line they were SHOWN, and nothing else can reach the removal.
 *
 * §13 records what the alternatives cost. A model gate between a numbered list and a cart mutation read the
 * PREVIOUS turn's "3번" and added an offer the user had just cancelled, so this loop has no model node: the
 * presenter renders, pauses on its own question, and classifies the reply through the same
 * `AX_CANDIDATE_BROWSER` the Thumbtack shortlist and the offers window use.
 */

const CART = 'https://www.amazon.com/gp/cart/view.html';

const lua = loadLuaModules([
  // 46 is the shared reply reader and it stands on the pure view layer beneath it; a module list that
  // names only what it calls directly fails at load with that module's own guard.
  '_common/scripts/00_base.lua',
  '_common/scripts/44_pagination.lua',
  '_common/scripts/45_offer_view.lua',
  '_common/scripts/46_candidate_browser.lua',
  '_common/rpc/62_rpc_sites.lua',
  '_common/rpc/67_rpc_cart.lua',
  '_common/rpc/74_rpc_cart_view.lua',
]);
// The listing travels as one JSON scalar, so the runtime needs the host codec the extension provides.
lua.expose({ json: { encode: (value) => JSON.stringify(value), decode: (text) => JSON.parse(text) } });
after(() => lua.close());

/**
 * A populated cart. `dom` is the stub's one map: a present selector answers its text, an absent one does
 * not exist. `rows` is what a batched `query_all` answers for the line selector — the shape the runtime
 * returns, `{ text, root_id }` per row, with no per-element selector.
 */
const cartPage = (rows = null) => makePage({
  href: CART,
  dom: {
    '#sc-active-cart': [{ text: 'cart' }],
    '#nav-cart-count': [{ text: '2' }],
    '#sc-active-cart .sc-list-item:has([data-action="delete-active"])[data-asin="B0ONE"]': [{ text: 'Logitech M185 무선 마우스' }],
    '#sc-active-cart .sc-list-item:has([data-action="delete-active"])[data-asin="B0TWO"]': [{ text: 'Anker 충전기' }],
    // What a batched `query_all` answers for the line selector: the runtime returns `{ text }` plus the
    // asked-for attributes per row, with no per-element selector.
    //
    // Keyed on the SCOPED selector the reader asks for: the same markup exists in "Saved for later" on the
    // same page (measured live), so an unscoped reader lists rows that are not in the cart.
    '#sc-active-cart .sc-list-item[data-asin]:has([data-action="delete-active"])': rows ?? [
      { text: 'Logitech M185 무선 마우스   $12.99  Quantity: 1  Delete', 'data-asin': 'B0ONE' },
      { text: 'Anker 충전기  $24.50  Quantity: 2  Delete', 'data-asin': 'B0TWO' },
      // The same line rendered twice — responsive duplicates are a measured fact of these pages.
      { text: 'Anker 충전기  $24.50  Quantity: 2  Delete', 'data-asin': 'B0TWO' },
    ],
  },
});

const call = (page, name, args) => {
  installRpcStub(lua, page);
  return lua.call(name, args);
};

test('the cart is read as lines, deduplicated by id, with the row text as the label', () => {
  const page = cartPage();
  const answer = call(page, 'AX_RPC_CART_VIEW.open', { site: 'amazon' });

  assert.equal(answer.next, 'show');
  assert.equal(answer.site, 'amazon');
  assert.equal(answer.cart_count, 2);
  assert.ok(answer.cart_state, 'the lines must travel to the next turn as one scalar');
  assert.equal(typeof answer.cart_state, 'string');
  assert.ok(answer.cart_state.includes('B0ONE') && answer.cart_state.includes('B0TWO'));
  // Three rows in, two lines out.
  assert.equal((answer.cart_state.match(/B0TWO/g) ?? []).length, 1);
});

test('an empty cart is a different answer from a cart nobody measured', () => {
  const empty = call(makePage({
    href: CART,
    dom: { '#sc-active-cart': [{ text: 'cart' }], '#nav-cart-count': [{ text: '0' }] },
  }), 'AX_RPC_CART_VIEW.open', { site: 'amazon' });
  assert.equal(empty.next, 'empty');

  // gmarket has a cart url and no measured line selector: it must not report an empty cart.
  const unmeasured = call(cartPage(), 'AX_RPC_CART_VIEW.open', { site: 'gmarket' });
  assert.equal(unmeasured.next, 'error');
  assert.equal(unmeasured.error, 'cart_read_not_configured');
});

test('the first pass renders the numbered window and pauses on it', () => {
  const page = cartPage();
  const opened = call(page, 'AX_RPC_CART_VIEW.open', { site: 'amazon' });
  const shown = call(page, 'AX_RPC_CART_VIEW.present', { cart_state: opened.cart_state });

  assert.equal(shown.next, 'ask');
  assert.equal(shown.choice_stage, 'await_choice');
  assert.ok(/1\./.test(shown.question) && /2\./.test(shown.question), shown.question);
  assert.ok(shown.question.includes('Logitech M185'), shown.question);
  // The ids are never shown and never asked for: the user answers with a number.
  assert.ok(!shown.question.includes('B0ONE'), shown.question);
  assert.equal(shown.cart_state, opened.cart_state, 'the listing must survive its own question');
});

test('a number resolves to the line that was shown, and carries the approval', () => {
  const page = cartPage();
  const opened = call(page, 'AX_RPC_CART_VIEW.open', { site: 'amazon' });
  const picked = call(page, 'AX_RPC_CART_VIEW.present', {
    cart_state: opened.cart_state,
    choice_stage: 'await_choice',
    userMessages: ['장바구니 비워줘', '2번 지워줘'],
  });

  assert.equal(picked.next, 'remove');
  assert.equal(picked.product_id, 'B0TWO');
  assert.ok(picked.product_title.includes('Anker'), picked.product_title);
  // The marker the mutation requires is written HERE, by the turn the user chose in — not by the tool that
  // mutates. §13: two writers of one approval is how an approval stops meaning anything.
  assert.equal(picked.cart_approval, 'user_confirmed_removal');
});

test('cancel stops, and a number nobody listed does not', () => {
  const page = cartPage();
  const opened = call(page, 'AX_RPC_CART_VIEW.open', { site: 'amazon' });

  const cancelled = call(page, 'AX_RPC_CART_VIEW.present', {
    cart_state: opened.cart_state,
    choice_stage: 'await_choice',
    userMessages: ['취소'],
  });
  assert.equal(cancelled.next, 'cancel');
  assert.equal(cancelled.product_id, undefined, 'a cancel names no line');

  const beyond = call(page, 'AX_RPC_CART_VIEW.present', {
    cart_state: opened.cart_state,
    choice_stage: 'await_choice',
    userMessages: ['7번'],
  });
  assert.equal(beyond.next, 'ask');
  assert.equal(beyond.choice_stage, 'await_choice');
  assert.ok(beyond.question.includes('7'), beyond.question);
  assert.equal(beyond.product_id, undefined);
});

test('the reply is read from the raw current message, not from a stale request', () => {
  // Measured trap (§13): the planner can resume the right node while preserving the ORIGINAL request text,
  // and reading that turned "취소" into the model number in the first query and reached the cart path.
  const page = cartPage();
  const opened = call(page, 'AX_RPC_CART_VIEW.open', { site: 'amazon' });
  const answer = call(page, 'AX_RPC_CART_VIEW.present', {
    cart_state: opened.cart_state,
    choice_stage: 'await_choice',
    requestText: 'M185 2개 장바구니에서 빼줘',
    userMessages: ['M185 2개 장바구니에서 빼줘', '취소'],
  });
  assert.equal(answer.next, 'cancel');
});

test('a listing that did not survive the turn says so instead of guessing', () => {
  const page = cartPage();
  const answer = call(page, 'AX_RPC_CART_VIEW.present', {
    choice_stage: 'await_choice',
    userMessages: ['1번'],
  });
  assert.equal(answer.next, 'error');
  assert.equal(answer.error, 'cart_lost');
});

test('the view reads and renders; it never presses anything', () => {
  const page = cartPage();
  call(page, 'AX_RPC_CART_VIEW.open', { site: 'amazon' });
  call(page, 'AX_RPC_CART_VIEW.present', { cart_state: 'x' });
  assert.deepEqual(page.ops.filter((op) => /click|submit|set_value/.test(op.op)), []);

  const source = readFileSync('_common/rpc/74_rpc_cart_view.lua', 'utf8');
  for (const name of ['dom.click', 'dom.submit_form', 'checkout', 'place_order']) {
    assert.ok(!source.includes(name), `the view must not mention ${name}`);
  }
});


test('a line the user already removed is not offered again', () => {
  // The undo panel: id present, remove control gone (measured live inside the cart's own container). Listing
  // it would hand the user a number that removes nothing — live, the window showed exactly that.
  const page = makePage({
    href: CART,
    dom: {
      '#sc-active-cart': [{ text: 'cart' }],
      '#nav-cart-count': [{ text: '1' }],
      '#sc-active-cart .sc-list-item[data-asin]:has([data-action="delete-active"])': [
        { text: 'Anker 충전기  Delete', 'data-asin': 'B0TWO' },
      ],
      '#sc-active-cart .sc-list-item[data-asin]': [
        { text: 'Logitech M185 무선 마우스  Undo', 'data-asin': 'B0ONE' },
        { text: 'Anker 충전기  Delete', 'data-asin': 'B0TWO' },
      ],
    },
  });
  const answer = call(page, 'AX_RPC_CART_VIEW.open', { site: 'amazon' });

  assert.equal(answer.next, 'show');
  assert.ok(answer.cart_state.includes('B0TWO'));
  assert.ok(!answer.cart_state.includes('B0ONE'), 'an undo panel is not a cart line');
  const asked = page.ops.filter((op) => op.op === 'dom.query_all').map((op) => op.params.selector);
  assert.ok(asked.every((selector) => selector.includes(':has(')), `asked: ${asked.join(' | ')}`);
});

test('a cart the store says is not empty is never reported as empty', () => {
  // Measured live 2026-08-27 on the packaged artifact: `cart_open_lines` answered
  // `{"next":"empty","cart_count":1}` — the store's own header said ONE item while the row reader found
  // none, because amazon renders the cart body client-side and the first document is a shell (the header
  // count IS in the shell, which is why the two disagreed). Reporting that as an empty cart told the user
  // their cart was empty and removed the only line they could have picked from the listing.
  const page = makePage({
    href: CART,
    dom: { '#sc-active-cart': [{ text: 'cart' }], '#nav-cart-count': [{ text: '1' }] },
    // The rows are simply not there, on every read.
  });
  const answer = call(page, 'AX_RPC_CART_VIEW.open', { site: 'amazon' });

  assert.notEqual(answer.next, 'empty');
  assert.equal(answer.next, 'error');
  assert.equal(answer.error, 'cart_lines_unreadable');
  assert.equal(answer.cart_count, 1);
});

test('rows that arrive on a later read are read, not called empty', () => {
  // The same shell, settling. `sequence` answers a different row set per read, which is what a hydrating
  // list does — a reader that takes the first answer reports a half-rendered page as the final one.
  const page = makePage({
    href: CART,
    dom: { '#sc-active-cart': [{ text: 'cart' }], '#nav-cart-count': [{ text: '1' }] },
    // `sequence` answers rows VERBATIM — the stub's field projection runs only on the plain `dom` map — so
    // the projected name is written out here. The attribute mapping itself is covered by the tests above.
    sequence: {
      '#sc-active-cart .sc-list-item[data-asin]:has([data-action="delete-active"])': [
        [],
        [{ text: 'Anker 충전기  $24.50  Delete', root_id: 'B0TWO' }],
      ],
    },
  });
  const answer = call(page, 'AX_RPC_CART_VIEW.open', { site: 'amazon' });

  assert.equal(answer.next, 'show');
  assert.ok(answer.cart_state.includes('B0TWO'));
});

test('a cart the store itself calls empty is empty', () => {
  const page = makePage({
    href: CART,
    dom: { '#sc-active-cart': [{ text: 'cart' }], '#nav-cart-count': [{ text: '0' }] },
  });
  const answer = call(page, 'AX_RPC_CART_VIEW.open', { site: 'amazon' });
  assert.equal(answer.next, 'empty');
  assert.equal(answer.cart_count, 0);
});

test('the arrival waits for the CART, not for the document', () => {
  // A cost contract with a correctness reason: the shell already has a `body` and already carries the
  // header count, so waiting for `body` returns immediately and every read after it pays the settle loop's
  // sleeps instead. `cart_ready_selector` is the store's own statement of "the cart is on screen".
  const page = makePage({
    href: 'https://www.amazon.com/',
    dom: {
      '#sc-active-cart': [{ text: 'cart' }],
      '#nav-cart-count': [{ text: '1' }],
      '#sc-active-cart .sc-list-item[data-asin]:has([data-action="delete-active"])': [
        { text: 'Anker 충전기 Delete', 'data-asin': 'B0TWO' },
      ],
    },
  });
  call(page, 'AX_RPC_CART_VIEW.open', { site: 'amazon' });

  // `dom.wait_for_selector` is NOT a wire op: the runtime prelude synthesises it by polling `dom.exists`
  // (`rpc-stub.mjs` header), so the ledger shows what was POLLED. Asserting on a synthesised name would
  // pass here and fail live, which is the mistake this comment exists to stop being made twice.
  const polled = page.ops.filter((op) => op.op === 'dom.exists').map((op) => op.params?.selector ?? op.params);
  assert.ok(polled.some((selector) => String(selector).includes('sc-active-cart')), `polled: ${polled.slice(0, 4).join(' | ')}`);
  assert.ok(!polled.includes('body'), `waited for the document: ${polled.join(' | ')}`);
});

test('the newer cart variant is read too — one handling for both measurements', () => {
  // Two live measurements of the same store, hours apart, on two profiles:
  //   dev profile  : rows carry `input[value="Delete"]` (4-5 of them)
  //   fresh profile: rows carry `[data-action="delete"]` and NO `value="Delete"` anywhere on the page
  // §13: when two live readings of one site conflict, neither is the contract — pin the handling that
  // survives both. Keyed on one of them, the packaged artifact answered `cart_lines_unreadable` for a cart
  // whose own container said `data-cart-total-item-count="1"`.
  const page = makePage({
    href: CART,
    dom: {
      '#sc-active-cart': [{ text: 'cart' }],
      '#nav-cart-count': [{ text: '1' }],
      // ONLY the newer variant's key: the classic one is absent, exactly as the fresh profile's page was.
      '#sc-active-cart .sc-list-item[data-asin]:has([data-action="delete-active"])': [
        { text: 'Logitech M185 무선 마우스  Delete  Save for later', 'data-asin': 'B00PGB7OKM' },
      ],
    },
  });
  const answer = call(page, 'AX_RPC_CART_VIEW.open', { site: 'amazon' });

  assert.equal(answer.next, 'show');
  assert.ok(answer.cart_state.includes('B00PGB7OKM'));
});

test('a long Korean title is cut at a character boundary, not at a byte', () => {
  // Measured live on the packaged artifact: `cart_present_lines` answered
  // "cannot convert invalid utf8 to javascript string" for the line
  // "Logitech M185 고무 그립이 있는 컴팩트 양손잡이용 무선 마우스 - 블루" — Lua strings are BYTES, so a 90-byte
  // cut split a 3-byte character and the listing could not cross into the flow at all. The store's own
  // titles are Korean in this locale, so this is the normal case, not an edge one.
  const long = 'Logitech M185 고무 그립이 있는 컴팩트 양손잡이용 무선 마우스 - 블루 실버 에디션 아주 긴 제목입니다';
  const page = makePage({
    href: CART,
    dom: {
      '#sc-active-cart': [{ text: 'cart' }],
      '#nav-cart-count': [{ text: '1' }],
      '#sc-active-cart .sc-list-item[data-asin]:has([data-action="delete-active"])': [
        { text: long, 'data-asin': 'B0LONG' },
      ],
    },
  });
  const opened = call(page, 'AX_RPC_CART_VIEW.open', { site: 'amazon' });
  assert.equal(opened.next, 'show');

  const shown = call(page, 'AX_RPC_CART_VIEW.present', { cart_state: opened.cart_state });
  assert.equal(shown.next, 'ask');
  // The conversion from Lua to JS is where a split character dies; reaching here at all is half the test.
  const label = shown.question.split('\n').find((line) => line.startsWith('1.')) ?? '';
  assert.ok(label.length > 10, shown.question);
  assert.ok(!label.includes('\uFFFD'), `replacement character in: ${label}`);
  assert.equal(Buffer.from(label, 'utf8').toString('utf8'), label, 'the label must be valid UTF-8');
  // And it is genuinely shortened, or the test would pass on a limit that never triggers.
  assert.ok(Buffer.byteLength(label, 'utf8') < Buffer.byteLength(long, 'utf8'));
});
