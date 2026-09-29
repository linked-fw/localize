/**
 * `localize` -- turn an npm-installed dependency into an editable git checkout.
 *
 * The loop, in five steps, none of which involve npm learning anything:
 *
 *   1. npm name -> registry `repository` (see resolve.js)
 *   2. `git clone` into `<dir>/<name>`
 *   3. **`npm install` INSIDE the checkout**
 *   4. `fs.symlink` node_modules/<name> -> the checkout
 *   5. record it in a gitignored manifest
 *
 * Step 3 is the one that is easy to "simplify" and must not be. Installing
 * from the parent instead -- `npm install <path> --no-save` -- hard-failed an
 * app's boot on a missing peer dependency, because module resolution happens
 * from the symlink's REAL path, whose ancestors have no `node_modules`. The
 * checkout needs its own installed tree. `test/real-localize.test.js` runs a
 * real clone and a real install and asserts the dependency landed inside the
 * checkout, so a reimplementation that moves the install back out fails there.
 *
 * A clone, not a copy: a published tarball has no `src/`, so copying the
 * installed package cannot give you something to edit.
 *
 * What localize NEVER does: run an install at the consumer root, or edit
 * `package.json`, `package-lock.json`, `.gitignore`, `workspaces` or any
 * bundler config. It asserts it did not before exiting 0.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  EXIT_INSTALL_FAILED,
  EXIT_MANIFEST_DIRTY,
  EXIT_REFUSED,
  EXIT_WARNED,
  LocalpkgError,
} from './errors.js';
import {DEFAULT_DIR, SCHEMA_VERSION, readManifest, writeManifest} from './manifest.js';
import {resolvePackage} from './resolve.js';
import {
  diffManifests,
  isGitCheckout,
  isInside,
  isSymlink,
  readJson,
  snapshotManifests,
  writeLink,
} from './fsops.js';

/**
 * @param {string[]} names  full npm package names
 * @param {object} opts  `{force, dir, repo, subdir, build}`
 * @param {object} deps  `{appRoot, run, log, warn, error}`
 * @returns {number} the process exit code: the HIGHEST of the per-name codes,
 *   since each name is atomic and a failure on name 2 does not undo name 1.
 */
export function localize(names, opts, deps) {
  // Taken BEFORE anything runs: the post-condition is about what THIS run
  // changed, not about what the tree looked like at HEAD.
  const before = snapshotManifests(deps.appRoot);

  let manifest;
  try {
    manifest = readManifest(deps.appRoot, deps);
  } catch (e) {
    return reportError(e, deps);
  }

  const dir = opts.dir ?? manifest.dir ?? DEFAULT_DIR;
  const entries = {...manifest.entries};
  let code = 0;

  for (const name of names) {
    try {
      const result = localizeOne(name, dir, entries[name], opts, deps);
      if (result.entry) entries[result.entry.name] = result.entry.value;
      code = Math.max(code, result.code);
      // Written after EACH name, so an interruption keeps what already worked.
      writeManifest(deps.appRoot, {version: SCHEMA_VERSION, dir, packages: entries});
    } catch (e) {
      code = Math.max(code, reportError(e, deps));
    }
  }

  code = Math.max(code, assertLinked(entries, deps));
  code = Math.max(code, assertManifestsUntouched(before, deps));
  return code;
}

