# Building and developing

- [Requirements](#requirements)
- [Running from source](#running-from-source)
- [Building the Windows binaries](#building-the-windows-binaries)
- [Regenerating the item database](#regenerating-the-item-database)
- [The icon](#the-icon)
- [Releases](#releases)
- [Project layout](#project-layout)
- [Working from WSL](#working-from-wsl)
- [If your antivirus eats electron.exe](#if-your-antivirus-eats-electronexe)

## Requirements

- [Node.js](https://nodejs.org) 20 or newer, **installed on Windows** — Electron has to launch
  from the Windows side.
- Rust installed, if you want to regenerate the item database or see item icons. The committed
  `data/*.json` is enough to run the app without it; only the icons will be missing.
- Python 3 with [UnityPy](https://pypi.org/project/UnityPy/), only to re-extract recipes.

## Running from source

```powershell
npm install
npm start
```

`npm start` goes through `scripts/start.js`, which launches Electron directly rather than
through the npm wrapper — see [the antivirus note](#if-your-antivirus-eats-electronexe) for why.

## Building the Windows binaries

```powershell
npm run make-icon      # only needed if assets/icon.ico is missing or the icon changed
npm run dist
```

Output lands in `dist/`:

- `RustOverlay-<version>-setup.exe` — NSIS installer, per-user, choosable directory
- `RustOverlay-<version>-portable.exe` — one self-contained file

`npm run dist:dir` skips the installers and produces just the unpacked app, which is much
faster when you only want to check that packaging works.

Two things are worth knowing about the packaging config in `package.json`:

- **`files`** deliberately lists only `src/`, `data/*.json` and the icon. The tools, the
  captures and the logs are development material and must never end up in someone else's
  download.
- **`asarUnpack`** keeps `koffi` outside the asar archive. It is a native binding, and the
  loader needs a real file on disk.

The binaries are unsigned. Windows SmartScreen will warn on first run, and there is no way
around that short of buying a code-signing certificate.

## Regenerating the item database

After a game patch:

```powershell
npm run build-db        # data/items.json — icons, metadata, fingerprints
npm run extract-bundle  # data/recipes.json — recipes and recycler yields
npm run audit-db        # optional: how separable the resulting index is
```

Both find Rust in the usual Steam locations. If yours is elsewhere:

```powershell
npm run build-db -- --rust-dir "D:/SteamLibrary/steamapps/common/Rust"
```

or set `RUST_DIR` once in the environment, which every tool honours.

## The icon

`assets/icon.ico` is generated, not drawn by hand:

```powershell
npm run make-icon
```

`tools/make-icon.mjs` renders the shapes from distance functions at 4× and box-filters them
down to 16, 24, 32, 48, 64, 128 and 256 px, then packs the lot into a single `.ico`. Change a
radius, rerun, done — no binary asset that nobody can edit.

## Releases

Push a tag and GitHub Actions does the rest:

```bash
git tag v0.2.0
git push origin v0.2.0
```

`.github/workflows/release.yml` builds on `windows-latest`, packages both binaries, and opens a
**draft** release with them attached. Review it, then publish. The workflow needs no game
install, because `data/*.json` is committed.

## Project layout

```
src/main/        Electron main process: window, hotkey, capture, focus watching, config
src/renderer/    the whole UI, plus recognition (recognize, quantity, text)
src/shared/      fingerprinting, shared by the renderer and the build tools
data/            generated item and recipe databases (committed)
tools/           database builders, simulators and diagnostics
assets/          the generated icon
static/          screenshots used by the documentation
```

`src/shared/fingerprint.js` is a classic script rather than an ES module on purpose: Chromium
refuses to load module scripts over `file://`, which is how the overlay page is served. It
exposes itself on `globalThis` for the renderer and via `module.exports` for the Node tools, so
both sides compute identical numbers from one implementation.

## Working from WSL

You can edit from WSL and run from Windows, but **keep the repository on a Windows drive**
(`C:\...`, reachable as `/mnt/c/...`). Installing and running Electron from a `\\wsl$\` path
extracts 200 MB of binaries onto the 9p filesystem and runs the Chromium sandbox through a UNC
path: slow and unreliable.

The usual arrangement is to clone on `C:` and, if you want it visible in a WSL workspace,
symlink it:

```bash
ln -s /mnt/c/path/to/rust-overlay ~/projects/rust-overlay
```

The Node tools all run fine from WSL — they resolve the Rust install through `/mnt/c` as well
as `C:`.

## If your antivirus eats electron.exe

Symptom: `npm start` re-downloads Electron every time and fails with
`failed to create ...\dist\electron.exe: Access denied (os error 5)`.

Some antivirus products treat a freshly extracted `electron.exe` as suspicious, quarantine it,
and then **refuse any write to that path** — including a plain text file with that name. Adding
a folder exclusion does not always lift a block already in place.

Work around it by putting an Electron distribution somewhere else and pointing the launcher at
it:

```powershell
$zip = "$env:LOCALAPPDATA\electron\Cache\<hash>\electron-v43.4.0-win32-x64.zip"
Expand-Archive $zip -DestinationPath C:\electron-43
Set-Content electron-dist.txt "C:\electron-43"
npm start
```

`scripts/start.js` picks that file up and launches the binary directly, bypassing the npm
package entirely. `ELECTRON_OVERRIDE_DIST_PATH` takes precedence if it is set.
`electron-dist.txt` is gitignored — it is machine-specific by nature.
