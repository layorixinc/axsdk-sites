#!/usr/bin/env node
/**
 * Empties a store cart in the dev browser, so a listing screenshot shows one item instead of whatever
 * earlier runs left behind.
 *
 * Why it lives here and not in the extension: the shipped single purpose is "compare, add the offer the
 * user picked, open the checkout review" (`store/single-purpose.md`). Removing items is not in that
 * sentence, and putting a new cart MUTATION in the package would weaken P0-3 for the sake of a screenshot.
 * So this is capture tooling — it drives the same dev browser by CDP and touches nothing that ships.
 *
 * Why by page evaluation rather than the runtime's `dom` ops: the delete control on coupang is a `<div>`
 * whose text is exactly `삭제` (measured live: 8 such divs, no `delete`/`remove` in any class, and the
 * runtime's `query_all` answers `{ text }` with no selector). CSS cannot select by text, and this realm
 * has no `dom.click_text` — measured, `dom.click_text`, `dom.read_many` and `dom.get_attribute` are all
 * `nil` there. A page evaluation can match the text and click the element it matched.
 *
 * Ordinary in-site navigation only: a direct hit on `cart.coupang.com/cartView.pang` answers a bot
 * challenge (measured: 986 bytes, "Powered and protected by Privacy"). Nothing here answers a challenge.
 */

import { attachActive, evaluatePage, listTargets, openPage, resolveOptions } from '../harness/cdp.mjs';

/** Per-store: how to reach the cart, what an item row is, and what the remove control says. */
export const CART_SITES = {
  coupang: {
    home: 'https://www.coupang.com/',
    cartHref: 'cartView.pang',
    cartMarker: 'cart.coupang.com',
    removeLabels: ['삭제'],
    confirmLabels: ['확인', '삭제'],
  },
  '11st': {
    home: 'https://www.11st.co.kr/',
    // Values taken from the shipped site data (`_common/rpc/62_rpc_sites.lua`), so the tool and the
    // product agree on where this store's cart lives.
    cartHref: 'CartAction.tmall',
    cartMarker: 'buy.11st.co.kr/cart',
    removeLabels: ['삭제', '선택삭제'],
    confirmLabels: ['확인', '삭제'],
  },
  gmarket: {
    home: 'https://www.gmarket.co.kr/',
    cartHref: '/cart',
    cartMarker: 'cart.gmarket.co.kr',
    // Measured 2026-08-27: the row control is `button.btn_del`; matching the WORD 삭제 instead pressed the
    // "recently viewed" layer's own delete button 20 times and removed nothing (the cap caught it). A store
    // that names its control gets used by name — word-based class, so §10 is satisfied.
    removeSelector: 'button.btn_del',
    removeLabels: ['삭제', '선택삭제'],
    confirmLabels: ['확인', '삭제'],
  },
  amazon: {
    home: 'https://www.amazon.com/',
    cartHref: '/gp/cart/view.html',
    cartMarker: '/gp/cart/view.html',
    removeLabels: ['Delete'],
    confirmLabels: [],
  },
};

/**
 * What a pass over the page should do next, from what the page reports.
 *
 * Pure so the decision is testable without a browser: a pass that removed nothing is done (a page that
 * still shows items but offers no control is a REFUSAL to report, not a loop to spin), and the cap exists
 * because a cart that never shrinks would otherwise click forever.
 */
export function nextAction({ items, controls, pressed, cap = 20 }) {
  if (items === 0) return { done: true, reason: 'empty' };
  if (pressed >= cap) return { done: true, reason: 'cap' };
  if (controls === 0) return { done: true, reason: 'no_control' };
  return { done: false, reason: 'press' };
}

/** Did the clearing achieve what it claimed? Reported, never assumed. */
export function clearVerdict({ before, after, reason }) {
  if (after === 0) return { ok: true, detail: `${before} → 0` };
  if (reason === 'no_control') {
    return { ok: false, detail: `${after} item(s) left and no remove control — the page may need a login` };
  }
  if (reason === 'cap') return { ok: false, detail: `${after} item(s) left after the click cap` };
  return { ok: false, detail: `${after} item(s) left` };
}

const visibleBySelector = (selector) => `(() => [...document.querySelectorAll(${JSON.stringify(selector)})]
  .filter((node) => node.getClientRects().length > 0).length)()`;

