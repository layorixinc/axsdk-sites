// The runner's own decisions, away from the browser: which rows get audited, and what a report means.
import assert from 'node:assert/strict';
import test from 'node:test';

import { auditVerdict, extractedCandidates, fillVerdict, rowsOf, siteVerdict } from './extraction-audit-live.mjs';

const call = (name, output) => ({ name, status: 'completed', output });

test('candidates are collected from both the reader and the fan-out shape', () => {
  // §13: the fan-out publishes the store's own reply one level deeper (`store_result.candidates`), and
  // reading only the top level attributed nothing.
  const rows = extractedCandidates([
    call('shopping_search_product', { candidates: [{ product_id: 'A', name: 'a' }] }),
    call('shopping_normalize_store_result', { store_result: { candidates: [{ product_id: 'B', name: 'b' }] } }),
  ]);

  assert.deepEqual(rows.map((row) => row.product_id), ['A', 'B']);
});

test('the same product published twice is audited once', () => {
  const rows = extractedCandidates([
    call('shopping_search_product', { candidates: [{ product_id: 'A', name: 'raw' }] }),
    call('shopping_normalize_store_result', { store_result: { candidates: [{ product_id: 'A', name: 'normalized' }] } }),
  ]);

  assert.equal(rows.length, 1, 'auditing one product twice says nothing new');
});

test('a turn with no candidates is a failed audit, not a green one', () => {
  // The trap this exists for: an audit that checked nothing must never report success.
  const verdict = auditVerdict({ ok: true, reason: 'grounded', checked: 0, fieldsChecked: 0, candidates: [] });

  assert.equal(verdict.pass, false);
  assert.match(verdict.reason, /checked nothing/);
});

test('an unreadable page blames the channel, not the extraction', () => {
  const verdict = auditVerdict({ ok: false, reason: 'html_unavailable', checked: 0, fieldsChecked: 0, candidates: [] });

  assert.equal(verdict.pass, false);
  assert.match(verdict.reason, /could not be read/);
});

test('a mismatch names the row, the field and the kind', () => {
  const verdict = auditVerdict({
    ok: false,
    reason: 'mismatch',
    checked: 2,
    fieldsChecked: 6,
    candidates: [
      { id: 'A', ok: true, problems: [], fieldsChecked: 3 },
      { id: 'B', ok: false, problems: [{ field: 'name', kind: 'absent', value: 'Logitech' }], fieldsChecked: 3 },
    ],
  });

  assert.equal(verdict.pass, false);
  assert.match(verdict.reason, /B/);
  assert.match(verdict.reason, /name/);
  assert.match(verdict.reason, /absent/);
});

test('a grounded report reports how many fields it checked', () => {
  const verdict = auditVerdict({ ok: true, reason: 'grounded', checked: 3, fieldsChecked: 11, candidates: [] });

  assert.equal(verdict.pass, true);
  assert.match(verdict.reason, /11 fields/);
});

// RETIRED: the fields-per-row bar. It failed coupang for a fact about coupang — its card exposes the sale
// price only through hashed CSS-module classes (AGENTS.md 10 forbids those), so it declares no price
// selector and derives the amount from card text. Two auditable fields is all it can have. fillVerdict
// replaced the heuristic with the signal that actually caught gmarket: a DECLARED selector filling zero
// rows. Both cases are covered below.

test('a config belonging to another store is a delivery fault, not a verdict', () => {
  // Measured live: after auditing etsy, the browser moved to gmarket search and the runtime still held
  // ETSY's AX_SITE_CONFIGS. The audit had been extracting a gmarket page with etsy selectors and calling
  // the result "too thin" — a conclusion about the wrong thing entirely.
  const verdict = siteVerdict({ expected: 'gmarket', loaded: 'etsy', href: 'https://www.gmarket.co.kr/n/search?keyword=x' });

  assert.equal(verdict.pass, false);
  assert.match(verdict.reason, /etsy/);
  assert.match(verdict.reason, /gmarket/);
});

test('the matching config passes the identity check', () => {
  assert.equal(siteVerdict({ expected: 'gmarket', loaded: 'gmarket', href: 'x' }), null);
});

// The fields-per-row bar was a heuristic, and coupang showed why it is the wrong one: its card exposes the
// sale price only through hashed CSS-module classes (AGENTS.md 10 forbids those), so the store declares no
// price selector at all and derives the amount from the card text. Two declared fields is all it can ever
// audit, and that is not a defect. The precise signal is the one that caught gmarket: a selector the store
// DECLARES that fills zero rows has drifted off the page.
// The first version of this rule failed five stores and four of those were facts about the STORE, not
// drift: coupang and ssg state their title in an img ALT (so the text selector fills nothing and the
// reader uses image_alt), and walmart and etsy grids omit shipping/rating/reviews entirely — AGENTS.md 13
// records both. So a zero fill is FAILED only for a core identity field (url, title-or-alt, declared
// price), and otherwise reported. A broadly empty extraction is caught by the mean fill instead, which is
// what gmarket's broken row selector looked like: 8 full rows and 22 carrying nothing but an id.
test('a core field that fills no row fails', () => {
  const verdict = fillVerdict({ declared: { url: 0, title: 8, image_alt: 8 }, rows: 8 });

  assert.equal(verdict.pass, false);
  assert.match(verdict.reason, /url/);
});

test('a title that lives in the alt is not a dead title', () => {
  const verdict = fillVerdict({ declared: { url: 8, title: 0, image_alt: 8 }, rows: 8 });

  assert.equal(verdict.pass, true);
});

test('an optional field the grid omits is reported, not failed', () => {
  const verdict = fillVerdict({ declared: { url: 8, title: 8, shipping_text: 0, rating_text: 0 }, rows: 8 });

  assert.equal(verdict.pass, true);
  assert.match(verdict.reason, /shipping_text/);
});

test('a declared price that fills nothing fails — an offer needs a price', () => {
  const verdict = fillVerdict({ declared: { url: 8, title: 8, price_text: 0 }, rows: 8 });

  assert.equal(verdict.pass, false);
});

test('rows that mostly carry nothing fail on the mean fill', () => {
  // gmarket's broken row selector: the union of two different element sets, so most rows held one field.
  const verdict = fillVerdict({ declared: { url: 8, title: 2, price_text: 2, image_alt: 2 }, rows: 8 });

  assert.equal(verdict.pass, false);
  assert.match(verdict.reason, /mean|mostly/i);
});

test('no declared selector at all is a failure — the audit checked nothing', () => {
  assert.equal(fillVerdict({ declared: {}, rows: 8 }).pass, false);
});

test('rows arriving as an OBJECT are still rows', () => {
  // AGENTS.md 13, in this runner: a Lua table crosses as a JSON object when the array marker is not
  // honoured, and gmarket answered {"1": {...}} once — .map threw and the store was reported as a runner
  // error rather than as an audit result.
  assert.deepEqual(rowsOf({ rows: { 1: { name: 'a' }, 2: { name: 'b' } } }).map((row) => row.name), ['a', 'b']);
  assert.deepEqual(rowsOf({ rows: [{ name: 'a' }] }).map((row) => row.name), ['a']);
  assert.deepEqual(rowsOf({}), []);
});
