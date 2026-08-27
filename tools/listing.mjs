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
 * The graphic assets the dashboard requires, and the size it requires them at.
 *
 * Read out of the PNG header rather than trusted: a capture taken at whatever window a developer had
 * open looks identical in a file listing and is refused at upload. `tools/scenarios/store-screenshots.mjs`
 * produces these from live turns, so they show what the product actually answers.
 */
export const LISTING_ASSETS = ['1-comparison.png', '2-refine.png', '3-choices.png', '4-cart.png'];
const ASSET_WIDTH = 1280;
const ASSET_HEIGHT = 800;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function assertListingAssets(root) {
  for (const file of LISTING_ASSETS) {
    const path = join(root, 'store', 'assets', file);
    let bytes;
    try {
      bytes = readFileSync(path);
    } catch {
      throw new Error(`listing screenshot is missing: store/assets/${file}`);
    }
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
      throw new Error(`store/assets/${file} is not a PNG`);
    }
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (width !== ASSET_WIDTH || height !== ASSET_HEIGHT) {
      throw new Error(`store/assets/${file} is ${width}x${height}, and the store takes ${ASSET_WIDTH}x${ASSET_HEIGHT}`);
    }
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