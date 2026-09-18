// Audits the hand-collected raid database for consistency and coverage.
//
// raid-structures.json and raid-damage.json are filled in by hand, which means nothing
// catches a typo the way the generated databases are caught at build time. This tool is
// the substitute: every weapon must resolve to a crafting cost (its own recipe in
// recipes.json, a costItem recipe, or an explicit recipeOverride), every damage entry
// must point at a structure that exists, and every null is counted so it is obvious how
// much of the collection is still outstanding. Exits non-zero on hard errors, so it can
// gate a release.
//
//   node tools/audit-raid-db.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const read = (file) => JSON.parse(readFileSync(join(ROOT, 'data', file), 'utf8'));

const structures = read('raid-structures.json').structures ?? {};
const weapons = read('raid-damage.json').weapons ?? {};
const recipes = read('recipes.json').recipes ?? {};
const items = new Set(read('items.json').items.map((it) => it.shortname));
const verbose = process.argv.slice(2).some((arg) => arg === '--verbose' || arg === '-v');

const errors = [];
const warnings = [];
const warningCounts = new Map();
const discrepancies = [];

const warn = (type, message) => {
  warnings.push(message);
  warningCounts.set(type, (warningCounts.get(type) ?? 0) + 1);
};

// --- Structures -------------------------------------------------------------
// maxHp is null while the value is still unmeasured; anything else must be a real HP.

for (const [id, s] of Object.entries(structures)) {
  if (typeof s?.name !== 'string' || !s.name) {
    errors.push(`structure ${id}: missing or empty "name"`);
  }
  if (s?.maxHp === null || s?.maxHp === undefined) {
    warn('unmeasured maxHp', `structure ${id}: maxHp not measured yet`);
  } else if (typeof s.maxHp !== 'number' || !Number.isFinite(s.maxHp) || s.maxHp <= 0) {
    errors.push(`structure ${id}: maxHp must be a positive number (or null while unmeasured)`);
  }
  if (typeof s?.category !== 'string' || !s.category) {
    warn('missing category', `structure ${id}: no category tag (the menu tree will need it)`);
  }
  if (s?.sides !== undefined && typeof s.sides !== 'boolean') {
    errors.push(`structure ${id}: "sides" must be a boolean when present`);
  }
}

// --- Weapons ----------------------------------------------------------------
// The planner prices each weapon per use; that needs a recipe to join against, and a
// workbench tier to slot the suggestion into. Damage entries must hit known structures.

const coveredByDamage = new Set();

