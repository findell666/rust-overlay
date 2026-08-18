// Measures the one thing that wrecked recognition in game: the stack count Rust burns into
// the corner of a slot.
//
// It renders a slot the way the game draws it, paints a realistic "x650" over the icon, then
// scores the item three ways — no text at all, text left in, text located and blanked. The
// gap between the last two is exactly what the masking in recognize.js buys.
//
//   node tools/simulate-counts.mjs [samples]

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';
import { iconsDir } from './rust-dir.mjs';

const require = createRequire(import.meta.url);
const { fingerprint, shapeDistance, colourDistance } = require('../src/shared/fingerprint.js');

// quantity.js is a browser script that hangs itself on globalThis. Only read() needs a
// canvas (for the glyph templates); segment()/textBounds() are pure pixel maths, which is
// what this tool exercises.
require('../src/renderer/quantity.js');
const { textBounds } = globalThis.Quantity;

const HERE = dirname(fileURLToPath(import.meta.url));
const db = JSON.parse(readFileSync(join(HERE, '..', 'data', 'items.json'), 'utf8'));
const ICONS = iconsDir();

const COLOUR_WEIGHT = 0.06;
const SLOT = 128; // a real slot at 1440p: the inventory zone is 767 px over 6 columns
const INSET = 0.14;
const COUNT_REGION = { x: 0.34, y: 0.58, w: 0.66, h: 0.42 };

const BACKGROUNDS = [
  [44, 42, 40],
  [58, 54, 50],
  [40, 90, 140],
];

let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

// 5x7 glyphs, enough to produce separate blobs of the right proportions.
const FONT = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00110', '00001', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  x: ['00000', '00000', '10001', '01010', '00100', '01010', '10001'],
};

function renderSlot(iconFile, padding, background) {
  const png = PNG.sync.read(readFileSync(join(ICONS, iconFile)));
  const cell = new Uint8ClampedArray(SLOT * SLOT * 4);

  const bleedPhaseX = rand() * 6;
  const bleedPhaseY = rand() * 6;
  const bleedAmp = 10 + rand() * 26;

  for (let y = 0; y < SLOT; y++) {
    for (let x = 0; x < SLOT; x++) {
      const i = (y * SLOT + x) * 4;
      const shade = (y / SLOT) * 14 - 7 + (rand() * 6 - 3);
      const edge = x === 0 || y === 0 || x === SLOT - 1 || y === SLOT - 1 ? 22 : 0;
      const bleed =
        bleedAmp *
        Math.sin(bleedPhaseX + (x / SLOT) * 2.2) *
        Math.cos(bleedPhaseY + (y / SLOT) * 1.7);

      cell[i] = background[0] + shade + edge + bleed * 1.3;
      cell[i + 1] = background[1] + shade + edge + bleed * 0.7;
      cell[i + 2] = background[2] + shade + edge + bleed * 0.5;
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

/** Near-white glyphs with the dark outline the game draws, right-aligned along the bottom. */
function paintCount(cell, text, scale) {
  const gw = 5 * scale;
  const gh = 7 * scale;
  const gap = scale;
  const width = text.length * gw + (text.length - 1) * gap;
  let x0 = SLOT - 6 - width;
  const y0 = SLOT - 6 - gh;

  const put = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= SLOT || y >= SLOT) return;
    const i = (y * SLOT + x) * 4;
    cell[i] = r;
    cell[i + 1] = g;
    cell[i + 2] = b;
  };

  for (const glyph of text) {
    const rows = FONT[glyph];
    for (let ry = 0; ry < 7; ry++) {
      for (let rx = 0; rx < 5; rx++) {
        if (rows[ry][rx] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = x0 + rx * scale + sx;
            const py = y0 + ry * scale + sy;
            for (let oy = -1; oy <= 1; oy++) {
              for (let ox = -1; ox <= 1; ox++) put(px + ox, py + oy, 12, 12, 12);
            }
          }
        }
      }
    }
    for (let ry = 0; ry < 7; ry++) {
      for (let rx = 0; rx < 5; rx++) {
        if (rows[ry][rx] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            put(x0 + rx * scale + sx, y0 + ry * scale + sy, 238, 235, 228);
          }
        }
      }
    }
    x0 += gw + gap;
  }
}

/** Crop exactly as recognize.js does before fingerprinting. */
function sub(rgba, size, x0, y0, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * size + x0 + x) * 4;
      const d = (y * w + x) * 4;
      out[d] = rgba[s];
      out[d + 1] = rgba[s + 1];
      out[d + 2] = rgba[s + 2];
      out[d + 3] = rgba[s + 3];
    }
  }
  return out;
}

