/**
 * THE test. Everything else in this suite stubs the subprocess runner; this
 * one does not.
 *
 * It runs a real `git clone` and a real `npm install`, and asserts the single
 * property that is easiest to lose and most expensive to lose:
 *
 *   **the install happens INSIDE the checkout.**
 *
 * The history: installing from the consumer instead, with
 * `npm install <path> --no-save`, hard-failed an app's boot on a missing peer
 * dependency (`lucide-react`). Module resolution happens from the symlink's
 * REAL path, whose ancestors have no `node_modules`, so a checkout that does
 * not carry its own installed tree cannot resolve anything. The tool that this
 * one was extracted from had 89 tests and every one of them stubbed the
 * runner, so `git clone` and `npm install` never executed and this constraint
 * was protected by nothing but a commit message.
 *
 * The assertions below fail for a reimplementation that moves the install back
 * to the consumer: the dependency would land in the consumer's `node_modules`
 * and not in the checkout's, and the consumer's lockfile would move.
 *
 * Marked `slow:` -- it does real subprocess work. `npm run test:fast` skips
 * it; plain `npm test` does not, because a constraint nobody runs is not
 * protected.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {localize} from '../src/localize.js';
import {delocalize} from '../src/delocalize.js';
import {relink} from '../src/relink.js';
import {readManifest} from '../src/manifest.js';
import {buildFixtureRepo} from './fixtures/build-fixture-repo.js';
import {makeConsumer, realDeps, rm, tmpdir} from './helpers.js';

test('slow: a real localize clones, installs inside the checkout and links it', async (t) => {
  const scratch = tmpdir('localpkg-fixture-');
  const {repoUrl, depName, name} = buildFixtureRepo(scratch);
  const appRoot = makeConsumer({pkg: {dependencies: {[name]: '^1.0.0'}}});
  t.after(() => {
    rm(scratch);
    rm(appRoot);
  });

  const lockPath = path.join(appRoot, 'package-lock.json');
  fs.writeFileSync(
    lockPath,
    JSON.stringify({name: 'consumer', lockfileVersion: 3, requires: true, packages: {}}, null, 2) + '\n',
  );
  const pkgBefore = fs.readFileSync(path.join(appRoot, 'package.json'));
  const lockBefore = fs.readFileSync(lockPath);

  const deps = realDeps(appRoot);
  // `--repo` rather than a registry lookup: the fixture package is not
  // published anywhere, and the registry lookup is covered by its own tests.
  // Everything after resolution -- clone, install, link, record -- is real.
  const code = localize([name], {repo: repoUrl}, deps);

  assert.equal(code, 0, `localize failed:\n${deps.output()}`);

  const checkout = path.join(appRoot, 'packages-local', name);

  // 1. a real clone
  assert.ok(fs.existsSync(path.join(checkout, '.git')), 'the checkout is a git repository');
  assert.ok(fs.existsSync(path.join(checkout, 'src', 'index.js')), 'the checkout has editable source');

  // 2. THE CONSTRAINT: the dependency tree is inside the checkout.
  const depInCheckout = path.join(checkout, 'node_modules', depName, 'package.json');
  assert.ok(
    fs.existsSync(depInCheckout),
    `the checkout must carry its own installed dependencies -- ${depName} is not in ` +
      `${path.relative(appRoot, path.dirname(depInCheckout))}. An install run from the consumer ` +
      `instead of from the checkout is the regression this test exists to catch.`,
  );
  assert.equal(JSON.parse(fs.readFileSync(depInCheckout, 'utf8')).name, depName);

  // ...and NOT in the consumer's.
  assert.equal(
    fs.existsSync(path.join(appRoot, 'node_modules', depName)),
    false,
    `${depName} leaked into the consumer's node_modules, which means the install ran from the ` +
      `consumer rather than from the checkout.`,
  );

  // 3. the link is a symlink, written by fs.symlink, resolving to the checkout
  const link = path.join(appRoot, 'node_modules', name);
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'node_modules/<name> is a symlink');
  assert.equal(fs.realpathSync(link), fs.realpathSync(checkout));
  // Relative, so the tree survives being moved or bind-mounted elsewhere.
  assert.equal(path.isAbsolute(fs.readlinkSync(link)), false, 'the symlink target is relative');

  // 4. the consumer's manifests are byte-identical. This is the property the
  //    whole design exists for, so it is compared as BYTES, not as parsed JSON.
  assert.deepEqual(fs.readFileSync(path.join(appRoot, 'package.json')), pkgBefore, 'package.json unchanged');
  assert.deepEqual(fs.readFileSync(lockPath), lockBefore, 'package-lock.json unchanged');

  // 5. recorded, so CI no-ops and --relink can restore it
  const manifest = readManifest(appRoot, deps);
  assert.deepEqual(Object.keys(manifest.entries), [name]);
  assert.equal(manifest.entries[name].path, path.join('packages-local', name));
  assert.equal(manifest.entries[name].branch, 'main');
  assert.equal(manifest.entries[name].range, '^1.0.0');

  // 6. the package actually resolves through the link, from source
  const mod = await import(path.join(link, 'src', 'index.js'));
  assert.equal(mod.widget, 'from source');

  // --- relink restores what `npm ci` would have destroyed -------------------
  fs.unlinkSync(link);
  assert.equal(relink(deps), 0);
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'relink recreated the symlink');
  assert.equal(fs.realpathSync(link), fs.realpathSync(checkout));

  // --- delocalize unlinks, keeps the work, and still touches nothing --------
  assert.equal(delocalize([name], {}, deps), 0, deps.output());
  assert.equal(fs.existsSync(link), false, 'the link is gone');
  assert.ok(fs.existsSync(path.join(checkout, 'src', 'index.js')), 'the checkout is left on disk');
  assert.match(deps.output(), /npm install --no-save fixture-widget@\^1\.0\.0/);
  assert.deepEqual(Object.keys(readManifest(appRoot, deps).entries), []);
  assert.deepEqual(fs.readFileSync(path.join(appRoot, 'package.json')), pkgBefore);
  assert.deepEqual(fs.readFileSync(lockPath), lockBefore);
});

test('slow: a real localize of a package inside a monorepo installs in the package directory', (t) => {
  const scratch = tmpdir('localpkg-fixture-');
  const {repoUrl, depName, name} = buildFixtureRepo(scratch, {subdir: 'packages/widget'});
  const appRoot = makeConsumer();
  t.after(() => {
    rm(scratch);
    rm(appRoot);
  });

  const deps = realDeps(appRoot);
  const code = localize([name], {repo: repoUrl, subdir: 'packages/widget'}, deps);
  assert.equal(code, 0, deps.output());

  const clone = path.join(appRoot, 'packages-local', name);
  const pkgDir = path.join(clone, 'packages', 'widget');

  // The clone is the whole repository; the install and the link are the package.
  assert.ok(fs.existsSync(path.join(clone, '.git')));
  assert.ok(
    fs.existsSync(path.join(pkgDir, 'node_modules', depName)),
    'the install ran in the package directory, not at the repository root',
  );
  assert.equal(
    fs.existsSync(path.join(clone, 'node_modules', depName)),
    false,
    'nothing was installed at the repository root',
  );
  assert.equal(fs.realpathSync(path.join(appRoot, 'node_modules', name)), fs.realpathSync(pkgDir));
  assert.equal(readManifest(appRoot, deps).entries[name].path, path.join('packages-local', name, 'packages', 'widget'));
});

test('slow: a real localize refuses a monorepo root rather than linking the wrong package', (t) => {
  const scratch = tmpdir('localpkg-fixture-');
  const {repoUrl, name} = buildFixtureRepo(scratch, {subdir: 'packages/widget'});
  const appRoot = makeConsumer();
  t.after(() => {
    rm(scratch);
    rm(appRoot);
  });

  const deps = realDeps(appRoot);
  // No --subdir: the repository root is a different package.
  const code = localize([name], {repo: repoUrl}, deps);

  assert.equal(code, 6, deps.output());
  assert.match(deps.output(), /declares itself as "fixture-monorepo-root"/);
  assert.match(deps.output(), /--subdir/);
  assert.equal(fs.existsSync(path.join(appRoot, 'node_modules', name)), false, 'nothing was linked');
  assert.deepEqual(Object.keys(readManifest(appRoot, deps).entries), [], 'nothing was recorded');
});
