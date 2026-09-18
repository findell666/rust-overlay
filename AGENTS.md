# AGENTS.md

Electron overlay for the game Rust (Windows). No test suite, no linter, no TS — verification
happens through the simulation/replay tools under `tools/`.

## The rule that outranks everything

**Never touch the game process.** No DLL injection, no DirectX hooks, no reading or writing
`RustClient.exe` memory. The overlay is an ordinary transparent always-on-top window plus OS
screen capture, and that is what keeps it on the right side of EasyAntiCheat. Reject any
"optimisation" that requires attaching to the game, on principle. Consequence: the game must
run borderless-windowed (exclusive fullscreen owns the display and blocks compositing).

## Commands

```bash
npm install
npm start          # runs scripts/start.js, not electron . — see gotchas
npm run dist       # Windows installers into dist/
npm run dist:dir   # unpacked app only; much faster packaging check
npm run make-icon  # regenerates assets/icon.ico — the icon is generated, never hand-drawn
```

Recognition verification (in lieu of tests):

```bash
npm run sim-counts       # renders slots like the game does, scores the matcher
npm run test-quantity    # stack-count reader, end to end
npm run replay -- tools/replay-capture.mjs captures/<file>.png [zoneId]  # replay a real capture
node tools/diagnose-match.mjs                                             # debug a single bad match
```

Item database regeneration (only after a game patch; `data/*.json` is generated **and
committed**, so neither CI nor the app needs Rust installed):

```bash
npm run build-db         # data/items.json — needs the local Rust install
npm run extract-bundle    # data/recipes.json — needs python3 + UnityPy
npm run audit-db         # optional quality check on the index
```

Both accept `--rust-dir <path>`, or set `RUST_DIR` in the environment.

Raid-planner data (`data/raid-structures.json`, `data/raid-damage.json`) is the exception:
**hand-collected, never generated** — damage values are measured in game with all
multipliers baked in, and crafting costs are not stored at all (the planner joins weapon
shortnames against `recipes.json`). Audit it after every edit:

```bash
npm run audit-raid -- -verbose     # schema + recipe joins + collection coverage; non-zero on errors
```

Test screenshots for the HP reader live in gitignored `captures/raid/`, with expected
values encoded in the filename (`wall-stone_320_500.png`, `negative_01.png`). In dev builds
the overlay registers an F7 global hotkey that saves a raw capture straight into that
folder (`captureHotkey`/`captureDir` in `config.json`; never registered when packaged).

The raid planner itself is specified in `docs/specs/spec_feat_raid_planner.md` — read it
first when resuming that work. It holds the design decisions, the data conventions and the
open questions (tagged `<ToDo>`). Current state: data collection tooling only — the F5
feature, the HP reader and the suggestion algorithm are **not implemented yet**.

## Environment gotchas

- **Windows is the dev target.** Electron must launch from the Windows side. The Node tools
  run fine from WSL (they resolve Rust via `/mnt/c` too), but keep the repo on a Windows
  drive (`C:\...` / `/mnt/c/...`), never on a `\\wsl$` path.
- `npm start` goes through `scripts/start.js` because antivirus products quarantine the
  npm-extracted `electron.exe`. Escape hatches: `electron-dist.txt` (gitignored) or
  `ELECTRON_OVERRIDE_DIST_PATH`. Don't "simplify" the launcher away.
- `captures/` and `logs/` are gitignored for a reason: they are pictures of someone's screen.

## Architecture and boundaries

- `src/main/` — Electron main process: window, hotkey, capture, focus watcher, config.
  CommonJS. Runtime output goes to `userData` when packaged (app.asar is read-only), never
  next to the app.
- `src/renderer/` — the whole UI plus recognition (`recognize.js`, `quantity.js`, `text.js`).
  Loaded over `file://`.
- `src/shared/fingerprint.js` — a **classic script, not an ES module, on purpose**: Chromium
  refuses module scripts over `file://`. It exposes itself on `globalThis` for the renderer
  and via `module.exports` for the Node tools, so both sides compute identical numbers.
  Do not convert it to ESM.
- `tools/` — build-time and diagnostic tools. Has its own `package.json` with
  `"type": "module"` (ESM) and its own `package-lock.json`; only `pngjs` as a dependency.
- `data/` — generated databases, committed. Never bake absolute paths (e.g. the Rust install
  dir) into them; `tools/rust-dir.mjs` resolves the install at run time precisely to avoid
  that.

## Packaging constraints (in `package.json` `build`)

- `files` deliberately ships only `src/`, `data/*.json` and the icon — tools, captures and
  logs must never end up in a user's download.
- `koffi` (native binding) must stay in `asarUnpack`; the loader needs a real file on disk.

## Release flow

Push a tag `v*`; `.github/workflows/release.yml` builds on `windows-latest` and opens a
**draft** release (review, then publish). A tag containing `-` (e.g. `v0.0.1-alpha.1`) is
marked prerelease automatically.

## Further reading

- `docs/BUILDING.md` — build, DB regeneration, WSL setup, antivirus workaround.
- `docs/HOW-IT-WORKS.md` — recognition pipeline and measured accuracy numbers.
- `docs/USAGE.md` — user-facing guide; keep it in sync when a shipped feature changes.
- `docs/specs/spec_feat_raid_planner.md` — raid planner design, decisions and open ToDos.
