#!/usr/bin/env node
// Live regression for removing ONE line from a store cart (`cart_remove_item` → `cart_open_lines`,
// `cart_present_lines`, `cart_remove_line`; RPC modules `_common.67_rpc_cart` + `_common.74_rpc_cart_view`).
//
// Three cases, in one session because the flow PAUSES on its listing and the pick is the next turn — two
// `npm run cdp -- send` calls would be two processes with two sessions (§13), and a paused node cannot
// resume across them.
//
// The evidence is the PAGE, never the tool's own status. §13 records what reading a tool's answer back
// cost the add path: `added = true` on a cart that never received the item, green for as long as the false
// positive existed. So a removal is counted only when the cart's own line disappears from its HTML.
import { pathToFileURL } from 'node:url';

import { FLOW_TOOLS, turnFault } from './turn-fault.mjs';

/** The tools that mean this flow ran, from the shared table rather than a second copy here. */
export const CART_TOOLS = FLOW_TOOLS.cartRemove;

export const toolLabels = (calls) => (calls || []).map((call) => `${call.name}(${call.status})`);

/**
 * The ACTIVE cart's own markup — not the page, and not the list below it.
 *
 * Measured live 2026-08-27: amazon renders "Saved for later" on the same page with the same
 * `.sc-list-item[data-asin]` rows and their own Delete controls. Counting ids page-wide reported four lines
 * for a cart holding one, which is a runner that cannot tell a removal from a rearrangement.
 */
export function activeCartRegion(html) {
  const text = String(html ?? '');
  const start = text.indexOf('id="sc-active-cart"');
  if (start < 0) return '';
  const rest = text.slice(start);
  const boundaries = ['sc-saved-cart', 'Saved for later', 'sc-buy-again', 'Buy it Again']
    .map((marker) => rest.indexOf(marker)).filter((at) => at > 0);
  return boundaries.length > 0 ? rest.slice(0, Math.min(...boundaries)) : rest;
}

/** The product ids a region states for itself. Inside the cart's container, `[data-asin]` IS the row set. */
export function asinsIn(html) {
  const ids = new Set();
  for (const match of String(html ?? '').matchAll(/data-asin="([A-Z0-9]{6,14})"/g)) ids.add(match[1]);
  return ids;
}

/**
 * Whether the document is the cart's own BODY, not the shell around it.
 *
 * Measured live: `pageHtml()` one moment after `open()` answers a 128 KiB shell with `nav-cart-count: 5`,
 * zero rows and zero delete controls — amazon renders the cart list client-side. Counting ids on that read
 * reports an EMPTY cart for a cart holding five lines, which is how the first live run blocked its own two
 * mutation cases. `sc-active-cart` is not the marker: it appears in the shell's scripts.
 */
export const cartBodyRendered = (html) => {
  const text = String(html ?? '');
  return /value="Delete"/.test(text) || /sc-empty-cart|Cart is empty/.test(text);
};

/** A numbered listing the user can answer with a number, and the sentence that says how. */
export function listingLooksNumbered(reply) {
  const text = String(reply ?? '');
  return /(^|\s)1[.)]/.test(text) && /번호|number/i.test(text);
}

export const pressedRemoval = (calls) => toolLabels(calls).some((label) => label.startsWith('cart_remove_line'));

/** The listing turn: both read tools ran and the user was shown something answerable. */
export const listingCasePassed = ({ calls, reply }) => {
  const labels = toolLabels(calls);
  return labels.some((l) => l.startsWith('cart_open_lines'))
    && labels.some((l) => l.startsWith('cart_present_lines'))
    && listingLooksNumbered(reply)
    && !pressedRemoval(calls);
};

/** Cancel: nothing pressed, and the cart the page states is byte-for-byte the same set of lines. */
export const cancelCasePassed = ({ calls, before, after }) =>
  !pressedRemoval(calls)
  && before.size === after.size
  && [...before].every((id) => after.has(id));

/**
 * A removal counted the only way it can be: one id the page used to state and no longer does.
 *
 * A tool that answered `removed` on an unchanged cart fails here, which is the whole point — and so does a
 * tool that removed two lines from one approval.
 */
export const removalCasePassed = ({ calls, before, after }) => {
  if (!pressedRemoval(calls)) return false;
  const gone = [...before].filter((id) => !after.has(id));
  const appeared = [...after].filter((id) => !before.has(id));
  return gone.length === 1 && appeared.length === 0;
};

