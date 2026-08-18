// Overlay host process.
//
// Design constraint that drives everything here: the overlay must never touch the game.
// No injection, no hooks, no process memory. It is an ordinary always-on-top window that
// happens to be transparent, plus screen capture through the OS. That is what keeps it
// on the right side of EasyAntiCheat — do not "optimise" this by attaching to Rust.
//
// Practical consequence: Rust has to run in borderless windowed mode. An exclusive
// fullscreen swapchain owns the display and nothing can be composited over it.

const {
  app,
  BrowserWindow,
  globalShortcut,
  screen,
  ipcMain,
  desktopCapturer,
  Tray,
  Menu,
  shell,
} = require('electron');
const { join } = require('node:path');
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const config = require('./config');
const focusWatcher = require('./focus-watcher');
const log = require('./log');

const DATA_DIR = join(__dirname, '..', '..', 'data');
const ICON = join(__dirname, '..', '..', 'assets', 'icon.ico');

// Where analyses and their captures are written.
//
// Not next to the app once it is packaged: __dirname then points inside app.asar, which is a
// read-only archive. Anything the app produces at runtime belongs beside its config, in the
// user's own data directory.
const OUTPUT_DIR = () =>
  app.isPackaged ? app.getPath('userData') : join(__dirname, '..', '..');

const RUST_DIR_CANDIDATES = [
  'C:/Program Files (x86)/Steam/steamapps/common/Rust',
  'C:/Program Files/Steam/steamapps/common/Rust',
  'C:/SteamLibrary/steamapps/common/Rust',
  'D:/Steam/steamapps/common/Rust',
  'D:/SteamLibrary/steamapps/common/Rust',
  'E:/SteamLibrary/steamapps/common/Rust',
  'F:/SteamLibrary/steamapps/common/Rust',
];

/** Where the item icons live. Needed at runtime only to display them in results. */
function findRustDir() {
  const configured = config.get().rustDir;
  const candidates = configured ? [configured, ...RUST_DIR_CANDIDATES] : RUST_DIR_CANDIDATES;
  return candidates.find((dir) => existsSync(join(dir, 'Bundles', 'items'))) ?? null;
}

let overlay = null;
let tray = null;
let menuOpen = false;
let gameFocused = false;
let watching = false;
let hideTimer = null;

// Showing is immediate; hiding waits. Windows hands the foreground to intermediate windows
// during an alt-tab, and Steam's own overlay steals it for a moment when it opens, so acting
// on the first frame of "not Rust" makes the overlay blink for no reason.
const HIDE_DELAY_MS = 400;

function createOverlay() {
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds;

  overlay = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    icon: join(__dirname, '..', '..', 'assets', 'icon.ico'),
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    // Starts unfocusable so clicks and keystrokes land in the game. We flip this on only
    // while the menu is open; see setInteractive().
    focusable: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // 'screen-saver' is the highest level Electron exposes and is the one that reliably
  // sits above a borderless fullscreen game on Windows.
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // `forward: true` keeps mouse-move events flowing to the renderer for hover effects
  // while every click still passes straight through to the game underneath.
  overlay.setIgnoreMouseEvents(true, { forward: true });

  overlay.loadFile(join(__dirname, '..', 'renderer', 'index.html'));

  overlay.once('ready-to-show', updateVisibility);

  // Every load, not just the first: a renderer that reloads or recovers from a crash
  // starts with no config at all, and an overlay with no config draws nothing.
  overlay.webContents.on('did-finish-load', pushConfig);

  // Surface renderer errors in the terminal. Without this they are only visible in
  // DevTools, which nobody opens on an overlay they are using in-game.
  // Electron changed this event's signature across versions; accept both shapes.
  overlay.webContents.on('console-message', (...args) => {
    const details = args[0] && typeof args[0] === 'object' && 'message' in args[0] ? args[0] : null;
    const level = details ? details.level : args[1];
    const message = details ? details.message : args[2];
    if (level === 'error' || level === 3) console.error('[renderer]', message);
  });

  // Some games and the Windows shell can push themselves above us on focus changes.
  // Re-asserting on blur is cheap and keeps the overlay from silently disappearing.
  overlay.on('blur', () => {
    if (!menuOpen) overlay.setAlwaysOnTop(true, 'screen-saver');
  });

  return overlay;
}

