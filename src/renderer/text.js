// Reads a line of text out of a screenshot — in practice, the item name Rust prints at the
// top of its detail panel.
//
// Why bother when we already match icons: the detail panel is the one place where the game
// tells us plainly what the item is. Matching its thumbnail means asking "which of 1243
// icons does this look most like", and a wrong answer is silent. Reading "Metal Blade" and
// looking that name up is a different kind of certainty — a near miss on a couple of letters
// still lands on the right item, because the answer only has to beat 1242 other names.
//
// Same machinery as the stack-count reader: bright pixels, connected components, correlation
// against templates rendered here. The extra work is grouping components into lines, since a
// detail panel holds a name, a category and a description, and only the name is wanted.

(function (root) {
  const { normalise, resample, components, brightMask, correlate } = root.Quantity.internals;

  const ALPHABET =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  const FONTS = [
    '700 40px "Segoe UI"',
    '600 40px Arial',
    '700 40px "Arial Narrow"',
    '400 40px "Segoe UI"',
  ];

  // The name is the brightest text on the panel; the description below it is grey.
  const BRIGHT = 170;
  // A line has to be this many glyphs before it is worth reading at all.
  const MIN_GLYPHS = 2;

  let templates = null;

  function buildTemplates() {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const built = [];

    for (const font of FONTS) {
      for (const glyph of ALPHABET) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = '#fff';
        ctx.font = font;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.fillText(glyph, size / 2, size / 2);

        const { data } = ctx.getImageData(0, 0, size, size);
        const mask = new Uint8Array(size * size);
        let x0 = size;
        let y0 = size;
        let x1 = -1;
        let y1 = -1;

        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            if (data[(y * size + x) * 4] <= 120) continue;
            mask[y * size + x] = 1;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }

        if (x1 < x0) continue;
        built.push({ glyph, vector: normalise(resample(mask, size, size, x0, y0, x1, y1)) });
      }
    }

    return built;
  }

  /** Blobs that could be a letter: tall enough to see, not the whole panel. */
  function plausible(blobs, w, h) {
    return blobs.filter(
      (b) =>
        b.h >= 6 &&
        b.h <= h * 0.6 &&
        b.w >= 1 &&
        b.w <= w * 0.25 &&
        b.w <= b.h * 2.2 &&
        b.area >= b.w * b.h * 0.1
    );
  }

  /**
   * Group blobs into text lines by where their baseline sits.
   *
   * Vertical centres are the wrong thing to group on: in "Metal Blade" the M and the l reach
   * far higher than the a, so their centres are nowhere near each other. Their bottoms are.
   */
  function lines(blobs) {
    const sorted = [...blobs].sort((a, b) => a.y1 - b.y1);
    const out = [];

    for (const blob of sorted) {
      const line = out[out.length - 1];
      const tolerance = Math.max(3, blob.h * 0.35);
      if (line && Math.abs(blob.y1 - line.baseline) <= tolerance) {
        line.blobs.push(blob);
        line.baseline = (line.baseline * (line.blobs.length - 1) + blob.y1) / line.blobs.length;
      } else {
        out.push({ baseline: blob.y1, blobs: [blob] });
      }
    }

    for (const line of out) {
      line.blobs.sort((a, b) => a.x0 - b.x0);
      const heights = line.blobs.map((b) => b.h).sort((a, b) => a - b);
      line.height = heights[heights.length >> 1];
      line.top = Math.min(...line.blobs.map((b) => b.y0));
    }

    return out;
  }

  function classify(labels, w, h, blob) {
    const mask = new Uint8Array(w * h);
    for (let y = blob.y0; y <= blob.y1; y++) {
      for (let x = blob.x0; x <= blob.x1; x++) {
        const p = y * w + x;
        if (labels[p] === blob.id) mask[p] = 1;
      }
    }

    const vector = normalise(resample(mask, w, h, blob.x0, blob.y0, blob.x1, blob.y1));

    let best = null;
    let score = -1;
    for (const template of templates) {
      const value = correlate(vector, template.vector);
      if (value > score) {
        score = value;
        best = template.glyph;
      }
    }

    return { glyph: best, score };
  }

  /**
   * Every text line found, tallest first — the item name is the biggest text on the panel.
   * @param {ImageData} imageData
   * @returns {Array<{text: string, height: number, top: number, confidence: number}>}
   */
  function readLines(imageData, options = {}) {
    if (!templates) templates = buildTemplates();

    const mask = brightMask(imageData, options.bright ?? BRIGHT);
    if (!mask) return [];

    const { width: w, height: h } = imageData;
    const { blobs: all, labels } = components(mask, w, h);
    const candidates = plausible(all, w, h);
    if (!candidates.length) return [];

    const out = [];

    for (const line of lines(candidates)) {
      if (line.blobs.length < MIN_GLYPHS) continue;

      let text = '';
      let total = 0;

      for (let i = 0; i < line.blobs.length; i++) {
        const blob = line.blobs[i];
        const previous = line.blobs[i - 1];
        // A gap wider than a comfortable letter spacing is a word break. Punctuation and
        // accents would land here too, which is why the lookup is fuzzy.
        if (previous && blob.x0 - previous.x1 > line.height * 0.34) text += ' ';

        const glyph = classify(labels, w, h, blob);
        text += glyph.glyph ?? '';
        total += glyph.score;
      }

      const trimmed = text.trim();
      if (trimmed.length < MIN_GLYPHS) continue;

      out.push({
        text: trimmed,
        height: line.height,
        top: line.top,
        confidence: Number((total / line.blobs.length).toFixed(3)),
      });
    }

    // Tallest first, and among equals the one nearest the top: that is the title.
    return out.sort((a, b) => b.height - a.height || a.top - b.top);
  }

  root.TextReader = { readLines, ALPHABET };
})(globalThis);
