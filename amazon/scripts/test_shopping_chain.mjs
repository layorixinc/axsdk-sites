#!/usr/bin/env node
// Live test for the shopping flow's per-item command chain (what _common/flows.yaml `shopping`
// drives one item at a time): for each query, AX_search_product(query) -> pick the first candidate's
// id (ASIN) -> AX_add_to_cart({ product_id, quantity }). This mirrors the flow nodes
// search_item -> pick_item -> add_item, proving the multi-item "iphone + eggs" scenario at the
// command level (the flow orchestration itself runs server-side and needs the doc pushed to test).
//
// Usage:
//   node amazon/scripts/test_shopping_chain.mjs --cdp=http://127.0.0.1:9225 [--queries=iphone,eggs] [--add] [--keep-open]
//   --add   also calls AX_add_to_cart for each item (mutates the real cart). Omit to test search+pick only.
import { openPage, callLuaSettled, waitForLuaRuntime, DEFAULT_EXTENSION_ID } from './test_amazon_lua.mjs';

function parseArgs(argv) {
  const options = {
    cdp: `http://127.0.0.1:${process.env.CDP_PORT || 9225}`,
    extensionId: process.env.AXSDK_EXTENSION_ID || DEFAULT_EXTENSION_ID,
    queries: ['iphone', 'eggs'],
    add: false,
    keepOpen: false,
  };
  for (const arg of argv) {
    if (arg.startsWith('--cdp=')) options.cdp = arg.slice('--cdp='.length);
    else if (arg.startsWith('--extension-id=')) options.extensionId = arg.slice('--extension-id='.length);
    else if (arg.startsWith('--queries=')) options.queries = arg.slice('--queries='.length).split(',').map(s => s.trim()).filter(Boolean);
    else if (arg === '--add') options.add = true;
    else if (arg === '--keep-open') options.keepOpen = true;
  }
  return options;
}

function pickFirstCandidate(candidates) {
  // Mirror flowTools.pick_product: first candidate with a non-empty id (read_candidate sets id = ASIN).
  for (const c of candidates || []) {
    if (c && c.id != null && c.id !== '') return { product_id: c.id, product_name: c.name || c.title };
  }
  return null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const page = await openPage(options.cdp, 'https://www.amazon.com/');
  const results = [];
  let allOk = true;
  try {
    await waitForLuaRuntime(page, options);

    for (const query of options.queries) {
      const row = { query };
      // search_item
      let search = await callLuaSettled(page, options, 'AX_search_product', { query }, 5);
      for (let attempt = 0; attempt < 2 && !(search?.ok && (search.value?.candidates?.length || 0) > 0); attempt += 1) {
        search = await callLuaSettled(page, options, 'AX_search_product', { query }, 5);
      }
      const candidates = search?.value?.candidates || [];
      row.search_ok = Boolean(search?.ok) && candidates.length > 0;
      row.candidate_count = candidates.length;
      row.candidate_keys = candidates[0] ? Object.keys(candidates[0]) : [];

      // pick_item
      const picked = pickFirstCandidate(candidates);
      row.picked_id = picked?.product_id || null;
      row.picked_name = picked?.product_name || null;

      if (!row.search_ok || !picked) {
        row.outcome = !row.search_ok ? 'SEARCH FAILED' : 'no usable candidate';
        allOk = false;
        results.push(row);
        continue;
      }

      // add_item (opt-in: mutates the real cart)
      if (options.add) {
        const add = await callLuaSettled(page, options, 'AX_add_to_cart', { product_id: picked.product_id, quantity: 1 }, 5);
        row.added = add?.value?.added === true;
        row.add_pending = add?.value?.pending === true;
        row.add_error = add?.value?.error || null;
        row.outcome = row.added ? 'ADDED' : (row.add_pending ? 'PENDING' : `NOT ADDED (${row.add_error || 'unknown'})`);
        if (!row.added && !row.add_pending) allOk = false;
      } else {
        row.outcome = 'search+pick OK (skipped add; pass --add to add to cart)';
      }
      results.push(row);
    }
  } finally {
    page.close();
  }

  for (const r of results) {
    console.log(`[${r.query}] ${r.outcome} | candidates=${r.candidate_count} keys=[${r.candidate_keys.join(',')}] picked=${r.picked_id || '-'}${r.picked_name ? ' (' + String(r.picked_name).slice(0, 50) + ')' : ''}`);
  }
  console.log(allOk ? '\nPASS' : '\nFAIL');
  process.exitCode = allOk ? 0 : 1;
}

main().catch(error => {
  console.error('\nFAIL');
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