function localizeOne(name, dir, recorded, opts, deps) {
  // An override recorded by an earlier run is reused, so `--repo` is a
  // one-time cost rather than something to remember on every invocation.
  const override = opts.repo
    ? {repo: opts.repo, subdir: opts.subdir}
    : recorded?.repo && !looksLikeOrgSlug(recorded.repo)
      ? {repo: recorded.repo, subdir: recorded.subdir}
      : undefined;

  const resolved = resolvePackage(name, deps, override);
  let code = 0;

  const relClone = path.join(dir, resolved.checkoutName);
  const clone = path.join(deps.appRoot, relClone);
  // When the repository holds more than this package, the CHECKOUT is the
  // clone but the PACKAGE is a directory inside it: that is where the install
  // runs and that is what the symlink points at.
  const relPkg = resolved.subdir ? path.join(relClone, resolved.subdir) : relClone;
  const pkgDir = path.join(deps.appRoot, relPkg);

  guardForeignLink(resolved.npmName, dir, opts, deps);

  if (isGitCheckout(clone)) {
    code = Math.max(code, refresh(relClone, clone, deps));
    if (code === EXIT_WARNED) return {code}; // a non-fast-forward is reported, never forced
  } else {
    fs.mkdirSync(path.dirname(clone), {recursive: true});
    deps.log(`[localrepo] cloning ${resolved.repo} -> ${relClone}`);
    const r = deps.run('git', ['clone', resolved.repo, clone]);
    if (r.status !== 0) {
      throw new LocalpkgError(
        `git clone ${resolved.repo} failed:\n${(r.stderr || r.stdout).trim()}`,
        EXIT_REFUSED,
      );
    }
  }

  if (!fs.existsSync(path.join(pkgDir, 'package.json'))) {
    throw new LocalpkgError(
      `${relPkg} has no package.json, so it is not the package "${name}".\n` +
        (resolved.subdir
          ? `The registry says "${name}" lives in "${resolved.subdir}" of ${resolved.repo}, and it does not.`
          : `${resolved.repo} looks like a monorepo root. Say where the package lives:\n` +
            `  localrepo ${name} --repo ${resolved.repo} --subdir <path-inside-the-repo>`),
      EXIT_REFUSED,
    );
  }

  // The checkout's own package.json is authoritative about the name: a
  // mismatch means the symlink would be written under a name nothing imports.
  const declared = readJson(path.join(pkgDir, 'package.json'))?.name;
  if (declared && declared !== resolved.npmName) {
    throw new LocalpkgError(
      `${relPkg} declares itself as "${declared}", not "${name}".\n` +
        (resolved.subdir
          ? `The registry's repository.directory for "${name}" points at the wrong package.`
          : `${resolved.repo} is probably a monorepo. Point at the right directory:\n` +
            `  localrepo ${name} --repo ${resolved.repo} --subdir <path-inside-the-repo>`),
      EXIT_REFUSED,
    );
  }

  // THE constraint. Read the module header before changing this.
  deps.log(`[localrepo] npm install in ${relPkg}`);
  const install = deps.run('npm', ['install', '--no-audit', '--no-fund'], {cwd: pkgDir});
  if (install.status !== 0) {
    throw new LocalpkgError(
      `npm install failed in ${relPkg}:\n${(install.stderr || install.stdout).trim()}\n` +
        `The checkout is left on disk. Nothing was linked and nothing was recorded.`,
      EXIT_INSTALL_FAILED,
    );
  }

  // The build is the one thing localrepo does not know how to do, so it is
  // configuration rather than behaviour. A failure is a WARNING: a package
  // whose build is broken is exactly what you are about to fix, and refusing
  // to link it would be perverse.
  if (runBuild(relPkg, pkgDir, opts, deps) === 'failed') code = Math.max(code, EXIT_WARNED);

  writeLink(deps.appRoot, resolved.npmName, pkgDir);
  const branch = currentBranch(clone, deps);
  deps.log(`[localrepo] linked ${resolved.npmName} -> ${relPkg} (branch ${branch})`);

  const range = declaredRange(resolved.npmName, deps);
  return {
    code,
    entry: {
      name: resolved.npmName,
      value: {
        repo: resolved.repo,
        path: relPkg,
        branch,
        ...(resolved.subdir ? {subdir: resolved.subdir} : {}),
        ...(range ? {range} : {}),
      },
    },
  };
}

/** Older manifests recorded `owner/repo`; those are re-resolved rather than cloned blind. */
function looksLikeOrgSlug(repo) {
  return /^[\w.-]+\/[\w.-]+$/.test(repo);
}

/**
 * Reuse an existing clone. A dirty tree is reused WITHOUT pulling and said so;
 * a clean one is fast-forwarded; a non-fast-forward is reported and skipped
 * rather than forced, because the developer's commits are the entire point.
 */
function refresh(relPath, clone, deps) {
  const status = deps.run('git', ['status', '--porcelain'], {cwd: clone});
  const modified = status.stdout.split('\n').filter((l) => l.trim()).length;
  if (modified > 0) {
    deps.log(`[localrepo] ${relPath}: ${modified} modified file${modified === 1 ? '' : 's'} — not pulling`);
    return 0;
  }
  const pull = deps.run('git', ['pull', '--ff-only'], {cwd: clone});
  if (pull.status !== 0) {
    deps.warn(
      `[localrepo] ${relPath}: \`git pull --ff-only\` failed (not a fast-forward) — skipped, not ` +
        `forced. Reconcile it by hand:\n${(pull.stderr || pull.stdout).trim()}`,
    );
    return EXIT_WARNED;
  }
  return 0;
}

