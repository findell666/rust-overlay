// Builds the item database and icon fingerprint index from a local Rust install.
//
// Everything we need ships with the game in Bundles/items: one JSON per item holding its
// metadata, and one PNG per item holding the exact sprite the inventory UI draws. That
// makes the install the authoritative source — no scraping, and re-running this after a
// patch is all it takes to stay current.
//
//   node build-item-db.mjs [--rust-dir <path>] [--out <path>]

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { createRequire } from 'node:module';
import { findRustDir } from './rust-dir.mjs';
// Classic script (it must also load in the renderer over file://), so require it.
const { fingerprint } = createRequire(import.meta.url)('../src/shared/fingerprint.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, '..');

function parseArgs(argv) {
  const args = { rustDir: null, out: join(PROJECT_ROOT, 'data') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rust-dir') args.rustDir = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  return args;
}

function decodePng(path) {
  const png = PNG.sync.read(readFileSync(path));
  return { rgba: png.data, width: png.width, height: png.height };
}

const args = parseArgs(process.argv.slice(2));
const rustDir = findRustDir(args.rustDir ? ['--rust-dir', args.rustDir] : []);
const itemsDir = join(rustDir, 'Bundles', 'items');

console.log(`Rust install : ${rustDir}`);
console.log(`Items folder : ${itemsDir}`);

const files = readdirSync(itemsDir);
const jsonFiles = files.filter((f) => f.endsWith('.json'));
const pngFiles = new Set(files.filter((f) => f.endsWith('.png')));

const items = new Map(); // itemid -> record
const skipped = { unparsable: 0, incomplete: 0, noIcon: 0, duplicate: 0 };

for (const file of jsonFiles) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(join(itemsDir, file), 'utf8'));
  } catch {
    skipped.unparsable++;
    continue;
  }

  if (typeof raw.itemid !== 'number' || !raw.shortname) {
    skipped.incomplete++;
    continue;
  }

  // The folder ships the same item twice, once named "rifle ak.json" and once
  // "rifle.ak.json". Same itemid, same icon — keep the first and count the rest.
  if (items.has(raw.itemid)) {
    skipped.duplicate++;
    continue;
  }

  const iconFile = `${basename(file, '.json')}.png`;
  if (!pngFiles.has(iconFile)) {
    skipped.noIcon++;
    continue;
  }

  let print;
  try {
    const { rgba, width, height } = decodePng(join(itemsDir, iconFile));
    print = fingerprint(rgba, width, height);
  } catch (err) {
    console.warn(`  ! icon unreadable for ${raw.shortname}: ${err.message}`);
    skipped.noIcon++;
    continue;
  }

  items.set(raw.itemid, {
    itemid: raw.itemid,
    shortname: raw.shortname,
    name: raw.Name,
    description: raw.Description ?? '',
    category: raw.Category ?? 'Unknown',
    rarity: raw.rarity ?? 'None',
    stackable: raw.stackable ?? 1,
    hasCondition: Boolean(raw.condition?.enabled),
    maxCondition: raw.condition?.max ?? 0,
    icon: iconFile,
    ...print,
  });
}

const records = [...items.values()].sort((a, b) => a.shortname.localeCompare(b.shortname));

// A collision means two items are indistinguishable to the matcher. Surfacing them here
// is the difference between "the DB is fine" and silently mis-identifying loot at runtime.
const byHash = new Map();
for (const item of records) {
  const bucket = byHash.get(JSON.stringify(item.thumb)) ?? [];
  bucket.push(item.shortname);
  byHash.set(JSON.stringify(item.thumb), bucket);
}
const collisions = [...byHash.entries()]
  .filter(([, names]) => names.length > 1)
  .map(([, names]) => ({ items: names }));

mkdirSync(args.out, { recursive: true });

writeFileSync(
  join(args.out, 'items.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString().slice(0, 10),
      itemCount: records.length,
      items: records,
    },
    null,
    2
  )
);

writeFileSync(join(args.out, 'icon-collisions.json'), JSON.stringify(collisions, null, 2));

console.log(`\nIndexed ${records.length} items`);
console.log(
  `Skipped: ${skipped.duplicate} duplicates, ${skipped.noIcon} without icon, ` +
    `${skipped.incomplete} incomplete, ${skipped.unparsable} unparsable`
);
console.log(`Icon hash collisions: ${collisions.length} group(s)`);
if (collisions.length) {
  for (const c of collisions.slice(0, 10)) {
    console.log(`  ${c.items.join(", ")}`);
  }
  if (collisions.length > 10) console.log(`  ... and ${collisions.length - 10} more`);
}
console.log(`\nWrote ${join(args.out, 'items.json')}`);
