#!/usr/bin/env node
/**
 * Does every extracted candidate exist in the page it claims to describe?
 *
 * The storefront reader produces candidates with OUR selectors. This audit re-reads the whole document
 * through CDP's DOM domain — a channel that shares nothing with those selectors — and asks whether each
 * value is in it. §13's extraction defects were all of this shape and all found by hand: a title read off
 * the wrong `h2` (every row named "Logitech"), a price glued out of `Now$4999current price`, an id mined
 * from a junk token so 156 cards read as one, shipping invented as 0 from a threshold sentence.
 *
 * Two projections, because a value lives in one or the other and never both:
 *   - ids and urls live in ATTRIBUTES  -> matched against the raw HTML;
 *   - titles, prices and shipping are TEXT -> matched against the tag-stripped projection, because
 *     `textContent` spans child elements and that string never appears contiguously in the markup.
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(value) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole);
}

const collapse = (value) => decodeEntities(String(value ?? ''))
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

/** The page as TEXT: scripts and styles dropped, tags stripped, whitespace collapsed, lowercased. */
export function textProjection(html) {
  return collapse(String(html ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '));
}

/** Renderings a page may use for one amount. A reader that answers a number the page never states is wrong. */
function amountRenderings(price) {
  const value = Number(price);
  if (!Number.isFinite(value)) return [];
  const fixed = value.toFixed(2);
  const whole = String(Math.round(value));
  const group = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const forms = new Set([fixed, fixed.replace('.', ','), group(fixed.split('.')[0]) + '.' + fixed.split('.')[1]]);
  if (Number.isInteger(value)) {
    forms.add(whole);
    forms.add(group(whole));
  }
  return [...forms];
}


/**
 * One candidate against one document.
 *
 * Both comparisons are looser than a literal substring, for reasons measured on the first live run:
 *   - an ATTRIBUTE read through the DOM is decoded (`&amp;` → `&`) while the markup is not, so the raw
 *     side is decoded too — every amazon row was otherwise reported absent;
 *   - TEXT read with `textContent` concatenates children with no separator while stripping tags inserts
 *     one, and eBay produced both directions in a single row, so whitespace is dropped from both sides.
 * `unstated_amount` is the interesting verdict: the digits are usually somewhere on the page (a glued
 * `Now$4999` contains 4999), so the check is whether the AMOUNT is stated in a form the page renders.
 */
export function auditCandidate(candidate, html, label = null) {
  const raw = String(html ?? '');
  const rawDecoded = decodeEntities(raw);
  const text = textProjection(raw).replace(/\s+/g, '');
  const problems = [];
  let fields = 0;

  const inRaw = (value) => raw.includes(String(value)) || rawDecoded.includes(String(value));
  const inText = (value) => text.includes(collapse(value).replace(/\s+/g, ''));

  const id = candidate.product_id ?? candidate.id;
  if (id !== undefined && id !== null && String(id) !== '') {
    fields += 1;
    if (!inRaw(id) && !inText(id)) problems.push({ field: 'product_id', kind: 'absent', value: String(id) });
  }
  if (candidate.url) {
    fields += 1;
    // The PATH only. Measured on coupang: every row's href carries tracking params
    // (`sourceType=srp_product`, `searchId=…`) and the DOM serialized a moment later does not carry the
    // same ones — four of eight rows were reported absent while their path was present in all of them. The
    // reader rebuilds canonical urls from the id anyway (§13), so a query string is not a claim about the
    // markup; the path and the id in it are.
    const path = String(candidate.url).replace(/^https?:\/\/[^/]+/, '').split(/[?#]/)[0];
    if (path && !inRaw(path) && !inRaw(encodeURI(path))) {
      problems.push({ field: 'url', kind: 'absent', value: path });
    }
  }
  for (const field of ['name', 'title', 'price_text', 'shipping_text', 'condition', 'seller']) {
    const value = candidate[field];
    if (typeof value !== 'string' || value.trim() === '') continue;
    fields += 1;
    // Text OR attribute. Measured on ssg: its result title IS the image alt — the reader asks for
    // `image_alt` for exactly that reason — so the value sits inside a tag and the text projection strips
    // it. Four rows were reported absent while the page carried each one verbatim in `<img alt="…">`. A
    // value in NEITHER place is still the mismatch this audit exists for.
    if (!inText(value) && !inRaw(value)) problems.push({ field, kind: 'absent', value });
  }
  if (candidate.price !== undefined && candidate.price !== null && candidate.price_text === undefined) {
    fields += 1;
    const forms = amountRenderings(candidate.price);
    if (forms.length > 0 && !forms.some((form) => text.includes(form.toLowerCase()))) {
      problems.push({ field: 'price', kind: 'unstated_amount', value: String(candidate.price) });
    } else if (Number.isInteger(Number(candidate.price))) {
      // The measured failure: Walmart glues the screen-reader form to the human one
      // (`Now$4999current price Now $49.99`), so a reader that answered 4999 produced digits the page
      // does show — as part of an amount it states WITH a decimal point. A bare integer whose digit
      // string equals a decimal amount on the same page is that misread, and nothing else looks like it.
      const digits = String(Math.round(Number(candidate.price)));
      const decimals = text.match(/\d[\d,]*[.,]\d{2}/g) ?? [];
      const collides = decimals.some((amount) => amount.replace(/[^\d]/g, '') === digits);
      if (collides && !text.includes(`${digits}원`) && !text.includes(`${digits} 원`)) {
        problems.push({ field: 'price', kind: 'unstated_amount', value: String(candidate.price) });
      }
    }
  }
  return { id: id ?? label ?? null, ok: problems.length === 0, problems, fieldsChecked: fields };
}

/** Every candidate against one document. A document nobody could read blames no candidate. */
export function auditCandidates(candidates, html) {
  const raw = String(html ?? '');
  if (raw.trim().length < 200) {
    return { ok: false, reason: 'html_unavailable', checked: 0, fieldsChecked: 0, candidates: [] };
  }
  // A row with no id is identified by POSITION: printing  in a mismatch line tells the reader
  // nothing about which row to look at.
  const list = (candidates ?? []).map((candidate, index) => auditCandidate(candidate, raw, `row ${index + 1}`));
  const failed = list.filter((verdict) => !verdict.ok);
  return {
    ok: failed.length === 0,
    reason: failed.length === 0 ? 'grounded' : 'mismatch',
    checked: list.length,
    fieldsChecked: list.reduce((sum, verdict) => sum + verdict.fieldsChecked, 0),
    candidates: list,
  };
}