/**
 * The overlay is only wanted while Rust is the active window. Two escape hatches: the
 * feature can be turned off, and if the watcher could not start we show unconditionally
 * rather than leaving an overlay that never appears.
 */
function shouldBeVisible() {
  if (!config.get().followGame.enabled || !watching) return true;
  return gameFocused || menuOpen;
}

function updateVisibility() {
  if (!overlay) return;

  const wanted = shouldBeVisible();

  if (wanted) {
    clearTimeout(hideTimer);
    hideTimer = null;
    if (!overlay.isVisible()) {
      overlay.showInactive(); // show without stealing focus from the game
      // Re-asserted on every show: a game going fullscreen, or the shell, can push itself
      // above us while we were hidden, and the overlay would come back underneath.
      overlay.setAlwaysOnTop(true, 'screen-saver');
      if (menuOpen) overlay.focus();
    }
    return;
  }

  if (!overlay.isVisible() || hideTimer) return;
  hideTimer = setTimeout(() => {
    hideTimer = null;
    // Re-check: the reason to hide may have gone away while we waited.
    if (!shouldBeVisible()) overlay?.hide();
  }, HIDE_DELAY_MS);
}

/** Toggle between click-through (game has input) and interactive (menu has input). */
function setInteractive(interactive) {
  if (!overlay) return;

  menuOpen = interactive;
  overlay.setIgnoreMouseEvents(!interactive, { forward: true });
  overlay.setFocusable(interactive);
  updateVisibility(); // an open menu is always visible, even with the game in the background

  if (interactive) {
    overlay.focus();
  } else {
    // Handing focus back explicitly avoids a state where the game is visible but the
    // keyboard still belongs to a window the user thinks is closed.
    overlay.blur();
  }

  overlay.webContents.send('overlay:menu-state', interactive);
}

function pushConfig() {
  const display = screen.getPrimaryDisplay();
  overlay?.webContents.send('overlay:config', {
    config: config.get(),
    display: { bounds: display.bounds, scaleFactor: display.scaleFactor },
    focus: { watching, foreground: focusWatcher.foreground()?.title ?? null, gameFocused },
  });
}

/**
 * Is the window in front the game?
 *
 * Matched on the window's title, which is what the window manager will tell us without being
 * asked anything about the process behind it. Rust titles its window "Rust".
 *
 * Our own window needs no special case: whenever it has focus the menu is open, and an open
 * menu keeps the overlay visible regardless — see shouldBeVisible().
 */
function isGameWindow(title) {
  const target = (config.get().followGame.windowTitle ?? '').trim().toLowerCase();
  if (!target) return false;
  return (title ?? '').trim().toLowerCase() === target;
}

/**
 * The notification-area icon.
 *
 * This is the only thing that says the app is running. The window is transparent, borderless
 * and deliberately absent from the taskbar, and a packaged build has no console window to
 * print a banner to — so without a tray icon, a launched overlay is indistinguishable from one
 * that failed to start. It also gives a way back in if the hotkey is taken by another app.
 */
function createTray() {
  tray = new Tray(ICON);
  refreshTray();

  // Double-click is the Windows convention for "the main thing", and here that is the menu.
  tray.on('double-click', () => setInteractive(true));
}

