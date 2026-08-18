// Overlay UI.
//
// Two independent layers live in this window:
//   - the passive layer (aim dot, zone highlights) which is always visible and always
//     click-through, so the game keeps every input;
//   - the menu, which only exists between the hotkey press and Escape, and is the only
//     time this window accepts a click.
//
// Note on styling: the CSP allows stylesheets but not inline <style>/style attributes.
// Scripted CSSOM writes (el.style.width = ...) are not covered by CSP and are what we
// use throughout — never el.setAttribute('style', ...), which would be blocked.

const els = {
  aimDot: document.getElementById('aim-dot'),
  zoneLayer: document.getElementById('zone-layer'),
  scrim: document.getElementById('scrim'),
  panel: document.getElementById('panel'),
  head: document.querySelector('.panel__head'),
  crumb: document.getElementById('panel-crumb'),
  body: document.getElementById('panel-body'),
  foot: document.getElementById('panel-foot'),
  hudHint: document.getElementById('hud-hint'),
  tree: document.getElementById('tree'),
  captureLayer: document.getElementById('capture-layer'),
  captureRect: document.getElementById('capture-rect'),
  captureHelp: document.getElementById('capture-help'),
};

// Slot counts are the ones Rust ships with today, but they are only starting values:
// the calibrator lets you correct rows and columns while looking at the real grid.
// `use` decides which HUD a zone belongs to: the recycler shows every 'recycle' zone at
// once, the crafting tree reads the single 'craft' one.
const ZONE_DEFS = [
  {
    id: 'inventory',
    label: 'Main inventory',
    cols: 6,
    rows: 4,
    use: 'recycle',
    hint: 'Frame the slot grid, without the hotbar at the bottom.',
  },
  {
    id: 'belt',
    label: 'Hotbar',
    cols: 6,
    rows: 1,
    // No recycler card for now: the hotbar holds what you are carrying, not what you are
    // about to feed a recycler, and its card only crowded the bottom of the screen. The
    // zone stays calibratable — put 'recycle' back here to bring the card back.
    use: null,
    hint: 'Frame the bottom row of slots.',
  },
  {
    id: 'backpack',
    label: 'Backpack',
    cols: 6,
    rows: 2,
    use: 'recycle',
    hint: 'Open the backpack and frame its grid — not the character model.',
  },
  {
    id: 'container',
    label: 'Open chest / container',
    cols: 6,
    rows: 5,
    use: 'recycle',
    hint: 'Open the chest and frame its slot grid.',
  },
  {
    id: 'itemdetail',
    label: 'Item detail',
    cols: 1,
    rows: 1,
    use: 'craft',
    // The card is now read by its printed name rather than by its thumbnail, so it wants the
    // whole panel — which is also far easier to line up by hand than a small icon.
    hint: 'Frame the whole detail card, name included. The name is what identifies the item.',
  },
];

const zonesFor = (use) => ZONE_DEFS.filter((def) => def.use === use);

const state = {
  cfg: null,
  display: null,
  menuOpen: false,
  view: 'root',
  cursor: 0,
  calibrating: null, // { zoneId, rect, cols, rows, dragging }
  awaitingHotkey: false,
  panelPos: null, // resolved position for this session; null until the menu first opens
  panelDrag: null,
  recycleMode: false, // menu hidden, every zone shown with its own controls
  craftMode: false, // menu hidden, crafting tree shown next to the item detail zone
  results: {}, // zone id -> last calculation result
  craftResult: null,
  debugZone: null, // zone id whose crops are currently being inspected
  collapsed: {}, // zone id -> card folded away
  tree: null, // { list, index } — item whose craft tree is open, and its siblings
  focus: null, // { watching, foreground, gameFocused } reported by the main process
  stock: null, // { counts: Map, unknown, at } — what the main inventory was last seen holding
};

const profileKey = () =>
  `${state.display.bounds.width}x${state.display.bounds.height}@${state.cfg.game.uiScale}`;

const zonesForProfile = () => state.cfg.zones[profileKey()] ?? {};

const save = (patch) => window.overlay.saveConfig(patch);

// --- Aim dot ------------------------------------------------------------------------

function renderAimDot() {
  const dot = state.cfg.aimDot;
  els.aimDot.replaceChildren();
  els.aimDot.hidden = !dot.enabled;
  if (!dot.enabled) return;

  els.aimDot.style.opacity = String(dot.opacity);
  // Screen centre plus the user's correction for wherever the game's viewport actually is.
  els.aimDot.style.left = `calc(50% + ${dot.offsetX}px)`;
  els.aimDot.style.top = `calc(50% + ${dot.offsetY}px)`;

  const halo = dot.outline ? '0 0 0 1px rgba(0,0,0,0.9)' : 'none';

  const bar = (w, h, dx, dy) => {
    const el = document.createElement('div');
    el.style.position = 'absolute';
    el.style.left = '50%';
    el.style.top = '50%';
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    el.style.marginLeft = `${dx}px`;
    el.style.marginTop = `${dy}px`;
    el.style.background = dot.colour;
    el.style.boxShadow = halo;
    return el;
  };

  if (dot.shape === 'dot') {
    const el = bar(dot.size, dot.size, -dot.size / 2, -dot.size / 2);
    el.style.borderRadius = '50%';
    els.aimDot.append(el);
    return;
  }

  if (dot.shape === 'circle') {
    const r = dot.size;
    const el = bar(r * 2, r * 2, -r, -r);
    el.style.background = 'transparent';
    el.style.border = `${dot.thickness}px solid ${dot.colour}`;
    el.style.borderRadius = '50%';
    els.aimDot.append(el);
    return;
  }

  // 'cross': four arms leaving a gap in the middle, so the exact centre pixel stays clear.
  const { size, thickness: t, gap } = dot;
  els.aimDot.append(
    bar(t, size, -t / 2, -gap - size), // up
    bar(t, size, -t / 2, gap), // down
    bar(size, t, -gap - size, -t / 2), // left
    bar(size, t, gap, -t / 2) // right
  );
}

// --- Zone highlights ------------------------------------------------------------------

/** The outlined rectangle plus its slot grid — shared by calibration and the recycler HUD. */
function buildZoneBox(zone, labelText) {
  const box = document.createElement('div');
  box.className = 'zone';
  box.style.left = `${zone.x}px`;
  box.style.top = `${zone.y}px`;
  box.style.width = `${zone.w}px`;
  box.style.height = `${zone.h}px`;

  if (labelText) {
    const label = document.createElement('div');
    label.className = 'zone__label';
    label.textContent = labelText;
    box.append(label);
  }

  const grid = document.createElement('div');
  grid.className = 'zone__grid';
  grid.style.gridTemplateColumns = `repeat(${zone.cols}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${zone.rows}, 1fr)`;
  for (let i = 0; i < zone.cols * zone.rows; i++) {
    const cell = document.createElement('div');
    cell.className = 'zone__cell';
    grid.append(cell);
  }

  box.append(grid);
  return box;
}

/** @param {string[]} visible ids of the zones to outline; empty hides the layer. */
function renderZones(visible = []) {
  els.zoneLayer.replaceChildren();
  const zones = zonesForProfile();

  for (const id of visible) {
    const zone = zones[id];
    if (!zone) continue;
    const def = ZONE_DEFS.find((z) => z.id === id);
    els.zoneLayer.append(buildZoneBox(zone, `${def?.label ?? id} — ${zone.cols}×${zone.rows}`));
  }
}

// --- Menu ------------------------------------------------------------------------------

