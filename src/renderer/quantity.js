// Reads the stack count Rust paints in the corner of a slot ("x20", "x650").
//
// Deliberately not Tesseract: its language data is a multi-megabyte download that a strict
// CSP and an offline app would both have to work around, for a job that is far narrower than
// general OCR. Here the alphabet is eleven glyphs, the text is near-white on a dark icon, and
// the digits are large. Rendering our own templates and correlating against them is smaller,
// instant, and has no dependency to install.
//
// The templates are drawn in several condensed fonts and the best match across all of them
// wins, so we do not depend on having the game's exact typeface installed.
//
// Segmentation is by connected component, not by empty column. Empty columns only work when
// the strip contains nothing but the text — and it never does: the icon sits right behind it,
// and a pale one (a jar of animal fat, a stone) puts bright pixels on the same columns as the
// digits. Components can be filtered on shape and alignment instead, which is what lets the
// digits be picked out of the icon rather than merged into it.

(function (root) {
  const GLYPHS = '0123456789x';
  const GW = 10; // normalised glyph width
  const GH = 14; // normalised glyph height

  const FONTS = [
    '700 30px "Arial Narrow"',
    '700 30px "Roboto Condensed"',
    '700 30px "Segoe UI"',
    '700 30px Arial',
    '700 30px Impact',
  ];

  // Pixels this bright count as text. The stack count is drawn near-white with a dark
  // outline; icon highlights rarely get this far, which is what keeps them out of the read.
  const BRIGHT = 205;
  // Below this correlation the read is thrown away rather than guessed at. Real text is
  // anti-aliased and small, so this cannot be as strict as a synthetic comparison allows.
  const MIN_CONFIDENCE = 0.55;
  // The count is right-aligned, so when more glyphs than this show up the extra ones are
  // icon fragments on the left — drop those instead of failing the whole read.
  const MAX_GLYPHS = 5;
  // Nothing shorter than this can be a glyph at the sizes Rust draws at.
  const MIN_GLYPH_H = 6;

  let templates = null;

  /** Zero-mean, unit-length vector, so a dot product between two of them is a correlation. */
  function normalise(values) {
    let sum = 0;
    for (const v of values) sum += v;
    const mean = sum / values.length;

    let energy = 0;
    const out = new Float64Array(values.length);
    for (let i = 0; i < values.length; i++) {
      out[i] = values[i] - mean;
      energy += out[i] * out[i];
    }

    const norm = Math.sqrt(energy) || 1;
    for (let i = 0; i < out.length; i++) out[i] /= norm;
    return out;
  }

  /** Scale a binary glyph bitmap into the fixed GW x GH box. */
  function resample(mask, w, h, x0, y0, x1, y1) {
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    const cells = new Float64Array(GW * GH);

    for (let gy = 0; gy < GH; gy++) {
      const sy0 = y0 + Math.floor((gy * bh) / GH);
      const sy1 = Math.max(sy0 + 1, y0 + Math.floor(((gy + 1) * bh) / GH));

      for (let gx = 0; gx < GW; gx++) {
        const sx0 = x0 + Math.floor((gx * bw) / GW);
        const sx1 = Math.max(sx0 + 1, x0 + Math.floor(((gx + 1) * bw) / GW));

        let on = 0;
        let count = 0;
        for (let y = sy0; y < sy1; y++) {
          for (let x = sx0; x < sx1; x++) {
            on += mask[y * w + x];
            count++;
          }
        }
        cells[gy * GW + gx] = count ? on / count : 0;
      }
    }

    return cells;
  }

  function buildTemplates() {
    const size = 48;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const built = [];

    for (const font of FONTS) {
      for (const glyph of GLYPHS) {
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

  const correlate = (a, b) => {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot;
  };

  /** Bright pixels of the strip, as a binary mask. */
  function brightMask(imageData, bright) {
    const { data, width: w, height: h } = imageData;
    const mask = new Uint8Array(w * h);
    let any = false;

    for (let p = 0; p < w * h; p++) {
      const i = p * 4;
      const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      if (luma < bright) continue;
      mask[p] = 1;
      any = true;
    }

    return any ? mask : null;
  }

  /**
   * 8-connected blobs of the mask, with their bounding boxes and a label per pixel.
   *
   * The labels matter as much as the boxes. A glyph sitting on a pale icon has bright pixels
   * inside its own bounding box that are not the glyph — the icon showing through the hole of
   * a 0 or a 6. Classifying against the raw brightness mask therefore reads every round digit
   * as a solid block, which is why a stack count over animal fat used to be unreadable while
   * the same count over wood read fine.
   */
  function components(mask, w, h) {
    const labels = new Int32Array(w * h).fill(-1);
    const found = [];
    const stack = [];

    for (let start = 0; start < w * h; start++) {
      if (!mask[start] || labels[start] >= 0) continue;

      const id = found.length;

      let x0 = w;
      let y0 = h;
      let x1 = -1;
      let y1 = -1;
      let area = 0;

      labels[start] = id;
      stack.push(start);

      while (stack.length) {
        const p = stack.pop();
        const px = p % w;
        const py = (p - px) / w;
        area++;
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;

        for (let dy = -1; dy <= 1; dy++) {
          const ny = py + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx;
            if (nx < 0 || nx >= w) continue;
            const n = ny * w + nx;
            if (!mask[n] || labels[n] >= 0) continue;
            labels[n] = id;
            stack.push(n);
          }
        }
      }

      found.push({ id, x0, y0, x1, y1, area, w: x1 - x0 + 1, h: y1 - y0 + 1 });
    }

    return { blobs: found, labels };
  }

  /** Blobs whose shape could be a digit at all — everything else is icon. */
  function plausible(blobs, w, h) {
    return blobs.filter(
      (b) =>
        b.h >= MIN_GLYPH_H &&
        b.h <= h * 0.96 &&
        b.w >= 2 &&
        b.w <= w * 0.5 &&
        b.w <= b.h * 1.7 &&
        // A digit is a stroke, not a solid block: a filled rectangle is a piece of icon.
        b.area >= b.w * b.h * 0.12 &&
        b.area <= b.w * b.h * 0.94
    );
  }

  /**
   * Walk left from a seed blob, keeping only what lines up with it: same height band, same
   * vertical centre, no wide gap. That is the stack count and nothing else.
   */
  function chainFrom(sorted, seedIndex) {
    const seed = sorted[seedIndex];
    const href = seed.h;
    const centre = (seed.y0 + seed.y1) / 2;
    const chain = [seed];

    for (let i = seedIndex + 1; i < sorted.length; i++) {
      const blob = sorted[i];
      const last = chain[chain.length - 1];
      const gap = last.x0 - blob.x1;

      if (gap > href * 1.1) break; // a space this wide ends the number
      if (Math.abs((blob.y0 + blob.y1) / 2 - centre) > href * 0.45) continue;
      if (blob.h < href * 0.5 || blob.h > href * 1.6) continue;

      // Glyphs are laid out side by side, never on top of one another. A blob whose columns
      // are largely those of one we already took is therefore icon debris that happens to
      // span the same range — a diagonal edge of a propane tank, in the case that sent this
      // rule into the code. Taking both put the same digit in the number twice.
      const overlap = Math.min(blob.x1, last.x1) - Math.max(blob.x0, last.x0) + 1;
      if (overlap > 0.3 * Math.min(blob.w, last.w)) continue;

      chain.push(blob);
    }

    return chain.reverse();
  }

  /**
   * Two digits whose anti-aliasing touches come back as one blob. A box far wider than the
   * others is therefore cut into as many equal slices as it has room for.
   */
  function split(chain) {
    const widths = chain.filter((b) => b.w <= b.h).map((b) => b.w);
    if (!widths.length) return chain;
    widths.sort((a, b) => a - b);
    const unit = widths[widths.length >> 1];

    const out = [];
    for (const blob of chain) {
      const parts = Math.round(blob.w / unit);
      if (parts < 2 || unit < 3) {
        out.push(blob);
        continue;
      }
      for (let i = 0; i < parts; i++) {
        out.push({
          ...blob,
          x0: blob.x0 + Math.floor((i * blob.w) / parts),
          x1: blob.x0 + Math.floor(((i + 1) * blob.w) / parts) - 1,
        });
      }
    }

    return out;
  }

  function classify(labels, w, h, blob) {
    // Only this blob's own pixels, so whatever the icon does behind the glyph stays out.
    const mask = new Uint8Array(w * h);
    let y0 = h;
    let y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = blob.x0; x <= blob.x1; x++) {
        const p = y * w + x;
        if (labels[p] !== blob.id) continue;
        mask[p] = 1;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (y1 - y0 < 3) return null;

    const vector = normalise(resample(mask, w, h, blob.x0, y0, blob.x1, y1));

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
   * The glyph blobs of the strip, rightmost group first — used both by read() and, when the
   * read fails, to blank the text out of the icon before fingerprinting it.
   * @returns {{chain: Array, labels: Int32Array, bounds: {x,y,w,h}} | null}
   */
  function segment(imageData, options = {}) {
    const mask = brightMask(imageData, options.bright ?? BRIGHT);
    if (!mask) return null;

    const { width: w, height: h } = imageData;
    const { blobs: all, labels } = components(mask, w, h);
    const blobs = plausible(all, w, h);
    if (blobs.length < 2) return null; // Rust never paints a count below 2, so "x" + a digit

    const sorted = [...blobs].sort((a, b) => b.x1 - a.x1);

    // The rightmost blob is normally the last digit, but a bright icon edge can sit further
    // right than the text. Try a few seeds and keep the longest number that comes out.
    let best = null;
    for (let seed = 0; seed < Math.min(3, sorted.length); seed++) {
      const chain = chainFrom(sorted, seed);
      if (chain.length < 2) continue;
      if (!best || chain.length > best.length) best = chain;
    }
    if (!best) return null;

    const chain = split(best).slice(-MAX_GLYPHS);
    const bounds = {
      x: Math.min(...chain.map((b) => b.x0)),
      y: Math.min(...chain.map((b) => b.y0)),
      w: 0,
      h: 0,
    };
    bounds.w = Math.max(...chain.map((b) => b.x1)) - bounds.x + 1;
    bounds.h = Math.max(...chain.map((b) => b.y1)) - bounds.y + 1;

    return { chain, labels, bounds };
  }

  /**
   * @param {ImageData} imageData the bottom-right corner of a slot
   * @returns {{value: number, text: string, confidence: number, bounds: object} | null}
   */
  function read(imageData, options = {}) {
    const minConfidence = options.minConfidence ?? MIN_CONFIDENCE;
    if (!templates) templates = buildTemplates();

    const found = segment(imageData, options);
    if (!found) return null;

    const { width: w, height: h } = imageData;
    let text = '';
    let worst = 1;

    for (const blob of found.chain) {
      const glyph = classify(found.labels, w, h, blob);
      if (!glyph || glyph.score < minConfidence) return null;
      worst = Math.min(worst, glyph.score);
      text += glyph.glyph;
    }

    // "x20" and "20" both mean twenty; anything else is not a stack count.
    const digits = text.replace(/^x/, '');
    if (!/^\d{1,4}$/.test(digits)) return null;

    return {
      value: Number(digits),
      text,
      confidence: Number(worst.toFixed(3)),
      bounds: found.bounds,
    };
  }

  /**
   * Where the stack count sits inside the strip, whether or not it could be read. The icon
   * matcher needs this even on a failed read: unmasked text wrecks the fingerprint.
   */
  function textBounds(imageData, options = {}) {
    return segment(imageData, options)?.bounds ?? null;
  }

  root.Quantity = {
    read,
    textBounds,
    GLYPHS,
    // text.js reads the item name with the same machinery, on a different alphabet. Sharing
    // the primitives keeps one implementation of "find the glyphs" rather than two that
    // drift apart.
    internals: { normalise, resample, components, brightMask, correlate },
  };
})(globalThis);
