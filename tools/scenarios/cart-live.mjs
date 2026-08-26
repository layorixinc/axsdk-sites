#!/usr/bin/env node
// Live proof that "담기" works on the stores the single-site flow can now reach.
//
// The flow's entry was `open_amazon` until the store resolver landed, so eight of the nine cart-capable
// stores have a mutation path nobody had ever run. Two rules shape this runner:
//
//  1. **The SITE decides.** A tool reporting `added` is not evidence — §13 records the false positive where
//     that was reported for a cart holding something else. After the turn this reads the page the browser
//     is on and asks whether the approved product id appears in it, through generic attribute probes, so
//     no per-store selector is duplicated here.
//  2. **Every other outcome is CLASSIFIED, not counted as failure.** A login wall, a required option, a
//     bot wall and an unconfirmed click are answers. An unverified claim and an unknown code are not.
//
// Real carts get real items (approved for this repo); no order is ever placed. The run prints what it left
// behind so the operator can empty those carts.
import { pathToFileURL } from 'node:url';

/** Stores whose generated adapter data carries an add path. naver-shopping is a comparison portal. */
export const CART_STORES = [
  'amazon', 'ebay', 'walmart', 'aliexpress', 'etsy', 'coupang', '11st', 'gmarket', 'ssg',
];
const NO_CART = { 'naver-shopping': 'comparison portal — no unified cart (AGENTS.md §4)' };
const DEFAULT_STORES = ['coupang', '11st'];

const HOME = {
  amazon: 'https://www.amazon.com/',
  ebay: 'https://www.ebay.com/',
  walmart: 'https://www.walmart.com/',
  aliexpress: 'https://www.aliexpress.com/',
  etsy: 'https://www.etsy.com/',
  coupang: 'https://www.coupang.com/',
  '11st': 'https://www.11st.co.kr/',
  gmarket: 'https://www.gmarket.co.kr/',
  ssg: 'https://www.ssg.com/',
};

const ACCESS_ERRORS = {
  security_verification_required: 'access_denied',
  captcha_required: 'access_denied',
  access_denied: 'access_denied',
  login_required: 'login_required',
  required_option: 'required_option',
  add_to_cart_pending: 'pending',
  // Measured 2026-08-26: `pending` covered three different facts. A cart the store itself renders as
  // empty (etsy, ssg) and a cart holding other lines but not ours (11st) are answers; only a page nobody
  // can read stays unknown.
  cart_empty: 'cart_empty',
  cart_missing_product: 'cart_missing_product',
  product_navigation_failed: 'product_unreachable',
  product_page_unreadable: 'product_unreachable',
  cart_unavailable: 'store_unsupported',
  site_not_ported: 'store_unsupported',
  add_to_cart_unavailable: 'add_control_missing',
  click_failed: 'add_control_missing',
  price_error: 'price_mismatch',
  identity_mismatch: 'identity_mismatch',
  quantity_unavailable: 'quantity_unavailable',
};

const CART_TOOL = 'shopping_add_to_cart';

/** `--stores=` and the flags, with the stores that have no cart path removed by name. */
export function parseStores(argv) {
  const listed = argv.map((arg) => /^--stores=(.+)$/.exec(arg)?.[1]).find((value) => value !== undefined);
  const cancel = argv.includes('--cancel');
  const query = argv.map((arg) => /^--query=(.+)$/.exec(arg)?.[1]).find((value) => value !== undefined)
    ?? '로지텍 M185 마우스';
  const requested = listed === undefined
    ? DEFAULT_STORES
    : listed.split(',').map((value) => value.trim()).filter((value) => value !== '');
  const skipped = [];
  const stores = [];
  for (const slug of requested) {
    if (NO_CART[slug] !== undefined) { skipped.push(`${slug}: ${NO_CART[slug]}`); continue; }
    if (!CART_STORES.includes(slug)) {
      throw new Error(`Unknown store "${slug}". Published stores with a cart: ${CART_STORES.join(', ')}.`);
    }
    stores.push(slug);
  }
  return { stores, skipped, cancel, query };
}

const toolOf = (calls, name) => (calls ?? []).filter((call) => call?.name === name).at(-1);
const outputOf = (call) => (typeof call?.output === 'object' && call?.output !== null ? call.output : {});

/**
 * The id the user's pick approved. `shopping_add_to_cart` publishes `add_status`/`add_error`/
 * `add_confirmation` and NO id, so the evidence read has to take it from the pick node — `refine_products`
 * is `output: tool.args`, and the last pick is the one the cart acted on.
 */
