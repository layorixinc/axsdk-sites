/**
 * The 440x280 promotional tile, drawn from geometry.
 *
 * The store's rules for this asset are unusually specific: *"Don't just use a screenshot; your images
 * should primarily communicate the brand"*, **avoid text**, fill the entire region, well-defined edges,
 * saturated colours, and not a lot of white or light grey
 * (<https://developer.chrome.com/docs/webstore/images>).
 *
 * So there is no font here and no browser: a renderer with no glyphs cannot violate the text rule, and a
 * deterministic one can be regenerated and reviewed like any other source. The brand is the extension's
 * own icon — indigo, a white cursor, a four-pointed sparkle — and the motif is the product's one visible
 * idea: a short list of offers where the total decides, one of them chosen.
 *
 * Drawn at 4x and box-downsampled, which is where the anti-aliasing comes from.
 */

import { deflateSync } from 'node:zlib';

export const TILE_WIDTH = 440;
export const TILE_HEIGHT = 280;
const SCALE = 4;

const BRAND = [0x4b, 0x44, 0xe8];
const BRAND_DEEP = [0x2b, 0x25, 0xa8];
const ROW = [0xff, 0xff, 0xff, 0.16];
const ROW_CHOSEN = [0xff, 0xff, 0xff, 0.92];
// Two accents for the two unchosen rows; the chosen row takes the deep brand colour instead.
const DOTS = [[0xff, 0xb3, 0x2b], [0x2b, 0xd6, 0xff]];

const lerp = (from, to, t) => from + (to - from) * t;

function canvas(width, height) {
  const pixels = new Float64Array(width * height * 3);
  return {
    width,
    height,
    pixels,
    set(x, y, [r, g, b]) {
      const index = (y * width + x) * 3;
      pixels[index] = r;
      pixels[index + 1] = g;
      pixels[index + 2] = b;
    },
    blend(x, y, [r, g, b, alpha = 1]) {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const index = (y * width + x) * 3;
      pixels[index] = lerp(pixels[index], r, alpha);
      pixels[index + 1] = lerp(pixels[index + 1], g, alpha);
      pixels[index + 2] = lerp(pixels[index + 2], b, alpha);
    },
  };
}

/** Diagonal brand gradient, corner to corner, so the tile is never flat and never light. */
function background(image) {
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const t = (x / image.width + y / image.height) / 2;
      image.set(x, y, [
        lerp(BRAND[0], BRAND_DEEP[0], t),
        lerp(BRAND[1], BRAND_DEEP[1], t),
        lerp(BRAND[2], BRAND_DEEP[2], t),
      ]);
    }
  }
}

function roundedRect(image, left, top, width, height, radius, colour) {
  for (let y = Math.floor(top); y < Math.ceil(top + height); y += 1) {
    for (let x = Math.floor(left); x < Math.ceil(left + width); x += 1) {
      const dx = Math.max(left + radius - x, x - (left + width - radius), 0);
      const dy = Math.max(top + radius - y, y - (top + height - radius), 0);
      if (dx * dx + dy * dy <= radius * radius) image.blend(x, y, colour);
    }
  }
}

function disc(image, cx, cy, radius, colour) {
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y += 1) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= radius * radius) image.blend(x, y, colour);
    }
  }
}

function polygon(image, points, colour) {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y += 1) {
    for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x += 1) {
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
        const [xi, yi] = points[i];
        const [xj, yj] = points[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) image.blend(x, y, colour);
    }
  }
}

/** The extension's own mark: a cursor with a sparkle at its shoulder. */
function brandMark(image, x, y, size) {
  const s = size / 100;
  polygon(image, [
    [x, y],
    [x + 52 * s, y + 50 * s],
    [x + 30 * s, y + 54 * s],
    [x + 43 * s, y + 86 * s],
    [x + 29 * s, y + 92 * s],
    [x + 16 * s, y + 60 * s],
  ], [0xff, 0xff, 0xff, 0.96]);
  const cx = x + 74 * s;
  const cy = y + 20 * s;
  const long = 26 * s;
  const short = 7 * s;
  polygon(image, [
    [cx, cy - long], [cx + short, cy - short], [cx + long, cy],
    [cx + short, cy + short], [cx, cy + long], [cx - short, cy + short],
    [cx - long, cy], [cx - short, cy - short],
  ], [0xff, 0xff, 0xff, 0.96]);
}

function png(image) {
  const raw = Buffer.alloc(image.height * (image.width * 4 + 1));
  let at = 0;
  for (let y = 0; y < image.height; y += 1) {
    raw[at] = 0;
    at += 1;
    for (let x = 0; x < image.width; x += 1) {
      const index = (y * image.width + x) * 3;
      raw[at] = Math.max(0, Math.min(255, Math.round(image.pixels[index])));
      raw[at + 1] = Math.max(0, Math.min(255, Math.round(image.pixels[index + 1])));
      raw[at + 2] = Math.max(0, Math.min(255, Math.round(image.pixels[index + 2])));
      raw[at + 3] = 255;
      at += 4;
    }
  }

  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  const crc = (bytes) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, body) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length, 0);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(typed), 0);
    return Buffer.concat([head, typed, tail]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function renderSmallTile() {
  const big = canvas(TILE_WIDTH * SCALE, TILE_HEIGHT * SCALE);
  background(big);
  // Everything below is written in tile coordinates and multiplied once, here.
  const s = (value) => value * SCALE;
  offerRowsScaled(big, s);
  brandMark(big, s(262), s(92), s(146));

  const out = canvas(TILE_WIDTH, TILE_HEIGHT);
  for (let y = 0; y < TILE_HEIGHT; y += 1) {
    for (let x = 0; x < TILE_WIDTH; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < SCALE; dy += 1) {
        for (let dx = 0; dx < SCALE; dx += 1) {
          const index = ((y * SCALE + dy) * big.width + (x * SCALE + dx)) * 3;
          r += big.pixels[index];
          g += big.pixels[index + 1];
          b += big.pixels[index + 2];
        }
      }
      const area = SCALE * SCALE;
      out.set(x, y, [r / area, g / area, b / area]);
    }
  }
  return png(out);
}

/**
 * Three offer rows, the shortest of them chosen — the product's whole idea without a word: several
 * candidates, one total that wins.
 */
function offerRowsScaled(image, s) {
  const widths = [232, 196, 150];
  for (let index = 0; index < widths.length; index += 1) {
    const top = s(78 + index * 54);
    const chosen = index === widths.length - 1;
    roundedRect(image, s(46), top, s(widths[index]), s(34), s(17), chosen ? ROW_CHOSEN : ROW);
    disc(image, s(63), top + s(17), s(9), chosen ? [...BRAND_DEEP, 1] : [...DOTS[index], 0.95]);
  }
}


if (process.argv[1] && (await import('node:url')).fileURLToPath(import.meta.url)
  === (await import('node:path')).resolve(process.argv[1])) {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { dirname, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const out = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'store', 'assets', 'tile-small.png');
  mkdirSync(dirname(out), { recursive: true });
  const bytes = renderSmallTile();
  writeFileSync(out, bytes);
  console.log(`TILE ${out} ${TILE_WIDTH}x${TILE_HEIGHT} ${(bytes.length / 1024).toFixed(1)} KiB`);
}