/**
 * Run the configured build command, if there is one.
 *
 * localrepo has no opinion about how a checkout is built, and does not look for
 * a builder. `--build "<cmd>"`, or a `build` field in the manifest, or
 * `{build}` in the programmatic options. Absent -- the common case, and the
 * case for anything whose dev loop reads source directly -- nothing runs and
 * nothing is said.
 */
function runBuild(relPath, pkgDir, opts, deps) {
  const cmd = opts.build;
  if (!cmd) return 'skipped';
  deps.log(`[localrepo] ${relPath}: ${cmd}`);
  const r = deps.run(cmd, [], {cwd: pkgDir, shell: true});
  if (r.status !== 0) {
    deps.warn(
      `[localrepo] ${relPath}: \`${cmd}\` failed. The package is linked and recorded anyway — ` +
        `a package whose build is broken is exactly what you are about to fix.\n` +
        `${(r.stderr || r.stdout).trim()}`,
    );
    return 'failed';
  }
  return 'ok';
}

/** Refuse when `node_modules/<name>` is already a symlink pointing outside `<dir>`. */
function guardForeignLink(npmName, dir, opts, deps) {
  const link = path.join(deps.appRoot, 'node_modules', npmName);
  if (!isSymlink(link)) return;
  let target;
  try {
    target = fs.realpathSync(link);
  } catch {
    return; // a dangling link is ours to replace
  }
  if (isInside(target, path.join(deps.appRoot, dir))) return;
  if (opts.force) {
    deps.warn(`[localrepo] --force: overwriting the existing link ${npmName} -> ${target}`);
    return;
  }
  throw new LocalpkgError(
    `node_modules/${npmName} is already a symlink to ${target}, which is outside ${dir}.\n` +
      `Refusing to overwrite someone else's link. Pass --force to replace it.`,
    EXIT_REFUSED,
  );
}

/** Every recorded package is actually linked where the manifest says it is. */
function assertLinked(entries, deps) {
  let code = 0;
  for (const [name, entry] of Object.entries(entries)) {
    const link = path.join(deps.appRoot, 'node_modules', name);
    const expected = path.join(deps.appRoot, entry.path);
    if (!isSymlink(link)) {
      deps.warn(`[localrepo] ${name} is recorded but node_modules/${name} is not a symlink.`);
      code = Math.max(code, EXIT_WARNED);
      continue;
    }
    if (!fs.existsSync(expected)) continue; // "checkout missing" is a --list state, not a failure
    if (fs.realpathSync(link) !== fs.realpathSync(expected)) {
      deps.warn(
        `[localrepo] ${name} links to ${fs.realpathSync(link)} but the manifest records ${entry.path}.`,
      );
      code = Math.max(code, EXIT_WARNED);
    }
  }
  return code;
}

/**
 * The property the whole design rests on: this run changed neither manifest.
 *
 * Content hashes, not `git status`. `git status` compares against HEAD, so in
 * any tree with an uncommitted `package.json` it reports a modification the
 * command did not make -- an earlier tool shipped exactly that and reported
 * correct runs as failures.
 */
export function assertManifestsUntouched(before, deps) {
  const changed = diffManifests(before, snapshotManifests(deps.appRoot));
  if (!changed.length) return 0;
  deps.error(
    `[localrepo] the consumer's manifests changed while this command ran:\n` +
      changed.map((c) => `  ${c}`).join('\n') +
      `\nThis is the exact failure localrepo exists to prevent. Revert those files; nothing in ` +
      `localrepo is supposed to touch them.`,
  );
  return EXIT_MANIFEST_DIRTY;
}

export function reportError(e, deps) {
  if (e instanceof LocalpkgError) {
    deps.error(`[localrepo] ${e.message}`);
    return e.code;
  }
  throw e;
}

export function currentBranch(clone, deps) {
  const r = deps.run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {cwd: clone});
  const b = r.stdout.trim();
  return r.status === 0 && b ? b : 'HEAD';
}

export function declaredRange(name, deps) {
  const pkg = readJson(path.join(deps.appRoot, 'package.json'));
  if (!pkg) return undefined;
  return pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? pkg.optionalDependencies?.[name];
}