const clickBySelector = (selector) => `(() => {
  const hit = [...document.querySelectorAll(${JSON.stringify(selector)})]
    .find((node) => node.getClientRects().length > 0);
  if (!hit) return { clicked: false };
  hit.click();
  return { clicked: true, tag: hit.tagName };
})()`;

const visibleControls = (labels) => `(() => {
  const wanted = ${JSON.stringify(labels)};
  return [...document.querySelectorAll('div, a, button, span, input[type=submit]')].filter((node) => {
    const text = (node.value ?? node.textContent ?? '').trim();
    if (!wanted.includes(text)) return false;
    if ([...node.children].some((child) => wanted.includes((child.textContent ?? '').trim()))) return false;
    return node.getClientRects().length > 0;
  }).length;
})()`;

const clickByText = (labels) => `(() => {
  const wanted = ${JSON.stringify(labels)};
  const nodes = [...document.querySelectorAll('div, a, button, span, input[type=submit]')];
  const hit = nodes.find((node) => {
    if (node.offsetParent === null && node.getClientRects().length === 0) return false;
    const text = (node.value ?? node.textContent ?? '').trim();
    if (!wanted.includes(text)) return false;
    // the innermost element carrying exactly this text: a container repeats its child's text
    return ![...node.children].some((child) => wanted.includes((child.textContent ?? '').trim()));
  });
  if (!hit) return { clicked: false };
  hit.click();
  return { clicked: true, tag: hit.tagName };
})()`;


/**
 * Reaches the cart the way a person does — the store's own header link — then presses the remove control
 * until the row count stops changing. Returns evidence, never a claim.
 */

/**
 * Presses the first visible match with REAL input events.
 *
 * Measured 2026-08-27 on gmarket: 20 `Element.click()` calls on `button.btn_del` removed nothing (the cap
 * caught it), because its cart is an SPA that listens for trusted pointer events. §13 records the same
 * class of failure for a synthetic click on a submit button. CDP can dispatch the real thing.
 */
