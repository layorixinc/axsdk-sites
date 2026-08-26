// The runner's own decisions, away from the browser: which rows get audited, and what a report means.
import assert from 'node:assert/strict';
import test from 'node:test';

import { auditVerdict, extractedCandidates, siteVerdict } from './extraction-audit-live.mjs';

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

test('an audit that checked barely anything is not a pass', () => {
  // Measured live: coupang audited 8 fields across 8 rows — one field per row, because its title lives in
  // an img[alt] the snippet had not asked for. Everything 'matched', and the run said PASS. An audit that
  // checks one field per row is not evidence that the extraction is grounded.
  const verdict = auditVerdict({ ok: true, reason: 'grounded', checked: 8, fieldsChecked: 8, candidates: [] });

  assert.equal(verdict.pass, false);
  assert.match(verdict.reason, /per row/);
});

test('two fields per row is enough to be evidence', () => {
  const verdict = auditVerdict({ ok: true, reason: 'grounded', checked: 8, fieldsChecked: 24, candidates: [] });

  assert.equal(verdict.pass, true);
});

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
