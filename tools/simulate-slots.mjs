// Simulates what the matcher will see in game, and measures whether it finds the item back.
//
// The game does not show a reference PNG: it draws the icon padded inside a slot, over a
// background that is dark, sometimes blue when selected, and never fully opaque. This tool
// reproduces that — random padding, random slot tint, downscale to a realistic slot size —
// then asks the index to identify the result.
//
//   node tools/simulate-slots.mjs [samples]

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';
import { iconsDir } from './rust-dir.mjs';

const require = createRequire(import.meta.url);
const { fingerprint, shapeDistance, colourDistance } = require('../src/shared/fingerprint.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const db = JSON.parse(readFileSync(join(HERE, '..', 'data', 'items.json'), 'utf8'));
const ICONS = iconsDir();

const COLOUR_WEIGHT = Number(process.env.CW ?? 0.06);
const SLOT = 64; // pixels, close to a real inventory slot at 1440p

// Slot fills seen in game: ordinary, hovered, and the blue selection highlight.
const BACKGROUNDS = [
  [44, 42, 40],
  [58, 54, 50],
  [40, 90, 140],
];

// Deterministic pseudo-random, so a regression is reproducible.
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

/**
 * Draw an icon into a SLOT x SLOT cell the way the game does.
 *
 * The background is deliberately *not* flat: a real slot has a vertical gradient, a lighter
 * border, per-pixel noise, a stack count burned into the corner and sometimes a condition
 * bar down the left edge. An earlier version of this tool rendered onto a perfectly uniform
 * colour, scored 84 %, and the same code recognised nothing in game — because the content
 * mask that separates icon from background only works if it survives a noisy background.
 */
function renderSlot(iconFile, padding, background, { stackText = true, conditionBar = false } = {}) {
  const png = PNG.sync.read(readFileSync(join(ICONS, iconFile)));
  const cell = new Uint8ClampedArray(SLOT * SLOT * 4);

  // Rust's inventory is translucent: the world behind it shows through as large, warm,
  // structured shapes, not as a clean gradient. Modelling only fine noise made the content
  // mask look far more reliable than it is.
  const bleedPhaseX = rand() * 6;
  const bleedPhaseY = rand() * 6;
  const bleedAmp = 10 + rand() * 26;

  for (let y = 0; y < SLOT; y++) {
    for (let x = 0; x < SLOT; x++) {
      const i = (y * SLOT + x) * 4;
      const shade = (y / SLOT) * 14 - 7 + (rand() * 6 - 3);
      const edge = x === 0 || y === 0 || x === SLOT - 1 || y === SLOT - 1 ? 22 : 0;
      // Low-frequency warm bleed from the scene behind the panel.
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

  // Stack count in the bottom-right corner: a few bright blocks, like "x16".
  if (stackText) {
    for (let y = SLOT - 14; y < SLOT - 4; y++) {
      for (let x = SLOT - 24; x < SLOT - 4; x++) {
        if ((x + y) % 3 === 0) continue; // rough glyph texture
        const i = (y * SLOT + x) * 4;
        cell[i] = 235;
        cell[i + 1] = 232;
        cell[i + 2] = 225;
      }
    }
  }

  // Condition bar down the left edge, bright green.
  if (conditionBar) {
    for (let y = 2; y < SLOT - 2; y++) {
      for (let x = 1; x < 4; x++) {
        const i = (y * SLOT + x) * 4;
        cell[i] = 120;
        cell[i + 1] = 200;
        cell[i + 2] = 60;
      }
    }
  }

  return cell;
}

/**
 * Crop exactly as recognize.js does before fingerprinting. Leaving this out was itself a
 * bug in this tool: it measured the whole cell, bright frame included, and reported a
 * catastrophic score for code that was in fact fine.
 */
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

const INSET = 0.14;

const score = (print, item) =>
  shapeDistance(print.thumb, item.thumb) + COLOUR_WEIGHT * colourDistance(print.colour, item.colour);

const samples = Number(process.argv[2] ?? 150);
const pool = db.items.filter((i) => i.category !== 'Unknown');

let top1 = 0;
let top3 = 0;
const distances = [];
const failures = [];

for (let n = 0; n < samples; n++) {
  const item = pool[Math.floor(rand() * pool.length)];
  const padding = 0.06 + rand() * 0.14; // 6 % to 20 % of the slot
  const background = BACKGROUNDS[Math.floor(rand() * BACKGROUNDS.length)];

  let cell;
  try {
    cell = renderSlot(item.icon, padding, background, {
      stackText: rand() < 0.5,
      conditionBar: rand() < 0.25,
    });
  } catch {
    continue;
  }

  const cropped = applyInset(cell, SLOT, INSET);
  const print = fingerprint(cropped.rgba, cropped.size, cropped.size);
  const ranked = db.items
    .map((candidate) => ({ candidate, distance: score(print, candidate) }))
    .sort((a, b) => a.distance - b.distance);

  const position = ranked.findIndex((r) => r.candidate.shortname === item.shortname);
  distances.push(ranked[0].distance);

  if (position === 0) top1++;
  else if (position < 3) top3++;
  else failures.push(`${item.shortname} -> ${ranked[0].candidate.shortname} (${ranked[0].distance.toFixed(1)}, rang réel ${position})`);
}

const total = distances.length;
distances.sort((a, b) => a - b);

console.log(`échantillons          : ${total}`);
console.log(`identifié du 1er coup : ${top1} (${((top1 / total) * 100).toFixed(1)} %)`);
console.log(`dans le top 3         : ${top1 + top3} (${(((top1 + top3) / total) * 100).toFixed(1)} %)`);
console.log(`distance médiane      : ${distances[total >> 1].toFixed(2)}`);
console.log(`distance 90e centile  : ${distances[Math.floor(total * 0.9)].toFixed(2)}`);
console.log(`distance max          : ${distances[total - 1].toFixed(2)}`);

if (failures.length) {
  console.log(`\néchecs (${failures.length}) :`);
  for (const f of failures.slice(0, 15)) console.log(`  ${f}`);
}
