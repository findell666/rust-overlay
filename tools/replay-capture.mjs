// Replays a real screen capture through the actual recognition code.
//
// Simulated slots can only be as honest as the assumptions behind them, and those turned
// out to be wrong more than once. This tool removes the guesswork: it reads a PNG the
// overlay itself saved, the zones the user actually calibrated, and reports what the
// matcher makes of each slot — plus a contact sheet of every crop next to the icon it was
// paired with.
//
//   node tools/replay-capture.mjs captures/capture-....png [zoneId]

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';
import { iconsDir } from './rust-dir.mjs';

const require = createRequire(import.meta.url);
const { fingerprint, shapeDistance, colourDistance } = require('../src/shared/fingerprint.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const COLOUR_WEIGHT = 0.06;

// Where Electron keeps the app's config, from either side of WSL.
const CONFIG_CANDIDATES = [
  process.env.OVERLAY_CONFIG,
  join(process.env.APPDATA ?? '', 'rust-overlay', 'config.json'),
  join(process.env.HOME ?? '', '.config', 'rust-overlay', 'config.json'),
  ...(process.env.WSL_DISTRO_NAME && process.env.USER
    ? [`/mnt/c/Users/${process.env.USER}/AppData/Roaming/rust-overlay/config.json`]
    : []),
].filter(Boolean);

function loadConfig() {
  for (const path of CONFIG_CANDIDATES) {
    try {
      return { path, config: JSON.parse(readFileSync(path, 'utf8')) };
    } catch {
      // next
    }
  }
  throw new Error(`config.json introuvable. Cherché dans :\n  ${CONFIG_CANDIDATES.join('\n  ')}`);
}

function newest(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
  if (!files.length) throw new Error(`aucune capture dans ${dir}`);
  return join(dir, files[files.length - 1]);
}

const capturePath = process.argv[2] ?? newest(join(ROOT, 'captures'));
const wantedZone = process.argv[3];

const png = PNG.sync.read(readFileSync(capturePath));
const { path: configPath, config } = loadConfig();
const db = JSON.parse(readFileSync(join(ROOT, 'data', 'items.json'), 'utf8'));

console.log(`capture : ${capturePath}  (${png.width}x${png.height})`);
console.log(`config  : ${configPath}`);

// The capture spans the whole screen, so the profile is whichever one matches its size.
const profiles = Object.keys(config.zones ?? {});
const profile =
  profiles.find((key) => key.startsWith(`${png.width}x${png.height}@`)) ?? profiles[0];
if (!profile) throw new Error('aucune zone calibrée dans la config');

const zones = config.zones[profile];
console.log(`profil  : ${profile}  (zones : ${Object.keys(zones).join(', ')})\n`);

const recognition = config.recognition ?? {};
const inset = recognition.inset ?? 0.14;
const maxDistance = recognition.maxDistance ?? 28;
const emptyVariance = recognition.emptyVariance ?? 6;

/** Extract a rectangle of the capture as a standalone RGBA buffer. */
function crop(x, y, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const s = ((y + row) * png.width + x + col) * 4;
      const d = (row * w + col) * 4;
      out[d] = png.data[s];
      out[d + 1] = png.data[s + 1];
      out[d + 2] = png.data[s + 2];
      out[d + 3] = png.data[s + 3];
    }
  }
  return out;
}

const ICONS = iconsDir();
const sheetRows = [];

for (const [zoneId, zone] of Object.entries(zones)) {
  if (wantedZone && zoneId !== wantedZone) continue;

  console.log(`=== ${zoneId} — ${zone.cols}x${zone.rows} @ (${zone.x},${zone.y}) ${zone.w}x${zone.h}`);

  const cellW = zone.w / zone.cols;
  const cellH = zone.h / zone.rows;

  for (let row = 0; row < zone.rows; row++) {
    for (let col = 0; col < zone.cols; col++) {
      const x = Math.round(zone.x + col * cellW + cellW * inset);
      const y = Math.round(zone.y + row * cellH + cellH * inset);
      const w = Math.round(cellW * (1 - 2 * inset));
      const h = Math.round(cellH * (1 - 2 * inset));
      if (x < 0 || y < 0 || x + w > png.width || y + h > png.height) continue;

      const rgba = crop(x, y, w, h);
      const print = fingerprint(rgba, w, h);
      if (print.variance < emptyVariance) continue;

      const ranked = db.items
        .map((item) => ({
          item,
          distance:
            shapeDistance(print.thumb, item.thumb) +
            COLOUR_WEIGHT * colourDistance(print.colour, item.colour),
        }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 3);

      const verdict = ranked[0].distance > maxDistance ? 'REJETÉ' : 'retenu';
      console.log(
        `  (${row},${col}) var ${String(print.variance).padStart(6)}  fill ${print.fill}  ${verdict}  ` +
          ranked.map((r) => `${r.distance.toFixed(1)} ${r.item.shortname}`).join(' | ')
      );

      sheetRows.push({ rgba, w, h, best: ranked[0].item, label: `${row},${col}` });
    }
  }
  console.log('');
}

// Contact sheet: each crop beside the icon it was matched with.
if (sheetRows.length) {
  const CELL = 72;
  const sheet = new PNG({ width: CELL * 2, height: CELL * sheetRows.length });

  sheetRows.forEach((entry, index) => {
    const iconPng = PNG.sync.read(readFileSync(join(ICONS, entry.best.icon)));
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const sx = Math.floor((x * entry.w) / CELL);
        const sy = Math.floor((y * entry.h) / CELL);
        const s = (sy * entry.w + sx) * 4;
        let d = ((index * CELL + y) * CELL * 2 + x) * 4;
        sheet.data[d] = entry.rgba[s];
        sheet.data[d + 1] = entry.rgba[s + 1];
        sheet.data[d + 2] = entry.rgba[s + 2];
        sheet.data[d + 3] = 255;

        const ix = Math.floor((x * iconPng.width) / CELL);
        const iy = Math.floor((y * iconPng.height) / CELL);
        const is = (iy * iconPng.width + ix) * 4;
        const a = iconPng.data[is + 3] / 255;
        d = ((index * CELL + y) * CELL * 2 + CELL + x) * 4;
        sheet.data[d] = iconPng.data[is] * a + 38 * (1 - a);
        sheet.data[d + 1] = iconPng.data[is + 1] * a + 38 * (1 - a);
        sheet.data[d + 2] = iconPng.data[is + 2] * a + 38 * (1 - a);
        sheet.data[d + 3] = 255;
      }
    }
  });

  const out = join(ROOT, 'captures', `${basename(capturePath, '.png')}-analyse.png`);
  writeFileSync(out, PNG.sync.write(sheet));
  console.log(`planche écrite : ${out}\n(colonne gauche : ce qui est mesuré · droite : l'icône retenue)`);
}