for (const [id, w] of Object.entries(weapons)) {
  if (typeof w?.name !== 'string' || !w.name) {
    errors.push(`weapon ${id}: missing or empty "name"`);
  }
  if (typeof w?.unit !== 'string' || !w.unit) {
    warn('missing unit', `weapon ${id}: missing "unit" (what one damage value corresponds to)`);
  }

  // Cost resolution: recipes.json entry, possibly via costItem, or an explicit override.
  const costId = w?.costItem ?? id;
  const override = w?.recipeOverride;
  const recipe = recipes[costId];
  let tier = null;

  if (override && recipe) {
    warn('redundant recipe override', `weapon ${id}: recipeOverride present but recipes.json has "${costId}" — drop the override`);
  }
  if (override) {
    const t = override.workbench;
    if (t === null || t === undefined) {
      tier = null;
    } else if (!Number.isInteger(t) || t < 0 || t > 3) {
      errors.push(`weapon ${id}: recipeOverride.workbench must be an integer 0-3 (or null for not craftable)`);
    } else {
      tier = t;
    }
    const ing = override.ingredients;
    if (typeof ing !== 'object' || ing === null || Object.keys(ing).length === 0) {
      errors.push(`weapon ${id}: recipeOverride.ingredients must be a non-empty object`);
    } else {
      for (const [shortname, qty] of Object.entries(ing)) {
        if (!items.has(shortname)) {
          warn('unknown override ingredient', `weapon ${id}: override ingredient "${shortname}" is not a known item shortname`);
        }
        if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0) {
          errors.push(`weapon ${id}: override ingredient "${shortname}" needs a positive quantity`);
        }
      }
    }
  } else if (recipe) {
    if (!recipe.userCraftable) {
      warn('non-craftable recipe', `weapon ${id}: recipe for "${costId}" exists but is not user-craftable — treat as found-only`);
    }
    tier = recipe.workbench;
  } else {
    errors.push(`weapon ${id}: no recipe for "${costId}" in recipes.json and no recipeOverride — the planner cannot price it`);
  }

  if (tier === null || tier === undefined) {
    warn('missing workbench tier', `weapon ${id}: no workbench tier — it cannot be slotted into a tier-specific suggestion`);
  }

  // Damage entries: every key must be a known structure, every value measured or null.
  // Values are per full use (one charge, or the whole durability of a crafted tool), so
  // the number is already damage-per-craft — no conversion factor is involved.
  const dmg = w?.damage;
  if (typeof dmg !== 'object' || dmg === null || Object.keys(dmg).length === 0) {
    warn('missing damage table', `weapon ${id}: no damage entries collected yet`);
    for (const sid of Object.keys(structures)) discrepancies.push(`weapon ${id} -> ${sid}: missing damage entry`);
    continue;
  }

  const sideKeys = new Map();
  for (const sid of Object.keys(dmg)) {
    if (sid.endsWith('.soft') || sid.endsWith('.hard')) {
      const base = sid.slice(0, -5);
      const sides = sideKeys.get(base) ?? new Set();
      sides.add(sid.slice(-4));
      sideKeys.set(base, sides);
    }
  }
  for (const [base, sides] of sideKeys) {
    if (sides.size !== 2) {
      discrepancies.push(`weapon ${id} -> ${base}: side-specific damage must include both .soft and .hard entries`);
    }
  }

  for (const sid of Object.keys(structures)) {
    if (!(sid in dmg) && !(`${sid}.soft` in dmg) && !(`${sid}.hard` in dmg)) {
      discrepancies.push(`weapon ${id} -> ${sid}: missing damage entry`);
    }
  }

  for (const [sid, value] of Object.entries(dmg)) {
    // Side-specific keys: a damage entry may add an optional ".soft"/".hard" suffix when
    // the weapon's damage depends on which face is hit. The variant lives only here —
    // structures keep a single entry, since maxHp does not depend on the side.
    let base = sid;
    let side = null;
    if (sid.endsWith('.soft') || sid.endsWith('.hard')) {
      base = sid.slice(0, -5);
      side = sid.slice(-4);
    }
    if (!(base in structures)) {
      errors.push(`weapon ${id} -> ${sid}: unknown structure key (not in raid-structures.json)`);
      continue;
    }
    if (side && structures[base].sides !== true) {
      discrepancies.push(`weapon ${id} -> ${sid}: side-specific damage but "${base}" is not flagged "sides": true`);
    }
    if (value === null) {
      warn('unmeasured damage', `weapon ${id} -> ${sid}: damage not measured yet`);
    } else if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      errors.push(`weapon ${id} -> ${sid}: damage must be a positive number (or null while unmeasured)`);
    } else {
      coveredByDamage.add(base);
    }
  }
}

// --- Report -----------------------------------------------------------------

const structureCount = Object.keys(structures).length;
const weaponCount = Object.keys(weapons).length;
const unmeasuredDamage = warningCounts.get('unmeasured damage') ?? 0;
const unmeasuredHp = warningCounts.get('unmeasured maxHp') ?? 0;
const uncovered = Object.keys(structures).filter((sid) => !coveredByDamage.has(sid));
const summary = (includeUncoveredList) => {
  console.log(`Structures              : ${structureCount} (${unmeasuredHp} maxHp unmeasured)`);
  console.log(`Weapons                 : ${weaponCount}`);
  let pairs = 0, measured = 0;
  for (const w of Object.values(weapons)) {
    if (!w?.damage) continue;
    for (const v of Object.values(w.damage)) {
      pairs++;
      if (typeof v === 'number') measured++;
    }
  }
  console.log(`Damage pairs            : ${measured}/${pairs} measured (${unmeasuredDamage} outstanding)`);
  console.log(`Structures w/o any data : ${uncovered.length}${includeUncoveredList && uncovered.length ? ' (' + uncovered.join(', ') + ')' : ''}`);
  console.log(`Errors                  : ${errors.length}`);
  console.log(`Warnings                : ${warnings.length} (${unmeasuredDamage} unmeasured damage, ${unmeasuredHp} unmeasured maxHp)`);
  console.log(`Discrepancies           : ${discrepancies.length}`);
};

if (verbose) {
  summary(true);
  for (const e of errors) console.log(`  ERROR   ${e}`);
  for (const w of warnings) console.log(`  warn    ${w}`);
  for (const d of discrepancies) console.log(`  diff    ${d}`);
  console.log('\nSummary:');
  console.log(`Errors: ${errors.length} | Warnings: ${warnings.length} | Discrepancies: ${discrepancies.length}`);
} else {
  summary(false);
  console.log('\nWarning types:');
  for (const [type, count] of [...warningCounts].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${type}: ${count}`);
  }
}

if (errors.length) process.exit(1);
