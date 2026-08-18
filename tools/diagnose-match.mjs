// Renders, side by side, what the matcher extracts from a reference icon and from a
// simulated in-game slot of the same item. If the two thumbnails do not look alike, the
// fault is in the mask or the bounds — not in the comparison.
//
//   node tools/diagnose-match.mjs sewingkit gears riflebody

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';
import { iconsDir } from './rust-dir.mjs';

const require = createRequire(import.meta.url);
const fp = require('../src/shared/fingerprint.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const db = JSON.parse(readFileSync(join(HERE, '..', 'data', 'items.json'), 'utf8'));
const ICONS = iconsDir();
const OUT = process.env.DIAG_OUT ?? join(HERE, '..', 'diagnose.png');

const SLOT = 64;
const INSET = 0.14;

let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

function renderSlot(iconFile, padding = 0.12) {
  const png = PNG.sync.read(readFileSync(join(ICONS, iconFile)));
  const cell = new Uint8ClampedArray(SLOT * SLOT * 4);
  const bg = [44, 42, 40];

  for (let y = 0; y < SLOT; y++) {
    for (let x = 0; x < SLOT; x++) {
      const i = (y * SLOT + x) * 4;
      const shade = (y / SLOT) * 14 - 7 + (rand() * 6 - 3);
      const edge = x === 0 || y === 0 || x === SLOT - 1 || y === SLOT - 1 ? 22 : 0;
      cell[i] = bg[0] + shade + edge;
      cell[i + 1] = bg[1] + shade + edge;
      cell[i + 2] = bg[2] + shade + edge;
      cell[i + 3] = 255;
    }
  }

  const inner = Math.round(SLOT * (1 - 2 * padding));
  const offset = Math.round((SLOT - inner) / 2);
  for (let y = 0; y < inner; y++) {
    for (let x = 0; x < inner; x++) {
      const sx = Math.min(png.width - 1, Math.floor((x * png.width) / inner));
      const sy = Math.min(png.height - 1, Math.floor((y * png.height) / inner));
      const s = (sy * png.width + sx) * 4;
      const a = png.data[s + 3] / 255;
      if (a === 0) continue;
      const d = ((y + offset) * SLOT + x + offset) * 4;
      cell[d] = png.data[s] * a + cell[d] * (1 - a);
      cell[d + 1] = png.data[s + 1] * a + cell[d + 1] * (1 - a);
      cell[d + 2] = png.data[s + 2] * a + cell[d + 2] * (1 - a);
    }
  }

  return cell;
}

/** Crop the way recognize.js does before fingerprinting. */
function applyInset(rgba, size, inset) {
  const off = Math.round(size * inset);
  const side = size - 2 * off;
  const out = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const s = ((y + off) * size + x + off) * 4;
      const d = (y * side + x) * 4;
      out[d] = rgba[s];
      out[d + 1] = rgba[s + 1];
      out[d + 2] = rgba[s + 2];
      out[d + 3] = rgba[s + 3];
    }
  }
  return { rgba: out, size: side };
}

/** Turn a stored descriptor back into a visible 16x16 patch. */
function thumbToPixels(thumb) {
  let min = Infinity;
  let max = -Infinity;
  for (const v of thumb) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  return thumb.map((v) => Math.round(((v - min) / span) * 255));
}

const names = process.argv.slice(2);
if (!names.length) names.push('sewingkit', 'gears', 'riflebody', 'stones');

const CELL = 64;
const COLS = 3; // reference thumb | simulated thumb | difference
const sheet = new PNG({ width: CELL * COLS, height: CELL * names.length });

names.forEach((shortname, rowIndex) => {
  const item = db.items.find((i) => i.shortname === shortname);
  if (!item) return console.log(`${shortname}: absent de l'index`);

  const png = PNG.sync.read(readFileSync(join(ICONS, item.icon)));
  const refMask = fp.fingerprint(png.data, png.width, png.height);

  const slot = renderSlot(item.icon);
  const cropped = applyInset(slot, SLOT, INSET);
  const capMask = fp.fingerprint(cropped.rgba, cropped.size, cropped.size);

  const distance = fp.shapeDistance(refMask.thumb, capMask.thumb);
  console.log(
    `${shortname.padEnd(14)} distance ${distance.toFixed(2).padStart(6)}` +
      `  ref fill ${refMask.fill}  capture fill ${capMask.fill}` +
      `  ref var ${refMask.variance}  capture var ${capMask.variance}`
  );

  const a = thumbToPixels(refMask.thumb);
  const b = thumbToPixels(capMask.thumb);

  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const tx = Math.floor((x * 16) / CELL);
      const ty = Math.floor((y * 16) / CELL);
      const idx = ty * 16 + tx;
      const put = (col, value) => {
        const d = ((rowIndex * CELL + y) * CELL * COLS + col * CELL + x) * 4;
        sheet.data[d] = value;
        sheet.data[d + 1] = value;
        sheet.data[d + 2] = value;
        sheet.data[d + 3] = 255;
      };
      put(0, a[idx]);
      put(1, b[idx]);
      put(2, Math.abs(a[idx] - b[idx]));
    }
  }
});

writeFileSync(OUT, PNG.sync.write(sheet));
console.log(`\ncolonnes : référence | capture simulée | différence\nécrit ${OUT}`);
