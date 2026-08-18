// Icon fingerprinting, shared by the build-time indexer (tools/) and the runtime matcher
// (renderer). Both sides must produce identical numbers, so the pixel maths lives here once.
//
// Written as a classic script rather than an ES module on purpose: Chromium refuses to load
// module scripts over file://, which is how the overlay page is served. It therefore exposes
// itself on globalThis for the renderer, and via module.exports for the Node tools.
//
// A fingerprint is three signals:
//   - thumb    : 16x16 luminance thumbnail, centred and scaled to a unit vector so that the
//                dot product of two of them is their correlation.
//   - colour   : mean RGB of the icon's own pixels, which separates icons sharing a shape but
//                not a palette (fire vs HV pistol ammo).
//   - variance : spread of the sampled luminance, used to tell an empty slot from a full one.
//
// The reference icons ship on a transparent background; a screenshot shows them composited
// over the dark inventory slot. Both sides therefore composite over the same BACKGROUND before
// measuring — otherwise every icon edge would produce a gradient on one side and not the other.
// Captured pixels are already opaque, so for them compositing is a no-op.

(function (root) {
  // Descriptor resolution. A 64-bit difference hash proved far too coarse: a clean, well
  // framed sewing kit still ranked behind gears and a backpack. 16x16 normalised luminance
  // compared by correlation keeps 256 values instead of 64 bits, and is invariant to
  // brightness and contrast, which is what changes between a reference PNG and a screenshot.
  const THUMB = 16;

  // Kept for the trimmed bounding box below.
  const TRIM = 0.05;

  // Approximates the Rust inventory slot fill. Both sides must use the same value.
  const BACKGROUND = [38, 38, 38];

  // A pixel counts as content when it differs from the estimated background by more than
  // this, in RGB distance (0-441).
  const CONTENT_THRESHOLD = 34;

  /** Median colour of the outer ring — a robust guess at what the background is. */
  function borderColour(rgba, w, h) {
    const channels = [[], [], []];
    const push = (x, y) => {
      const i = (y * w + x) * 4;
      channels[0].push(rgba[i]);
      channels[1].push(rgba[i + 1]);
      channels[2].push(rgba[i + 2]);
    };

    for (let x = 0; x < w; x++) {
      push(x, 0);
      push(x, h - 1);
    }
    for (let y = 1; y < h - 1; y++) {
      push(0, y);
      push(w - 1, y);
    }

    return channels.map((values) => {
      values.sort((a, b) => a - b);
      return values[values.length >> 1] ?? 0;
    });
  }

  /**
   * Marks which pixels belong to the icon rather than to what is behind it, and the box
   * that contains them.
   *
   * This is what makes a reference PNG comparable to a screenshot. The shipped icons have
   * wildly different transparent margins — scrap.png fills 98 % of its canvas, seed.hemp.png
   * only 60 % — while the game draws each one padded inside a slot. Comparing raw canvases
   * therefore compares framing, not shape. Cropping both sides to their content removes it.
   *
   * The same mask also neutralises the slot background, so a selected (blue-highlighted)
   * slot fingerprints the same as an ordinary one.
   */
  function contentMask(rgba, w, h, ignore) {
    let transparent = false;
    for (let i = 3; i < rgba.length; i += 4) {
      if (rgba[i] < 250) {
        transparent = true;
        break;
      }
    }

    const mask = new Uint8Array(w * h);
    const background = transparent ? null : borderColour(rgba, w, h);

    const rows = new Int32Array(h);
    const cols = new Int32Array(w);
    let total = 0;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const pixel = y * w + x;
        // Pixels the caller ruled out — the stack count Rust burns into the corner — must
        // not count as content. They are the icon's worst enemy here: a bright glyph drags
        // the trimmed bounding box into the corner and rescales the whole icon around it.
        if (ignore && ignore[pixel]) continue;

        const i = pixel * 4;
        let isContent;

        if (transparent) {
          isContent = rgba[i + 3] > 16;
        } else {
          const dr = rgba[i] - background[0];
          const dg = rgba[i + 1] - background[1];
          const db = rgba[i + 2] - background[2];
          isContent = Math.sqrt(dr * dr + dg * dg + db * db) > CONTENT_THRESHOLD;
        }

        if (!isContent) continue;
        mask[pixel] = 1;
        rows[y]++;
        cols[x]++;
        total++;
      }
    }

    // Nothing stood out: an empty slot. Keep the whole area so variance can say so.
    if (total === 0) return { mask, bounds: { x: 0, y: 0, w, h }, empty: true };

    // Bounds come from where the *bulk* of the content is, not from its outermost pixel.
    // A plain min/max box is decided by single stray pixels — the stack count burned into
    // a corner, a condition bar, a speck of background noise — and that box then rescales
    // the icon differently on each side, which is exactly what made matching collapse.
    const extent = (profile, length) => {
      let seen = 0;
      let lo = 0;
      let hi = length - 1;
      for (let i = 0; i < length; i++) {
        seen += profile[i];
        if (seen >= total * TRIM) {
          lo = i;
          break;
        }
      }
      seen = 0;
      for (let i = length - 1; i >= 0; i--) {
        seen += profile[i];
        if (seen >= total * TRIM) {
          hi = i;
          break;
        }
      }
      return hi >= lo ? [lo, hi] : [0, length - 1];
    };

    const [x0, x1] = extent(cols, w);
    const [y0, y1] = extent(rows, h);

    return { mask, bounds: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, empty: false };
  }

  /**
   * Box-filter the content box down to dstW x dstH. Pixels outside the mask are replaced by
   * `background` so both sides describe "icon over the same flat colour".
   * @returns {{ lum: Float64Array, alpha: Float64Array }} luminance 0-255 and coverage per cell
   */
  function boxSample(rgba, srcW, srcH, mask, bounds, dstW, dstH, background) {
    const lum = new Float64Array(dstW * dstH);
    const alpha = new Float64Array(dstW * dstH);
    const [bgR, bgG, bgB] = background;

    for (let dy = 0; dy < dstH; dy++) {
      const y0 = bounds.y + Math.floor((dy * bounds.h) / dstH);
      const y1 = Math.max(y0 + 1, bounds.y + Math.floor(((dy + 1) * bounds.h) / dstH));

      for (let dx = 0; dx < dstW; dx++) {
        const x0 = bounds.x + Math.floor((dx * bounds.w) / dstW);
        const x1 = Math.max(x0 + 1, bounds.x + Math.floor(((dx + 1) * bounds.w) / dstW));

        let sumL = 0;
        let sumA = 0;
        let count = 0;

        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * srcW + x) * 4;
            // Alpha for reference icons, mask for screenshots: either way, anything that is
            // not the icon becomes the flat background colour.
            const a = mask[y * srcW + x] ? rgba[i + 3] / 255 : 0;
            const r = rgba[i] * a + bgR * (1 - a);
            const g = rgba[i + 1] * a + bgG * (1 - a);
            const b = rgba[i + 2] * a + bgB * (1 - a);

            sumL += 0.2126 * r + 0.7152 * g + 0.0722 * b; // Rec. 709 luma
            sumA += a;
            count++;
          }
        }

        const idx = dy * dstW + dx;
        lum[idx] = count > 0 ? sumL / count : 0;
        alpha[idx] = count > 0 ? sumA / count : 0;
      }
    }

    return { lum, alpha };
  }

  /**
   * Centre and scale the sampled luminance to a unit vector, so comparing two of them by
   * dot product yields their correlation. Stored as small integers to keep the JSON index
   * readable and compact.
   */
  function descriptor(lum) {
    let sum = 0;
    for (const value of lum) sum += value;
    const mean = sum / lum.length;

    let energy = 0;
    const centred = new Float64Array(lum.length);
    for (let i = 0; i < lum.length; i++) {
      centred[i] = lum[i] - mean;
      energy += centred[i] * centred[i];
    }

    const norm = Math.sqrt(energy) || 1;
    const out = new Array(lum.length);
    for (let i = 0; i < lum.length; i++) out[i] = Math.round((centred[i] / norm) * 1000);
    return out;
  }

  /** Mean colour of the icon's own pixels — never of the space around it. */
  function meanColour(rgba, srcW, srcH, mask) {
    let r = 0;
    let g = 0;
    let b = 0;
    let weight = 0;

    for (let pixel = 0; pixel < srcW * srcH; pixel++) {
      if (!mask[pixel]) continue;
      const i = pixel * 4;
      const a = rgba[i + 3] / 255;
      if (a < 0.5) continue;
      r += rgba[i] * a;
      g += rgba[i + 1] * a;
      b += rgba[i + 2] * a;
      weight += a;
    }

    if (weight === 0) return [0, 0, 0];
    return [Math.round(r / weight), Math.round(g / weight), Math.round(b / weight)];
  }

  /**
   * @param {Uint8Array|Uint8ClampedArray} rgba 4 bytes per pixel
   * @param {{ignore?: Uint8Array}} [options] mask of pixels to treat as background
   * @returns {{ dhash: string, colour: number[], coverage: number, variance: number }}
   */
  function fingerprint(rgba, width, height, options = {}) {
    const { mask, bounds } = contentMask(rgba, width, height, options.ignore);
    const { lum, alpha } = boxSample(rgba, width, height, mask, bounds, THUMB, THUMB, BACKGROUND);

    let sum = 0;
    for (const l of lum) sum += l;
    const mean = sum / lum.length;

    let sqSum = 0;
    for (const l of lum) sqSum += (l - mean) * (l - mean);

    let coverage = 0;
    for (const a of alpha) coverage += a;

    return {
      thumb: descriptor(lum),
      colour: meanColour(rgba, width, height, mask),
      coverage: Number((coverage / alpha.length).toFixed(4)),
      variance: Number(Math.sqrt(sqSum / lum.length).toFixed(2)), // standard deviation, 0-255
      // Fraction of the source the icon occupies — a slot holding nothing barely fills any.
      fill: Number(((bounds.w * bounds.h) / (width * height)).toFixed(4)),
    };
  }

  /**
   * Shape distance from the correlation of two descriptors, mapped onto 0-64 so the
   * thresholds keep the same feel as before: 0 identical, 32 uncorrelated, 64 opposite.
   */
  function shapeDistance(a, b) {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return (1 - dot / 1e6) * 32;
  }

  /** Euclidean distance in RGB, 0-441. */
  function colourDistance(a, b) {
    const dr = a[0] - b[0];
    const dg = a[1] - b[1];
    const db = a[2] - b[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  const api = { THUMB, BACKGROUND, fingerprint, shapeDistance, colourDistance };
  root.Fingerprint = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
