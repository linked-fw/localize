/**
 * Build a real git repository on disk, holding a real npm package that has a
 * real dependency, and a real tarball of that dependency to install from.
 *
 * Why a generated fixture and not a small public repo from GitHub:
 *
 * - **Hermetic.** No network, so the test cannot fail because a registry, a
 *   proxy or GitHub is having a bad day, and it runs on a machine with no
 *   credentials.
 * - **Nothing can be renamed or deleted out from under it.** A third-party
 *   repo is somebody else's to move.
 * - **It is a real clone and a real install either way.** `git clone` from a
 *   local path is the same code path as from a remote, and `npm install` of a
 *   `file:` tarball is the same install machinery as from a registry: npm
 *   builds an ideal tree, writes a lockfile and extracts into `node_modules`.
 *   What the test needs to observe is WHERE that tree is written, and that is
 *   identical for both.
 */
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'localpkg tests',
      GIT_AUTHOR_EMAIL: 'tests@localpkg.invalid',
      GIT_COMMITTER_NAME: 'localpkg tests',
      GIT_COMMITTER_EMAIL: 'tests@localpkg.invalid',
    },
  });

/**
 * @param {string} root    a scratch directory
 * @param {object} [opts]
 * @param {string} [opts.name]    the package's npm name
 * @param {string} [opts.subdir]  put the package in this directory of the repo
 *                                instead of at the root (the monorepo case)
 * @returns {{repoUrl: string, depName: string, depTarball: string, name: string}}
 */
export function buildFixtureRepo(root, opts = {}) {
  const name = opts.name ?? 'fixture-widget';
  const depName = 'fixture-dep';

  // 1. the dependency, packed into a tarball the fixture package can install
  const depSrc = path.join(root, 'dep-src');
  fs.mkdirSync(depSrc, {recursive: true});
  fs.writeFileSync(
    path.join(depSrc, 'package.json'),
    JSON.stringify({name: depName, version: '1.0.0', main: 'index.js'}, null, 2),
  );
  fs.writeFileSync(path.join(depSrc, 'index.js'), 'export const dep = true;\n');
  execFileSync('npm', ['pack', '--pack-destination', root], {cwd: depSrc, encoding: 'utf8', stdio: 'pipe'});
  const depTarball = path.join(root, `${depName}-1.0.0.tgz`);
  if (!fs.existsSync(depTarball)) throw new Error(`npm pack did not produce ${depTarball}`);

  // 2. the package itself, in a git repository
  const work = path.join(root, 'repo');
  const pkgDir = opts.subdir ? path.join(work, opts.subdir) : work;
  fs.mkdirSync(pkgDir, {recursive: true});
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify(
      {
        name,
        version: '1.0.0',
        type: 'module',
        main: 'src/index.js',
        // A `file:` specifier. npm resolves, extracts and locks it exactly as
        // it would a registry dependency -- which is what makes this able to
        // show WHERE the install happened.
        dependencies: {[depName]: `file:${depTarball}`},
      },
      null,
      2,
    ) + '\n',
  );
  fs.mkdirSync(path.join(pkgDir, 'src'), {recursive: true});
  fs.writeFileSync(path.join(pkgDir, 'src', 'index.js'), `export const widget = 'from source';\n`);
  if (opts.subdir) {
    fs.writeFileSync(
      path.join(work, 'package.json'),
      JSON.stringify({name: 'fixture-monorepo-root', version: '0.0.0', private: true}, null, 2) + '\n',
    );
  }

  git(work, 'init', '-q', '-b', 'main');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'fixture');

  return {repoUrl: work, depName, depTarball, name};
}
