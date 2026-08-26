// The decision layer of the extraction audit, tested away from the browser.
//
// Every storefront candidate is produced by OUR selectors against a live DOM. Nothing has ever checked
// that what came out is actually IN the page: §13 records a title read off the wrong `h2` (every row came
// back "Logitech"), a price glued from two amounts (`Now$4999current price` read as 4999), an id mined
// from a junk token so a page of 156 cards collapsed to one, and shipping invented as 0 from a
// threshold sentence. Each of those is a mismatch between the extraction and the page it claims to
// describe, and each was found by hand, weeks later.
//
// So the audit re-reads the WHOLE page through CDP and asks a different question than the reader did:
// does this value exist in that document at all? Two projections, because a value lives in one or the
// other and never both:
//   - ids and urls live in ATTRIBUTES, so they are matched against the raw HTML;
//   - titles, prices and shipping are TEXT, and text read with `textContent` spans child elements
//     (`<span>Logitech</span> <span>M185</span>` reads "Logitech M185", which never appears contiguously
//     in the markup), so they are matched against the tag-stripped projection.
import assert from 'node:assert/strict';
import test from 'node:test';

import { auditCandidate, auditCandidates, textProjection } from './extraction-audit.mjs';

const HTML = `<html><body>
  <li class="card" data-id="B0TEST1234">
    <a href="/dp/B0TEST1234"><h2><span>Logitech</span> <span>M185 Wireless Mouse</span></h2></a>
    <span class="price">$29.99</span>
    <span class="ship">Free shipping</span>
  </li>
  <li class="card" data-id="B0OTHER999">
    <a href="/dp/B0OTHER999"><h2>Keychron K8 Keyboard</h2></a>
    <span class="price">Now$4999current price Now $49.99</span>
  </li>
</body></html>`;

test('a title spanning child elements is found in the text projection', () => {
  // The whole reason for the projection: this string is not contiguous in the markup.
  assert.ok(!HTML.includes('Logitech M185 Wireless Mouse'));
  assert.ok(textProjection(HTML).includes('logitech m185 wireless mouse'));
});

test('a grounded candidate passes every field', () => {
  const verdict = auditCandidate({
    product_id: 'B0TEST1234',
    name: 'Logitech M185 Wireless Mouse',
    price_text: '$29.99',
    url: 'https://www.amazon.com/dp/B0TEST1234',
    shipping_text: 'Free shipping',
  }, HTML);

  assert.deepEqual(verdict.problems, []);
  assert.equal(verdict.ok, true);
});

test('a title the page does not contain is the failure this audit exists for', () => {
  // The measured shape: Amazon's card carries TWO h2 elements and a CSS list took the brand, so every
  // branded row came back named "Logitech" — a value that is in the page but is not this row's title.
  const verdict = auditCandidate({ product_id: 'B0TEST1234', name: 'Logitech M185 Ergonomic Vertical Mouse' }, HTML);

  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.problems.map((problem) => problem.field), ['name']);
  assert.equal(verdict.problems[0].kind, 'absent');
});

test('an id that appears nowhere in the markup is reported', () => {
  const verdict = auditCandidate({ product_id: '9999999999', name: 'Keychron K8 Keyboard' }, HTML);

  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.problems.map((problem) => problem.field), ['product_id']);
});

test('a numeric price is accepted only in a rendering the page actually shows', () => {
  // 29.99 is rendered as `$29.99`, so the digits and the separator are both there.
  assert.deepEqual(auditCandidate({ product_id: 'B0TEST1234', price: 29.99 }, HTML).problems, []);
  // The Walmart shape: the page shows `Now$4999current price Now $49.99`. A reader that answered 4999
  // produced a number the page never states as a price — the digits exist, the AMOUNT does not.
  const glued = auditCandidate({ product_id: 'B0OTHER999', price: 4999 }, HTML);
  assert.equal(glued.ok, false);
  assert.equal(glued.problems[0].kind, 'unstated_amount');
});

test('a KRW-style grouped amount matches its grouped rendering', () => {
  const html = '<div>16,900원 무료배송</div>';
  assert.deepEqual(auditCandidate({ price: 16900, currency: 'KRW' }, html).problems, []);
});

test('entities and collapsed whitespace do not count as mismatches', () => {
  const html = '<h2>Anker&nbsp;PowerLine&#39;s   Cable &amp; Adapter</h2>';
  assert.deepEqual(auditCandidate({ name: "Anker PowerLine's Cable & Adapter" }, html).problems, []);
});

test('an empty document is reported as unavailable, never as a mismatch', () => {
  const report = auditCandidates([{ product_id: 'X', name: 'Y' }], '');

  assert.equal(report.ok, false);
  assert.equal(report.reason, 'html_unavailable');
  assert.equal(report.candidates.length, 0, 'no candidate is blamed for a document nobody could read');
});