/** A plain menu row: clicking it (or Enter) runs onSelect. See numberRow for values. */
function row({ label, sub, value, on, disabled, onSelect }) {
  const el = document.createElement('button');
  el.className = 'row';
  el.type = 'button';
  el.disabled = Boolean(disabled);

  const key = document.createElement('span');
  key.className = 'row__key';

  const text = document.createElement('span');
  text.className = 'row__label';
  text.textContent = label;
  if (sub) {
    const s = document.createElement('span');
    s.className = 'row__sub';
    s.textContent = sub;
    text.append(s);
  }

  el.append(key, text);

  if (value !== undefined) {
    const v = document.createElement('span');
    v.className = on ? 'row__value is-on' : 'row__value';
    v.textContent = value;
    el.append(v);
  }

  el.addEventListener('click', onSelect);
  el.dataset.selectable = 'true';
  return el;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * A row holding a numeric value: [−] [field] [+], plus ← → on the keyboard.
 * The field is directly editable — clicking a value up 30 times to reach an offset is
 * not a usable way to enter a number. Every path clamps to [min, max].
 */
function numberRow({ label, sub, value, min, max, step = 1, unit = 'px', onChange }) {
  const el = document.createElement('div');
  el.className = 'row row--static';
  el.dataset.selectable = 'true';
  el.dataset.adjustable = 'true';

  const commit = (next) => {
    const clamped = clamp(Math.round(next), min, max);
    if (clamped !== value) onChange(clamped);
    return clamped;
  };
  el.__adjust = (delta) => commit(value + delta * step);

  const key = document.createElement('span');
  key.className = 'row__key';

  const text = document.createElement('span');
  text.className = 'row__label';
  text.textContent = label;
  if (sub) {
    const s = document.createElement('span');
    s.className = 'row__sub';
    s.textContent = sub;
    text.append(s);
  }

  const control = document.createElement('div');
  control.className = 'num';

  const stepper = (glyph, sign) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = glyph;
    // Shift jumps by ten, matching the keyboard shortcut on the same row.
    b.addEventListener('click', (e) => commit(value + sign * step * (e.shiftKey ? 10 : 1)));
    return b;
  };

  const input = document.createElement('input');
  input.className = 'num__input';
  input.type = 'text';
  input.inputMode = 'numeric';
  input.value = String(value);
  input.setAttribute('aria-label', label);

  // The menu reads bare digits and arrows as shortcuts; inside the field they are text.
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      input.value = String(value);
      input.blur();
    }
  });

  input.addEventListener('change', () => {
    const parsed = Number.parseInt(input.value.replace(',', '.'), 10);
    input.value = String(Number.isFinite(parsed) ? commit(parsed) : value);
  });

  const unitEl = document.createElement('span');
  unitEl.className = 'num__unit';
  unitEl.textContent = unit;

  control.append(stepper('−', -1), input, stepper('+', 1), unitEl);
  el.append(key, text, control);
  return el;
}

function sectionTitle(text) {
  const el = document.createElement('div');
  el.className = 'section-title';
  el.textContent = text;
  return el;
}

const VIEWS = {
  root() {
    const dot = state.cfg.aimDot;
    const zones = zonesForProfile();
    const zoneCount = Object.keys(zones).length;
    const recycleReady = zonesFor('recycle').some((def) => zones[def.id]);

    return {
      crumb: '',
      foot: `Active profile: ${profileKey()}`,
      rows: [
        row({
          label: 'Aim dot',
          sub: 'Aiming dot at the centre of the screen',
          value: dot.enabled ? 'ON' : 'OFF',
          on: dot.enabled,
          onSelect: async () => {
            state.cfg = await save({ aimDot: { enabled: !dot.enabled } });
            renderAimDot();
            render();
          },
        }),
        row({
          label: 'Aim dot settings',
          sub: `${dot.shape} · ${dot.size}px · ${dot.colour}`,
          onSelect: () => go('aimdot'),
        }),
        row({
          label: 'Recycler output',
          sub: recycleReady
            ? 'Shows every zone with its own controls'
            : 'Calibrate an inventory zone first',
          disabled: !recycleReady,
          onSelect: () => enterRecycleMode(),
        }),
        row({
          label: 'Crafting tree',
          sub: zones[CRAFT_ZONE]
            ? 'Recipe and uses of the selected item'
            : 'Calibrate the “Item detail” zone first',
          disabled: !zones[CRAFT_ZONE],
          onSelect: () => enterCraftMode(),
        }),
        row({
          label: 'Zone calibration',
          sub: `${zoneCount} zone(s) saved for this profile`,
          onSelect: () => go('zones'),
        }),
        row({ label: 'Settings', onSelect: () => go('settings') }),
        row({ label: 'Quit overlay', onSelect: () => window.overlay.quit() }),
      ],
    };
  },

  aimdot() {
    const dot = state.cfg.aimDot;
    const patch = async (change) => {
      state.cfg = await save({ aimDot: change });
      renderAimDot();
      render();
    };

    const SHAPES = ['dot', 'cross', 'circle'];
    const COLOURS = ['#33ff99', '#ff2d55', '#ffffff', '#00e5ff', '#ffcc00', '#ce422b'];
    const cycle = (list, value) => list[(list.indexOf(value) + 1) % list.length];

    const number = ({ label, sub, key, min, max, step, unit }) =>
      numberRow({
        label,
        sub,
        value: dot[key],
        min,
        max,
        step,
        unit,
        onChange: (v) => patch({ [key]: v }),
      });

    return {
      crumb: '› Aim dot',
      foot: '− + or ← → to adjust · Shift for steps of 10 · the field is editable',
      rows: [
        row({
          label: 'Shape',
          value: dot.shape,
          onSelect: () => patch({ shape: cycle(SHAPES, dot.shape) }),
        }),
        number({ label: 'Size', key: 'size', min: 1, max: 40 }),
        number({ label: 'Thickness', sub: 'cross and circle only', key: 'thickness', min: 1, max: 8 }),
        number({ label: 'Centre gap', sub: 'cross only', key: 'gap', min: 0, max: 40 }),
        row({
          label: 'Colour',
          value: dot.colour,
          onSelect: () => patch({ colour: cycle(COLOURS, dot.colour) }),
        }),
        numberRow({
          label: 'Opacity',
          value: Math.round(dot.opacity * 100),
          min: 5,
          max: 100,
          step: 5,
          unit: '%',
          onChange: (v) => patch({ opacity: v / 100 }),
        }),
        row({
          label: 'Dark outline',
          value: dot.outline ? 'ON' : 'OFF',
          on: dot.outline,
          onSelect: () => patch({ outline: !dot.outline }),
        }),

        sectionTitle('Centring'),
        number({
          label: 'Horizontal offset',
          sub: 'positive = to the right',
          key: 'offsetX',
          min: -400,
          max: 400,
        }),
        number({
          label: 'Vertical offset',
          sub: 'positive = downwards',
          key: 'offsetY',
          min: -400,
          max: 400,
        }),
        row({
          label: 'Reset to screen centre',
          sub: 'offset 0 / 0',
          disabled: dot.offsetX === 0 && dot.offsetY === 0,
          onSelect: () => patch({ offsetX: 0, offsetY: 0 }),
        }),
        row({ label: '← Back', onSelect: () => go('root') }),
      ],
    };
  },

  zones() {
    const zones = zonesForProfile();

    return {
      crumb: '› Calibration',
      foot:
        ZONE_DEFS[state.cursor]?.hint ??
        'Open the relevant screen in Rust BEFORE pressing the overlay key.',
      rows: [
        ...ZONE_DEFS.map((def) => {
          const zone = zones[def.id];
          return row({
            label: def.label,
            sub: zone
              ? `${zone.w}×${zone.h} px at (${zone.x}, ${zone.y}) · grid ${zone.cols}×${zone.rows}`
              : 'not calibrated',
            value: zone ? 'OK' : '—',
            on: Boolean(zone),
            onSelect: () => startCalibration(def),
          });
        }),
        row({ label: '← Back', onSelect: () => go('root') }),
      ],
    };
  },

  settings() {
    const cfg = state.cfg;
    const UI_SCALES = [0.7, 0.8, 0.9, 1];
    const cycle = (list, value) => list[(list.indexOf(value) + 1) % list.length];

    return {
      crumb: '› Settings',
      foot: `Config: ${profileKey()}`,
      rows: [
        row({
          label: 'Open key',
          sub: 'Select, then press the new key',
          value: state.awaitingHotkey ? '⏳ press…' : cfg.hotkey,
          on: state.awaitingHotkey,
          onSelect: () => {
            state.awaitingHotkey = true;
            render();
          },
        }),
        row({
          label: 'Show only over Rust',
          // This line is the diagnosis when the overlay does not appear: it says what Windows
          // reports as the active window and how the app read it.
          sub: !state.focus?.watching
            ? 'Cannot watch the active window — overlay always shown'
            : `Front: "${state.focus.foreground ?? '—'}" → ${
                state.focus.gameFocused ? 'the game' : 'not the game'
              } · looking for "${cfg.followGame.windowTitle}"`,
          value: cfg.followGame.enabled ? 'ON' : 'OFF',
          on: cfg.followGame.enabled,
          disabled: !state.focus?.watching,
          onSelect: async () => {
            state.cfg = await save({ followGame: { enabled: !cfg.followGame.enabled } });
            render();
          },
        }),
        row({
          label: 'graphics.uiscale',
          sub: 'Must match the in-game value exactly (F1 console)',
          value: String(cfg.game.uiScale),
          onSelect: async () => {
            state.cfg = await save({ game: { uiScale: cycle(UI_SCALES, cfg.game.uiScale) } });
            render();
          },
        }),
        numberRow({
          label: 'Slot inset',
          // Measured on a real capture: 14 % still lets a slot's green condition bar into
          // the crop, and that alone pushed an electric fuse down to 64th place.
          sub: 'Trimmed from each side of a cell. Too low catches borders, too high cuts the icon.',
          value: Math.round(cfg.recognition.inset * 100),
          min: 4,
          max: 30,
          step: 1,
          unit: '%',
          onChange: async (next) => {
            state.cfg = await save({ recognition: { inset: next / 100 } });
            render();
          },
        }),
        numberRow({
          label: 'Recognition tolerance',
          // Measured on tools/simulate-counts.mjs: the right item sits at distance 3.5 in
          // the median case and under 20.6 in 99 % of them. Below ~20 the app starts
          // refusing slots it had actually got right; well above it, it starts inventing.
          sub: 'Max distance accepted for a slot. Low = more “unidentified”, high = more mistakes.',
          value: cfg.recognition.maxDistance,
          min: 8,
          max: 40,
          step: 1,
          unit: '',
          onChange: async (next) => {
            state.cfg = await save({ recognition: { maxDistance: next } });
            render();
          },
        }),
        row({ label: '← Back', onSelect: () => go('root') }),
      ],
    };
  },
};

