import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { assertListingStructure, outstandingConfirmations, LISTING_FILES } from './listing.mjs';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * The dashboard fields are typed by a person at submission time, which is exactly when improvising them
 * is cheapest and worst. So every field has a file, and this is the gate that says so.
 */
test('every listing surface the dashboard asks for exists in the repo', () => {
  assertListingStructure(repoRoot);
});

test('a missing file names itself rather than failing generically', () => {
  assert.throws(() => assertListingStructure(join(repoRoot, 'tools')), /store\/single-purpose\.md/);
});

test('the single purpose is one sentence, because that is what the field takes', () => {
  const text = readFileSync(join(repoRoot, 'store', 'single-purpose.md'), 'utf8');
  const sentence = text.split(/\r?\n/).find((line) => line.startsWith('> '));
  assert.ok(sentence, 'the sentence must be the quoted line, so one file is the only source');
  assert.ok(sentence.length < 400, 'a single purpose that needs a paragraph is not narrow');
});

/**
 * The privacy page is the one surface a reviewer compares against behaviour, so its sections are pinned
 * by name: a page that omits the recipients or the retention is a page that answers the easy half.
 */
test('the privacy page carries every section the CWS user-data policy asks about', () => {
  const text = readFileSync(join(repoRoot, 'docs', 'privacy.md'), 'utf8');
  for (const heading of [
    '## 무엇을 수집하는가',
    '## 어디로 가는가',
    '## 얼마나 남아 있는가',
    '## 삭제하는 방법',
    '## Limited Use',
  ]) {
    assert.ok(text.includes(heading), `privacy.md is missing ${heading}`);
  }
});

test('the permission page justifies every permission the manifest declares', () => {
  const manifest = JSON.parse(readFileSync(
    join(repoRoot, '..', 'axsdk-sdk-js', 'packages', 'axsdk-extension-cdp', 'src', 'manifest.json'),
    'utf8',
  ));
  const text = readFileSync(join(repoRoot, 'store', 'permissions.md'), 'utf8');
  for (const permission of manifest.permissions) {
    assert.ok(text.includes(`\`${permission}\``), `permissions.md does not justify ${permission}`);
  }
  assert.ok(text.includes('host_permissions'), 'the broad host grant needs its own paragraph');
});

/**
 * Placeholders are allowed to exist — a privacy page waiting on a retention answer is honest — but they
 * must be countable, so "ready to submit" is a measurement rather than an opinion.
 */
test('outstanding confirmations are reported, not hidden', () => {
  const outstanding = outstandingConfirmations(repoRoot);
  for (const entry of outstanding) {
    assert.match(entry.file, /^(docs|store)\//);
    assert.ok(entry.line > 0);
    assert.ok(entry.text.length > 0);
  }
});

test('the file list is the one the gate walks', () => {
  assert.ok(LISTING_FILES.includes('store/single-purpose.md'));
  assert.ok(LISTING_FILES.includes('docs/privacy.md'));
  assert.ok(LISTING_FILES.includes('docs/support.md'));
});
