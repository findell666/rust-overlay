// Finds the Rust installation, for the tools that need its icons or its bundles.
//
// Kept out of the generated data files on purpose: an absolute path baked into
// data/items.json would be wrong on every machine but the one that generated it, and it is
// the kind of thing that quietly ends up in a public repository.
//
// Resolution order: --rust-dir on the command line, then RUST_DIR in the environment, then
// the usual Steam locations on Windows, WSL and Linux.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const CANDIDATES = [
  'C:/Program Files (x86)/Steam/steamapps/common/Rust',
  'C:/Program Files/Steam/steamapps/common/Rust',
  'D:/Steam/steamapps/common/Rust',
  'D:/SteamLibrary/steamapps/common/Rust',
  'E:/SteamLibrary/steamapps/common/Rust',
  // Same drives seen from WSL, so the tools run from either side.
  '/mnt/c/Program Files (x86)/Steam/steamapps/common/Rust',
  '/mnt/c/Program Files/Steam/steamapps/common/Rust',
  '/mnt/d/Steam/steamapps/common/Rust',
  '/mnt/d/SteamLibrary/steamapps/common/Rust',
  '/mnt/e/SteamLibrary/steamapps/common/Rust',
];

const looksRight = (dir) => Boolean(dir) && existsSync(join(dir, 'Bundles', 'items'));

/**
 * @param {string[]} [argv] defaults to the current process arguments
 * @returns {string} the install directory
 * @throws when the game cannot be found, with the list of places that were tried
 */
export function findRustDir(argv = process.argv) {
  const flag = argv.indexOf('--rust-dir');
  const explicit = flag >= 0 ? argv[flag + 1] : process.env.RUST_DIR;

  if (explicit) {
    if (looksRight(explicit)) return explicit;
    throw new Error(`No Bundles/items under ${explicit}`);
  }

  const found = CANDIDATES.find(looksRight);
  if (found) return found;

  throw new Error(
    'Rust installation not found. Pass --rust-dir "D:/path/to/Rust", or set RUST_DIR.\n' +
      `Looked in:\n  ${CANDIDATES.join('\n  ')}`
  );
}

/** Where the item icons live. */
export const iconsDir = (rustDir = findRustDir()) => join(rustDir, 'Bundles', 'items');

export { CANDIDATES };
