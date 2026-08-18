// Mirrors everything the app prints to a file next to its settings.
//
// A packaged build has no console window. Every diagnosis this app prints — which window is in
// front, whether the hotkey registered, why the focus watcher gave up — was therefore visible
// only when running from source, which is exactly backwards: the people who need it most are
// the ones who downloaded a binary.
//
// Truncated at each start and capped, so it stays a record of the current session rather than
// a file that grows forever.

const { appendFileSync, writeFileSync, mkdirSync, statSync } = require('node:fs');
const { join, dirname } = require('node:path');

const MAX_BYTES = 512 * 1024;

let path = null;
let overflowed = false;

const stamp = () => new Date().toISOString().slice(11, 23);

function write(level, args) {
  if (!path || overflowed) return;

  try {
    const line = args
      .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
      .join(' ');
    appendFileSync(path, `${stamp()} ${level} ${line}\n`);

    if (statSync(path).size > MAX_BYTES) {
      appendFileSync(path, `${stamp()} INFO log capped at ${MAX_BYTES} bytes\n`);
      overflowed = true;
    }
  } catch {
    // Logging must never be the thing that breaks the app.
  }
}

/** @param {string} dir where to put overlay.log — the app's user data directory */
function start(dir) {
  path = join(dir, 'overlay.log');

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${stamp()} INFO --- Rust Overlay started ---\n`);
  } catch {
    path = null;
    return null;
  }

  for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      write(level === 'log' ? 'INFO' : level.toUpperCase(), args);
    };
  }

  return path;
}

module.exports = { start, path: () => path };