function go(view) {
  state.view = view;
  state.cursor = 0;
  render();
}

/**
 * A thrown view leaves the panel empty, which looks like "the app does nothing" and is
 * impossible to diagnose from the outside. Show the failure where the user is looking.
 */
function showFatal(err) {
  console.error('[overlay]', err);

  els.scrim.hidden = false;
  els.crumb.textContent = '› Erreur';
  els.foot.textContent = 'Esc to close · run npm start again after fixing it';

  const box = document.createElement('pre');
  box.className = 'fatal';
  box.textContent = err?.stack ?? String(err);
  els.body.replaceChildren(box);
}

window.addEventListener('error', (e) => showFatal(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => showFatal(e.reason));

function render() {
  if (!state.cfg) return;
  try {
    renderView();
  } catch (err) {
    showFatal(err);
  }
}

function renderView() {
  const view = VIEWS[state.view]();
  els.crumb.textContent = view.crumb;
  els.foot.textContent = view.foot ?? '';
  els.body.replaceChildren(...view.rows);

  const selectable = [...els.body.querySelectorAll('[data-selectable]')];
  state.cursor = Math.max(0, Math.min(state.cursor, selectable.length - 1));

  selectable.forEach((el, i) => {
    el.classList.toggle('is-active', i === state.cursor);
    const key = el.querySelector('.row__key');
    if (key) key.textContent = i < 9 ? String(i + 1) : '';

    // Clicking anywhere on a row moves the cursor there, so the arrow keys keep acting on
    // the row you just touched. This deliberately updates the highlight in place instead
    // of re-rendering: replacing the DOM on mousedown would destroy the element before
    // its click event fires, and the row's own action would never run.
    el.addEventListener('mousedown', () => {
      if (state.cursor === i) return;
      state.cursor = i;
      selectable.forEach((other, j) => other.classList.toggle('is-active', j === i));
    });
  });

  // Highlight the zone the cursor is sitting on, so calibration is verifiable at a glance.
  if (state.view === 'zones') {
    renderZones([ZONE_DEFS[state.cursor]?.id].filter(Boolean));
  } else {
    renderZones([]);
  }

  // Views have different heights, so re-clamp: a panel parked near the bottom must not
  // hang off the screen when a longer view replaces a shorter one.
  applyPanelPos();
}

// --- Panel placement ---------------------------------------------------------------------

/** Keep the panel fully on screen, and always leave its header grabbable. */
function clampPanel({ x, y }) {
  const maxX = Math.max(0, window.innerWidth - els.panel.offsetWidth);
  const maxY = Math.max(0, window.innerHeight - els.panel.offsetHeight);
  return {
    x: Math.round(Math.max(0, Math.min(x, maxX))),
    y: Math.round(Math.max(0, Math.min(y, maxY))),
  };
}

const centredPanel = () =>
  clampPanel({
    x: (window.innerWidth - els.panel.offsetWidth) / 2,
    y: (window.innerHeight - els.panel.offsetHeight) / 2,
  });

function applyPanelPos() {
  if (!state.panelPos) return;
  const { x, y } = clampPanel(state.panelPos);
  els.panel.style.left = `${x}px`;
  els.panel.style.top = `${y}px`;
}

/** Called when the menu opens: stored position if there is one, screen centre otherwise. */
function resolvePanelPos() {
  const stored = state.cfg?.panel;
  state.panelPos =
    stored && stored.x !== null && stored.y !== null ? clampPanel(stored) : centredPanel();
  applyPanelPos();
}

els.head.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const rect = els.panel.getBoundingClientRect();
  state.panelDrag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
  els.panel.classList.add('is-dragging');
  e.preventDefault(); // stops the drag from turning into a text selection
});

window.addEventListener('mousemove', (e) => {
  if (!state.panelDrag) return;
  state.panelPos = clampPanel({
    x: e.clientX - state.panelDrag.dx,
    y: e.clientY - state.panelDrag.dy,
  });
  applyPanelPos();
});

window.addEventListener('mouseup', async () => {
  if (!state.panelDrag) return;
  state.panelDrag = null;
  els.panel.classList.remove('is-dragging');
  state.cfg = await save({ panel: state.panelPos });
});

// Double-clicking the header forgets the stored position and re-centres.
els.head.addEventListener('dblclick', async () => {
  state.cfg = await save({ panel: { x: null, y: null } });
  state.panelPos = centredPanel();
  applyPanelPos();
});

// --- Calibration -------------------------------------------------------------------------

function startCalibration(def) {
  const existing = zonesForProfile()[def.id];
  state.calibrating = {
    zoneId: def.id,
    label: def.label,
    hint: def.hint,
    rect: existing ? { ...existing } : null,
    cols: existing?.cols ?? def.cols,
    rows: existing?.rows ?? def.rows,
    dragging: null,
  };

  els.scrim.hidden = true;
  els.captureLayer.hidden = false;
  renderCalibration();
}

function renderCalibration() {
  const cal = state.calibrating;
  if (!cal) return;

  if (cal.rect) {
    els.captureRect.hidden = false;
    els.captureRect.style.left = `${cal.rect.x}px`;
    els.captureRect.style.top = `${cal.rect.y}px`;
    els.captureRect.style.width = `${cal.rect.w}px`;
    els.captureRect.style.height = `${cal.rect.h}px`;
  } else {
    els.captureRect.hidden = true;
  }

  renderZones([]);
  if (cal.rect) {
    // Reuse the zone renderer for the live grid preview by drawing a provisional zone.
    const preview = { ...cal.rect, cols: cal.cols, rows: cal.rows };
    els.zoneLayer.replaceChildren();
    const box = document.createElement('div');
    box.className = 'zone';
    box.style.left = `${preview.x}px`;
    box.style.top = `${preview.y}px`;
    box.style.width = `${preview.w}px`;
    box.style.height = `${preview.h}px`;

    const grid = document.createElement('div');
    grid.className = 'zone__grid';
    grid.style.gridTemplateColumns = `repeat(${preview.cols}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${preview.rows}, 1fr)`;
    for (let i = 0; i < preview.cols * preview.rows; i++) {
      const cell = document.createElement('div');
      cell.className = 'zone__cell';
      grid.append(cell);
    }
    box.append(grid);
    els.zoneLayer.append(box);
  }

  els.captureHelp.textContent = cal.rect
    ? `${cal.label} — grille ${cal.cols} × ${cal.rows}\n` +
      '← → columns · ↑ ↓ rows · drag again to restart\n' +
      'Enter to save · Esc to cancel'
    : `${cal.label}\n${cal.hint ?? 'Drag a rectangle around the slot grid.'}\nEsc to cancel`;
}

