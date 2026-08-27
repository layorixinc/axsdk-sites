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