/**
 * A store whose remove control nobody measured must refuse BY NAME and press nothing.
 *
 * Passing on "the reply mentions a reason" would accept a generic failure; the decidable part is that no
 * mutation tool ran and the cart is unchanged.
 */
export const unmeasuredCasePassed = ({ calls, before, after }) =>
  !pressedRemoval(calls) && before.size === after.size;

export function tally(checks) {
  let pass = 0;
  for (const [, ok] of checks) if (ok) pass += 1;
  // `total > 0` deliberately: §13 records a journey runner where every leg failed to do the one thing it
  // exists to prove and the run still exited 0, because "no failures" was read as success.
  return { pass, total: checks.length, allPassed: checks.length > 0 && pass === checks.length };
}

/** Runs one case and records its outcome whatever happens — a throw costs one check, never the verdict. */
export async function recordCase(checks, name, run) {
  try {
    checks.push([name, (await run()) === true]);
  } catch (error) {
    checks.push([name, false, String(error?.message ?? error)]);
  }
}

async function send(session, label, message, timeoutMs = 150000) {
  const res = await session.send(message, { timeoutMs })
    .catch((error) => ({ text: `ERR ${error && error.message}`, parts: [], toolCalls: [] }));
  const reply = (res.text || '').replace(/\s+/g, ' ');
  console.log(`\n[${label}] ${message}`);
  console.log('  tools:', toolLabels(res.toolCalls).join(' -> ') || '(none)');
  console.log('  reply:', reply.slice(0, 220));
  // A lost session or a planner misroute is not a cart defect; naming it is how the afternoon stays in the
  // right repo.
  const fault = turnFault(
    { toolCalls: res.toolCalls, failure: /^ERR /.test(res.text ?? '') ? res.text : null },
    { expects: CART_TOOLS },
  );
  if (fault) console.log(`  fault: ${fault.kind} — ${fault.detail}`);
  return { res, reply, fault };
}

const AMAZON_CART = 'https://www.amazon.com/gp/cart/view.html';
const AMAZON_HOME = 'https://www.amazon.com/';
// One product, so a seeded line is recognisable in the evidence. Reserved test shopping only.
const SEED_PRODUCT = 'https://www.amazon.com/dp/B0BYJ78G3S';
const GMARKET_CART = 'https://cart.gmarket.co.kr/ko/pc/cart';

/**
 * Puts one line in the cart when it is empty. The SHIPPED add flow first, its own tab second.
 *
 * A removal runner that needs the cart pre-loaded reports "blocked" whenever the profile's cart was cleared
 * — which is what the first live run did, twice, for a reason that was not the product. Seeding through
 * `shopping_single_site` also proves the two mutations compose: what the add put in, the removal takes out.
 * The utterances are quoted from `shopping.mjs`, which is live-verified, rather than invented here.
 *
 * The direct fallback exists because of a MEASURED, separate failure (2026-08-27): the shipped add answered
 * `add_to_cart_pending` twice with the cart's own count staying 0, while a plain `#add-to-cart-button` click
 * in a tab this runner opens landed the item every time (`/cart/smart-wagon?newItems=…,1`, count 1,
 * confirmation panel present). That belongs to the add path, not to the removal, and it must not be able to
 * block the removal's evidence — the runner says which path seeded so a green run is never ambiguous.
 */
async function seedDirectly() {
  const { evaluatePage, openPage, resolveOptions } = await import('../harness/cdp.mjs');
  const options = resolveOptions({ port: Number(process.env.CDP_PORT ?? 9334) });
  const page = await openPage(options.cdp, SEED_PRODUCT);
  try {
    // The first document is a shell whose only marker is `body`; the buy box arrives about a second later.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const ready = await evaluatePage(page, "(() => !!document.querySelector('#add-to-cart-button'))()");
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    await evaluatePage(page, "(() => { document.querySelector('#add-to-cart-button')?.click(); return true; })()");
    await new Promise((resolve) => setTimeout(resolve, 3500));
    const landed = await evaluatePage(page, '(() => location.href.slice(0, 80))()');
    console.log('  direct seed landed on', landed);
  } finally {
    // Its own tab, and only its own: closing a tab this tool did not create took a live session out from
    // under the extension earlier in the day.
    await page.send('Page.close').catch(() => {});
  }
}

async function ensureCartLines(session, cartIds) {
  const present = await cartIds();
  if (present.size > 0) return present;
  console.log('  cart is empty — seeding one line through the shipped add flow');
  await session.open(AMAZON_HOME);
  await session.reset();
  await send(session, 'seed search', '신발 사줘');
  await send(session, 'seed pick', '첫 번째로 해줘');
  await session.open(AMAZON_CART);
  const afterFlow = await cartIds();
  if (afterFlow.size > 0) return afterFlow;
  console.log('  the shipped add left the cart empty — seeding directly (see seedDirectly)');
  await seedDirectly();
  await session.open(AMAZON_CART);
  return cartIds();
}