function endCalibration() {
  state.calibrating = null;
  els.captureLayer.hidden = true;
  els.captureRect.hidden = true;
  els.scrim.hidden = false;
  render();
}

async function saveCalibration() {
  const cal = state.calibrating;
  if (!cal?.rect) return;

  state.cfg = await save({
    zones: {
      [profileKey()]: {
        ...zonesForProfile(),
        [cal.zoneId]: { ...cal.rect, cols: cal.cols, rows: cal.rows },
      },
    },
  });

  endCalibration();
}

els.captureLayer.addEventListener('mousedown', (e) => {
  const cal = state.calibrating;
  if (!cal) return;
  cal.dragging = { x: e.clientX, y: e.clientY };
  cal.rect = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
  renderCalibration();
});

els.captureLayer.addEventListener('mousemove', (e) => {
  const cal = state.calibrating;
  if (!cal?.dragging) return;
  cal.rect = {
    x: Math.min(cal.dragging.x, e.clientX),
    y: Math.min(cal.dragging.y, e.clientY),
    w: Math.abs(e.clientX - cal.dragging.x),
    h: Math.abs(e.clientY - cal.dragging.y),
  };
  renderCalibration();
});

els.captureLayer.addEventListener('mouseup', () => {
  const cal = state.calibrating;
  if (!cal) return;
  cal.dragging = null;
  // A stray click should not leave a 0×0 zone behind that looks calibrated.
  if (cal.rect && (cal.rect.w < 20 || cal.rect.h < 20)) cal.rect = null;
  renderCalibration();
});

// --- Recycler HUD ---------------------------------------------------------------------------
//
// The menu gets out of the way entirely: every calibrated zone is outlined at once, each
// with its own card of controls pinned beside it. You set the recycler's efficiency and
// cycle time per zone, hit Calculer, and the result lands next to the zone it came from.

// The game only has these. Offering anything else would invite wrong answers.
const EFFICIENCIES = [0.4, 0.5, 0.6];
const CYCLE_TIMES = [5, 8];

// The game offers these values and no others, but a config written before that was known —
// or edited by hand — can hold anything. Snapping to the nearest allowed value keeps the
// selector honest instead of showing no selection at all.
const nearest = (list, value) =>
  list.reduce((best, option) => (Math.abs(option - value) < Math.abs(best - value) ? option : best), list[0]);

const efficiencyOf = (zone) => nearest(EFFICIENCIES, zone.efficiency ?? state.cfg.recycler.efficiency);
const secondsOf = (zone) => nearest(CYCLE_TIMES, zone.seconds ?? state.cfg.recycler.secondsPerCycle);

const CARD_WIDTH = 300;
const CARD_GAP = 14;

/**
 * Result icons are drawn at half the size of a real inventory slot, taken from the zone's
 * own calibration — so they scale with the player's resolution and UI scale instead of
 * being a fixed pixel guess.
 */
function iconSizeFor(zone) {
  const slot = Math.min(zone.w / zone.cols, zone.h / zone.rows);
  return Math.round(Math.max(22, Math.min(56, slot / 2)));
}

function enterRecycleMode() {
  state.recycleMode = true;
  state.results = {};
  els.scrim.hidden = true;
  renderRecycleHud();
}

function exitRecycleMode() {
  closeTree();
  state.recycleMode = false;
  state.results = {};
  els.hudHint.hidden = true;
  els.zoneLayer.replaceChildren();
  els.scrim.hidden = false;
  render();
}

const CARD_MARGIN = 8;

/** Pin the card beside its zone, flipping to the left when the right edge runs out. */
function placeCard(card, zone) {
  const right = zone.x + zone.w + CARD_GAP;
  const fitsRight = right + CARD_WIDTH + CARD_MARGIN <= window.innerWidth;
  const left = fitsRight ? right : zone.x - CARD_WIDTH - CARD_GAP;
  const maxLeft = window.innerWidth - CARD_WIDTH - CARD_MARGIN;

  card.style.left = `${Math.max(CARD_MARGIN, Math.min(left, maxLeft))}px`;
  card.style.top = `${Math.max(CARD_MARGIN, zone.y)}px`;
}

/**
 * Second pass, once the cards are in the document and their real height is known.
 *
 * Placement alone cannot do this: a card's height depends on its content, so a tall result
 * would hang off the bottom of the screen with its buttons out of reach. Here each card is
 * capped to the viewport, nudged up if it overflows, and pushed clear of the ones already
 * placed so two zones never bury each other.
 */
function fitCards() {
  const placed = [];

  for (const card of els.zoneLayer.querySelectorAll('.zone-card')) {
    card.style.maxHeight = `${window.innerHeight - CARD_MARGIN * 2}px`;

    let top = parseFloat(card.style.top) || CARD_MARGIN;
    const left = parseFloat(card.style.left) || CARD_MARGIN;
    const width = card.offsetWidth;

    for (const other of placed) {
      const overlapsX = left < other.left + other.width && left + width > other.left;
      if (overlapsX && top < other.bottom && top + card.offsetHeight > other.top) {
        top = other.bottom + CARD_GAP;
      }
    }

    const height = card.offsetHeight;
    if (top + height > window.innerHeight - CARD_MARGIN) {
      top = Math.max(CARD_MARGIN, window.innerHeight - height - CARD_MARGIN);
    }

    card.style.top = `${top}px`;
    placed.push({ left, width, top, bottom: top + card.offsetHeight });
  }
}

/**
 * Title bar with a collapse toggle. Several zones are shown at once, so being able to fold
 * the ones you are not reading is what keeps the screen usable.
 */
function cardBar(id, title, subtitle) {
  const bar = document.createElement('div');
  bar.className = 'zone-card__bar';

  const heading = document.createElement('div');
  heading.style.flex = '1';

  const name = document.createElement('div');
  name.className = 'zone-card__title';
  name.textContent = title;
  heading.append(name);

  if (subtitle) {
    const meta = document.createElement('div');
    meta.className = 'zone-card__meta';
    meta.textContent = subtitle;
    heading.append(meta);
  }

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'zone-card__toggle';
  toggle.textContent = state.collapsed[id] ? '+' : '−';
  toggle.title = state.collapsed[id] ? 'Expand' : 'Collapse';
  toggle.addEventListener('click', () => {
    state.collapsed[id] = !state.collapsed[id];
    if (state.recycleMode) renderRecycleHud();
    else if (state.craftMode) renderCraftHud();
  });

  bar.append(heading, toggle);
  return bar;
}

function segmented(values, current, format, onPick) {
  const seg = document.createElement('div');
  seg.className = 'seg';

  for (const value of values) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = format(value);
    if (value === current) b.classList.add('is-on');
    b.addEventListener('click', () => onPick(value));
    seg.append(b);
  }

  return seg;
}

