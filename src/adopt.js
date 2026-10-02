/**
 * `adopt` -- localize a checkout that is ALREADY in the checkout directory,
 * without asking the registry or a remote anything.
 *
 * `localize` gets its checkout by resolving the published `repository` and
 * cloning it. That cannot work for two kinds of checkout that nonetheless
 * belong in `<dir>`:
 *
 * - a package created locally and never published, which may not even have a
 *   remote yet;
 * - a clone that was put there by hand.
 *
 * `adopt` takes the checkout as it finds it -- no clone, no pull, no fetch --
 * and runs the same tail as `localize`: install inside it, build, symlink,
 * record. The checkout has to be a git checkout at `<dir>/<checkoutName>`, so
 * that `localize` and `adopt` can never disagree about where a package lives.
 *
 * The recorded `repo` is `--repo` when given, else the checkout's `origin`,
 * else what an earlier run recorded, else absent. Absent is fine: `relink`,
 * `--list` and `remove` never need it.
 */
import fs from 'node:fs';
import path from 'node:path';

import {EXIT_REFUSED, LocalizeError} from './errors.js';
import {forEachName, guardForeignLink, installLinkAndRecord, reportError} from './localize.js';
import {checkoutNameFor, normalizeGitUrl} from './resolve.js';
import {isGitCheckout, readJson} from './fsops.js';

/**
 * @param {string[]} names  full npm package names
 * @param {object} opts  `{dir, repo, build, force}`
 * @param {object} deps  `{appRoot, run, log, warn, error}`
 * @returns {number} the process exit code, as `localize` returns it.
 */
export function adopt(names, opts, deps) {
  if (opts.repo && names.length > 1) {
    return reportError(
      new LocalizeError(
        `--repo names one repository, so it can only be used when adopting one package.`,
        EXIT_REFUSED,
      ),
      deps,
    );
  }
  return forEachName(names, opts, deps, adoptOne);
}

function adoptOne(name, dir, recorded, opts, deps) {
  const relPkg = path.join(dir, checkoutNameFor(name));
  const pkgDir = path.join(deps.appRoot, relPkg);

  if (!fs.existsSync(pkgDir)) {
    throw new LocalizeError(
      `there is nothing to adopt at ${relPkg}.\n` +
        `adopt links a checkout that is already there. To clone a published package instead:\n` +
        `  linked-localize ${name}`,
      EXIT_REFUSED,
    );
  }
  if (!isGitCheckout(pkgDir)) {
    throw new LocalizeError(
      `${relPkg} is not a git checkout. Run \`git init\` in it first -- localize tracks a ` +
        `checkout's branch, and a checkout without history has none.`,
      EXIT_REFUSED,
    );
  }

  const declared = readJson(path.join(pkgDir, 'package.json'))?.name;
  if (declared !== name) {
    throw new LocalizeError(
      declared
        ? `${relPkg} declares itself as "${declared}", not "${name}".`
        : `${relPkg} has no package.json naming it, so it is not the package "${name}".`,
      EXIT_REFUSED,
    );
  }

  if (recorded?.subdir) {
    deps.warn(
      `[localize] ${name} was recorded inside a monorepo (${recorded.path}); adopt replaces that ` +
        `with ${relPkg}.`,
    );
  }

  guardForeignLink(name, dir, opts, deps);

  const repo = opts.repo ? normalizeGitUrl(opts.repo) : originOf(pkgDir, deps) ?? recorded?.repo;
  deps.log(`[localize] adopting ${relPkg}${repo ? ` (${repo})` : ' (no remote)'}`);

  return installLinkAndRecord({npmName: name, clone: pkgDir, relPkg, pkgDir, repo}, opts, deps);
}

/** The checkout's `origin` URL, or undefined when it has none. Read, never fetched. */
function originOf(pkgDir, deps) {
  const r = deps.run('git', ['remote', 'get-url', 'origin'], {cwd: pkgDir});
  const url = r.stdout.trim();
  return r.status === 0 && url ? normalizeGitUrl(url) : undefined;
}
