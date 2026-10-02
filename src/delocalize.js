/**
 * `delocalize` -- reverse a localize WITHOUT deleting work.
 *
 * With no names, every recorded entry is delocalized, so there is one revert
 * verb rather than two.
 *
 * The checkout is LEFT ON DISK by default: uncommitted work lives there.
 * `--purge` deletes it, and refuses on uncommitted changes or unpushed commits
 * unless `--force`.
 *
 * The restore command is PRINTED, not run. localize never invokes an install
 * at the consumer root -- that is the rule the whole design rests on, and it
 * does not get an exception for the convenient case. The printed line carries
 * `--no-save`, which is load-bearing rather than tidy: a plain
 * `npm install <name>@<range>` rewrites the range in package.json to whatever
 * it resolved and rewrites the lockfile with it, so a developer following the
 * tool's own advice would end the cycle with the exact diff the tool exists to
 * prevent.
 */
import fs from 'node:fs';
import path from 'node:path';

import {EXIT_WARNED} from './errors.js';
import {SCHEMA_VERSION, readManifest, writeManifest} from './manifest.js';
import {isInside, isSymlink, snapshotManifests} from './fsops.js';
import {assertManifestsUntouched, declaredRange, reportError} from './localize.js';

export function delocalize(names, opts, deps) {
  const before = snapshotManifests(deps.appRoot);

  let manifest;
  try {
    manifest = readManifest(deps.appRoot, deps);
  } catch (e) {
    return reportError(e, deps);
  }

  const dir = manifest.dir;
  const entries = {...manifest.entries};
  const targets = names.length ? names.map((n) => toRecordedName(n, entries)) : Object.keys(entries);
  let code = 0;

  for (const name of targets) {
    const entry = entries[name];
    if (!entry) {
      deps.warn(`[localize] ${name} is not recorded — nothing to do.`);
      code = Math.max(code, EXIT_WARNED);
      continue;
    }

    code = Math.max(code, unlink(name, dir, deps));

    const checkout = path.join(deps.appRoot, entry.path);
    if (opts.purge) {
      const refusal = purgeRefusal(checkout, deps);
      if (refusal && !opts.force) {
        deps.warn(`[localize] ${entry.path}: not deleting — ${refusal}. Pass --force to delete it anyway.`);
        code = Math.max(code, EXIT_WARNED);
      } else {
        if (refusal) deps.warn(`[localize] --force: deleting ${entry.path} despite ${refusal}`);
        fs.rmSync(checkout, {recursive: true, force: true});
        deps.log(`[localize] removed ${entry.path}`);
      }
    } else if (fs.existsSync(checkout)) {
      deps.log(`[localize] ${entry.path} left on disk (uncommitted work lives there). --purge removes it.`);
    }

    delete entries[name];

    const range = entry.range ?? declaredRange(name, deps);
    if (!range && !entry.repo) {
      // An adopted package that was never published: there is no registry copy
      // to go back to, and `@latest` would only 404.
      deps.log(`[localize] ${name} was never declared or published — there is no registry copy to restore.`);
    } else {
      deps.log(`[localize] restore the registry copy with:  npm install --no-save ${name}@${range ?? 'latest'}`);
    }
  }

  writeManifest(deps.appRoot, {version: SCHEMA_VERSION, dir, packages: entries});
  return Math.max(code, assertManifestsUntouched(before, deps));
}

/** Remove the link only when it is a symlink INTO the configured dir. */
function unlink(name, dir, deps) {
  const link = path.join(deps.appRoot, 'node_modules', name);
  if (!fs.existsSync(link) && !isSymlink(link)) return 0;

  if (!isSymlink(link)) {
    deps.warn(
      `[localize] node_modules/${name} is a real directory, not a link — left alone. ` +
        `That is the registry copy; nothing to unlink.`,
    );
    return EXIT_WARNED;
  }

  let target;
  try {
    target = fs.realpathSync(link);
  } catch {
    fs.unlinkSync(link); // dangling, and ours by elimination
    deps.log(`[localize] unlinked ${name} (its target was already gone)`);
    return 0;
  }

  if (!isInside(target, path.join(deps.appRoot, dir))) {
    deps.warn(
      `[localize] node_modules/${name} links to ${target}, outside ${dir} — left alone. ` +
        `delocalize only removes links it could have made.`,
    );
    return EXIT_WARNED;
  }

  fs.unlinkSync(link);
  deps.log(`[localize] unlinked ${name}`);
  return 0;
}

/** @returns {string|null} the reason a purge must be refused. */
function purgeRefusal(checkout, deps) {
  if (!fs.existsSync(checkout)) return null;
  const status = deps.run('git', ['status', '--porcelain'], {cwd: checkout});
  if (status.stdout.trim()) {
    const n = status.stdout.split('\n').filter((l) => l.trim()).length;
    return `it has ${n} uncommitted change${n === 1 ? '' : 's'}`;
  }
  const unpushed = deps.run('git', ['log', '--oneline', '@{u}..HEAD'], {cwd: checkout});
  if (unpushed.status === 0 && unpushed.stdout.trim()) {
    const n = unpushed.stdout.split('\n').filter((l) => l.trim()).length;
    return `it has ${n} unpushed commit${n === 1 ? '' : 's'}`;
  }
  return null;
}

/** Accept a short name where the manifest records a scoped one. */
function toRecordedName(name, entries) {
  if (entries[name]) return name;
  return Object.keys(entries).find((k) => k.split('/').pop() === name) ?? name;
}
