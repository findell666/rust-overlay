// Turns a screenshot of a calibrated zone into a list of items, then into recycler output.
//
// No OCR is involved in identifying an item: the inventory draws the exact PNG that ships
// in the game's Bundles/items folder, so a slot is matched by fingerprint against the whole
// item index. OCR is only ever needed for the stack count painted in the corner of a slot,
// which is not read yet — every occupied slot currently counts as one item.

(function (root) {
  const { fingerprint, shapeDistance, colourDistance } = root.Fingerprint;
  const { Quantity, TextReader } = root;

  // Same weighting as tools/audit-index.mjs, which measured how separable the index is.
  const COLOUR_WEIGHT = 0.06;

  const DEFAULTS = {
    // Fraction of the cell trimmed on every side, to drop slot borders and neighbour bleed.
    // Measured on a real capture: at 0.14 the green condition bar down the left edge of a
    // slot still falls inside the crop, and an electric fuse ranked 64th because of it. At
    // 0.18 the bar is gone and all four items in that inventory came back first.
    inset: 0.18,
    // Combined distance above which a slot is reported as unidentified rather than guessed.
    // Measured on a real capture: a correct match sits at 3.5 in the median and reaches 20.6
    // in 1 % of cases, so below about 20 the app starts refusing slots it had right.
    maxDistance: 22,
    // How far ahead of the runner-up the best match must be, as a fraction of its own
    // distance, to be trusted.
    //
    // Distance alone cannot tell a real icon from the faint game text Rust prints across an
    // empty inventory row: that text matched a flasher light at 14.5 with the second
    // candidate at 14.7. A real icon does not behave that way — it wins by a wide relative
    // margin, because it is the icon. The lead has to be relative rather than absolute: two
    // genuinely similar icons can sit half a point apart at distance 3 and still be the
    // right answer, while half a point at distance 15 is noise.
    //
    // Measured over 400 simulated slots: the lead is 2.1 in the median for a correct match
    // and 0.0 for a wrong one. At 0.25 this rejects 92 % of wrong answers and costs 9 % of
    // right ones — and a rejected slot is offered in the debug panel for one click, where a
    // wrong one silently corrupts the total.
    minLead: 0.25,
    // Luminance standard deviation below which a slot is considered empty. An empty Rust
    // slot is a flat dark rectangle; the median indexed icon sits around 22.
    emptyVariance: 6,
    // Keep a PNG of every crop, so the debug panel can show exactly what was measured.
    keepCrops: false,
    // Where in the cell the stack count is painted, as fractions of its size. Rust
    // right-aligns it along the bottom edge. Kept generous on purpose: a four-digit stack
    // ("x650") is far wider than a two-digit one, and the reader now filters icon pixels
    // out by blob shape instead of needing a tight box.
    countRegion: { x: 0.34, y: 0.58, w: 0.66, h: 0.42 },
    // Passed through to Quantity.read for tuning without touching the module. Measured on a
    // real capture rather than guessed: Rust's stack count peaks around 160-200 over a slot
    // whose median is 59, not the near-white 235 a screenshot of a menu would suggest. At the
    // old threshold of 205 three of four counts had *no* pixels at all to read.
    countBright: 120,
    countConfidence: 0.55,
    // Reading the item name off a detail panel. The name is the brightest text on the card;
    // the description under it is grey and stays out of the way.
    nameBright: 170,
    // How many of the tallest lines to try before giving up on the card.
    nameLines: 3,
    // Below this similarity the read is reported but not acted on.
    nameConfidence: 0.62,
  };

  let index = null; // { items, recycle, iconBase }

  async function load() {
    if (!index) index = await root.overlay.itemDb();
    return index;
  }

  const iconUrl = (item) =>
    index?.iconBase ? index.iconBase + encodeURIComponent(item.icon) : null;

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('capture illisible'));
      img.src = dataUrl;
    });
  }

  /**
   * Maps a point of the overlay's viewport onto the capture.
   *
   * Three coordinate systems meet here, and conflating any two of them shifts every crop:
   *   - CSS pixels of the renderer, which is what a calibrated zone is stored in
   *   - screen coordinates, where the window sits at some offset and may be *smaller than
   *     the display* — Windows handed us a window 30 px shorter than the screen, and the
   *     old code, which simply divided the capture height by window.innerHeight, therefore
   *     read every slot about 16 px too low
   *   - capture pixels, the display scaled by whatever desktopCapturer actually returned
   *
   * Falls back to the old assumption when the host did not send its geometry, so an older
   * main process still works.
   */
  function projection(shot) {
    const bounds = shot.display?.bounds;
    const win = shot.window;

    if (!bounds || !win) {
      const sx = shot.size.width / window.innerWidth;
      const sy = shot.size.height / window.innerHeight;
      return { x: (v) => v * sx, y: (v) => v * sy, sx, sy };
    }

    // The viewport fills the window's content area, so CSS pixels convert to screen units
    // by that ratio — 1 unless the page is zoomed.
    const cssX = win.width / window.innerWidth;
    const cssY = win.height / window.innerHeight;
    // And screen units convert to capture pixels by whatever size the thumbnail came back.
    const sx = shot.size.width / bounds.width;
    const sy = shot.size.height / bounds.height;

    return {
      x: (v) => (win.x - bounds.x + v * cssX) * sx,
      y: (v) => (win.y - bounds.y + v * cssY) * sy,
      sx: cssX * sx,
      sy: cssY * sy,
      describe: () =>
        `window ${win.width}x${win.height} @ (${win.x},${win.y}) · screen ${bounds.width}x${bounds.height} · viewport ${window.innerWidth}x${window.innerHeight}`,
    };
  }

  /** Best matches for one slot fingerprint, nearest first. */
  function rank(print, limit = 3) {
    const scored = index.items.map((item) => ({
      item,
      distance:
        shapeDistance(print.thumb, item.thumb) +
        COLOUR_WEIGHT * colourDistance(print.colour, item.colour),
    }));

    scored.sort((a, b) => a.distance - b.distance);
    return scored.slice(0, limit);
  }

  /**
   * @param {{dataUrl: string, size: {width: number, height: number}}} shot
   * @param {{x,y,w,h,cols,rows}} zone in CSS pixels of the overlay window
   * @returns {Promise<{slots: Array, counts: Map<string, number>, empty: number, unknown: number}>}
   */
  async function recognizeZone(shot, zone, options = {}) {
    const opts = { ...DEFAULTS, ...options };
    await load();

    const image = await loadImage(shot.dataUrl);
    const project = projection(shot);
    const { sx: scaleX, sy: scaleY } = project;

    const canvas = document.createElement('canvas');
    canvas.width = shot.size.width;
    canvas.height = shot.size.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);

    const cellW = zone.w / zone.cols;
    const cellH = zone.h / zone.rows;

    const slots = [];
    const counts = new Map();
    let empty = 0;
    let unknown = 0;

    // A rectangle reaching past the capture would come back padded with transparent black,
    // which silently corrupts a fingerprint. Clamp instead, and skip anything left empty.
    const clamp = (x, y, w, h) => {
      const x0 = Math.max(0, Math.min(Math.round(x), canvas.width));
      const y0 = Math.max(0, Math.min(Math.round(y), canvas.height));
      const x1 = Math.max(x0, Math.min(Math.round(x + w), canvas.width));
      const y1 = Math.max(y0, Math.min(Math.round(y + h), canvas.height));
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    };

    // The count strip and the icon crop are two different rectangles of the capture. This
    // turns "text found here in the strip" into "these pixels of the icon crop are not icon",
    // with a couple of pixels of margin for the glyphs' anti-aliased edges and dark outline.
    const MARGIN = 2;
    const maskFrom = (textBox, strip, icon) => {
      const x0 = Math.max(icon.x, strip.x + textBox.x - MARGIN);
      const y0 = Math.max(icon.y, strip.y + textBox.y - MARGIN);
      const x1 = Math.min(icon.x + icon.w, strip.x + textBox.x + textBox.w + MARGIN);
      const y1 = Math.min(icon.y + icon.h, strip.y + textBox.y + textBox.h + MARGIN);
      if (x1 <= x0 || y1 <= y0) return null;

      const out = new Uint8Array(icon.w * icon.h);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) out[(y - icon.y) * icon.w + (x - icon.x)] = 1;
      }
      return out;
    };

    for (let row = 0; row < zone.rows; row++) {
      for (let col = 0; col < zone.cols; col++) {
        const box = clamp(
          project.x(zone.x + col * cellW + cellW * opts.inset),
          project.y(zone.y + row * cellH + cellH * opts.inset),
          cellW * (1 - 2 * opts.inset) * scaleX,
          cellH * (1 - 2 * opts.inset) * scaleY
        );

        if (box.w < 4 || box.h < 4) {
          empty++;
          slots.push({ row, col, empty: true, offscreen: true });
          continue;
        }

        const { x: sx, y: sy, w: sw, h: sh } = box;
        const data = ctx.getImageData(sx, sy, sw, sh);

        // The stack count is read before the icon is fingerprinted, and for two reasons.
        // A slot holding a stack of 20 is twenty items, not one — and the glyphs Rust burns
        // into the corner are the single worst thing that can happen to a fingerprint. They
        // are the brightest pixels in the cell, so they drag the trimmed content box into
        // that corner and rescale the icon around text rather than around itself. Blanking
        // them first is what stopped "x650" of stone from ranking behind a wind turbine.
        const region = opts.countRegion;
        const countBox = clamp(
          project.x(zone.x + col * cellW + cellW * region.x),
          project.y(zone.y + row * cellH + cellH * region.y),
          cellW * region.w * scaleX,
          cellH * region.h * scaleY
        );

        let count = null;
        let countCrop = null;
        let ignore = null;

        if (countBox.w >= 6 && countBox.h >= 6) {
          const countData = ctx.getImageData(countBox.x, countBox.y, countBox.w, countBox.h);
          const readOptions = { bright: opts.countBright, minConfidence: opts.countConfidence };
          count = Quantity.read(countData, readOptions);

          // Even a read that failed locates the text, and blanking it still helps the icon.
          const textBox = count?.bounds ?? Quantity.textBounds(countData, readOptions);
          if (textBox) ignore = maskFrom(textBox, countBox, box);

          // Shown in the debug panel: seeing the strip is the only way to tell a bad region
          // from a bad threshold from a bad glyph match.
          if (opts.keepCrops) {
            const strip = document.createElement('canvas');
            strip.width = countBox.w;
            strip.height = countBox.h;
            strip.getContext('2d').putImageData(countData, 0, 0);
            countCrop = strip.toDataURL('image/png');
          }
        }

        const print = fingerprint(data.data, sw, sh, { ignore });

        // Snapshot the exact pixels that were measured, not a re-crop of the screen.
        let crop = null;
        if (opts.keepCrops) {
          const cell = document.createElement('canvas');
          cell.width = sw;
          cell.height = sh;
          cell.getContext('2d').putImageData(data, 0, 0);
          crop = cell.toDataURL('image/png');
        }

        const base = { row, col, crop, variance: print.variance, print };

        if (print.variance < opts.emptyVariance) {
          empty++;
          slots.push({ ...base, empty: true });
          continue;
        }

        const best = rank(print);
        const margin = best.length > 1 ? best[1].distance - best[0].distance : Infinity;
        const lead = margin / Math.max(0.5, best[0].distance);
        if (best[0].distance > opts.maxDistance || lead < opts.minLead) {
          unknown++;
          slots.push({
            ...base,
            unknown: true,
            reason: best[0].distance > opts.maxDistance ? 'too far' : 'ambiguous',
            margin,
            lead,
            candidates: best,
            count,
            countCrop,
          });
          continue;
        }

        const item = best[0].item;

        // No count painted in the corner means a single item, which is exactly what Rust
        // draws for a stack of one.
        const quantity = count?.value ?? 1;

        counts.set(item.shortname, (counts.get(item.shortname) ?? 0) + quantity);
        slots.push({
          ...base,
          item,
          quantity,
          count,
          countCrop,
          distance: best[0].distance,
          margin,
          lead,
          candidates: best,
        });
      }
    }

    return { slots, counts, empty, unknown, geometry: project.describe?.() ?? 'legacy (host sent no geometry)' };
  }

  /**
   * What one unit of an item returns at a given recycler efficiency, as exact fractions.
   *
   * The rule comes from the game's own blueprints and was checked against every component
   * whose real yields are documented, at both 40 % and 60 %:
   *   - every craft ingredient except scrap comes back at `amount × efficiency`
   *   - scrap comes back at `scrapFromRecycle × efficiency × 2`, and the scrap *spent*
   *     crafting the item is never returned as such
   * The whole part is guaranteed; the fraction is the chance of one more.
   */
  function yieldFor(shortname, efficiency) {
    const recipe = index.recipes[shortname];
    if (!recipe) return null;

    const perUnit = {};
    for (const [ingredient, amount] of Object.entries(recipe.ingredients)) {
      if (ingredient === 'scrap') continue;
      perUnit[ingredient] = amount * efficiency;
    }
    if (recipe.scrapFromRecycle) {
      perUnit.scrap = (perUnit.scrap ?? 0) + recipe.scrapFromRecycle * efficiency * 2;
    }

    return perUnit;
  }

  /**
   * @param {Map<string, number>} counts recognised item -> how many slots held it
   * @returns {{guaranteed: Array, chance: Array, noData: Array}}
   */
  function computeYield(counts, efficiency) {
    const guaranteed = new Map();
    const extra = new Map();
    const noData = [];

    for (const [shortname, quantity] of counts) {
      const perUnit = yieldFor(shortname, efficiency);
      if (!perUnit) {
        noData.push({ shortname, amount: quantity, item: byShortname(shortname) });
        continue;
      }

      // Each item is recycled on its own, so the certain part is the whole number per
      // unit; the fractions only add up as an average over many items.
      for (const [output, amount] of Object.entries(perUnit)) {
        const whole = Math.floor(amount);
        if (whole) guaranteed.set(output, (guaranteed.get(output) ?? 0) + whole * quantity);

        const fraction = amount - whole;
        if (fraction > 0.001) extra.set(output, (extra.get(output) ?? 0) + fraction * quantity);
      }
    }

    const toList = (map) =>
      [...map]
        .map(([shortname, amount]) => ({
          shortname,
          amount: Math.round(amount),
          item: byShortname(shortname),
        }))
        .filter((entry) => entry.amount > 0)
        .sort((a, b) => b.amount - a.amount);

    return { guaranteed: toList(guaranteed), chance: toList(extra), noData };
  }

  // --- Identifying an item by its printed name ------------------------------------------
  //
  // For the detail panel, reading the name beats matching the thumbnail: the name only has
  // to be recognisable, not perfect, because it is looked up against 1243 known strings and
  // the nearest one wins. Two letters misread still land on the right item.

  const simplify = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

  /** Levenshtein distance, capped: names are short and the table stays tiny. */
  function editDistance(a, b) {
    if (a === b) return 0;
    if (!a.length || !b.length) return Math.max(a.length, b.length);

    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

    for (let i = 1; i <= a.length; i++) {
      const current = [i];
      for (let j = 1; j <= b.length; j++) {
        current[j] = Math.min(
          previous[j] + 1,
          current[j - 1] + 1,
          previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
      }
      previous = current;
    }

    return previous[b.length];
  }

  const similarity = (a, b) =>
    !a.length || !b.length ? 0 : 1 - editDistance(a, b) / Math.max(a.length, b.length);

  /**
   * Nearest items to a piece of read text, best first.
   * @returns {Array<{item: object, score: number}>}
   */
  function matchName(text, limit = 3) {
    const needle = simplify(text);
    if (needle.length < 3) return [];

    return index.items
      .map((item) => ({
        item,
        // The shortname is worth trying too: "metal.blade" reads as one word on screen when
        // the display name does not, and some items are only ever called by it.
        score: Math.max(similarity(needle, simplify(item.name)), similarity(needle, simplify(item.shortname))),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Identify the item shown in a detail panel, from the name printed on it.
   *
   * The zone here frames the whole card, not just its thumbnail: the name is the reliable
   * part, and a card is much easier to line up by hand than a small icon.
   * @returns {Promise<{lines: Array, text: string|null, candidates: Array, item: object|null, crop: string|null}>}
   */
  async function readCard(shot, zone, options = {}) {
    const opts = { ...DEFAULTS, ...options };
    await load();

    const image = await loadImage(shot.dataUrl);
    const project = projection(shot);

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(zone.w * project.sx));
    canvas.height = Math.max(1, Math.round(zone.h * project.sy));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(
      image,
      Math.round(project.x(zone.x)),
      Math.round(project.y(zone.y)),
      canvas.width,
      canvas.height,
      0,
      0,
      canvas.width,
      canvas.height
    );

    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const lines = TextReader.readLines(pixels, { bright: opts.nameBright });

    // Lines come back tallest first. The title is normally the first, but a stray bright
    // shape can fake one, so the best match over the first few wins.
    let best = null;
    for (const line of lines.slice(0, opts.nameLines)) {
      const candidates = matchName(line.text);
      if (!candidates.length) continue;
      if (!best || candidates[0].score > best.candidates[0].score) best = { line, candidates };
    }

    return {
      lines,
      text: best?.line.text ?? lines[0]?.text ?? null,
      candidates: best?.candidates ?? [],
      item: best && best.candidates[0].score >= opts.nameConfidence ? best.candidates[0].item : null,
      crop: opts.keepCrops ? canvas.toDataURL('image/png') : null,
      geometry: project.describe?.() ?? 'legacy (host sent no geometry)',
    };
  }

  // --- Crafting -----------------------------------------------------------------------

  let usedByCache = null;

  /** Reverse index: which items list this one among their ingredients. */
  function usedBy(shortname) {
    if (!usedByCache) {
      usedByCache = new Map();
      for (const [target, recipe] of Object.entries(index.recipes)) {
        for (const ingredient of Object.keys(recipe.ingredients)) {
          if (!usedByCache.has(ingredient)) usedByCache.set(ingredient, []);
          usedByCache.get(ingredient).push({ shortname: target, amount: recipe.ingredients[ingredient] });
        }
      }
    }

    return (usedByCache.get(shortname) ?? [])
      .map((entry) => ({ ...entry, item: byShortname(entry.shortname) }))
      .sort((a, b) => a.amount - b.amount);
  }

  /** How to craft this item: its ingredients, workbench level and craft time. */
  function craftedFrom(shortname) {
    const recipe = index.recipes[shortname];
    if (!recipe) return null;

    return {
      ...recipe,
      ingredients: Object.entries(recipe.ingredients)
        .map(([name, amount]) => ({ shortname: name, amount, item: byShortname(name) }))
        .sort((a, b) => b.amount - a.amount),
    };
  }

  const byShortname = (shortname) => index?.items.find((i) => i.shortname === shortname) ?? null;

  root.Recognizer = {
    DEFAULTS,
    load,
    recognizeZone,
    readCard,
    matchName,
    computeYield,
    usedBy,
    craftedFrom,
    iconUrl,
    byShortname,
  };
})(globalThis);
