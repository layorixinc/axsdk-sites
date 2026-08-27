import assert from 'node:assert/strict';
import test from 'node:test';
import { inflateSync } from 'node:zlib';

import { renderSmallTile, TILE_WIDTH, TILE_HEIGHT } from './store-tile.mjs';

/**
 * The store's own rules for a promotional tile, as checks rather than intentions
 * (<https://developer.chrome.com/docs/webstore/images>): 440x280, brand not screenshot, **avoid text**,
 * fill the entire region, well-defined edges, saturated colours, and not a lot of white or light grey.
 *
 * Text is the one rule a test cannot see, so it is enforced by construction — the renderer has no glyphs
 * and no font, only geometry.
 */

/** Decodes our own PNG back to RGBA rows, so the assertions are about pixels rather than about intent. */
function decode(png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const chunks = [];
  let at = 8;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString('ascii', at + 4, at + 8);
    if (type === 'IDAT') chunks.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    assert.equal(filter, 0, 'the writer emits unfiltered scanlines');
    raw.copy(pixels, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  }
  return { width, height, pixels };
}

const at = (image, x, y) => {
  const index = (y * image.width + x) * 4;
  return [image.pixels[index], image.pixels[index + 1], image.pixels[index + 2], image.pixels[index + 3]];
};

test('the tile is exactly the size the store takes', () => {
  const image = decode(renderSmallTile());
  assert.equal(image.width, TILE_WIDTH);
  assert.equal(image.height, TILE_HEIGHT);
  assert.equal(TILE_WIDTH, 440);
  assert.equal(TILE_HEIGHT, 280);
});

test('it fills the entire region — every corner is opaque brand colour, not padding', () => {
  const image = decode(renderSmallTile());
  for (const [x, y] of [[0, 0], [image.width - 1, 0], [0, image.height - 1], [image.width - 1, image.height - 1]]) {
    const [r, g, b, a] = at(image, x, y);
    assert.equal(a, 255, `corner ${x},${y} must be opaque`);
    assert.ok(r + g + b < 600, `corner ${x},${y} must not be white padding`);
  }
});

test('it is not mostly white or light grey', () => {
  const image = decode(renderSmallTile());
  let light = 0;
  for (let index = 0; index < image.pixels.length; index += 4) {
    const [r, g, b] = [image.pixels[index], image.pixels[index + 1], image.pixels[index + 2]];
    if (r > 200 && g > 200 && b > 200) light += 1;
  }
  const share = light / (image.width * image.height);
  assert.ok(share < 0.25, `light pixels are ${(share * 100).toFixed(1)}% of the tile`);
});

test('the colour is saturated rather than muddy', () => {
  const image = decode(renderSmallTile());
  let saturated = 0;
  for (let index = 0; index < image.pixels.length; index += 4) {
    const channels = [image.pixels[index], image.pixels[index + 1], image.pixels[index + 2]];
    const high = Math.max(...channels);
    const low = Math.min(...channels);
    if (high > 40 && (high - low) / high > 0.4) saturated += 1;
  }
  const share = saturated / (image.width * image.height);
  assert.ok(share > 0.5, `only ${(share * 100).toFixed(1)}% of the tile carries a saturated colour`);
});

/** Half size is where a busy tile falls apart, so the motif has to survive a 2x box downsample. */
test('the motif survives being shrunk to half size', () => {
  const image = decode(renderSmallTile());
  let differing = 0;
  for (let y = 0; y < image.height; y += 2) {
    for (let x = 0; x < image.width; x += 2) {
      const [r] = at(image, x, y);
      const [r2] = at(image, Math.min(x + 1, image.width - 1), Math.min(y + 1, image.height - 1));
      if (Math.abs(r - r2) > 24) differing += 1;
    }
  }
  // Some structure, but not noise: a tile of thin lines would differ almost everywhere.
  const share = differing / ((image.width / 2) * (image.height / 2));
  assert.ok(share > 0.002 && share < 0.2, `edge share at half size is ${(share * 100).toFixed(2)}%`);
});

test('rendering twice produces the same bytes', () => {
  assert.deepEqual(renderSmallTile(), renderSmallTile());
});
