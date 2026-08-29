import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  assertListingAssets, assertListingStructure, assertBilingualCopy, assertNoMarketplaceKeywordSpam,
  outstandingConfirmations, LISTING_ASSETS, LISTING_ASSET_LOCALES, LISTING_FILES,
  LISTING_METADATA_FILES, LISTING_TILE,
} from './listing.mjs';

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

/**
 * CWS rejected the submitted descriptions on 2026-08-29 because a line naming every supported
 * marketplace was metadata keyword spam. Capability belongs in prose; a catalogue of third-party
 * brands does not. Scan both the source and the paste-ready dashboard sheet so correcting one cannot
 * leave the rejected copy ready to paste from the other.
 */
test('listing descriptions do not enumerate marketplaces as keyword metadata', () => {
  assertNoMarketplaceKeywordSpam(repoRoot);
});

test('a marketplace catalogue names the rejected metadata source', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'axsdk-listing-keywords-'));
  for (const file of LISTING_METADATA_FILES) {
    await mkdir(join(root, ...file.split('/').slice(0, -1)), { recursive: true });
    await writeFile(join(root, file), file.endsWith('listing.md')
      ? 'Supported stores: Amazon, Walmart, eBay, Etsy.'
      : 'Paste-ready description without a catalogue.');
  }
  assert.throws(
    () => assertNoMarketplaceKeywordSpam(root),
    /store\/listing\.md enumerates 4 marketplace names/,
  );
});

test('wrapping a marketplace catalogue across lines does not evade the gate', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'axsdk-listing-keywords-wrapped-'));
  for (const file of LISTING_METADATA_FILES) {
    await mkdir(join(root, ...file.split('/').slice(0, -1)), { recursive: true });
    await writeFile(join(root, file), file.endsWith('listing.md')
      ? 'Supported stores:\nAmazon\nWalmart\neBay\nEtsy\n'
      : 'Paste-ready description without a catalogue.');
  }
  assert.throws(
    () => assertNoMarketplaceKeywordSpam(root),
    /store\/listing\.md enumerates 4 marketplace names/,
  );
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

/**
 * A screenshot at the wrong size is refused by the dashboard, and the size is not visible in a file
 * listing — so it is read out of the PNG header rather than trusted.
 */
test('every listing screenshot is the size the store requires', () => {
  assertListingAssets(repoRoot);
});

test('a screenshot at the wrong size names itself and its size', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'axsdk-assets-'));
  for (const locale of LISTING_ASSET_LOCALES) {
    await mkdir(join(root, 'store', 'assets', locale), { recursive: true });
  }
  for (const file of LISTING_ASSETS) {
    for (const locale of LISTING_ASSET_LOCALES) {
      await writeFile(join(root, 'store', 'assets', locale, file), png(640, 480));
    }
  }
  assert.throws(() => assertListingAssets(root), /640x480.*1280x800|1280x800.*640x480/s);
});

test('a missing screenshot is named', async () => {
  const { mkdtemp, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'axsdk-assets-'));
  for (const locale of LISTING_ASSET_LOCALES) {
    await mkdir(join(root, 'store', 'assets', locale), { recursive: true });
  }
  assert.throws(() => assertListingAssets(root), new RegExp(LISTING_ASSETS[0]));
});

test('something that is not a PNG is refused rather than measured', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'axsdk-assets-'));
  for (const locale of LISTING_ASSET_LOCALES) {
    await mkdir(join(root, 'store', 'assets', locale), { recursive: true });
  }
  for (const locale of LISTING_ASSET_LOCALES) {
    for (const file of LISTING_ASSETS) await writeFile(join(root, 'store', 'assets', locale, file), 'not a png');
  }
  assert.throws(() => assertListingAssets(root), /not a PNG/);
});

/** A 1280x800 PNG header with no image data: the gate reads dimensions, not pixels. */
function png(width, height) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
}

/**
 * Two audiences, not one. The reviewer reads the single purpose, the permission justifications and the
 * privacy policy — in English — while the users this product is built for read Korean. A surface that
 * exists in one language is a surface someone will improvise a translation for at submission time.
 */
test('every dashboard surface carries both languages', () => {
  assertBilingualCopy(repoRoot);
});

test('a surface missing the English half names itself', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'axsdk-copy-'));
  await mkdir(join(root, 'store'), { recursive: true });
  await mkdir(join(root, 'docs'), { recursive: true });
  for (const file of LISTING_FILES) {
    await writeFile(join(root, file), '# 한국어만 있는 문서\n\n## 한국어\n\n내용\n');
  }
  assert.throws(() => assertBilingualCopy(root), /English/);
});

/**
 * The locales we have screenshots FOR, which is not the same as the locales the listing is written in.
 * The rendered comparison window is Korean by construction (87 Korean string literals across the
 * renderers), so an English capture would show an English reply around a Korean window.
 */
test('screenshots cover the locales whose UI actually exists', () => {
  assert.deepEqual([...LISTING_ASSET_LOCALES], ['ko']);
});

/**
 * The promotional tile is the one required asset that is NOT a screenshot, and the store is specific
 * about it: 440x280, brand rather than a screenshot, no text. Size is the half a gate can read.
 */
test('the promotional tile is present at the size the store requires', () => {
  const bytes = readFileSync(join(repoRoot, LISTING_TILE.path));
  assert.equal(bytes.readUInt32BE(16), LISTING_TILE.width);
  assert.equal(bytes.readUInt32BE(20), LISTING_TILE.height);
  assert.equal(LISTING_TILE.width, 440);
  assert.equal(LISTING_TILE.height, 280);
});

test('a tile at the wrong size is refused by the asset gate', async () => {
  const { mkdtemp, mkdir, writeFile, cp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'axsdk-tile-'));
  for (const locale of LISTING_ASSET_LOCALES) {
    await mkdir(join(root, 'store', 'assets', locale), { recursive: true });
    for (const file of LISTING_ASSETS) {
      await cp(join(repoRoot, 'store', 'assets', locale, file), join(root, 'store', 'assets', locale, file));
    }
  }
  const wrong = Buffer.from(readFileSync(join(repoRoot, LISTING_TILE.path)));
  wrong.writeUInt32BE(300, 16);
  await writeFile(join(root, LISTING_TILE.path), wrong);
  assert.throws(() => assertListingAssets(root), /tile-small.png is 300x280/);
});