function refreshTray() {
  if (!tray) return;

  const cfg = config.get();
  const front = focusWatcher.foreground();

  tray.setToolTip(
    watching
      ? `Rust Overlay — press ${cfg.hotkey} to open the menu`
      : 'Rust Overlay — cannot watch the active window, always shown'
  );

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open menu (${cfg.hotkey})`, click: () => setInteractive(true) },
      { type: 'separator' },
      // Disabled on purpose: this is a readout, not a control. It is the fastest answer to
      // "why is the overlay showing / not showing", and a packaged build has no console.
      {
        label: watching
          ? `Active window: ${front?.title || '—'}${gameFocused ? ' (the game)' : ''}`
          : 'Active window: cannot be read',
        enabled: false,
      },
      { type: 'separator' },
      {
        label: 'Aim dot',
        type: 'checkbox',
        checked: cfg.aimDot.enabled,
        click: () => {
          config.save({ aimDot: { enabled: !config.get().aimDot.enabled } });
          pushConfig();
          refreshTray();
        },
      },
      {
        label: 'Show only over Rust',
        type: 'checkbox',
        checked: cfg.followGame.enabled,
        enabled: watching,
        click: () => {
          config.save({ followGame: { enabled: !config.get().followGame.enabled } });
          updateVisibility();
          pushConfig();
          refreshTray();
        },
      },
      { type: 'separator' },
      { label: 'Open settings folder', click: () => shell.openPath(app.getPath('userData')) },
      { label: 'Open log file', click: () => log.path() && shell.openPath(log.path()) },
      { label: 'Quit Rust Overlay', click: () => app.quit() },
    ])
  );
}

function startFocusWatcher() {
  watching = focusWatcher.start(
    (front) => {
      gameFocused = isGameWindow(front.title);
      // Printed on every change: when the overlay does not appear, this line is the whole
      // diagnosis — it gives the exact title of the window in front, which is also exactly
      // what to put in the setting if the game ever calls itself something else.
      console.log(
        `[focus] front window: "${front.title || '(untitled)'}" → ${
          gameFocused ? 'the game' : 'not the game'
        }`
      );
      updateVisibility();
      refreshTray(); // the tray shows which window is in front; it must not go stale
      pushConfig(); // lets the settings screen show what was actually detected
    },
    (alive, reason) => {
      // The watcher gave up. Fall back to showing unconditionally: an overlay that is always
      // there is a nuisance, one that never comes back is a broken app.
      watching = alive;
      console.log(`[focus] no longer watching (${reason}) — the overlay stays visible.`);
      updateVisibility();
      refreshTray();
      pushConfig();
    }
  );

  if (watching) console.log('[focus] watching the active window');
  else console.log('[focus] cannot watch the active window — the overlay stays visible');

  return watching;
}

function registerHotkey() {
  globalShortcut.unregisterAll();

  const accelerator = config.get().hotkey;
  const ok = globalShortcut.register(accelerator, () => setInteractive(!menuOpen));

  if (!ok) {
    console.error(
      `[overlay] Could not register hotkey "${accelerator}" — another application owns it. ` +
        'Change "hotkey" in ' + config.path()
    );
  }

  return ok;
}

/**
 * The overlay is transparent, click-through and absent from the taskbar, so a successful
 * launch looks exactly like a hung terminal. Say so out loud.
 */
function announce(hotkeyRegistered) {
  const { bounds } = screen.getPrimaryDisplay();
  const hotkey = config.get().hotkey;

  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║  RUST OVERLAY — running                              ║');
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Press ${hotkey} to open the menu.`);
  console.log('');
  const follow = config.get().followGame;
  console.log(`  Screen     : ${bounds.width}x${bounds.height}`);
  console.log(`  Profile    : ${bounds.width}x${bounds.height}@${config.get().game.uiScale}`);
  console.log(`  Config     : ${config.path()}`);
  console.log(
    `  Shown      : ${
      follow.enabled && watching
        ? `only while the "${follow.windowTitle}" window is in front`
        : 'always'
    }`
  );
  console.log('');

  if (!hotkeyRegistered) {
    console.log(`  /!\\  Hotkey ${hotkey} could not be registered: another`);
    console.log('       application has claimed it. Change "hotkey" in the');
    console.log('       config file above, then start again.');
    console.log('');
  }

  console.log('  The window is transparent and stays out of the taskbar:');
  console.log('  seeing nothing until the menu is open is expected.');
  console.log('  Ctrl+C here to quit.');
  console.log('');
}

// Single instance: two overlays would fight over the hotkey and stack two aim dots.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => overlay?.showInactive());

  app.whenReady().then(() => {
    config.load();
    log.start(app.getPath('userData'));
    createOverlay();
    startFocusWatcher();
    createTray(); // after the watcher: the menu greys out its own toggle when it cannot watch
    announce(registerHotkey());

    // Follow resolution changes so the overlay never ends up covering half the screen.
    screen.on('display-metrics-changed', (_event, display) => {
      if (display.id !== screen.getPrimaryDisplay().id) return;
      overlay?.setBounds(display.bounds);
      pushConfig();
    });
  });
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  focusWatcher.stop(); // otherwise the PowerShell loop outlives the app
});
app.on('window-all-closed', () => app.quit());

app.on('will-quit', () => {
  tray?.destroy();
  tray = null;
});

// --- Renderer requests -------------------------------------------------------------

ipcMain.handle('overlay:close-menu', () => setInteractive(false));

