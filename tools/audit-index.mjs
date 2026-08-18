// Audits how separable the indexed items actually are.
//
// A shape hash alone confuses icons that differ only in palette (fire vs HV pistol ammo),
// so the matcher scores shape and colour together. This tool reports which items stay
// ambiguous under the combined score — those are the ones that will be misread in game,
// and the list is what tells us whether the fingerprint is good enough to ship.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
// Classic script (it must also load in the renderer over file://), so require it.
const { shapeDistance, colourDistance } = createRequire(import.meta.url)('../src/shared/fingerprint.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const db = JSON.parse(readFileSync(join(HERE, '..', 'data', 'items.json'), 'utf8'));
const items = db.items;

// Shape distance dominates; colour breaks the ties it leaves behind. The weight puts a
// full-palette swap (~150 RGB units) on par with a few bits of shape difference.
const COLOUR_WEIGHT = 0.06;

const score = (a, b) => shapeDistance(a.thumb, b.thumb) + COLOUR_WEIGHT * colourDistance(a.colour, b.colour);

const AMBIGUOUS_BELOW = 4;
const pairs = [];

for (let i = 0; i < items.length; i++) {
  for (let j = i + 1; j < items.length; j++) {
    const d = score(items[i], items[j]);
    if (d < AMBIGUOUS_BELOW) {
      pairs.push({ a: items[i].shortname, b: items[j].shortname, distance: Number(d.toFixed(2)) });
    }
  }
}

pairs.sort((x, y) => x.distance - y.distance);

console.log(`Items indexed          : ${items.length}`);
console.log(`Pairs compared         : ${(items.length * (items.length - 1)) / 2}`);
console.log(`Ambiguous pairs (<${AMBIGUOUS_BELOW}) : ${pairs.length}\n`);

for (const p of pairs) {
  console.log(`  ${String(p.distance).padStart(6)}  ${p.a}  <->  ${p.b}`);
}

// Nearest-neighbour margin: how much room the matcher has before the runner-up wins.
let worst = Infinity;
let worstPair = null;
for (let i = 0; i < items.length; i++) {
  let nearest = Infinity;
  let nearestName = null;
  for (let j = 0; j < items.length; j++) {
    if (i === j) continue;
    const d = score(items[i], items[j]);
    if (d < nearest) {
      nearest = d;
      nearestName = items[j].shortname;
    }
  }
  if (nearest < worst) {
    worst = nearest;
    worstPair = [items[i].shortname, nearestName];
  }
}

console.log(`\nTightest neighbour pair: ${worstPair?.join(' <-> ')} at ${worst.toFixed(2)}`);