function buildZoneCard(def, zone) {
  const card = document.createElement('div');
  card.className = 'zone-card';

  const efficiency = efficiencyOf(zone);
  const seconds = secondsOf(zone);
  const slots = zone.cols * zone.rows;

  const effLabel = document.createElement('div');
  effLabel.className = 'zone-card__label';
  effLabel.textContent = 'Efficiency';

  const timeLabel = document.createElement('div');
  timeLabel.className = 'zone-card__label';
  timeLabel.textContent = 'Cycle time';

  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'zone-card__go';
  go.textContent = 'Calculate';

  const debug = document.createElement('button');
  debug.type = 'button';
  debug.className = 'zone-card__debug';
  debug.textContent = state.debugZone === def.id ? 'Hide details' : 'Show what was read';
  debug.addEventListener('click', () => {
    state.debugZone = state.debugZone === def.id ? null : def.id;
    renderRecycleHud();
  });


  const out = document.createElement('div');
  out.className = 'zone-card__out';

  const result = state.results[def.id];
  // Disabled but not relabelled: the spinner in the card says it is working, and a button
  // that changes width mid-click makes the card jump.
  if (result?.busy) go.disabled = true;
  renderResult(out, result, slots, seconds, iconSizeFor(zone));

  go.addEventListener('click', () => calculateZone(def, zone));

  const body = document.createElement('div');
  body.className = 'zone-card__scroll';

  card.append(cardBar(def.id, def.label, `${zone.cols}×${zone.rows} — ${slots} slots`));
  placeCard(card, zone); // before the early return: a folded card still needs a position
  if (state.collapsed[def.id]) return card;

  body.append(
    effLabel,
    segmented(EFFICIENCIES, efficiency, (v) => `${Math.round(v * 100)} %`, (v) =>
      patchZone(def.id, { efficiency: v })
    ),
    timeLabel,
    segmented(CYCLE_TIMES, seconds, (v) => `${v} s`, (v) => patchZone(def.id, { seconds: v })),
    go,
    debug,
    out
  );

  if (state.debugZone === def.id && result?.scan) {
    body.append(buildDebugPanel(result.scan, def.id));
  }

  card.append(body);
  placeCard(card, zone);
  return card;
}

/**
 * Shows each measured crop beside the icon the matcher thought closest, with the distance.
 * This is the only way to tell apart the three ways recognition fails: a mis-calibrated
 * grid (crops show borders or halves of icons), a threshold set too low (the right item is
 * the nearest candidate but scores above maxDistance), or a genuine mismatch.
 */
function buildDebugPanel(scan, zoneId) {
  const panel = document.createElement('div');
  panel.className = 'debug';

  const occupied = scan.slots.filter((slot) => !slot.empty);
  if (!occupied.length) {
    panel.textContent = 'Every slot was judged empty.';
    return panel;
  }

  for (const slot of occupied) {
    const row = document.createElement('div');
    row.className = 'debug__row';

    if (slot.crop) {
      const img = document.createElement('img');
      img.src = slot.crop;
      img.className = 'debug__crop';
      row.append(img);
    }

    const best = slot.candidates?.[0];
    if (best) {
      const url = Recognizer.iconUrl(best.item);
      if (url) {
        const ref = document.createElement('img');
        ref.src = url;
        ref.className = 'debug__crop';
        row.append(ref);
      }
    }

    const text = document.createElement('div');
    text.className = 'debug__text';

    // The strip the count reader was given, so a missed quantity can be told apart from a
    // badly placed region.
    if (slot.countCrop) {
      const strip = document.createElement('img');
      strip.src = slot.countCrop;
      strip.className = 'debug__strip';
      strip.title = 'strip fed to the quantity reader';
      row.append(strip);
    }

    const head = document.createElement('div');
    head.textContent =
      `(${slot.row},${slot.col})` +
      (slot.count
        ? `  read "${slot.count.text}" = ${slot.count.value} (conf ${slot.count.confidence})`
        : '  quantity not read');
    text.append(head);

    // The right item is in the top three about four times in five, so make picking it a
    // single click rather than something to work around.
    for (const candidate of slot.candidates ?? []) {
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'debug__pick';
      pick.textContent = `${candidate.distance.toFixed(1)} ${candidate.item.shortname}`;
      if (slot.item && candidate.item.shortname === slot.item.shortname) {
        pick.classList.add('is-on');
      }
      pick.addEventListener('click', () => overrideSlot(zoneId, slot, candidate.item));
      text.append(pick);
    }

    row.append(text);
    panel.append(row);
  }

  return panel;
}

/** Take one of the names offered for the detail card, and rebuild the tree around it. */
function pickCraftItem(item) {
  state.craftResult = {
    ...state.craftResult,
    item,
    craft: Recognizer.craftedFrom(item.shortname),
    usedBy: Recognizer.usedBy(item.shortname),
  };
  renderCraftHud();
}

/** Force a slot to an item the matcher ranked lower, then redo the totals from the scan. */
function overrideSlot(zoneId, slot, item) {
  const result = state.results[zoneId];
  if (!result?.scan) return;

  const target = result.scan.slots.find((s) => s.row === slot.row && s.col === slot.col);
  if (!target) return;

  if (target.unknown) {
    target.unknown = false;
    result.scan.unknown = Math.max(0, result.scan.unknown - 1);
  }
  target.item = item;
  target.quantity = target.quantity ?? target.count?.value ?? 1;

  const counts = new Map();
  for (const s of result.scan.slots) {
    if (!s.item) continue;
    counts.set(s.item.shortname, (counts.get(s.item.shortname) ?? 0) + (s.quantity ?? 1));
  }

  result.scan.counts = counts;
  result.output = Recognizer.computeYield(counts, result.efficiency);
  result.recognised = [...counts.values()].reduce((sum, n) => sum + n, 0);

  renderRecycleHud();
}

// The zone whose contents count as "what you have on you".
const STOCK_ZONE = 'inventory';

/**
 * Reads the main inventory from a screenshot that has already been taken.
 *
 * It reuses the caller's capture rather than taking its own: the crafting tree already grabs
 * the screen to read the item card, and a second capture would mean hiding the overlay again
 * for another 180 ms — and reading an inventory a moment older than the card.
 */
async function readStock(shot) {
  const zone = zonesForProfile()[STOCK_ZONE];
  if (!zone) return null;

  const scan = await Recognizer.recognizeZone(shot, zone, { ...state.cfg.recognition });
  return { counts: scan.counts, unknown: scan.unknown, at: new Date() };
}

/**
 * How an ingredient compares to what the inventory was last seen holding.
 * @returns {'have' | 'partial' | 'missing' | null} null when there is nothing to compare to
 */
function stockState(shortname, needed) {
  if (!state.stock) return null;
  const have = state.stock.counts.get(shortname) ?? 0;
  if (have >= needed) return 'have';
  return have > 0 ? 'partial' : 'missing';
}

/**
 * Compact icon + count chips, sized to fit several per line inside a card.
 * @param {Array<{shortname: string, amount: number, item: object|null}>} entries
 * @param {boolean} [compare] outline each chip by whether the inventory holds enough of it
 */
function buildYield(entries, iconSize = 32, onPick, compare = false) {
  const grid = document.createElement('div');
  grid.className = 'yield';

  entries.forEach((entry, index) => {
    const chip = document.createElement(onPick ? 'button' : 'div');
    chip.className = onPick ? 'yield__item yield__item--link' : 'yield__item';
    chip.title = onPick
      ? `${entry.item?.name ?? entry.shortname} — see its craft tree`
      : entry.item?.name ?? entry.shortname;

    // Green when you have enough, orange when you have some, red when you have none. Only
    // ever applied to ingredient lists: on a "used to craft" list the number means how much
    // the *other* recipe needs, which has nothing to do with what is in your bag.
    if (compare) {
      const verdict = stockState(entry.shortname, entry.amount);
      if (verdict) {
        const have = state.stock.counts.get(entry.shortname) ?? 0;
        chip.classList.add(`yield__item--${verdict}`);
        chip.title = `${entry.item?.name ?? entry.shortname} — you have ${have} of ${entry.amount}`;
      }
    }
    if (onPick) {
      chip.type = 'button';
      chip.addEventListener('click', () => onPick(entries, index));
    }

    const url = entry.item ? Recognizer.iconUrl(entry.item) : null;
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = chip.title;
      img.style.width = `${iconSize}px`;
      img.style.height = `${iconSize}px`;
      chip.append(img);
    } else {
      const fallback = document.createElement('span');
      fallback.className = 'yield__n';
      fallback.textContent = entry.shortname;
      chip.append(fallback);
    }

    const n = document.createElement('span');
    n.className = 'yield__n';
    n.textContent = `×${entry.amount}`;
    chip.append(n);
    grid.append(chip);
  });

  return grid;
}

