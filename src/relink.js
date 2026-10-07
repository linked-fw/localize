/**
 * `--relink` -- the `postinstall` hook. Recreate every recorded symlink after
 * an install removed it (`npm ci` deletes `node_modules` and exits 0).
 *
 * Three rules, each of which is the difference between a useful hook and one
 * everybody disables:
 *
 * - **It always exits 0.** A postinstall that fails an install because of a
 *   developer's private state is worse than the problem it solves.
 * - **With no manifest it produces NO output at all.** That is the CI case and
 *   the fresh-clone case. Any output there and people learn to ignore this
 *   hook's output, which is the one thing it can never become.
 * - **It never runs npm at the consumer root.** A postinstall that installs
 *   the root, recurses. A test asserts it.
 *
 * It DOES run `npm install` inside a checkout whose dependencies are gone, and
 * only then. Measured on npm 11: a root `npm install` treats a linked checkout
 * that sits under the root as part of the root's tree, marks its dependencies
 * `extraneous` and prunes them -- for a localized published dependency as
 * much as for an undeclared one. Putting the link back without the
 * dependencies leaves a checkout that cannot build. That install runs in the
 * checkout, never at the root, so it cannot re-enter this hook; and it runs
 * only when a declared dependency is missing, so an ordinary install stays
 * silent and fast.
 */
import fs from 'node:fs';
import path from 'node:path';

import {readManifest} from './manifest.js';
import {isSymlink, readJson, writeLink} from './fsops.js';
import {declaredRange} from './localize.js';
import {isProvidedByApp, pruneProvided, shouldPrune} from './prune.js';

/**
 * @param {object} deps
 * @param {{prune?: boolean, provided?: string[]}} [opts]  unless `prune` is
 *   false, every checkout's own copies of what the app provides are removed
 *   after relinking (see prune.js), and a dependency missing from a checkout
 *   because it was pruned is not mistaken for one a root install took.
 */
export function relink(deps, opts = {}) {
  let manifest;
  try {
    manifest = readManifest(deps.appRoot, deps);
  } catch (e) {
    // Even a refusal is only a warning here: never fail an install.
    deps.warn(`[localize] ${e.message}`);
    return 0;
  }

  if (!manifest.exists) return 0;
  const names = Object.keys(manifest.entries);
  if (!names.length) return 0;

  let relinked = 0;
  for (const name of names) {
    const entry = manifest.entries[name];
    const checkout = path.join(deps.appRoot, entry.path);

    if (!fs.existsSync(checkout)) {
      deps.warn(
        `[localize] ${name} is recorded as local but ${entry.path} is gone — using the registry ` +
          `copy. ` +
          (entry.repo
            ? `\`linked-localize ${name}\` to re-clone.`
            : `It has no recorded repository, so restore the checkout by hand, then ` +
              `\`linked-localize adopt ${name}\`.`),
      );
      continue;
    }

    reinstallIfPruned(name, entry, manifest.entries, opts, deps);

    if (isSymlink(path.join(deps.appRoot, 'node_modules', name))) {
      // Already linked; rewriting it would be noise on every install.
      const existing = fs.realpathSync(path.join(deps.appRoot, 'node_modules', name));
      if (existing === fs.realpathSync(checkout)) continue;
    }

    writeLink(deps.appRoot, name, checkout);
    relinked++;
    deps.log(`[localize] relinked ${name} -> ${entry.path} (branch ${entry.branch})`);
    warnRangeDrift(name, entry, checkout, deps);
  }

  if (relinked) {
    deps.log(
      `[localize] ${relinked} local package${relinked === 1 ? '' : 's'} relinked. ` +
        '`linked-localize --list` for detail.',
    );
  }

  if (shouldPrune(opts)) {
    try {
      pruneProvided(manifest.entries, opts, deps);
    } catch (e) {
      // Never fail an install over it.
      deps.warn(`[localize] pruning failed: ${e.message}`);
    }
  }
  return 0;
}

/**
 * Restore a checkout's own `node_modules` when a root install pruned it: any
 * declared dependency (or devDependency -- the checkout's build needs those)
 * missing from it. A failure warns; the hook still exits 0.
 */
function reinstallIfPruned(name, entry, entries, opts, deps) {
  const checkout = path.join(deps.appRoot, entry.path);
  // When pruning, a dependency the app provides is absent on purpose.
  const provided = shouldPrune(opts)
    ? (dep, range, pkg) => isProvidedByApp(dep, range, pkg, entries, opts, deps)
    : () => false;
  const missing = missingDependencies(checkout, cloneRootOf(entry, deps), provided);
  if (!missing.length) return;
  deps.log(
    `[localize] ${name}: ${missing.length} of its dependencies are gone from ${entry.path}/node_modules ` +
      `(a root install prunes a checkout under the root) — npm install in ${entry.path}`,
  );
  const r = deps.run('npm', ['install', '--no-audit', '--no-fund'], {cwd: checkout});
  if (r.status !== 0) {
    deps.warn(
      `[localize] ${name}: npm install in ${entry.path} failed — run it there yourself.\n` +
        `${(r.stderr || r.stdout).trim()}`,
    );
  }
}

/**
 * Declared dependency names found in neither the checkout's own `node_modules`
 * nor, for a package inside a monorepo, the clone root's -- where a workspaces
 * install hoists them. Checking only the package directory there would find
 * every hoisted dependency "missing" and reinstall on every postinstall.
 */
function missingDependencies(checkout, cloneRoot, provided = () => false) {
  const pkg = readJson(path.join(checkout, 'package.json'));
  if (!pkg) return [];
  const declared = {...pkg.devDependencies, ...pkg.dependencies};
  const roots = cloneRoot === checkout ? [checkout] : [checkout, cloneRoot];
  return Object.keys(declared).filter(
    (dep) =>
      !roots.some((root) => fs.existsSync(path.join(root, 'node_modules', dep))) &&
      !provided(dep, declared[dep], pkg),
  );
}

/** The clone a `subdir` entry lives in: its path with the subdir taken off the end. */
function cloneRootOf(entry, deps) {
  const pkgDir = path.join(deps.appRoot, entry.path);
  if (!entry.subdir) return pkgDir;
  const rel = path.normalize(entry.subdir);
  return pkgDir.endsWith(path.sep + rel) ? pkgDir.slice(0, -(rel.length + 1)) : pkgDir;
}

/**
 * npm matches a link by NAME and never checks the range, so a checkout at
 * 2.0.99 silently satisfies `^3.0.0` and `npm ls` does not flag it. This warns
 * and never errors, and the range is never used to decide whether a checkout
 * is usable -- only to say out loud that the declared range is now fiction.
 */
function warnRangeDrift(name, entry, checkout, deps) {
  const declared = declaredRange(name, deps);
  const version = readJson(path.join(checkout, 'package.json'))?.version;
  if (!declared || !version) return;
  if (sameMajor(version, declared) && (!entry.range || entry.range === declared)) return;
  deps.warn(
    `[localize] ${name}: checkout is ${version}, package.json asks ${declared}` +
      (entry.range ? ` (recorded ${entry.range})` : '') +
      ` — the symlink wins; npm does NOT check the range.`,
  );
}

/**
 * Deliberately crude: enough to spot obvious drift for a warning, never used
 * to gate anything. A real semver implementation here would be a dependency,
 * and would invite someone to treat the answer as a constraint.
 */
function sameMajor(version, range) {
  const m = /^[\^~]?(\d+)\./.exec(range);
  if (!m) return true;
  return version.split('.')[0] === m[1];
}