test('the report counts what it checked, so a green run cannot mean zero checks', () => {
  const report = auditCandidates([
    { product_id: 'B0TEST1234', name: 'Logitech M185 Wireless Mouse', price_text: '$29.99' },
    { product_id: 'B0OTHER999', name: 'Keychron K8 Keyboard' },
  ], HTML);

  assert.equal(report.ok, true);
  assert.equal(report.checked, 2);
  assert.equal(report.fieldsChecked, 5);
});

// The first live run's job was to expose the AUDIT's own false positives, and it found three. Each is a
// difference between what a DOM read returns and what the markup literally contains, not a difference
// between the extraction and the page.
test('an attribute value is compared decoded, the way the DOM returns it', () => {
  // Measured on amazon: every row's href came back
  // `/sspa/click?ie=UTF8&spc=…` while the markup carries `&amp;spc=…`. A DOM read decodes entities; the
  // raw HTML does not. All 8 rows were reported absent.
  const html = '<a href="/sspa/click?ie=UTF8&amp;spc=MTo4MDgz&amp;url=%2Fdp%2FB07DD5YHMH">x</a>';
  const verdict = auditCandidate({ url: 'https://www.amazon.com/sspa/click?ie=UTF8&spc=MTo4MDgz&url=%2Fdp%2FB07DD5YHMH' }, html);

  assert.deepEqual(verdict.problems, []);
});

test('text is compared without whitespace, because neither side agrees about it', () => {
  // Measured on eBay: `textContent` concatenates across children with NO separator
  // (`…4.92 ft) ⚡️새 창 또는 새 탭에서 열림`), while stripping tags INSERTS one. Both directions appear in one
  // row, so whitespace cannot be part of the comparison at all.
  const html = '<h3><span>2-Pack USB C-C 240W Cable (1.5 m, 4.92 ft)</span><span class="sr">새 창 또는 새 탭에서 열림</span></h3>';
  const verdict = auditCandidate({
    name: '2-Pack USB C-C 240W Cable (1.5 m, 4.92 ft)새 창 또는 새 탭에서 열림',
  }, html);

  assert.deepEqual(verdict.problems, []);
});

test('a row with no id is identified by its position, never as null', () => {
  // amazon declares no `result_id_selector` — the id is mined from the url — so the audit has no id to
  // print. `null` in a mismatch line tells the reader nothing about which row to look at.
  const report = auditCandidates([{ name: 'nowhere near this page' }], HTML);

  assert.equal(report.candidates[0].id, 'row 1');
});

test('whitespace-insensitivity does not rescue a value the page never had', () => {
  // The audit still has to fail on the defect it exists for.
  const verdict = auditCandidate({ name: 'Logitech M185 Ergonomic Vertical Mouse' }, HTML);

  assert.equal(verdict.ok, false);
});

test('a url is compared by PATH, because a store rewrites its own query', () => {
  // Measured on coupang: every row href carries tracking params (sourceType=srp_product, searchId=…) and
  // the serialized DOM read a moment later does not carry the same ones. All four such rows were reported
  // absent while their PATH was present in every case. The reader rebuilds canonical urls from the id
  // anyway (§13), so a query string was never a claim about the markup.
  const html = '<a href="/vp/products/8087835532?itemId=22831071578">x</a>';
  const verdict = auditCandidate({ url: 'https://www.coupang.com/vp/products/8087835532?itemId=22831071578&q=USB%20cable&searchId=abc' }, html);

  assert.deepEqual(verdict.problems, []);
});

test('a url whose PATH is absent is still a mismatch', () => {
  const html = '<a href="/vp/products/1111111111">x</a>';
  const verdict = auditCandidate({ url: 'https://www.coupang.com/vp/products/9999999999?q=x' }, html);

  assert.equal(verdict.ok, false);
});

test('a title that lives in an ALT attribute is found there', () => {
  // Measured on ssg: its result title IS the image alt (the reader asks for image_alt for exactly this),
  // so the value is inside a tag and the text projection strips it. Four rows were reported absent while
  // the page carried each one verbatim in <img alt="…">.
  const html = '<div><img alt="벨킨 240W USB-C to C 브레이디드 고속 충전 케이블 2M" src="x.jpg"></div>';
  const verdict = auditCandidate({ name: '벨킨 240W USB-C to C 브레이디드 고속 충전 케이블 2M' }, html);

  assert.deepEqual(verdict.problems, []);
});

test('a value in neither the text nor an attribute is still absent', () => {
  const html = '<div><img alt="something else entirely" src="x.jpg">visible text</div>';
  const verdict = auditCandidate({ name: '벨킨 240W USB-C to C' }, html);

  assert.equal(verdict.ok, false);
  assert.equal(verdict.problems[0].kind, 'absent');
});