function yieldSection(parent, label, entries, iconSize, onPick, compare = false) {
  if (!entries?.length) return;
  const title = document.createElement('div');
  title.className = 'zone-card__label';
  title.textContent = label;
  parent.append(title, buildYield(entries, iconSize, onPick, compare));
}

/** Fills a card's output area: what was seen, what it recycles into, what is missing. */
/** A turning ring and a line saying what is happening. */
function spinner(label) {
  const row = document.createElement('div');
  row.className = 'spinner';

  const ring = document.createElement('div');
  ring.className = 'spinner__ring';

  const text = document.createElement('span');
  text.textContent = label;

  row.append(ring, text);
  return row;
}

function renderResult(out, result, slots, seconds, iconSize) {
  out.replaceChildren();

  // A calculation in progress adds a spinner; it does not clear the card. The previous
  // result is what the user is still reading while the new one is computed, and wiping it
  // makes the whole card flash empty for a second on every press.
  if (result?.busy) out.append(spinner(result.status ?? 'Analysing…'));

  if (result?.error) {
    const failed = document.createElement('div');
    failed.className = 'zone-card__meta';
    failed.textContent = result.error;
    out.append(failed);
    return;
  }

  if (!result?.scan) {
    if (!result?.busy) out.textContent = `${slots} slots · ${slots * seconds} s if all full`;
    return;
  }

  const { scan, output, seconds: cycle } = result;

  // What the matcher saw, so a bad calibration is obvious rather than silently wrong.
  const detected = [...scan.counts]
    .map(([shortname, amount]) => ({ shortname, amount, item: Recognizer.byShortname(shortname) }))
    .sort((a, b) => b.amount - a.amount);

  yieldSection(out, 'Detected', detected, iconSize, openTree);
  yieldSection(out, 'Guaranteed yield', output.guaranteed, iconSize);
  yieldSection(out, 'On average, extra', output.chance, iconSize);
  yieldSection(out, 'No known recipe', output.noData, iconSize);

  const summary = document.createElement('div');
  summary.className = 'zone-card__meta';
  summary.style.marginTop = '7px';
  const filled = scan.slots.filter((slot) => slot.item).length;
  summary.textContent =
    `${result.recognised} item(s) in ${filled} slot(s) · ${scan.empty} empty · ` +
    `${scan.unknown} unidentified · ${filled * cycle} s`;
  out.append(summary);

  if (!detected.length) {
    const hint = document.createElement('div');
    hint.className = 'zone-card__meta';
    hint.textContent = 'Nothing recognised: check the zone calibration.';
    out.append(hint);
  }
}

function renderRecycleHud() {
  const zones = zonesForProfile();
  els.zoneLayer.replaceChildren();

  for (const def of zonesFor('recycle')) {
    const zone = zones[def.id];
    if (!zone) continue;
    els.zoneLayer.append(buildZoneBox(zone, def.label), buildZoneCard(def, zone));
  }

  fitCards();
  els.hudHint.textContent = 'Esc to go back to the menu';
  els.hudHint.hidden = false;
}


// --- Craft tree of one item, centred -----------------------------------------------------
//
// Clicking any item chip opens this. It keeps the list the chip came from, so the arrows
// walk the siblings — the ingredients of a recipe, or the recipes an item feeds into —
// without having to close and reopen anything.

/** @param {Array} list entries as built for buildYield  @param {number} index */
function openTree(list, index) {
  const entries = list.filter((entry) => entry.item ?? Recognizer.byShortname(entry.shortname));
  if (!entries.length) return;

  state.tree = { list: entries, index: Math.max(0, Math.min(index, entries.length - 1)) };
  renderTree();
}

function closeTree() {
  state.tree = null;
  els.tree.hidden = true;
  els.tree.replaceChildren();
}

function stepTree(delta) {
  if (!state.tree) return;
  const count = state.tree.list.length;
  state.tree.index = (state.tree.index + delta + count) % count;
  renderTree();
}

function renderTree() {
  if (!state.tree) return closeTree();

  const { list, index } = state.tree;
  const entry = list[index];
  const item = entry.item ?? Recognizer.byShortname(entry.shortname);
  if (!item) return closeTree();

  const craft = Recognizer.craftedFrom(item.shortname);
  const usedBy = Recognizer.usedBy(item.shortname);

  const head = document.createElement('div');
  head.className = 'tree__head';

  const button = (label, title, onClick, disabled) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tree__btn';
    b.textContent = label;
    b.title = title;
    b.disabled = Boolean(disabled);
    b.addEventListener('click', onClick);
    return b;
  };

  const title = document.createElement('div');
  title.className = 'tree__title';
  title.textContent = item.name;

  const position = document.createElement('span');
  position.className = 'tree__pos';
  position.textContent = `${index + 1} / ${list.length}`;

  head.append(
    button('‹', 'Previous', () => stepTree(-1), list.length < 2),
    title,
    position,
    button('›', 'Next', () => stepTree(1), list.length < 2),
    button('✕', 'Close', closeTree)
  );

  const body = document.createElement('div');
  body.className = 'tree__body';

  const hero = document.createElement('div');
  hero.className = 'tree__hero';

  const url = Recognizer.iconUrl(item);
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = item.name;
    hero.append(img);
  }

  const meta = document.createElement('div');
  meta.className = 'tree__meta';
  meta.textContent = craft
    ? `${item.shortname}\nWorkbench level ${craft.workbench} · ${craft.craftTime}s` +
      (craft.amountToCreate > 1 ? ` · makes ${craft.amountToCreate}` : '') +
      (craft.scrapRequired ? `\n${craft.scrapRequired} scrap to unlock` : '')
    : `${item.shortname}\nNot craftable`;
  meta.style.whiteSpace = 'pre-line';
  hero.append(meta);
  body.append(hero);

  // Every chip in here opens the tree again, with its own row as the new sibling list.
  const drill = (entries, at) => openTree(entries, at);

  // The colours below are only as good as the reading behind them, so say what that reading
  // was and when it happened rather than presenting them as fact.
  if (craft?.ingredients?.length) {
    const note = document.createElement('div');
    note.className = 'tree__meta';
    note.style.marginTop = '8px';
    note.textContent = state.stock
      ? `Compared with your inventory, read at ${state.stock.at.toLocaleTimeString()}` +
        (state.stock.unknown ? ` · ${state.stock.unknown} slot(s) unidentified` : '')
      : 'Calibrate the main inventory zone to see what you already have.';
    body.append(note);
  }

  if (craft?.ingredients?.length) {
    yieldSection(body, 'Crafted from', craft.ingredients, 40, drill, true);
  }
  if (usedBy.length) {
    // No cap: the panel scrolls, and truncating would hide exactly what the tree was
    // opened to show. Wood feeds ~200 recipes and all of them are reachable here.
    yieldSection(body, `Used to craft (${usedBy.length})`, usedBy, 40, drill);
  }
  if (!craft && !usedBy.length) {
    const none = document.createElement('div');
    none.className = 'tree__meta';
    none.textContent = 'This item is not craftable and is not part of any recipe.';
    body.append(none);
  }

  els.tree.replaceChildren(head, body);
  els.tree.hidden = false;
}

// --- Crafting tree HUD -------------------------------------------------------------------
//
// Reads the item detail panel Rust shows for the selected item, identifies it, then answers
// both directions at once: what it takes to craft, and what it is an ingredient for.

const CRAFT_ZONE = 'itemdetail';

function enterCraftMode() {
  state.craftMode = true;
  state.craftResult = null;
  els.scrim.hidden = true;
  renderCraftHud();
}

function exitCraftMode() {
  closeTree();
  state.craftMode = false;
  state.craftResult = null;
  els.hudHint.hidden = true;
  els.zoneLayer.replaceChildren();
  els.scrim.hidden = false;
  render();
}

