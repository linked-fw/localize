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
 * - **It never invokes npm.** A postinstall that installs, recurses. A test
 *   asserts no npm invocation on any code path.
 */
import fs from 'node:fs';
import path from 'node:path';

import {readManifest} from './manifest.js';
import {isSymlink, readJson, writeLink} from './fsops.js';
import {declaredRange} from './localize.js';

export function relink(deps) {
  let manifest;
  try {
    manifest = readManifest(deps.appRoot, deps);
  } catch (e) {
    // Even a refusal is only a warning here: never fail an install.
    deps.warn(`[localrepo] ${e.message}`);
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
        `[localrepo] ${name} is recorded as local but ${entry.path} is gone — using the registry ` +
          `copy. \`localrepo ${name}\` to re-clone.`,
      );
      continue;
    }

    if (isSymlink(path.join(deps.appRoot, 'node_modules', name))) {
      // Already linked; rewriting it would be noise on every install.
      const existing = fs.realpathSync(path.join(deps.appRoot, 'node_modules', name));
      if (existing === fs.realpathSync(checkout)) continue;
    }

    writeLink(deps.appRoot, name, checkout);
    relinked++;
    deps.log(`[localrepo] relinked ${name} -> ${entry.path} (branch ${entry.branch})`);
    warnRangeDrift(name, entry, checkout, deps);
  }

  if (relinked) {
    deps.log(
      `[localrepo] ${relinked} local package${relinked === 1 ? '' : 's'} relinked. ` +
        '`localrepo --list` for detail.',
    );
  }
  return 0;
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
    `[localrepo] ${name}: checkout is ${version}, package.json asks ${declared}` +
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