function rankOf(print, shortname) {
  const scored = db.items
    .map((item) => ({
      shortname: item.shortname,
      distance:
        shapeDistance(print.thumb, item.thumb) +
        COLOUR_WEIGHT * colourDistance(print.colour, item.colour),
    }))
    .sort((a, b) => a.distance - b.distance);
  return {
    rank: scored.findIndex((s) => s.shortname === shortname),
    best: scored[0],
    margin: scored[1].distance - scored[0].distance,
    lead: (scored[1].distance - scored[0].distance) / Math.max(0.5, scored[0].distance),
  };
}

const samples = Number(process.argv[2] ?? 200);
const withIcons = db.items.filter((item) => item.icon);
const TEXTS = ['x2', 'x10', 'x16', 'x64', 'x100', 'x650', 'x1000'];

const off = Math.round(SLOT * INSET);
const side = SLOT - 2 * off;
const cx = Math.round(SLOT * COUNT_REGION.x);
const cy = Math.round(SLOT * COUNT_REGION.y);
const cw = Math.round(SLOT * COUNT_REGION.w);
const ch = Math.round(SLOT * COUNT_REGION.h);

const score = { clean: 0, raw: 0, masked: 0, rawTop3: 0, maskedTop3: 0, located: 0 };
const hits = [];
const misses = [];

for (let n = 0; n < samples; n++) {
  const item = withIcons[Math.floor(rand() * withIcons.length)];
  const padding = 0.06 + rand() * 0.12;
  const background = BACKGROUNDS[Math.floor(rand() * BACKGROUNDS.length)];
  const text = TEXTS[Math.floor(rand() * TEXTS.length)];

  let cell;
  try {
    cell = renderSlot(item.icon, padding, background);
  } catch {
    continue; // icon missing from the install
  }

  const clean = rankOf(fingerprint(sub(cell, SLOT, off, off, side, side), side, side), item.shortname);
  paintCount(cell, text, 3);

  const crop = sub(cell, SLOT, off, off, side, side);
  const raw = rankOf(fingerprint(crop, side, side), item.shortname);

  // Exactly the path recognize.js takes: locate the text in the strip, blank it, re-measure.
  const strip = { data: sub(cell, SLOT, cx, cy, cw, ch), width: cw, height: ch };
  const box = textBounds(strip);

  let ignore = null;
  if (box) {
    score.located++;
    ignore = new Uint8Array(side * side);
    for (let y = box.y - 2; y < box.y + box.h + 2; y++) {
      for (let x = box.x - 2; x < box.x + box.w + 2; x++) {
        const gx = cx + x - off;
        const gy = cy + y - off;
        if (gx < 0 || gy < 0 || gx >= side || gy >= side) continue;
        ignore[gy * side + gx] = 1;
      }
    }
  }
  const masked = rankOf(fingerprint(crop, side, side, { ignore }), item.shortname);

  if (masked.rank === 0) hits.push(masked.lead);
  else misses.push(masked.lead);
  if (clean.rank === 0) score.clean++;
  if (raw.rank === 0) score.raw++;
  if (masked.rank === 0) score.masked++;
  if (raw.rank >= 0 && raw.rank < 3) score.rawTop3++;
  if (masked.rank >= 0 && masked.rank < 3) score.maskedTop3++;
}

const pct = (n) => `${((n / samples) * 100).toFixed(1)} %`;
console.log(`${samples} slots de ${SLOT}px, comptes "x2".."x1000"\n`);
console.log(`texte localisé          ${pct(score.located)}`);
console.log(`top-1 sans compte       ${pct(score.clean)}   (plafond : ce que vaut le matcher)`);
console.log(`top-1 compte non masqué ${pct(score.raw)}`);
console.log(`top-1 compte masqué     ${pct(score.masked)}`);
console.log(`top-3 compte non masqué ${pct(score.rawTop3)}`);
console.log(`top-3 compte masqué     ${pct(score.maskedTop3)}`);

const quantile = (list, q) => {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]?.toFixed(1);
};
console.log(`\navance relative, bon match : médiane ${quantile(hits, 0.5)}  p10 ${quantile(hits, 0.1)}  p05 ${quantile(hits, 0.05)}`);
console.log(`avance relative, faux      : médiane ${quantile(misses, 0.5)}  p90 ${quantile(misses, 0.9)}`);
for (const t of [0.15, 0.2, 0.25, 0.3]) {
  console.log(`  seuil ${t}: perd ${hits.filter((m) => m < t).length}/${hits.length} bons · rejette ${misses.filter((m) => m < t).length}/${misses.length} faux`);
}
