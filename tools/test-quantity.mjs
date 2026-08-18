// Exercises the stack-count reader end to end, with the glyph templates stubbed out.
//
// quantity.js renders its templates with a real font through a canvas, which Node does not
// have. The stub below draws the same 5x7 shapes the harness paints into the slot, so this
// checks the parts that actually broke — blob segmentation, alignment filtering, splitting a
// merged pair, and parsing — rather than font tolerance, which only the game can settle.
//
//   node tools/test-quantity.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';
import { iconsDir } from './rust-dir.mjs';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const db = JSON.parse(readFileSync(join(HERE, '..', 'data', 'items.json'), 'utf8'));
const ICONS = iconsDir();

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

/** Minimal canvas: solid fills and one centred glyph, which is all buildTemplates asks for. */
globalThis.document = {
  createElement() {
    let w = 0;
    let h = 0;
    let data = null;
    const ctx = {
      fillStyle: '#000',
      font: '',
      textBaseline: '',
      textAlign: '',
      fillRect(x, y, rw, rh) {
        const v = ctx.fillStyle === '#000' ? 0 : 255;
        for (let py = y; py < y + rh; py++) {
          for (let px = x; px < x + rw; px++) {
            const i = (py * w + px) * 4;
            data[i] = v;
            data[i + 1] = v;
            data[i + 2] = v;
            data[i + 3] = 255;
          }
        }
      },
      fillText(text, cx, cy) {
        const scale = 5;
        const x0 = Math.round(cx - (5 * scale) / 2);
        const y0 = Math.round(cy - (7 * scale) / 2);
        const rows = FONT[text];
        if (!rows) return;
        for (let ry = 0; ry < 7; ry++) {
          for (let rx = 0; rx < 5; rx++) {
            if (rows[ry][rx] !== '1') continue;
            for (let sy = 0; sy < scale; sy++) {
              for (let sx = 0; sx < scale; sx++) {
                const i = ((y0 + ry * scale + sy) * w + x0 + rx * scale + sx) * 4;
                data[i] = 255;
                data[i + 1] = 255;
                data[i + 2] = 255;
                data[i + 3] = 255;
              }
            }
          }
        }
      },
      getImageData: (x, y, gw, gh) => ({ data, width: gw, height: gh }),
      putImageData() {},
    };
    return {
      set width(value) {
        w = value;
        data = new Uint8ClampedArray(w * (h || value) * 4);
      },
      get width() {
        return w;
      },
      set height(value) {
        h = value;
        data = new Uint8ClampedArray((w || value) * h * 4);
      },
      get height() {
        return h;
      },
      getContext: () => ctx,
    };
  },
};

require('../src/renderer/quantity.js');
const { read } = globalThis.Quantity;

const W = 84;
const H = 54;

/** A count strip: a slice of a real icon, with the count painted over it. */
function strip(iconFile, text, scale, gap) {
  const data = new Uint8ClampedArray(W * H * 4);
  const png = PNG.sync.read(readFileSync(join(ICONS, iconFile)));

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = Math.min(png.width - 1, Math.floor((x * png.width) / W));
      const sy = Math.min(png.height - 1, Math.floor(((y + H) * png.height) / (H * 2)));
      const s = (sy * png.width + sx) * 4;
      const a = png.data[s + 3] / 255;
      const i = (y * W + x) * 4;
      data[i] = png.data[s] * a + 42 * (1 - a);
      data[i + 1] = png.data[s + 1] * a + 40 * (1 - a);
      data[i + 2] = png.data[s + 2] * a + 38 * (1 - a);
      data[i + 3] = 255;
    }
  }

  const gw = 5 * scale;
  let x0 = W - 4 - (text.length * gw + (text.length - 1) * gap);
  const y0 = H - 4 - 7 * scale;

  const put = (x, y, v) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    data[i] = v;
    data[i + 1] = v - 3;
    data[i + 2] = v - 10;
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
              for (let ox = -1; ox <= 1; ox++) put(px + ox, py + oy, 14);
            }
          }
        }
      }
    }
    for (let ry = 0; ry < 7; ry++) {
      for (let rx = 0; rx < 5; rx++) {
        if (rows[ry][rx] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) put(x0 + rx * scale + sx, y0 + ry * scale + sy, 240);
        }
      }
    }
    x0 += gw + gap;
  }

  return { data, width: W, height: H };
}

// A pale icon behind the text is the hard case: animal fat and stone are why the previous
// reader gave up on every slot in the inventory.
const BACKDROPS = ['fat.animal.png', 'stones.png', 'wood.png', 'metal.fragments.png'];

const CASES = [
  ['x2', 3, 2],
  ['x10', 3, 2],
  ['x16', 3, 2],
  ['x64', 3, 2],
  ['x100', 3, 2],
  ['x650', 3, 2],
  ['x1000', 3, 1],
  ['x25', 4, 2],
  ['x999', 2, 2],
  ['x10', 3, 0], // glyphs touching: must be split back apart
];

let pass = 0;
let total = 0;

for (const backdrop of BACKDROPS) {
  let icon = backdrop;
  try {
    readFileSync(join(ICONS, icon));
  } catch {
    icon = db.items.find((i) => i.icon)?.icon;
  }

  for (const [text, scale, gap] of CASES) {
    total++;
    const expected = Number(text.slice(1));
    const got = read(strip(icon, text, scale, gap));
    const ok = got?.value === expected;
    if (ok) pass++;
    else console.log(`  ÉCHEC ${backdrop.padEnd(20)} ${text} (échelle ${scale}, espace ${gap}) → ${got ? `${got.text} = ${got.value}` : 'illisible'}`);
  }
}

console.log(`\n${pass}/${total} lectures correctes`);
process.exitCode = pass === total ? 0 : 1;
