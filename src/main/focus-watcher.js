// Reports which window currently owns the foreground, so the overlay can show itself only
// while Rust is the active window.
//
// Two read-only calls into user32: GetForegroundWindow, then GetWindowText on the handle it
// returns. Nothing is opened, read or attached to the game process — this asks the window
// manager which window is in front and what it is called, which is what Task Manager does to
// draw its list. That keeps the feature inside the project's rule of zero contact with Rust.
//
// It used to be a PowerShell loop instead, and that was a mistake twice over. It asked
// Get-Process about the foreground window's PID, which is more than we need; and running it
// meant a long, base64-encoded PowerShell command line, which is what malware droppers look
// like. AVG blocked it on sight (IDP.HELU.PSE88, "command line detection") — correctly, by
// its own rules. Calling the API directly has no command line for a heuristic to read.
//
// The FFI binding is optional: if it cannot be loaded, the watcher simply reports that it is
// unavailable and the overlay stays visible. A missing nicety must never become a missing app.

const POLL_MS = 250;

let koffi = null;
let GetForegroundWindow = null;
let GetWindowText = null;

function bind() {
  if (GetForegroundWindow) return true;
  if (process.platform !== 'win32') return false;

  // Each step is reported on its own, because they fail for completely different reasons:
  // the module can be missing from the package, its native binary can be quarantined by an
  // antivirus, and the prototypes can be rejected by a different version of koffi. A single
  // "it did not work" would leave all three indistinguishable.
  try {
    koffi = require('koffi');
  } catch (err) {
    console.error(`[focus] koffi could not be loaded: ${err.message}`);
    return false;
  }

  let user32;
  try {
    user32 = koffi.load('user32.dll');
  } catch (err) {
    console.error(`[focus] user32.dll could not be opened: ${err.message}`);
    return false;
  }

  try {
    // No calling convention in the prototypes: on x64 there is only one, and naming it is a
    // needless way for a koffi version to disagree with us.
    GetForegroundWindow = user32.func('void* GetForegroundWindow()');
    // The W variant, so a title with an accent in it comes back intact.
    GetWindowText = user32.func(
      'int GetWindowTextW(void* hWnd, _Out_ uint16_t* lpString, int nMaxCount)'
    );
  } catch (err) {
    console.error(`[focus] user32 prototypes rejected: ${err.message}`);
    GetForegroundWindow = null;
    return false;
  }

  return true;
}

/** Title of the window currently in front, plus its handle as a comparable number. */
function readForeground() {
  const handle = GetForegroundWindow();
  if (!handle) return null;

  const buffer = new Uint16Array(512);
  const length = GetWindowText(handle, buffer, buffer.length);
  const title = length > 0 ? Buffer.from(buffer.buffer, 0, length * 2).toString('utf16le') : '';

  return { handle: koffi.address(handle).toString(), title: title.trim() };
}

let timer = null;
let current = null;
let handlers = null;

/**
 * @param {(front: {handle: string, title: string}) => void} onChange called when the window in
 *   front changes.
 * @param {(alive: boolean, reason?: string) => void} [onStatus] called if watching stops for
 *   good, so the caller can go back to showing the overlay unconditionally.
 * @returns {boolean} false when this platform or build cannot watch (everything stays visible).
 */
function start(onChange, onStatus) {
  stop();
  if (!bind()) return false;

  handlers = { onChange, onStatus };
  let failures = 0;

  timer = setInterval(() => {
    let front;
    try {
      front = readForeground();
    } catch (err) {
      // A transient failure is not worth reacting to, a persistent one is: after a few in a
      // row the binding is broken and the overlay should stop depending on it.
      if (++failures < 5) return;
      stop();
      console.error(`[focus] giving up on the foreground window: ${err.message}`);
      handlers?.onStatus?.(false, err.message);
      handlers = null;
      return;
    }

    failures = 0;
    if (!front) return;
    if (current && front.handle === current.handle && front.title === current.title) return;

    current = front;
    onChange(front);
  }, POLL_MS);

  timer.unref?.();
  return true;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

const foreground = () => current;

module.exports = {
  start,
  stop: () => {
    handlers = null;
    stop();
  },
  foreground,
};
