#!/usr/bin/env node
/**
 * Live: per site, let the SHIPPED flow search and extract, then re-read the whole page through CDP's DOM
 * domain and check that every extracted value is in it.
 *
 * Why this is not a duplicate of the existing sweeps: they assert that a store answered, and they read the
 * answer through the same `dom.query_all` path that produced it. §13's extraction defects all passed that
 * bar — a title read off the wrong `h2`, a price glued out of two amounts, an id mined from a junk token,
 * shipping invented from a threshold sentence — and each was found by hand weeks later. Here the page comes
 * from Chrome's own tree, so "is this value in the document" is answered by a channel that shares nothing
 * with the reader.
 *
 * The flow is driven with a real message (`send`), so what gets audited is what the product extracted.
 */
import { pathToFileURL } from 'node:url';

import { auditCandidates } from './extraction-audit.mjs';
import { FLOW_TOOLS, turnFault } from './turn-fault.mjs';

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
  'naver-shopping': 'https://shopping.naver.com/',
};
const DEFAULT_STORES = ['amazon', 'ebay', 'coupang', '11st'];

/** The candidates a searching turn published, wherever the trace carries them. */
export function extractedCandidates(toolCalls) {
  const rows = [];
  for (const call of toolCalls ?? []) {
    const output = call?.output;
    if (output === null || typeof output !== 'object') continue;
    const direct = Array.isArray(output.candidates) ? output.candidates : [];
    const nested = Array.isArray(output.store_result?.candidates) ? output.store_result.candidates : [];
    for (const row of [...direct, ...nested]) if (row && typeof row === 'object') rows.push(row);
  }
  // The same product can be published by the reader and again by the normalizer; auditing it twice says
  // nothing new, and the id is what the flow carries forward.
  const seen = new Set();
  return rows.filter((row) => {
    const key = String(row.product_id ?? row.id ?? row.name ?? '');
    if (key === '' || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function auditVerdict(report) {
  if (report.reason === 'html_unavailable') {
    return { pass: false, reason: 'the page could not be read through CDP — nothing was checked' };
  }
  if (report.checked === 0) {
    return { pass: false, reason: 'the turn published no candidates, so the audit checked nothing' };
  }
  if (!report.ok) {
    const first = report.candidates.find((entry) => !entry.ok);
    const problem = first?.problems?.[0];
    return {
      pass: false,
      reason: `extraction disagrees with the page: ${first?.id ?? '?'} ${problem?.field}=${JSON.stringify(problem?.value)} (${problem?.kind})`,
    };
  }
  return { pass: true, reason: `every extracted value is in the page (${report.fieldsChecked} fields, ${(report.fieldsChecked / report.checked).toFixed(1)} per row)` };
}

/**
 * Did the store's own selectors fill rows, and does the extraction look like a page at all?
 *
 * The first version failed a zero fill on ANY declared selector, and four of its five failures were facts
 * about the store rather than drift: coupang and ssg state their title in an `img alt` (so the text
 * selector fills nothing and the reader uses `image_alt`), while walmart and etsy grids omit
 * shipping/rating/reviews — §13 records both. So a zero fill fails only for a CORE identity field: the url,
 * the title in either form, and a price the store declares (an offer with no price cannot be compared).
 * Everything else is reported.
 *
 * The mean fill catches the shape that started this: gmarket's `result_selector` was the union of two
 * different element sets, so most rows carried nothing but an id — 8 full rows out of 30.
 */
const CORE = ['url', 'price_text'];

export function fillVerdict({ declared, rows }) {
  const entries = Object.entries(declared ?? {});
  if (entries.length === 0) return { pass: false, reason: 'the store declares no result selectors — nothing to audit' };
  const fill = (field) => declared[field] ?? 0;
  const dead = entries.filter(([, filled]) => filled === 0).map(([field]) => field);
  const partial = entries.filter(([, filled]) => filled > 0 && filled < rows)
    .map(([field, filled]) => `${field} ${filled}/${rows}`);
  const deadCore = CORE.filter((field) => field in declared && fill(field) === 0);
  // The title counts as present in EITHER form: the reader's own fallback is text-then-alt.
  const titleDeclared = 'title' in declared || 'image_alt' in declared;
  if (titleDeclared && fill('title') === 0 && fill('image_alt') === 0) deadCore.push('title/image_alt');
  if (deadCore.length > 0) {
    return { pass: false, reason: `core selector filled 0 of ${rows} rows: ${deadCore.join(', ')} — drifted off the page` };
  }
  const mean = entries.reduce((sum, [, filled]) => sum + filled, 0) / (entries.length * Math.max(rows, 1));
  if (mean < 0.5) {
    return { pass: false, reason: `rows mostly carry nothing: mean fill ${(mean * 100).toFixed(0)}% across ${entries.length} selectors` };
  }
  const notes = [...dead.map((field) => `${field} 0/${rows}`), ...partial];
  return {
    pass: true,
    reason: `all ${entries.length} declared selectors checked, mean fill ${(mean * 100).toFixed(0)}%`
      + `${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`,
  };
}

/**
 * Did the runtime hold the store under test's own selectors?
 *
 * Measured live: after auditing etsy, the browser moved to gmarket search and `AX_SITE_CONFIGS` still held
 * ETSY's config, so the audit extracted a gmarket page with etsy selectors and called the result too thin —
 * a conclusion about the wrong thing entirely. The site Lua layer follows core's site resolution and can
 * lag a navigation; anything read before it catches up is evidence about neither store.
 */
export function siteVerdict({ expected, loaded, href }) {
  if (loaded === expected) return null;
  return {
    pass: false,
    reason: `the runtime held ${loaded ?? 'no'} selectors while the browser was on ${expected} (${href}) — the site layer had not switched`,
  };
}

/**
 * The extraction, run with the STORE'S OWN configured selectors through the same `dom.query_all` op the
 * shipped reader uses. The flow's own trace cannot be the source here: chat truncates a large tool output
 * at 4,120 characters (§13), so a page of candidates arrives as a cut string and the audit would check
 * nothing. `AX_SITE_CONFIGS` is delivered as the site's Lua layer, so the selectors are the product's, not
 * a copy — a second copy in this runner is exactly how the two drift apart.
 */
const EXTRACT_LUA = `
  local site = nil
  for key in pairs(AX_SITE_CONFIGS or {}) do site = site or key end
  if not site then return { error = "no site config in this runtime" } end
  local config = AX_SITE_CONFIGS[site]
  local fields = { text = true }
  local function add(name, selector, attr)
    if not selector then return end
    fields[name] = { selector = selector }
    if attr then fields[name].attr = attr end
  end
  if config.result_url_selector then add("url", config.result_url_selector, "href")
  elseif config.result_url_from_root then fields.url = { attr = "href" } end
  -- Mirrors the reader's own fields_for, key for key. A partial copy is why the first run audited one
  -- field per row on four stores: coupang states its title in an img ALT, ssg carries neither price nor
  -- shipping selector, and asking for less than the reader asks for makes the audit vacuous, not green.
  add("title", config.result_title_selector)
  add("image_alt", config.result_image_selector, "alt")
  add("brand", config.result_brand_selector)
  add("manufacturer_model", config.result_model_selector)
  add("price_text", config.result_price_selector)
  add("shipping_text", config.result_shipping_selector)
  add("rating_text", config.result_rating_selector)
  add("reviews_text", config.result_reviews_selector)
  add("condition", config.result_condition_selector)
  add("delivery_text", config.result_delivery_selector)
  add("return_terms", config.result_return_selector)
  add("seller_text", config.result_seller_selector)
  if config.result_id_attr or config.result_id_selector then
    fields.root_id = { attr = config.result_id_attr or "id" }
    if config.result_id_selector then fields.root_id.selector = config.result_id_selector end
  end
  local ok, rows = pcall(function()
    return dom.query_all(config.result_selector, fields, 8)
  end)
  if not ok then return { error = "query_all refused" } end
  local out = {}
  -- An empty string is TRUTHY in Lua, and coupang/ssg state their titles in an img ALT: asking for the
  -- text of an img answers "", so a plain title-or-alt fallback picked the empty one and both stores
  -- audited exactly one field per row. The reader has its own non-empty rule; this mirrors it.
  local function nonblank(...)
    for _, value in ipairs({ ... }) do
      if type(value) == "string" and value:gsub("%s", "") ~= "" then return value end
    end
    return nil
  end
  for index = 1, #(rows or {}) do
    local row = rows[index]
    out[#out + 1] = {
      name = nonblank(row.title, row.image_alt),
      price_text = row.price_text,
      shipping_text = row.shipping_text,
      condition = row.condition,
      seller = row.seller_text,
      rating_text = row.rating_text,
      reviews_text = row.reviews_text,
      delivery_text = row.delivery_text,
      brand = row.brand,
      url = row.url,
      row_id = row.root_id,
    }
  end
  -- Per DECLARED selector, how many rows it filled. A selector the store declares that fills zero rows has
  -- drifted off the page; that is what gmarket's shipping/delivery/reviews selectors had done.
  local declared = {}
  for name in pairs(fields) do
    if name ~= "text" then
      local filled = 0
      for index = 1, #(rows or {}) do
        local value = rows[index][name]
        if type(value) == "string" and value:gsub("%s", "") ~= "" then filled = filled + 1 end
      end
      declared[name] = filled
    end
  end
  return { site = site, href = dom.get_location_href(), selector = config.result_selector, rows = out, declared = declared, rowCount = #(rows or {}) }
`;

async function auditStore(session, store, query) {
  console.log(`\n=== ${store} ===`);
  await session.reset();
  await session.open(HOME[store]);

  const started = Date.now();
  let answer = null;
  let failure = null;
  try {
    answer = await session.send(`이 사이트에서 ${query} 찾아줘`, { timeoutMs: 240000 });
  } catch (error) {
    failure = String(error?.message ?? error);
  }
  const toolCalls = answer?.toolCalls ?? [];
  console.log(`  [search] ${query} (${Date.now() - started}ms)${failure ? ` ERR=${failure}` : ''}`);
  console.log(`  tools: ${toolCalls.map((call) => `${call.name}(${call.status})`).join(' -> ') || '(none)'}`);

  const fault = turnFault({ toolCalls, failure }, { expects: FLOW_TOOLS.singleSite });
  if (fault) {
    console.log(`  fault: ${fault.kind} — ${fault.detail}`);
    return { store, fault, verdict: { pass: false, reason: `${fault.kind}: ${fault.detail}` } };
  }

  // Extract from the page the flow searched, with that store's own selectors.
  // The site Lua layer becomes active when core resolves the current site, and a search navigation can
  // land on another host first (gmarket searches on browse.gmarket.co.kr). One retry, then the host is
  // reported: a missing layer is a fact about delivery, not about the extraction.
  let extracted = await session.eval(EXTRACT_LUA, { timeoutMs: 60000 }).catch((error) => ({ error: String(error?.message ?? error) }));
  if (extracted?.error) {
    extracted = await session.eval(EXTRACT_LUA, { timeoutMs: 60000 }).catch((error) => ({ error: String(error?.message ?? error) }));
  }
  if (extracted?.error) {
    console.log(`  extract: ${extracted.error}`);
    return { store, verdict: { pass: false, reason: `extraction unavailable: ${extracted.error}` } };
  }
  const mismatch = siteVerdict({ expected: store, loaded: extracted?.site, href: extracted?.href ?? '?' });
  if (mismatch) {
    console.log('  site: ' + mismatch.reason);
    return { store, verdict: mismatch };
  }
  const candidates = (extracted?.rows ?? []).map((row) => ({ ...row, product_id: row.row_id }));
  const page = await session.pageHtml();
  console.log(`  page: ${page.url} html=${page.html.length}B${page.error ? ` error=${page.error}` : ''}`);
  console.log(`  extracted: ${candidates.length} rows via ${extracted.selector}`);

  const report = auditCandidates(candidates, page.html);
  const grounded = auditVerdict(report);
  const filled = fillVerdict({ declared: extracted?.declared ?? {}, rows: extracted?.rowCount ?? candidates.length });
  console.log('  declared: ' + filled.reason);
  const verdict = grounded.pass ? filled : grounded;
  for (const entry of report.candidates.filter((row) => !row.ok)) {
    for (const problem of entry.problems) {
      console.log(`  MISMATCH ${entry.id}: ${problem.field}=${JSON.stringify(problem.value).slice(0, 90)} (${problem.kind})`);
    }
  }
  return { store, report, verdict, url: page.url };
}

async function main() {
  const args = process.argv.slice(2);
  const storesArg = args.find((entry) => entry.startsWith('--stores='));
  const queryArg = args.find((entry) => entry.startsWith('--query='));
  const query = queryArg ? queryArg.slice('--query='.length) : 'usb cable';
  const stores = storesArg ? storesArg.slice('--stores='.length).split(',').filter(Boolean) : DEFAULT_STORES;
  for (const store of stores) if (!HOME[store]) throw new Error(`unknown store: ${store}`);

  const { openCdpSession } = await import('../harness/cdp-session.mjs');
  const session = await openCdpSession();
  const results = [];
  try {
    for (const store of stores) {
      try {
        results.push(await auditStore(session, store, query));
      } catch (error) {
        results.push({ store, verdict: { pass: false, reason: String(error?.message ?? error) } });
      }
    }
  } finally {
    await session.close().catch(() => {});
  }

  console.log('\n=== EXTRACTION AUDIT ===');
  let pass = 0;
  for (const result of results) {
    if (result.verdict.pass) pass += 1;
    console.log(`  ${result.verdict.pass ? 'PASS' : 'FAIL'}  ${result.store.padEnd(15)} ${result.verdict.reason}`);
  }
  console.log(`AUDIT: ${pass}/${results.length} PASS`);
  process.exitCode = pass === results.length && results.length > 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('FATAL', error?.stack ?? error);
    process.exitCode = 1;
  });
}