ipcMain.handle('overlay:save-config', (_event, patch) => {
  const previousHotkey = config.get().hotkey;
  const next = config.save(patch);
  if (next.hotkey !== previousHotkey) registerHotkey();
  updateVisibility(); // toggling "follow the game" takes effect immediately
  refreshTray(); // the tray shows the same toggles, so it must not drift from the menu
  pushConfig();
  return next;
});

ipcMain.handle('overlay:quit', () => app.quit());

/**
 * Writes a full account of one analysis to logs/, with the exact capture it was made from.
 *
 * The console alone is not enough to settle a disagreement about what the overlay saw: it
 * scrolls, it truncates objects, and it disappears with the window. A file next to the PNG
 * it came from can be read later, replayed offline, and compared against what was actually
 * on screen.
 */
ipcMain.handle('overlay:log-analysis', (_event, { report, dataUrl } = {}) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logs = join(OUTPUT_DIR(), 'logs');
  mkdirSync(logs, { recursive: true });

  const file = join(logs, `analyse-${stamp}.txt`);
  let png = null;

  if (dataUrl) {
    const captures = join(OUTPUT_DIR(), 'captures');
    mkdirSync(captures, { recursive: true });
    png = join(captures, `analyse-${stamp}.png`);
    writeFileSync(png, Buffer.from(dataUrl.split(',')[1], 'base64'));
  }

  writeFileSync(file, `${report}\n${png ? `\ncapture : ${png}\n` : ''}`, 'utf8');
  console.log(`[overlay] analysis saved: ${file}`);
  return { file, png };
});

/**
 * The item index and the recycler table, read once and kept in memory.
 * Served over IPC rather than fetched by the renderer: fetch() is blocked on file://
 * pages, and this keeps Node out of the renderer.
 */
let itemDbCache = null;
ipcMain.handle('overlay:item-db', () => {
  if (itemDbCache) return itemDbCache;

  const items = JSON.parse(readFileSync(join(DATA_DIR, 'items.json'), 'utf8'));
  const recipes = JSON.parse(readFileSync(join(DATA_DIR, 'recipes.json'), 'utf8'));
  const rustDir = findRustDir();

  if (!rustDir) {
    console.error('[overlay] Rust install not found: item icons will not show.');
    console.error(`[overlay] Set "rustDir" in ${config.path()}`);
  }

  itemDbCache = {
    items: items.items,
    recipes: recipes.recipes,
    // Trailing slash so the renderer only appends an encoded file name.
    iconBase: rustDir ? `${pathToFileURL(join(rustDir, 'Bundles', 'items')).href}/` : null,
  };

  console.log(
    `[overlay] Database loaded: ${itemDbCache.items.length} items, ` +
      `${Object.keys(recipes.recipes).length} recipes`
  );

  return itemDbCache;
});

/**
 * One-shot screen grab of the primary display, returned as a PNG data URL.
 * Capture happens on demand (the user asked for a calculation), never continuously —
 * that keeps the cost near zero and means no background frame pipeline to maintain.
 */
ipcMain.handle('overlay:capture-screen', async () => {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.size;

  // Hide first: otherwise the overlay's own cards and zone rectangles end up in the
  // screenshot it is about to analyse — and every slot they cover is read as garbage.
  //
  // hide() returns immediately, but the compositor has not necessarily dropped the window
  // from the frame the capture will read. Without this pause the overlay photographs
  // itself: that is exactly what happened here, and it corrupted recognition for weeks.
  const wasVisible = overlay?.isVisible();
  overlay?.hide();
  if (wasVisible) {
    await new Promise((resolve) => setTimeout(resolve, config.get().captureDelayMs));
  }

  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(width * display.scaleFactor),
        height: Math.round(height * display.scaleFactor),
      },
    });

    const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    if (!source) throw new Error('No screen source available');

    return {
      dataUrl: source.thumbnail.toDataURL(),
      size: source.thumbnail.getSize(),

      // Where the renderer's viewport actually sits on the screen, and how big the screen
      // is. The renderer used to assume its window covered the display exactly, and divide
      // the capture size by window.innerHeight to get a scale. Windows does not grant that
      // assumption: here the window came back 30 px shorter than the display, so every crop
      // was taken ~16 px too low and the matcher was reading the wrong pixels. Sending the
      // real rectangle removes the guess.
      window: overlay?.getContentBounds() ?? null,
      display: { bounds: display.bounds, scaleFactor: display.scaleFactor },
    };
  } finally {
    if (wasVisible) {
      overlay.showInactive();
      if (menuOpen) overlay.focus();
    }
  }
});
