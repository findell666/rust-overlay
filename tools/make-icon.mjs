// Draws the application icon and packs it into assets/icon.ico (plus a PNG for the docs).
//
// Generated rather than committed as a binary blob nobody can edit: the shapes are a few
// distance functions, so the icon can be tweaked in a line and rebuilt. Everything is drawn
// at 4x and box-filtered down, which is what keeps the curves clean at 16 px.
//
//   node tools/make-icon.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, '..', 'assets');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4; // supersampling factor

// The app's own palette: the rust orange of the panels, the green of the aim dot.
const INK = [0x18, 0x16, 0x15];
const INK_TOP = [0x2a, 0x26, 0x24];
const EDGE = [0x45, 0x3d, 0x3a];
const ORANGE = [0xce, 0x42, 0x2b];
const ORANGE_TOP = [0xe5, 0x5e, 0x40];
const DOT = [0x33, 0xff, 0x99];

const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Signed distance to a rounded square of half-extent `h` and corner radius `r`. */
function roundedBox(u, v, h, r) {
  const dx = Math.abs(u) - (h - r);
  const dy = Math.abs(v) - (h - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(dx, dy), 0) - r;
}

/**
 * Colour and coverage at one point of the icon, in coordinates where the canvas spans
 * -1..1 on both axes.
 */
function sample(u, v) {
  const plate = roundedBox(u, v, 0.98, 0.30);
  if (plate > 0) return null; // outside the tile: transparent

  const vertical = (v + 1) / 2;
  let colour = mix(INK_TOP, INK, vertical);

  // A hairline edge, so the icon keeps its shape on a light background too.
  if (plate > -0.055) colour = mix(colour, EDGE, 0.85);

  const d = Math.sqrt(u * u + v * v);
  const reticle = mix(ORANGE_TOP, ORANGE, vertical);

  // Ring, cut by four gaps on the diagonals — a reticle, not a target.
  const angle = Math.atan2(v, u);
  const wedge = Math.abs(((angle % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2) - Math.PI / 4);
  const inGap = wedge > Math.PI / 4 - 0.30;
  if (d > 0.50 && d < 0.655 && !inGap) return reticle;

  // Four ticks along the axes, reaching in towards the centre but stopping short of it.
  const arm = 0.072;
  if ((Math.abs(v) < arm && Math.abs(u) > 0.24 && Math.abs(u) < 0.86) ||
      (Math.abs(u) < arm && Math.abs(v) > 0.24 && Math.abs(v) < 0.86)) {
    return reticle;
  }

  // The aim dot itself.
  if (d < 0.15) return DOT;

  return colour;
}

function render(size) {
  const n = size * SS;
  const png = new PNG({ width: size, height: size });

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = ((x * SS + sx + 0.5) / n) * 2 - 1;
          const v = ((y * SS + sy + 0.5) / n) * 2 - 1;
          const hit = sample(u, v);
          if (!hit) continue;
          r += hit[0];
          g += hit[1];
          b += hit[2];
          a += 1;
        }
      }

      const i = (y * size + x) * 4;
      const total = SS * SS;
      // Premultiplied average, so the edge fades out instead of darkening.
      png.data[i] = a ? Math.round(r / a) : 0;
      png.data[i + 1] = a ? Math.round(g / a) : 0;
      png.data[i + 2] = a ? Math.round(b / a) : 0;
      png.data[i + 3] = Math.round((a / total) * 255);
    }
  }

  return PNG.sync.write(png);
}

/** ICO container holding PNG-compressed entries, which Windows has read since Vista. */
function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  let offset = header.length;
  images.forEach(({ size, data }, index) => {
    const at = 6 + index * 16;
    header.writeUInt8(size >= 256 ? 0 : size, at); // 0 means 256
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt8(0, at + 2); // palette size
    header.writeUInt8(0, at + 3); // reserved
    header.writeUInt16LE(1, at + 4); // colour planes
    header.writeUInt16LE(32, at + 6); // bits per pixel
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });

  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

mkdirSync(ASSETS, { recursive: true });

const images = SIZES.map((size) => ({ size, data: render(size) }));
writeFileSync(join(ASSETS, 'icon.ico'), ico(images));
writeFileSync(join(ASSETS, 'icon.png'), images[images.length - 1].data);
writeFileSync(join(ASSETS, 'icon-512.png'), render(512));

console.log(`assets/icon.ico  — ${SIZES.join(', ')} px`);
console.log('assets/icon.png  — 256 px');
console.log('assets/icon-512.png');