async function main() {
  // Lazy: the unit tests import the pure decisions without loading the CDP driver.
  const { openCdpSession } = await import('../harness/cdp-session.mjs');
  const session = await openCdpSession();
  const checks = [];
  // `pageHtml()` answers `{ url, html }` — reading it as a string made every cart look EMPTY, so the two
  // mutation cases refused to run and the run reported 1/3 for a reason that had nothing to do with the
  // product. A fixture cannot catch that: it is the harness's contract, not ours.
  //
  // And the first read is the SHELL, so the count settles rather than being taken once (measured: rows
  // appear on the second read, ~1s later).
  const cartPage = async () => {
    let last = '';
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const page = await session.pageHtml().catch(() => ({ html: '' }));
      last = String(page?.html ?? '');
      if (cartBodyRendered(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    return last;
  };
  const cartIds = async () => asinsIn(activeCartRegion(await cartPage()));

  try {
    // 1) the listing, then a refusal. Read-only from end to end: the cart must be identical afterwards.
    await recordCase(checks, '1 the cart is listed numbered, and 취소 removes nothing', async () => {
      await session.open(AMAZON_CART);
      await session.reset();
      const before = await ensureCartLines(session, cartIds);
      console.log(`  cart before: ${before.size} line(s)`);
      if (before.size === 0) throw new Error('could not seed the cart: the add flow put nothing in it');
      const listing = await send(session, '1a list', '장바구니에서 하나 지워줘');
      const listed = listingCasePassed({ calls: listing.res.toolCalls, reply: listing.reply });
      const cancelled = await send(session, '1b cancel', '취소');
      const after = await cartIds();
      console.log(`  cart after: ${after.size} line(s)`);
      return listed && cancelCasePassed({ calls: cancelled.res.toolCalls, before, after });
    });

    // 2) one real removal, proven by the cart's own lines. Approved: cart mutation is in scope for this
    // profile, ordering is not and no tool in this flow can reach it.
    await recordCase(checks, '2 the picked line is gone from the store cart', async () => {
      await session.open(AMAZON_CART);
      await session.reset();
      const before = await ensureCartLines(session, cartIds);
      console.log(`  cart before: ${before.size} line(s)`);
      if (before.size === 0) throw new Error('could not seed the cart: the add flow put nothing in it');
      await send(session, '2a list', '장바구니에서 상품 삭제해줘');
      const picked = await send(session, '2b pick 1', '1번');
      // What the page looks like in the instant after the press, before anything reloads. The tool reported
      // `remove_unconfirmed` on a removal that WORKED, so the shape it re-read is the thing to record.
      const immediate = await session.pageHtml().catch(() => ({ html: '' }));
      const region = activeCartRegion(String(immediate?.html ?? ''));
      console.log('  post-press ACTIVE region:', JSON.stringify({
        bytes: region.length,
        ids: [...asinsIn(region)],
        delete: (region.match(/value="Delete"/g) ?? []).length,
        rows: (region.match(/sc-list-item/g) ?? []).length,
        removed: (region.match(/>\s*Removed/g) ?? []).length,
        undo: (region.match(/Undo/g) ?? []).length,
      }));
      await session.open(AMAZON_CART);
      const after = await cartIds();
      console.log(`  cart after: ${after.size} line(s)`);
      return removalCasePassed({ calls: picked.res.toolCalls, before, after });
    });

    // 3) a store whose removal controls nobody measured: refuse, press nothing.
    await recordCase(checks, '3 an unmeasured store refuses and presses nothing', async () => {
      await session.open(GMARKET_CART);
      await session.reset();
      const before = await cartIds();
      const answer = await send(session, '3 unmeasured store', '장바구니에서 하나 빼줘');
      const after = await cartIds();
      return unmeasuredCasePassed({ calls: answer.res.toolCalls, before, after });
    });
  } finally {
    await session.close().catch(() => {});
  }

  console.log('\n=== RESULT ===');
  for (const [name, ok, why] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${why ? ` — ${why}` : ''}`);
  }
  const { pass, total, allPassed } = tally(checks);
  console.log(`CART REMOVE: ${pass}/${total} PASS`);
  process.exitCode = allPassed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error('FATAL', (error && error.stack) || error); process.exitCode = 1; });
}