function buildCraftCard(zone) {
  const card = document.createElement('div');
  card.className = 'zone-card';

  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'zone-card__go';
  go.textContent = 'Analyse the selected item';
  go.addEventListener('click', () => analyseCraft(zone));

  const out = document.createElement('div');
  out.className = 'zone-card__out';

  const result = state.craftResult;
  if (result?.busy) out.append(spinner(result.status ?? 'Analysing…'));
  if (result?.busy) go.disabled = true;

  if (result?.error) {
    const failed = document.createElement('div');
    failed.className = 'zone-card__meta';
    failed.textContent = result.error;
    out.append(failed);
  } else if (result?.item || result?.text || result?.lines) {
    renderCraftResult(out, result, iconSizeFor(zone));
  } else {
    out.textContent =
      'Hover or select an item in Rust so its detail panel shows, then run the analysis.';
  }

  const body = document.createElement('div');
  body.className = 'zone-card__scroll';

  card.append(cardBar(CRAFT_ZONE, 'Crafting tree', 'Selected item'));
  placeCard(card, zone);
  if (state.collapsed[CRAFT_ZONE]) return card;

  body.append(go, out);
  card.append(body);
  placeCard(card, zone);
  return card;
}

function renderCraftResult(out, result, iconSize) {
  const { item, craft, usedBy } = result;

  const header = document.createElement('div');
  header.className = 'zone-card__meta';
  header.style.marginBottom = '4px';
  header.textContent = item ? `${item.name} (${item.shortname})` : 'Item not identified';
  out.append(header);

  // What was actually read off the card, always — this is the one line that says whether a
  // wrong answer came from the zone, the reading, or the lookup.
  if (result.text) {
    const read = document.createElement('div');
    read.className = 'zone-card__meta';
    read.textContent = `Read on the card: “${result.text}”`;
    out.append(read);
  }

  // The nearest names, one click each: a misread letter should cost a click, not a retry.
  if (result.candidates?.length) {
    const picks = document.createElement('div');
    picks.className = 'debug__text';
    for (const candidate of result.candidates) {
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'debug__pick';
      pick.textContent = `${Math.round(candidate.score * 100)} % ${candidate.item.name}`;
      if (item && candidate.item.shortname === item.shortname) pick.classList.add('is-on');
      pick.addEventListener('click', () => pickCraftItem(candidate.item));
      picks.append(pick);
    }
    out.append(picks);
  }

  if (!item) {
    const hint = document.createElement('div');
    hint.className = 'zone-card__meta';
    hint.textContent = result.text
      ? 'No known name is close enough. Pick one above, or tighten the zone on the card.'
      : 'No text was read. The zone must frame the detail card, name included.';
    out.append(hint);

    if (result.crop) {
      const shot = document.createElement('img');
      shot.src = result.crop;
      shot.className = 'debug__card';
      shot.title = 'zone that was read';
      out.append(shot);
    }
    return;
  }

  if (craft) {
    const meta = document.createElement('div');
    meta.className = 'zone-card__meta';
    meta.textContent =
      `Workbench level ${craft.workbench} · ${craft.craftTime}s` +
      (craft.amountToCreate > 1 ? ` · makes ${craft.amountToCreate}` : '') +
      (craft.scrapRequired ? ` · ${craft.scrapRequired} scrap to unlock` : '');
    out.append(meta);
    yieldSection(out, 'Crafted from', craft.ingredients, iconSize, openTree, true);
  } else {
    const none = document.createElement('div');
    none.className = 'zone-card__label';
    none.textContent = 'Not craftable';
    out.append(none);
  }

  if (usedBy.length) {
    // Everything, no cap: .zone-card__scroll scrolls and fitCards() keeps the card on
    // screen, so the full list costs nothing but a scrollbar.
    yieldSection(out, `Used to craft (${usedBy.length})`, usedBy, iconSize, openTree);
  } else {
    const none = document.createElement('div');
    none.className = 'zone-card__label';
    none.textContent = 'Not used in any recipe';
    out.append(none);
  }
}

function renderCraftHud() {
  const zone = zonesForProfile()[CRAFT_ZONE];
  els.zoneLayer.replaceChildren();
  if (!zone) return exitCraftMode();

  els.zoneLayer.append(buildZoneBox(zone, 'Item detail'), buildCraftCard(zone));
  fitCards();
  els.hudHint.textContent = 'Esc to go back to the menu';
  els.hudHint.hidden = false;
}

async function analyseCraft(zone) {
  // Same as the recycler: the card keeps what it was showing, with a spinner over it.
  const previous = state.craftResult;
  const progress = (status) => {
    state.craftResult = { ...previous, busy: true, error: null, status };
    renderCraftHud();
  };

  progress('Capturing the screen…');

  try {
    const shot = await window.overlay.captureScreen();
    progress('Reading the card…');
    // Read, do not guess: the card prints the item's name, and a name looked up against the
    // whole index is a far safer answer than the nearest-looking icon.
    const card = await Recognizer.readCard(shot, zone, {
      ...state.cfg.recognition,
      keepCrops: true,
    });
    console.log('[overlay] crafting tree', card.text, card.lines);

    state.craftResult = {
      ...card,
      craft: card.item ? Recognizer.craftedFrom(card.item.shortname) : null,
      usedBy: card.item ? Recognizer.usedBy(card.item.shortname) : [],
    };

    // Same screenshot, second reading: what the player is carrying, so the tree can show
    // which ingredients are already covered.
    try {
      state.stock = await readStock(shot);
    } catch (stockError) {
      console.error('[overlay] inventory read', stockError);
      state.stock = null;
    }

    const report = [
      `analysis ${new Date().toISOString()}`,
      `zone      ${CRAFT_ZONE} @ (${zone.x},${zone.y}) ${zone.w}x${zone.h}`,
      `profile   ${profileKey()}`,
      `capture   ${shot.size.width}x${shot.size.height}`,
      `geometry  ${card.geometry}`,
      '',
      'LINES READ (tallest first)',
      ...(card.lines.length
        ? card.lines.map((l) => `  h${l.height} y${l.top} conf ${l.confidence}  “${l.text}”`)
        : ['  (none)']),
      '',
      `KEPT    ${card.item ? `${card.item.shortname} (${card.item.name})` : 'none'}`,
      'NEAREST NAMES',
      ...(card.candidates.length
        ? card.candidates.map((c) => `  ${(c.score * 100).toFixed(0)} % ${c.item.shortname} (${c.item.name})`)
        : ['  (none)']),
    ].join('\n');

    try {
      const written = await window.overlay.logAnalysis({ report, dataUrl: shot.dataUrl });
      state.craftResult.log = written?.file ?? null;
    } catch (logError) {
      console.error('[overlay] log', logError);
    }
  } catch (err) {
    console.error('[overlay] crafting tree', err);
    state.craftResult = { error: `Failed: ${err.message}` };
  }

  renderCraftHud();
}

/**
 * A readable account of one scan: every slot, what was measured on it, what was read in its
 * corner, and the three items it was closest to. Written to logs/ beside the capture it came
 * from, so what the overlay saw can be compared line by line with what was on screen.
 */
