/**
 * The filesystem primitives, and the guard that proves localrepo kept its
 * promise.
 *
 * The link is written with `fs.symlink` and never by invoking npm. Two
 * separate reasons, both measured rather than assumed:
 *
 * - `npm install <path> --no-save` brings npm's peer resolution along, which
 *   hard-failed an app's boot on a missing peer dependency. Module resolution
 *   happens from the symlink's REAL path, whose ancestors have no
 *   `node_modules`, so the checkout needs its own installed tree.
 * - a `postinstall` hook that invokes an install recurses.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export function isGitCheckout(p) {
  return fs.existsSync(path.join(p, '.git'));
}

/** Is `child` at or below `parent`? Both must be absolute, real paths. */
export function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Where `node_modules/<name>` points, resolved, or null when it is not a link. */
export function linkTarget(appRoot, name) {
  const link = path.join(appRoot, 'node_modules', name);
  if (!isSymlink(link)) return null;
  try {
    return fs.realpathSync(link);
  } catch {
    // A dangling link is still linked intent; its target is simply gone.
    return path.resolve(path.dirname(link), fs.readlinkSync(link));
  }
}

/**
 * Write `node_modules/<name> -> <checkout>` and nothing else.
 *
 * The target is stored RELATIVE so the tree survives being moved or bind-mounted
 * into a container at a different path.
 */
export function writeLink(appRoot, name, checkout) {
  const link = path.join(appRoot, 'node_modules', name);
  fs.mkdirSync(path.dirname(link), {recursive: true});
  if (isSymlink(link)) fs.unlinkSync(link);
  else if (fs.existsSync(link)) fs.rmSync(link, {recursive: true, force: true});
  fs.symlinkSync(path.relative(path.dirname(link), checkout), link, 'dir');
  return link;
}

/** Every symlink directly under node_modules whose target leaves node_modules. */
export function scanLinks(appRoot) {
  const root = path.join(appRoot, 'node_modules');
  const out = [];
  let top;
  try {
    top = fs.readdirSync(root, {withFileTypes: true});
  } catch {
    return out;
  }
  const collect = (name, full) => {
    if (!isSymlink(full)) return;
    let target;
    try {
      target = fs.realpathSync(full);
    } catch {
      return;
    }
    if (isInside(target, root)) return; // an ordinary hoisting link, not a checkout
    out.push({name, target});
  };
  for (const item of top) {
    if (item.name === '.bin' || item.name.startsWith('.')) continue;
    const full = path.join(root, item.name);
    if (item.name.startsWith('@')) {
      let inner;
      try {
        inner = fs.readdirSync(full, {withFileTypes: true});
      } catch {
        continue;
      }
      for (const sub of inner) collect(`${item.name}/${sub.name}`, path.join(full, sub.name));
    } else {
      collect(item.name, full);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// the post-condition
// ---------------------------------------------------------------------------

/** The files no localrepo command may ever touch. */
export const MANIFEST_FILES = ['package.json', 'package-lock.json'];

/**
 * Hash the consumer's manifests.
 *
 * Content hashes, NOT `git status`. `git status` compares against HEAD, so in
 * any tree with an uncommitted `package.json` it reports a modification the
 * command did not make -- an earlier version of this tool shipped that bug and
 * reported correct runs as failures. Hashes also work in a tree with no git,
 * and catch an edit that HEAD happens to agree with.
 *
 * `latin1` is a byte-exact round-trip for arbitrary bytes; `utf8` is not.
 */
export function snapshotManifests(appRoot) {
  const snap = {};
  for (const file of MANIFEST_FILES) {
    try {
      const bytes = fs.readFileSync(path.join(appRoot, file), 'latin1');
      snap[file] = createHash('sha256').update(bytes, 'latin1').digest('hex');
    } catch {
      snap[file] = null;
    }
  }
  return snap;
}

/** @returns {string[]} a human description of each manifest that changed. */
export function diffManifests(before, after) {
  return MANIFEST_FILES.filter((f) => before[f] !== after[f]).map((f) => {
    if (before[f] === null) return `${f} (created)`;
    if (after[f] === null) return `${f} (deleted)`;
    return `${f} (modified)`;
  });
}