async function pressReal(page, selector) {
  const box = await evaluatePage(page, `(() => {
    const hit = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((node) => node.getClientRects().length > 0);
    if (!hit) return null;
    hit.scrollIntoView({ block: 'center' });
    const rect = hit.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!box) return { clicked: false };
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', {
      type, x: box.x, y: box.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1,
    });
  }
  return { clicked: true };
}

export async function clearCart({ site, port, dryRun = false, survey = false, log = (line) => console.log(line) }) {
  const config = CART_SITES[site];
  if (!config) throw new Error(`no cart configuration for ${site}`);
  // `resolveOptions` answers `cdp`, not `cdpUrl` — the field name is the one thing a caller cannot guess.
  const options = resolveOptions({ port });
  // Chrome allows ONE debugger client per tab, and the extension holds its own agent tab — measured, a
  // second socket to that tab is refused outright ("Failed to attach"). So this works only on tabs it
  // created itself: open the home page, press the store's own cart link (which opens a new tab), and
  // attach to the target that appeared. Direct navigation to the cart URL is not a fallback — it answers
  // a bot challenge (986 bytes on coupang).
  const pageTargets = async () => (await listTargets(options.cdp)).filter((target) => target.type === 'page');
  const knownTargets = new Set((await pageTargets()).map((target) => target.id));

  const opener = await openPage(options.cdp, config.home);
  const created = [opener];
  let cartTarget;
  try {
    for (let attempt = 0; attempt < 30 && !cartTarget; attempt += 1) {
      const state = await evaluatePage(opener, 'document.readyState').catch(() => undefined);
      if (state === 'complete') {
        await evaluatePage(opener, `(() => {
          const link = [...document.querySelectorAll('a[href]')]
            .find((node) => node.getAttribute('href').includes(${JSON.stringify(config.cartHref)}));
          if (!link) return false;
          link.click();
          return true;
        })()`).catch(() => undefined);
      }
      await new Promise((resolve) => setTimeout(resolve, 900));
      cartTarget = (await pageTargets()).find((target) => !knownTargets.has(target.id)
        && String(target.url ?? '').includes(config.cartMarker));
    }
  } catch (error) {
    log(`${site}: could not reach the cart — ${String(error?.message ?? error).slice(0, 90)}`);
  }
  if (!cartTarget) {
    for (const client of created) {
      await client.send('Page.close').catch(() => undefined);
      try { client.close?.(); } catch { /* gone */ }
    }
    return { site, ok: false, detail: 'no cart tab of our own appeared', before: null, after: null };
  }

  const { page } = await attachActive(options.cdp, options, { match: cartTarget.url.slice(0, 40) });
  created.push(page);
  log(`${site}: attached to ${String(cartTarget.url).slice(0, 60)}`);
  const countExpression = config.removeSelector
    ? visibleBySelector(config.removeSelector)
    : visibleControls(config.removeLabels);
  const pressExpression = config.removeSelector
    ? clickBySelector(config.removeSelector)
    : clickByText(config.removeLabels);

  try {
    // A row is a row because it offers its own remove control — measured on coupang, the row containers
    // are `twc-*` utility classes (build-generated, which §10 forbids depending on) while every visible
    // row carries exactly one 삭제.
    const before = Number(await evaluatePage(page, countExpression)) || 0;
    let items = before;
    let pressed = 0;
    let reason = 'press';
    log(`${site}: ${before} item(s) in the cart`);
    if (survey) {
      // The measurement the config is written from: what a row IS, and what the control is nested in.
      const seen = await evaluatePage(page, `(() => {
        const controls = [...document.querySelectorAll('div, a, button, span')].filter((node) => {
          const text = (node.textContent ?? '').trim();
          return ${JSON.stringify(config.removeLabels)}.includes(text)
            && ![...node.children].some((c) => ${JSON.stringify(config.removeLabels)}.includes((c.textContent ?? '').trim()));
        });
        const describe = (node) => node.tagName
          + (node.className ? '.' + String(node.className).split(/\\s+/).slice(0, 2).join('.') : '');
        return {
          url: location.href,
          controls: controls.length,
          visible: controls.filter((node) => node.getClientRects().length > 0).length,
          chains: controls.slice(0, 3).map((node) => {
            const chain = [];
            let cursor = node;
            for (let up = 0; up < 7 && cursor; up += 1) { chain.push(describe(cursor)); cursor = cursor.parentElement; }
            return chain.join(' < ');
          }),
          counts: Object.fromEntries(['li', 'tr', 'input[type=checkbox]', '[class*=cart]', '[class*=item]',
            'a[href*="/vp/products/"]', '[data-vendor-item-id]', '[data-product-id]', '[data-item-id]']
            .map((selector) => [selector, document.querySelectorAll(selector).length])),
        };
      })()`);
      return { site, ok: null, survey: seen, before: null, after: null };
    }
    if (dryRun) {
      const controls = Number(await evaluatePage(page, countExpression)) || 0;
      return { site, ok: null, before, after: before, pressed: 0, controls, detail: 'dry run' };
    }

    for (;;) {
      const controls = Number(await evaluatePage(page, countExpression)) || 0;
      const action = nextAction({ items, controls, pressed });
      reason = action.reason;
      if (action.done) break;
      const clicked = config.removeSelector
        ? await pressReal(page, config.removeSelector)
        : await evaluatePage(page, pressExpression);
      if (!clicked?.clicked) { reason = 'no_control'; break; }
      pressed += 1;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (config.confirmSelector) {
        await pressReal(page, config.confirmSelector).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 900));
      } else if (config.confirmLabels.length > 0) {
        await evaluatePage(page, clickByText(config.confirmLabels)).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      items = Number(await evaluatePage(page, countExpression)) || 0;
      log(`  pressed ${pressed} → ${items} left`);
    }

    const after = Number(await evaluatePage(page, countExpression)) || 0;
    const verdict = clearVerdict({ before, after, reason });
    return { site, ...verdict, before, after, pressed, reason };
  } finally {
    // Every tab here is ours: the opener and the cart tab it produced. The extension's own tab is never
    // touched — closing an attached tab took the cart out from under the session on the first run.
    for (const client of created) {
      await client.send('Page.close').catch(() => undefined);
      try { client.close?.(); } catch { /* gone */ }
    }
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  const site = process.argv[2] ?? 'coupang';
  const port = Number(process.env.CDP_PORT ?? 9334);
  const dryRun = process.argv.includes('--dry-run');
  const survey = process.argv.includes('--survey');
  const result = await clearCart({ site, port, dryRun, survey });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok === false ? 1 : 0;
}