export function pickedProductId(toolCalls) {
  const pick = toolOf(toolCalls, 'shopping_single_site.refine_item');
  const id = outputOf(pick).product_id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * What the store's mutation turn actually did. `siteEvidence` is the runner's own read of the page, never
 * the tool's report of itself.
 */
export function classifyAdd({ toolCalls, text, siteEvidence, expect = 'add' }) {
  const cart = toolOf(toolCalls, CART_TOOL);
  if (expect === 'cancel') {
    if (cart !== undefined) return { label: 'cancel_mutated', detail: 'the cart tool ran on a cancel turn' };
    return { label: 'cancelled', detail: String(text ?? '').slice(0, 120) };
  }
  if (cart === undefined) {
    return {
      label: 'no_add_call',
      detail: `tools: ${(toolCalls ?? []).map((call) => call.name).join(' -> ') || '(none)'}`,
    };
  }
  const output = outputOf(cart);
  const error = typeof output.add_error === 'string' ? output.add_error : undefined;
  if (output.add_status === 'added') {
    // A probe that could not run is not evidence of absence (§13: a transient op refusal is not a page
    // fact), so it is its own verdict rather than an accusation against the product.
    if (siteEvidence?.evidenceError !== undefined) {
      return { label: 'unverifiable', detail: String(siteEvidence.evidenceError) };
    }
    if (siteEvidence?.mentionsProduct === true) {
      return { label: 'added', detail: String(siteEvidence.productId ?? '') };
    }
    return {
      label: 'claimed_unverified',
      detail: `the cart page does not mention ${siteEvidence?.productId ?? 'the product'}`,
    };
  }
  const mapped = error === undefined ? undefined : ACCESS_ERRORS[error];
  if (mapped !== undefined) return { label: mapped, detail: error };
  return { label: 'unknown', detail: error ?? `status ${cart.status ?? '?'}` };
}

/** Which outcomes are answers and which are defects. */
export function storeVerdict(outcome) {
  const answers = {
    added: 'the site shows the approved product in the cart',
    pending: 'clicked, not confirmed — nothing claimed',
    cart_empty: 'the store renders its cart as empty — the click never reached it',
    cart_missing_product: 'the cart holds other lines and not this product',
    login_required: 'the store needs a signed-in user',
    access_denied: 'the store served a wall',
    required_option: 'the listing needs an option the flow does not choose',
    product_unreachable: 'the picked row has no reachable product page — the cart refused to click blindly',
    store_unsupported: 'this store has no cart path in the shipped data',
    add_control_missing: 'the listing shows no add control the adapter knows — nothing was clicked',
    price_mismatch: 'the price moved and the guard refused',
    identity_mismatch: 'the product page did not match the approved identity',
    quantity_unavailable: 'the requested quantity is not offered',
    cancelled: 'the cancel turn mutated nothing',
  };
  if (answers[outcome.label] !== undefined) return { pass: true, reason: answers[outcome.label] };
  if (outcome.label === 'claimed_unverified') {
    return { pass: false, reason: `claimed a cart line the cart page does not show: ${outcome.detail}` };
  }
  if (outcome.label === 'unverifiable') {
    return { pass: false, reason: `the cart page could not be read: ${outcome.detail}` };
  }
  if (outcome.label === 'cancel_mutated') return { pass: false, reason: 'a cancel turn reached the cart' };
  if (outcome.label === 'no_add_call') return { pass: false, reason: `the flow never reached the cart: ${outcome.detail}` };
  return { pass: false, reason: `unclassified outcome: ${outcome.detail}` };
}

/**
 * Does the page the browser is on show this product? Generic attribute probes plus the page text, so the
 * runner never carries a copy of a store's selectors — the adapter owns those, and a second copy is how
 * the two drift apart.
 */
async function readSiteEvidence(session, productId) {
  if (typeof productId !== 'string' || productId === '') {
    return { productId, onCartPage: false, mentionsProduct: false };
  }
  const escaped = productId.replace(/["\\]/g, '');
  const source = `
    local id = ${JSON.stringify(escaped)}
    local href = tostring(dom.get_location_href() or "")
    local selector = '[href*="' .. id .. '"], [data-asin="' .. id .. '"], [data-product-id="' .. id .. '"], '
      .. '[data-item-id="' .. id .. '"], [data-listing-id="' .. id .. '"], [data-cart-item-id="' .. id .. '"]'
    local found = false
    local ok, answer = pcall(function() return dom.exists(selector) end)
    if ok and answer == true then found = true end
    if not found then
      local ok2, body = pcall(function() return dom.get_text("body") end)
      if ok2 and type(body) == "string" and body:find(id, 1, true) then found = true end
    end
    return { href = href, found = found }
  `;
  try {
    const answer = await session.eval(source, { timeoutMs: 60000 });
    const href = String(answer?.href ?? '');
    return {
      productId,
      href,
      onCartPage: /cart|basket|장바구니/i.test(href),
      mentionsProduct: answer?.found === true,
    };
  } catch (error) {
    return { productId, onCartPage: false, mentionsProduct: false, evidenceError: String(error?.message ?? error) };
  }
}

async function turn(session, label, message, timeoutMs = 240000) {
  const started = Date.now();
  let answer = null;
  let failure = null;
  try {
    answer = await session.send(message, { timeoutMs });
  } catch (error) {
    failure = String(error?.message ?? error);
  }
  const toolCalls = answer?.toolCalls ?? [];
  const text = (answer?.text ?? '').replace(/\s+/g, ' ');
  console.log(`  [${label}] ${message}  (${Date.now() - started}ms)${failure ? ` ERR=${failure}` : ''}`);
  console.log(`     tools: ${toolCalls.map((call) => `${call.name}(${call.status})`).join(' -> ') || '(none)'}`);
  console.log(`     reply: ${text.slice(0, 200)}`);
  return { failure, text, toolCalls };
}

async function proveStore(session, store, { cancel, query }) {
  console.log(`\n=== ${store} ===`);
  await session.reset();
  await session.open(HOME[store]);

  const search = await turn(session, 'search', `이 사이트에서 ${query} 사줘`);
  if (search.failure) {
    return { store, outcome: { label: 'unknown', detail: `search turn: ${search.failure}` }, search };
  }
  const pick = await turn(session, cancel ? 'cancel' : 'pick', cancel ? '취소' : '첫 번째로 해줘');
  // The cart tool publishes no id, so the pick node's own arguments are where it lives.
  const productId = pickedProductId(pick.toolCalls);
  const siteEvidence = cancel ? {} : await readSiteEvidence(session, productId);
  const outcome = classifyAdd({
    toolCalls: pick.toolCalls,
    text: pick.text,
    siteEvidence,
    expect: cancel ? 'cancel' : 'add',
  });
  if (!cancel) {
    console.log(`     site: href=${siteEvidence.href ?? '?'} mentions=${siteEvidence.mentionsProduct}`
      + `${siteEvidence.evidenceError ? ` evidenceError=${siteEvidence.evidenceError}` : ''}`);
  }
  return { store, outcome, siteEvidence, productId };
}

async function main() {
  const { stores, skipped, cancel, query } = parseStores(process.argv.slice(2));
  for (const note of skipped) console.log(`skip ${note}`);
  const { openCdpSession } = await import('../harness/cdp-session.mjs');
  const session = await openCdpSession();
  const results = [];
  try {
    for (const store of stores) {
      try {
        results.push(await proveStore(session, store, { cancel, query }));
      } catch (error) {
        results.push({ store, outcome: { label: 'unknown', detail: String(error?.message ?? error) } });
      }
    }
  } finally {
    await session.close().catch(() => {});
  }

  console.log('\n=== CART MATRIX ===');
  let pass = 0;
  for (const result of results) {
    const verdict = storeVerdict(result.outcome);
    if (verdict.pass) pass += 1;
    console.log(`  ${verdict.pass ? 'PASS' : 'FAIL'}  ${result.store.padEnd(15)} ${result.outcome.label.padEnd(19)} ${verdict.reason}`
      + `${result.outcome.detail ? ` [${result.outcome.detail}]` : ''}`);
  }
  const added = results.filter((result) => result.outcome.label === 'added');
  if (added.length > 0) {
    console.log('\nleft in real carts (empty them when you are done):');
    for (const result of added) console.log(`  ${result.store}: ${result.productId}`);
  }
  console.log(`CARTLIVE: ${pass}/${results.length} PASS${cancel ? ' (cancel path)' : ''}`);
  process.exitCode = pass === results.length && results.length > 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('FATAL', error?.stack ?? error);
    process.exitCode = 1;
  });
}
