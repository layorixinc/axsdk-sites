#!/usr/bin/env node
/**
 * Listing screenshots, taken from the real product.
 *
 * Every scene is a live turn through the shipped flow engine, captured at 1280x800 — the store's size.
 * Nothing is staged: the comparison window, the refinement, the cart confirmation and the checkout stop
 * are whatever the product actually answers, which is the only kind of screenshot that stays true after
 * the next change.
 *
 * The cart scene mutates a real cart (approved for this repo). No order is ever placed — the checkout
 * scene stops at the review page, which is what the product does.
 *
 * PII: the dev profile may be signed in to a store, and a store header shows an account name. Every
 * capture is therefore reported with its path so the operator can look before anything is committed.
 */

import { pathToFileURL } from 'node:url';

import { openCdpSession } from '../harness/cdp-session.mjs';

const OUT = 'store/assets';

/**
 * One set per listing locale. The widget answers in the language of the request, and the stores a
 * Korean shopper compares are not the ones an English shopper does — so these differ by more than
 * wording, which is why the store lets screenshots be localized at all.
 */
const SCENES = {
  ko: [
    {
      file: '1-comparison.png',
      site: 'https://www.11st.co.kr/',
      // An exact model skips discovery and reaches the comparison window directly; both stores were
      // measured stating a shipping fee, so the rows carry complete totals instead of folding.
      text: '로지텍 M185 마우스를 11번가, 지마켓에서 배송비 포함 총액으로 비교해줘',
      what: 'total-cost comparison across two stores',
    },
    {
      file: '2-refine.png',
      // A visible difference rather than a re-render: the folded incomplete row comes back.
      text: '미확인 포함',
      what: 'the folded incomplete-total row, shown on request',
      continues: true,
    },
    {
      file: '3-choices.png',
      site: 'https://www.coupang.com/',
      text: '이 사이트에서 로지텍 M185 마우스 찾아줘',
      what: 'numbered products on one store, waiting for the user to choose',
    },
    {
      file: '4-cart.png',
      // The gate reads a bare number; a sentence around it routes elsewhere (measured).
      text: '1번',
      what: 'guarded cart add, confirmed on the store cart page',
      continues: true,
    },
  ],
  en: [
    {
      file: '1-comparison.png',
      site: 'https://www.amazon.com/',
      text: 'Compare the Logitech M185 mouse on amazon and ebay by total cost including shipping',
      what: 'total-cost comparison across two stores',
    },
    {
      file: '2-refine.png',
      text: 'include the unknown ones',
      what: 'the folded incomplete-total row, shown on request',
      continues: true,
    },
    {
      file: '3-choices.png',
      site: 'https://www.amazon.com/',
      text: 'find a Logitech M185 mouse on this site',
      what: 'numbered products on one store, waiting for the user to choose',
    },
    {
      file: '4-cart.png',
      text: '1',
      what: 'guarded cart add, confirmed on the store cart page',
      continues: true,
    },
  ],
};

async function main(locale) {
  const session = await openCdpSession();
  const captured = [];
  try {
    for (const scene of SCENES[locale]) {
      if (!scene.continues) {
        // A paused window would read the next message as a selection, so each independent scene starts clean.
        await session.reset();
        if (scene.site !== undefined) await session.open(scene.site);
      }
      const started = Date.now();
      const answer = await session.send(scene.text, { timeoutMs: 300_000 })
        .catch((error) => ({ text: `ERR ${error?.message ?? error}`, toolCalls: [] }));
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      const shot = await session.screenshot({ path: `${OUT}/${locale}/${scene.file}` });
      captured.push({ ...scene, shot, elapsed, reply: String(answer?.text ?? '').replace(/\s+/g, ' ').slice(0, 120) });
      console.log(`\n=== ${scene.file} (${elapsed}s) — ${scene.what}`);
      console.log(`  url   ${shot.url}`);
      console.log(`  reply ${captured.at(-1).reply}`);
    }
  } finally {
    await session.close().catch(() => {});
  }

  console.log('\n=== CAPTURED ===');
  for (const entry of captured) console.log(`  ${entry.shot.path} ${entry.shot.width}x${entry.shot.height}`);
  console.log('\nLook at each one before committing: a signed-in store header can carry an account name.');
  return captured;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.find((a) => a.startsWith('--locale='))?.slice(9) ?? 'ko').catch((error) => {
    console.error('FATAL', error?.stack ?? error);
    process.exitCode = 1;
  });
}

export { SCENES };
