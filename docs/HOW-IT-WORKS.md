# How it works

The overlay never asks the game anything. It puts a transparent window on top, takes a
screenshot through the operating system when you press *Calculate*, and works out the rest from
pixels and from the game's own data files.

- [Reading a slot](#reading-a-slot)
- [The stack count](#the-stack-count)
- [Reading the item card by name](#reading-the-item-card-by-name)
- [Where the item data comes from](#where-the-item-data-comes-from)
- [The recycler formula](#the-recycler-formula)
- [Measured accuracy](#measured-accuracy)
- [Tuning](#tuning)
- [Diagnostic tools](#diagnostic-tools)

## Reading a slot

No OCR is involved in identifying an item. The inventory draws the exact PNG that ships in the
game's `Bundles/items/` folder, so a slot can be compared against the whole index directly.

Each icon — reference and screenshot alike — is reduced to a fingerprint:

1. **Content mask.** Alpha for the reference PNGs, distance from the border-median colour for
   screenshots. This is what makes the two comparable: the shipped icons have wildly different
   transparent margins (`scrap.png` fills 98 % of its canvas, `seed.hemp.png` 60 %) while the
   game draws each one padded inside a slot. Comparing raw canvases compares framing, not
   shape.
2. **Trimmed bounding box**, from cumulative row and column profiles rather than the outermost
   pixel. A single stray bright pixel would otherwise decide the box and rescale the icon
   differently on each side.
3. **A 16×16 luminance thumbnail** over a fixed background, centred and scaled to a unit
   vector, so the dot product of two of them is their correlation. That makes the comparison
   invariant to brightness and contrast, which is exactly what differs between a reference PNG
   and a screenshot.
4. **Mean colour** of the icon's own pixels, weighted lightly (6 %), to separate icons that
   share a shape but not a palette.

A slot is then the nearest item in that space, subject to two guards:

- **Distance.** Past `maxDistance` the slot is reported unidentified rather than guessed.
- **Relative lead.** The best match must beat the runner-up by at least 25 % of its own
  distance. This is what rejects the faint text Rust prints across an empty inventory row —
  that text matched a flasher light at distance 14.5 with the second candidate at 14.7. A real
  icon does not behave that way: it wins by a wide margin, because it *is* the icon. Measured
  over 400 rendered slots, the lead is 2.1 in the median for a correct match and 0.0 for a
  wrong one.

A rejected slot costs one click in the debug panel. A wrong one silently corrupts the total,
which is why the guards lean towards rejecting.

## The stack count

The number Rust paints in the corner of a slot is read by correlation against digit templates
drawn at runtime in several condensed fonts — no OCR dependency to install, no language data to
download, for an alphabet of eleven glyphs.

Two details matter more than the matching itself:

**The text has to be found before the icon is fingerprinted.** Those glyphs are the brightest
pixels in the cell, so they drag the trimmed content box into the corner and rescale the icon
around text rather than around itself. Measured: leaving the count in place costs **24 points**
of top-1 accuracy (84 % → 60 %). The reader locates the text first and blanks it out of the
crop.

**Segmentation is by connected component, not by empty column.** Splitting on empty columns
only works if the strip contains nothing but text, and it never does — the icon is right
behind it, and a pale one puts bright pixels on the same columns as the digits. Components can
be filtered on shape and alignment instead. Each glyph is also classified against *its own*
pixels rather than the raw brightness mask, otherwise the icon showing through the hole of a
`0` makes every round digit look solid.

The brightness threshold was measured, not guessed: the count peaks around 160–200 over a slot
whose median is 59, so 120 separates them comfortably.

An unreadable count falls back to 1 rather than inventing a number, and the debug panel shows
the exact strip that was read.

## Reading the item card by name

For the crafting tree, the app reads the item's **name** off the detail card instead of
matching its thumbnail. Same machinery — bright pixels, connected components, correlation
against templates — with two additions: components are grouped into lines by their baseline
(in "Metal Blade" the `M` and the `l` reach far higher than the `a`, but their bottoms agree),
and the tallest line is taken as the title.

The name is then matched against all 1243 known names by edit distance. This is a different
kind of certainty from icon matching: the reading only has to be *recognisable*, because the
answer merely has to beat 1242 other strings. Two misread letters still land on the right item.

## Where the item data comes from

Everything comes from your own game install. No scraping, no third-party API, and a
regeneration after a patch is enough to stay current.

- **Icons and metadata** — `Bundles/items/` holds a JSON of metadata and the exact icon PNG for
  every item. `npm run build-db` turns that into `data/items.json`: 1243 items with their
  fingerprints.
- **Recipes** — `Bundles/shared/items.preload.bundle` ships its Unity *type trees*, which means
  every `ItemDefinition` and `ItemBlueprint` can be read without dumping IL2CPP metadata.
  `npm run extract-bundle` writes `data/recipes.json`: 996 recipes, no orphaned blueprint, no
  unresolved ingredient.

## The recycler formula

Derived from the game's own blueprints, then checked against the documented real yields of
every component at both efficiencies — **67 of 68 outputs agree**:

- every craft ingredient **except scrap** comes back at `amount × efficiency`
- scrap comes back at `scrapFromRecycle × efficiency × 2`, and the scrap *spent* crafting the
  item is never returned
- the whole part is guaranteed; the fraction is a chance per item

That also pins the correspondence: **40 % is a safe-zone recycler, 60 % a monument one.**

The single disagreement is `targeting.computer`, where the public reference table contradicts
itself (2 tech parts in a safe zone against 1 at a monument, which cannot happen).
`data/recycle.json` is kept only as a record of that cross-check; `recipes.json` is what runs.

996 of 1243 items have a recipe, about 80 % of the index. The rest are non-craftable objects,
reported under *No known recipe* rather than counted as zero.

## Measured accuracy

Measured on `tools/simulate-counts.mjs`, which renders icons the way the game draws them —
128 px slots, background gradient, per-pixel noise, low-frequency bleed from the scene behind
the translucent panel, random padding, the blue selection tint, and a stack count burned into
the corner:

| | top-1 | top-3 |
| --- | --- | --- |
| no stack count on the slot | 86.5 % | — |
| count left in place | 60.5 % | 70.5 % |
| **count located and blanked** | **84.0 %** | **88.5 %** |

The simulation is deliberately unkind, and it has been wrong in both directions before: an
early version rendered onto a perfectly flat background, scored 84 %, and the same code
recognised nothing in game. Anything measured here is re-checked against a real capture with
`npm run replay` before it is believed.

## Tuning

`config.json`, `recognition` section. The first two are also in the Settings menu, and the
[usage guide](USAGE.md#tuning-recognition) covers when to change them and what the symptoms of
each look like.

| Key | What it does |
| --- | --- |
| `inset` | fraction trimmed from each side of a cell, to drop slot borders and the condition bar — 0.18 |
| `maxDistance` | past this, a slot is unidentified rather than guessed — 22 |
| `minLead` | how far ahead of the runner-up the best match must be, relative to its own distance — 0.25 |
| `emptyVariance` | below this luminance spread, a slot is considered empty |
| `countRegion` | where in the cell to look for the stack count |
| `countBright` | luminance above which a pixel counts as stack text |
| `nameBright` | same, for the item card's name |

## Diagnostic tools

```bash
npm run replay             # replay a real capture through the actual recognition code
npm run sim-counts 400     # accuracy over rendered slots, with and without stack counts
npm run test-quantity      # the stack-count reader against synthetic strips
npm run audit-db           # how separable the icon index actually is
```

`npm run replay` is the one that settles arguments: it reads a PNG the app saved, your real
calibrated zones, and prints per-slot variance, fill and top-3, plus a contact sheet pairing
every crop with the icon it was matched to.
