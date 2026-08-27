import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every Chrome Web Store field that a person would otherwise improvise at submission time.
 *
 * `store/` is what gets pasted into the dashboard; `docs/` is what the URLs serve, published from this
 * repository by GitHub Pages (`Settings → Pages → main /docs`). Two directories because they have two
 * audiences: the reviewer reads both, the user only reads the second.
 */
export const LISTING_FILES = [
  'store/single-purpose.md',
  'store/listing.md',
  'store/permissions.md',
  'docs/privacy.md',
  'docs/support.md',
];


/**
 * The graphic assets the dashboard requires, per locale, and the size it requires them at.
 *
 * Screenshots ARE localizable (the small promo tile and the marquee are not), and ours differ by more
 * than language: the widget answers in the user's language, and the stores a Korean shopper compares are
 * not the ones an English shopper does. So each locale gets its own live capture.
 *
 * Sizes are read out of the PNG header rather than trusted: a capture taken at whatever window a
 * developer had open looks identical in a file listing and is refused at upload.
 */
export const LISTING_ASSETS = ['1-comparison.png', '2-refine.png', '3-choices.png', '4-cart.png'];
/**
 * Only `ko` today, and the reason is a product fact rather than an omission: the window the screenshots
 * show is Korean BY CONSTRUCTION. Measured 2026-08-26 — 87 lines of Korean string literals across the
 * renderers (`45_offer_view` 60, `54_comparison` 24, `55_offers` 3): store names, the shipping and
 * rating labels, the folded-row note, every refusal sentence. An English request today produces an
 * English reply around a Korean window, so an `en` capture would misrepresent the product rather than
 * localize it. The mechanism stays per-locale so the set can be added the day the renderer is.
 */
export const LISTING_ASSET_LOCALES = ['ko'];

/**
 * The one required asset that is not a screenshot. The store asks for brand rather than a shrunken
 * screenshot and says **avoid text**; `tools/store-tile.mjs` draws it from geometry with no font, so that
 * rule holds by construction and the tile can be regenerated (`npm run build:tile`).
 */
export const LISTING_TILE = { path: 'store/assets/tile-small.png', width: 440, height: 280 };
const ASSET_WIDTH = 1280;
const ASSET_HEIGHT = 800;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function assertListingAssets(root) {
  for (const locale of LISTING_ASSET_LOCALES) {
    for (const file of LISTING_ASSETS) {
      const relative = `store/assets/${locale}/${file}`;
      let bytes;
      try {
        bytes = readFileSync(join(root, 'store', 'assets', locale, file));
      } catch {
        throw new Error(`listing screenshot is missing: ${relative}`);
      }
      if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error(`${relative} is not a PNG`);
      }
      const width = bytes.readUInt32BE(16);
      const height = bytes.readUInt32BE(20);
      if (width !== ASSET_WIDTH || height !== ASSET_HEIGHT) {
        throw new Error(`${relative} is ${width}x${height}, and the store takes ${ASSET_WIDTH}x${ASSET_HEIGHT}`);
      }
    }
  }

  let tile;
  try {
    tile = readFileSync(join(root, LISTING_TILE.path));
  } catch {
    throw new Error(`promotional tile is missing: ${LISTING_TILE.path}`);
  }
  if (tile.length < 24 || !tile.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${LISTING_TILE.path} is not a PNG`);
  }
  const tileWidth = tile.readUInt32BE(16);
  const tileHeight = tile.readUInt32BE(20);
  if (tileWidth !== LISTING_TILE.width || tileHeight !== LISTING_TILE.height) {
    throw new Error(`${LISTING_TILE.path} is ${tileWidth}x${tileHeight}, and the store takes ${LISTING_TILE.width}x${LISTING_TILE.height}`);
  }
}

/**
 * Both languages on every dashboard surface.
 *
 * The reviewer reads the single purpose, the permission justifications and the privacy policy, and reads
 * them in English; the users this product is built for read Korean. A surface that exists in one language
 * is one someone improvises a translation for at submission time, which is exactly when it is worst.
 *
 * Matched on headings rather than by guessing at language: a file states which halves it carries.
 */
const ENGLISH_HEADING = '## English';
const KOREAN_HEADING = '## 한국어';

export function assertBilingualCopy(root) {
  for (const file of LISTING_FILES) {
    let text;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      throw new Error(`listing surface is missing: ${file}`);
    }
    if (!text.includes(ENGLISH_HEADING)) throw new Error(`${file} has no English section (${ENGLISH_HEADING})`);
    if (!text.includes(KOREAN_HEADING)) throw new Error(`${file} has no Korean section (${KOREAN_HEADING})`);
  }
}

/** A line a person still has to answer. Countable on purpose — see `outstandingConfirmations`. */
const CONFIRM = 'BIZ-CONFIRM';

export function assertListingStructure(root) {
  for (const file of LISTING_FILES) {
    let text;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      throw new Error(`listing surface is missing: ${file}`);
    }
    if (text.trim() === '') throw new Error(`listing surface is empty: ${file}`);
  }
}

/**
 * The lines still waiting on someone. A privacy page that cannot yet state a backend retention period is
 * honest; one that quietly invents it is not. So placeholders are allowed to exist and are counted, and
 * "ready to submit" becomes a number rather than an opinion.
 */
export function outstandingConfirmations(root) {
  const outstanding = [];
  for (const file of LISTING_FILES) {
    let text;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue;
    }
    text.split(/\r?\n/).forEach((line, index) => {
      if (!line.includes(CONFIRM)) return;
      outstanding.push({ file, line: index + 1, text: line.trim() });
    });
  }
  return outstanding;
}

export function assertSubmissionReady(root) {
  const outstanding = outstandingConfirmations(root);
  if (outstanding.length === 0) return;
  const lines = outstanding.map((entry) => `${entry.file}:${entry.line}`).join(', ');
  throw new Error(`${outstanding.length} listing answer(s) still outstanding: ${lines}`);
}

if (process.argv[1] && (await import('node:url')).fileURLToPath(import.meta.url) === (await import('node:path')).resolve(process.argv[1])) {
  const root = (await import('node:path')).resolve((await import('node:url')).fileURLToPath(new URL('.', import.meta.url)), '..');
  assertListingStructure(root);
  assertListingAssets(root);
  assertBilingualCopy(root);
  const outstanding = outstandingConfirmations(root);
  console.log(`LISTING OK ${LISTING_FILES.length} surfaces`);
  // Reported, never fatal: a page waiting on a retention answer is honest, and a permanently red gate
  // is one nobody reads. `--submission` is the switch that makes it fatal, for the day of the upload.
  for (const entry of outstanding) console.log(`  outstanding ${entry.file}:${entry.line}`);
  if (outstanding.length > 0) {
    console.log(`  ${outstanding.length} answer(s) still needed before submitting`);
    if (process.argv.includes('--submission')) {
      assertSubmissionReady(root);
    }
  }
}