function buildReport(def, zone, scan, output, efficiency, seconds, shot) {
  const pad = (value, width) => String(value).padEnd(width);
  const lines = [];

  lines.push(`analysis ${new Date().toISOString()}`);
  lines.push(`zone      ${def.id} (${def.label}) ${zone.cols}x${zone.rows} @ (${zone.x},${zone.y}) ${zone.w}x${zone.h}`);
  lines.push(`profile   ${profileKey()}`);
  lines.push(`capture   ${shot.size.width}x${shot.size.height}`);
  lines.push(`geometry  ${scan.geometry}`);
  lines.push(`settings  efficiency ${Math.round(efficiency * 100)} % · cycle ${seconds} s · inset ${state.cfg.recognition.inset} · maxDistance ${state.cfg.recognition.maxDistance} · emptyVariance ${state.cfg.recognition.emptyVariance}`);
  lines.push(`result    ${scan.slots.length - scan.empty} slot(s) filled · ${scan.empty} empty · ${scan.unknown} unidentified`);
  lines.push('');
  lines.push('slot   var    fill    quantity                  kept                       3 nearest');

  for (const slot of scan.slots) {
    if (slot.empty) continue;

    const quantity = slot.count
      ? `"${slot.count.text}"=${slot.count.value} conf ${slot.count.confidence}`
      : 'NOT READ (count = 1)';
    const kept = slot.item
      ? `${slot.item.shortname} @ ${slot.distance.toFixed(1)} lead ${slot.lead.toFixed(2)}`
      : `NONE (${slot.reason ?? 'rejected'}, lead ${Number(slot.lead ?? 0).toFixed(2)})`;
    const near = (slot.candidates ?? [])
      .map((c) => `${c.distance.toFixed(1)} ${c.item.shortname}`)
      .join(' | ');

    lines.push(
      `(${slot.row},${slot.col})  ${pad(slot.variance, 6)} ${pad(slot.print?.fill ?? '', 7)} ${pad(quantity, 25)} ${pad(kept, 26)} ${near}`
    );
  }

  lines.push('');
  lines.push('RECOGNISED TOTALS');
  for (const [shortname, quantity] of scan.counts) lines.push(`  ${shortname} x${quantity}`);
  if (!scan.counts.size) lines.push('  (none)');

  const list = (label, entries) => {
    lines.push(label);
    if (!entries.length) lines.push('  (none)');
    for (const entry of entries) lines.push(`  ${entry.shortname} x${entry.amount}`);
  };

  lines.push('');
  list('GUARANTEED YIELD', output.guaranteed);
  list('ON AVERAGE, EXTRA', output.chance);
  list('NO KNOWN RECIPE', output.noData);

  return lines.join('\n');
}

async function patchZone(id, patch) {
  const zones = zonesForProfile();
  state.cfg = await save({
    zones: { [profileKey()]: { ...zones, [id]: { ...zones[id], ...patch } } },
  });
  renderRecycleHud();
}

async function calculateZone(def, zone) {
  // Spread the previous result rather than replacing it: the card keeps showing the last
  // numbers, with a spinner over them, instead of going blank.
  const previous = state.results[def.id];
  const progress = (status) => {
    state.results[def.id] = { ...previous, busy: true, error: null, status };
    renderRecycleHud();
  };

  progress('Capturing the screen…');

  try {
    const shot = await window.overlay.captureScreen();
    progress('Reading the slots…');
    const efficiency = efficiencyOf(zone);
    const seconds = secondsOf(zone);

    const scan = await Recognizer.recognizeZone(shot, zone, {
      ...state.cfg.recognition,
      ...(def.inset != null ? { inset: def.inset } : {}),
      keepCrops: true, // cheap at this scale, and the debug panel is useless without them
    });
    const output = Recognizer.computeYield(scan.counts, efficiency);
    const recognised = [...scan.counts.values()].reduce((sum, n) => sum + n, 0);

    // Kept for troubleshooting: each slot's top candidates are in scan.slots.
    console.log('[overlay] scan', def.id, {
      recognised,
      empty: scan.empty,
      unknown: scan.unknown,
      slots: scan.slots,
    });

    state.results[def.id] = { busy: false, scan, output, efficiency, seconds, recognised };

    // A calculation on the main inventory already knows what is in it, so the crafting tree
    // gets its comparison for free.
    if (def.id === STOCK_ZONE) {
      state.stock = { counts: scan.counts, unknown: scan.unknown, at: new Date() };
    }

    // The capture goes with the report: a disagreement about what was on screen is settled
    // by replaying the same pixels, not by running the test again.
    try {
      const written = await window.overlay.logAnalysis({
        report: buildReport(def, zone, scan, output, efficiency, seconds, shot),
        dataUrl: shot.dataUrl,
      });
      state.results[def.id].log = written?.file ?? null;
    } catch (logError) {
      console.error('[overlay] log', logError);
    }
  } catch (err) {
    console.error('[overlay] calculate', err);
    state.results[def.id] = { busy: false, error: `Failed: ${err.message}` };
  }

  renderRecycleHud();
}

// --- Input ---------------------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  if (state.awaitingHotkey) {
    e.preventDefault();
    const accelerator = toAccelerator(e);
    state.awaitingHotkey = false;
    if (accelerator) save({ hotkey: accelerator }).then((cfg) => ((state.cfg = cfg), render()));
    else render();
    return;
  }

  if (state.calibrating) {
    const cal = state.calibrating;
    if (e.key === 'Tab') {
      e.preventDefault();
      endCalibration();
      return window.overlay.closeMenu();
    }
    if (e.key === 'Escape') return endCalibration();
    if (e.key === 'Enter') return saveCalibration();
    if (!cal.rect) return;

    const step = { ArrowLeft: ['cols', -1], ArrowRight: ['cols', 1], ArrowUp: ['rows', 1], ArrowDown: ['rows', -1] }[e.key];
    if (step) {
      e.preventDefault();
      cal[step[0]] = Math.max(1, Math.min(20, cal[step[0]] + step[1]));
      renderCalibration();
    }
    return;
  }

  if (!state.menuOpen) return;

  // Tab closes everything, at any depth. It is the key that closes the inventory in Rust, so
  // it has to leave nothing of ours floating over a screen that no longer exists — and having
  // it dismiss one layer at a time would mean pressing it three times to get back to the game.
  if (e.key === 'Tab') {
    e.preventDefault(); // Tab also moves DOM focus; we are closing, not navigating
    return window.overlay.closeMenu();
  }

  // The centred tree sits on top of both HUDs, so it takes the keys first.
  if (state.tree) {
    if (e.key === 'Escape') closeTree();
    else if (e.key === 'ArrowLeft') stepTree(-1);
    else if (e.key === 'ArrowRight') stepTree(1);
    return;
  }

  // The HUDs are mouse-driven; the only key they answer to is the way out.
  if (state.recycleMode) {
    if (e.key === 'Escape') exitRecycleMode();
    return;
  }
  if (state.craftMode) {
    if (e.key === 'Escape') exitCraftMode();
    return;
  }

  const selectable = [...els.body.querySelectorAll('[data-selectable]')];

  // Escape always closes, from any screen. Stepping back one level first sounds tidier, but
  // this is an overlay sitting on a game: the reflex is "get this off my screen", and having
  // to press it twice from a sub-menu is the wrong answer to that reflex. Going back a level
  // is what the "← Back" row is for, and reopening always lands on the root menu anyway.
  if (e.key === 'Escape') return window.overlay.closeMenu();

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const delta = e.key === 'ArrowDown' ? 1 : -1;
    state.cursor = (state.cursor + delta + selectable.length) % selectable.length;
    render();
    return;
  }

  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const adjust = selectable[state.cursor]?.__adjust;
    if (!adjust) return;
    e.preventDefault();
    adjust((e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 1));
    return;
  }

  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    selectable[state.cursor]?.click();
    return;
  }

  if (/^[1-9]$/.test(e.key)) {
    const index = Number(e.key) - 1;
    if (index < selectable.length) {
      state.cursor = index;
      selectable[index].click();
    }
  }
});

/** Turn a KeyboardEvent into an Electron accelerator string, or null if it is a bare modifier. */
function toAccelerator(e) {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null;

  const parts = [];
  if (e.ctrlKey) parts.push('Control');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Super');

  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  parts.push(key);
  return parts.join('+');
}

// --- Wiring ---------------------------------------------------------------------------------

window.overlay.onConfig(({ config, display, focus }) => {
  state.cfg = config;
  state.display = display;
  state.focus = focus ?? null;
  renderAimDot();
  if (state.menuOpen) render();
});

window.overlay.onMenuState((open) => {
  state.menuOpen = open;
  els.scrim.hidden = !open;

  if (open) {
    state.view = 'root';
    state.cursor = 0;
    render();
    resolvePanelPos(); // after render: the panel must be laid out before it can be measured
  } else {
    state.awaitingHotkey = false;
    if (state.calibrating) endCalibration();
    // Closing the overlay must leave nothing interactive behind on screen.
    state.recycleMode = false;
    state.craftMode = false;
    closeTree();
    state.results = {};
    state.craftResult = null;
    els.hudHint.hidden = true;
      renderZones([]);
  }
});
