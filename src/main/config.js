// Persisted user settings, stored next to Electron's per-user data so the app folder
// stays disposable. Unknown keys from an older config are dropped, missing ones are
// filled from DEFAULTS — that way a version bump never leaves a half-populated config.

const { app } = require('electron');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join, dirname } = require('node:path');

const DEFAULTS = {
  // Any Electron accelerator works here: 'F9', 'Alt+X', 'CommandOrControl+Space'...
  hotkey: 'F9',

  // How long to wait after hiding the overlay before grabbing the screen. hide() is not
  // synchronous with what the compositor shows, and a capture taken too early contains the
  // overlay's own panels. Raise this if cards still appear in saved captures.
  captureDelayMs: 180,

  // Rust install directory, only needed to display item icons. null = autodetect the
  // usual Steam locations; set it by hand if the game lives on another drive.
  rustDir: null,

  // Slot recognition. Measured on tools/simulate-counts.mjs, which renders icons at the size
  // the game actually draws them (128 px at 1440p) and burns a stack count into the corner
  // the way Rust does: 80 % of slots are identified outright and 85 % have the right item
  // among the three candidates the debug panel offers, where one click corrects it.
  //
  // That stack count is worth 20 points of accuracy on its own — left in place it drags the
  // matcher down to 61 %, because the glyphs are the brightest pixels in the cell and the
  // icon then gets framed around them. recognize.js locates and blanks it first.
  //
  // Tune `inset` if the matcher picks up slot borders, and `maxDistance` if too many slots
  // come back unidentified. See src/renderer/recognize.js.
  recognition: {
    inset: 0.14,
    maxDistance: 28,
    emptyVariance: 6,
  },

  aimDot: {
    enabled: false,
    shape: 'dot', // 'dot' | 'cross' | 'circle'
    size: 4, // px — the visible dot diameter, or the arm length for a cross
    thickness: 2, // px — cross/circle stroke width, ignored by 'dot'
    gap: 3, // px — centre gap for 'cross'
    colour: '#33ff99',
    opacity: 0.85,
    outline: true, // 1px dark halo, keeps it readable against snow and sand

    // The centre of the screen is not always the centre of the game's viewport: a
    // windowed Rust sits below its title bar, and a resolution or DPI mismatch shifts
    // things further. No detection is reliable enough to trust, so the offset is manual
    // and, once set for a given setup, permanent.
    offsetX: 0,
    offsetY: 0,
  },

  // Where the user dragged the menu panel, in CSS pixels from the top-left of the screen.
  // null means "not placed yet" — the panel centres itself until it is moved once.
  panel: { x: null, y: null },

  // Hide the overlay whenever Rust is not the active window, so the aim dot does not sit
  // on top of the desktop or a browser.
  followGame: {
    // On by default now that the watcher fails safe. It used to be off because the first
    // version could leave the overlay hidden for good: if the PowerShell loop that reports
    // the foreground window died, nothing ever said so, and the app simply never appeared
    // again. It now retries, and on giving up it goes back to showing unconditionally.
    enabled: true,
    // Title of the game's window, matched exactly (case and surrounding spaces aside).
    // The window title is used rather than the process name because reading it asks the
    // window manager a question about a window, and never asks the operating system
    // anything about the game's process. The console prints the title of whatever is in
    // front on every change, so the value to put here is always one glance away.
    windowTitle: 'Rust',
  },

  game: {
    // Rust's `graphics.uiscale` (F1 console). We cannot read it, so the user records it
    // here — it is half of the calibration profile key, since the same resolution at a
    // different UI scale puts the inventory grid somewhere else entirely.
    uiScale: 1,
  },

  // Screen regions, keyed by "<width>x<height>@<uiscale>" so one profile per setup.
  // Populated by the in-app calibrator; see src/renderer/overlay.js.
  zones: {},

  // Defaults applied to a zone the first time it is calculated. Each zone then carries
  // its own pair, because you rarely recycle a backpack and a chest under the same
  // assumptions. The game only has these values — see EFFICIENCIES / CYCLE_TIMES in the
  // renderer, which are the single source of truth for what the selectors offer.
  recycler: {
    efficiency: 0.5,
    secondsPerCycle: 5,
  },
};

let configPath = null;
let current = null;

function deepMerge(base, override) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) {
    return override === undefined ? base : override;
  }

  const out = {};
  for (const [key, baseValue] of Object.entries(base)) {
    out[key] = deepMerge(baseValue, override?.[key]);
  }
  return out;
}

function load() {
  configPath = join(app.getPath('userData'), 'config.json');

  let stored = {};
  try {
    stored = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    // First run, or the file was hand-edited into invalid JSON. Either way, defaults.
  }

  // `zones` is free-form (profile keys are discovered at runtime), so it survives the
  // schema merge untouched instead of being pruned down to the empty default.
  current = deepMerge(DEFAULTS, stored);
  current.zones = stored.zones ?? {};

  return current;
}

function get() {
  return current ?? load();
}

function save(patch) {
  const next = deepMerge(get(), patch);
  if (patch?.zones) next.zones = { ...get().zones, ...patch.zones };
  current = next;

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(current, null, 2));

  return current;
}

module.exports = { DEFAULTS, load, get, save, path: () => configPath };
