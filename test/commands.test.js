/**
 * Guards, listing, delocalize and the postinstall hook, with the subprocess
 * runner stubbed. The properties that need a REAL subprocess live in
 * real-localize.test.js; these are the ones a stub can honestly show.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {localize} from '../src/localize.js';
import {delocalize} from '../src/delocalize.js';
import {list} from '../src/list.js';
import {relink} from '../src/relink.js';
import {writeManifest, readManifest} from '../src/manifest.js';
import {fail, makeConsumer, ok, rm, stubbed, tmpdir} from './helpers.js';

const consumer = (t, pkg) => {
  const root = makeConsumer({pkg});
  t.after(() => rm(root));
  return root;
};

/** A checkout on disk, as if a previous localize had made it. */
function seedCheckout(appRoot, name, {version = '1.0.0', dir = 'packages-local'} = {}) {
  const checkout = path.join(appRoot, dir, name);
  fs.mkdirSync(path.join(checkout, '.git'), {recursive: true});
  fs.writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({name, version}));
  return checkout;
}

function link(appRoot, name, target) {
  const l = path.join(appRoot, 'node_modules', name);
  fs.mkdirSync(path.dirname(l), {recursive: true});
  fs.symlinkSync(path.relative(path.dirname(l), target), l, 'dir');
  return l;
}

// --- guards ----------------------------------------------------------------

test('a symlink pointing outside the checkout dir is refused, and --force overrides', (t) => {
  const appRoot = consumer(t);
  const foreign = tmpdir('localize-foreign-');
  t.after(() => rm(foreign));
  fs.writeFileSync(path.join(foreign, 'package.json'), JSON.stringify({name: 'widget', version: '1.0.0'}));
  link(appRoot, 'widget', foreign);

  const deps = stubbed(appRoot);
  assert.equal(localize(['widget'], {repo: 'r'}, deps), 6);
  assert.match(deps.output(), /Refusing to overwrite someone else's link/);
  assert.equal(deps.calls.length, 0, 'it refused before cloning anything');

  // --force gets past the guard (the clone is stubbed, so it stops at the
  // missing package.json -- but it did try).
  const forced = stubbed(appRoot);
  localize(['widget'], {repo: 'r', force: true}, forced);
  assert.ok(forced.calls.some((c) => c.args[0] === 'clone'), '--force proceeds to the clone');
});

test('a failed install links nothing and records nothing', (t) => {
  const appRoot = consumer(t);
  const deps = stubbed(appRoot, (inv) => {
    if (inv.args[0] === 'clone') {
      const dest = inv.args[2];
      fs.mkdirSync(dest, {recursive: true});
      fs.mkdirSync(path.join(dest, '.git'), {recursive: true});
      fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({name: 'widget', version: '1.0.0'}));
      return ok();
    }
    if (inv.cmd === 'npm' && inv.args[0] === 'install') return {status: 1, stdout: '', stderr: 'ERESOLVE'};
    return ok();
  });

  assert.equal(localize(['widget'], {repo: 'r'}, deps), 7);
  assert.match(deps.output(), /npm install failed/);
  assert.match(deps.output(), /left on disk/);
  assert.equal(fs.existsSync(path.join(appRoot, 'node_modules', 'widget')), false);
  assert.deepEqual(Object.keys(readManifest(appRoot, deps).entries), []);
});

test('the install runs in the checkout; nothing runs at the consumer root', (t) => {
  const appRoot = consumer(t);
  const deps = stubbed(appRoot, (inv) => {
    if (inv.args[0] === 'clone') {
      const dest = inv.args[2];
      fs.mkdirSync(path.join(dest, '.git'), {recursive: true});
      fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({name: 'widget', version: '1.0.0'}));
      return ok();
    }
    if (inv.args[0] === 'rev-parse') return ok('main\n');
    return ok();
  });

  assert.equal(localize(['widget'], {repo: 'r'}, deps), 0, deps.output());
  const installs = deps.npmCalls().filter((c) => c.args[0] === 'install');
  assert.equal(installs.length, 1);
  assert.equal(installs[0].cwd, path.join(appRoot, 'packages-local', 'widget'));
  assert.notEqual(installs[0].cwd, appRoot);
});

test('a configured build failure warns and still links; no build command runs nothing', (t) => {
  const seed = (inv) => {
    if (inv.args[0] === 'clone') {
      const dest = inv.args[2];
      fs.mkdirSync(path.join(dest, '.git'), {recursive: true});
      fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({name: 'widget', version: '1.0.0'}));
      return ok();
    }
    if (inv.args[0] === 'rev-parse') return ok('main\n');
    return ok();
  };

  const withBuild = stubbed(consumer(t), (inv) =>
    inv.cmd === 'npm run build' ? {status: 1, stdout: '', stderr: 'tsc exploded'} : seed(inv),
  );
  assert.equal(localize(['widget'], {repo: 'r', build: 'npm run build'}, withBuild), 5);
  assert.match(withBuild.output(), /exactly what you are about to fix/);
  assert.ok(fs.lstatSync(path.join(withBuild.appRoot, 'node_modules', 'widget')).isSymbolicLink());

  const noBuild = stubbed(consumer(t), seed);
  assert.equal(localize(['widget'], {repo: 'r'}, noBuild), 0);
  assert.equal(
    noBuild.calls.some((c) => /build/.test(c.cmd)),
    false,
    'localize does not look for a builder of its own',
  );
});

// --- list ------------------------------------------------------------------

test('--list distinguishes the four states, and --check fails only on the costly ones', (t) => {
  const appRoot = consumer(t);
  const deps = stubbed(appRoot);

  const linkedCheckout = seedCheckout(appRoot, 'linked-one');
  link(appRoot, 'linked-one', linkedCheckout);
  seedCheckout(appRoot, 'not-linked-one'); // checkout present, no symlink: what `npm ci` leaves
  const untrackedTarget = tmpdir('localize-untracked-');
  t.after(() => rm(untrackedTarget));
  link(appRoot, 'untracked-one', untrackedTarget);

  writeManifest(appRoot, {
    dir: 'packages-local',
    packages: {
      'linked-one': {repo: 'r', path: 'packages-local/linked-one', branch: 'main'},
      'not-linked-one': {repo: 'r', path: 'packages-local/not-linked-one', branch: 'main'},
      'gone-one': {repo: 'r', path: 'packages-local/gone-one', branch: 'main'},
      'broken-one': {repo: 'r'},
    },
  });

  assert.equal(list({}, deps), 0, '--list alone always exits 0');
  const out = deps.output();
  assert.match(out, /linked-one\s+linked/);
  assert.match(out, /not-linked-one\s+NOT LINKED\s+\S+\s+main\s+checkout present/);
  assert.match(out, /gone-one\s+NOT LINKED\s+\S+\s+—\s+CHECKOUT MISSING/);
  assert.match(out, /untracked-one\s+linked\s+.*not in local-packages\.json/);
  assert.match(out, /broken-one\s+NOT LINKED\s+.*malformed entry/);
  assert.match(out, /1 linked · 2 not linked · 1 untracked link · 1 malformed entry/);

  assert.equal(list({check: true}, stubbed(appRoot)), 1);
});

test('--list says nothing at all when nothing is localized', (t) => {
  const deps = stubbed(consumer(t));
  assert.equal(list({}, deps), 0);
  assert.equal(deps.output(), '');
});

// --- delocalize ------------------------------------------------------------

test('delocalize keeps the checkout, prints --no-save, and forgets the entry', (t) => {
  const appRoot = consumer(t, {dependencies: {widget: '^2.0.0'}});
  const checkout = seedCheckout(appRoot, 'widget');
  link(appRoot, 'widget', checkout);
  writeManifest(appRoot, {dir: 'packages-local', packages: {widget: {repo: 'r', path: 'packages-local/widget', branch: 'main', range: '^2.0.0'}}});

  const deps = stubbed(appRoot);
  assert.equal(delocalize(['widget'], {}, deps), 0);
  assert.equal(fs.existsSync(path.join(appRoot, 'node_modules', 'widget')), false);
  assert.ok(fs.existsSync(checkout), 'the checkout is left on disk');
  // --no-save is load-bearing: without it, following this line rewrites the
  // range and the lockfile -- the exact diff the tool exists to prevent.
  assert.match(deps.output(), /npm install --no-save widget@\^2\.0\.0/);
  assert.equal(deps.npmCalls().length, 0, 'it printed the command, it did not run it');
  assert.deepEqual(Object.keys(readManifest(appRoot, deps).entries), []);
});

test('delocalize leaves a real directory and a foreign link alone', (t) => {
  const appRoot = consumer(t);
  fs.mkdirSync(path.join(appRoot, 'node_modules', 'realdir'), {recursive: true});
  const foreign = tmpdir('localize-foreign-');
  t.after(() => rm(foreign));
  link(appRoot, 'foreignlink', foreign);
  writeManifest(appRoot, {
    dir: 'packages-local',
    packages: {
      realdir: {repo: 'r', path: 'packages-local/realdir', branch: 'main'},
      foreignlink: {repo: 'r', path: 'packages-local/foreignlink', branch: 'main'},
    },
  });

  const deps = stubbed(appRoot);
  assert.equal(delocalize([], {}, deps), 5);
  assert.match(deps.output(), /realdir is a real directory, not a link — left alone/);
  assert.match(deps.output(), /foreignlink links to .*outside packages-local — left alone/);
  assert.ok(fs.existsSync(path.join(appRoot, 'node_modules', 'realdir')));
  assert.ok(fs.existsSync(path.join(appRoot, 'node_modules', 'foreignlink')));
});

test('--purge refuses on uncommitted work unless forced', (t) => {
  const appRoot = consumer(t);
  const checkout = seedCheckout(appRoot, 'widget');
  link(appRoot, 'widget', checkout);
  const entry = {dir: 'packages-local', packages: {widget: {repo: 'r', path: 'packages-local/widget', branch: 'main'}}};
  writeManifest(appRoot, entry);

  const dirty = (inv) => (inv.args[0] === 'status' ? ok(' M src/index.js\n') : ok());
  const deps = stubbed(appRoot, dirty);
  assert.equal(delocalize(['widget'], {purge: true}, deps), 5);
  assert.match(deps.output(), /1 uncommitted change/);
  assert.ok(fs.existsSync(checkout), 'the work is still there');

  writeManifest(appRoot, entry);
  const forced = stubbed(appRoot, dirty);
  assert.equal(delocalize(['widget'], {purge: true, force: true}, forced), 0);
  assert.equal(fs.existsSync(checkout), false);
});

// --- relink (the postinstall hook) -----------------------------------------

test('relink never runs npm when the checkout is intact', (t) => {
  const appRoot = consumer(t, {dependencies: {widget: '^3.0.0'}});
  const checkout = seedCheckout(appRoot, 'widget', {version: '2.0.99'});
  writeManifest(appRoot, {dir: 'packages-local', packages: {widget: {repo: 'r', path: 'packages-local/widget', branch: 'main'}}});

  const deps = stubbed(appRoot);
  assert.equal(relink(deps), 0);
  assert.equal(deps.npmCalls().length, 0, 'an ordinary install stays silent and fast');
  assert.ok(fs.lstatSync(path.join(appRoot, 'node_modules', 'widget')).isSymbolicLink());

  // npm matches a link by NAME and never checks the range: 2.0.99 satisfies
  // ^3.0.0 as far as npm is concerned. Warn, never fail.
  assert.match(deps.output(), /checkout is 2\.0\.99, package\.json asks \^3\.0\.0/);
  assert.match(deps.output(), /the symlink wins; npm does NOT check the range/);
});

test('relink reinstalls a checkout a root install pruned — inside the checkout, never at the root', (t) => {
  const appRoot = consumer(t);
  const checkout = path.join(appRoot, 'packages-local', 'widget');
  fs.mkdirSync(path.join(checkout, '.git'), {recursive: true});
  fs.writeFileSync(
    path.join(checkout, 'package.json'),
    JSON.stringify({name: 'widget', version: '1.0.0', dependencies: {kept: '1'}, devDependencies: {pruned: '1'}}),
  );
  fs.mkdirSync(path.join(checkout, 'node_modules', 'kept'), {recursive: true});
  writeManifest(appRoot, {dir: 'packages-local', packages: {widget: {path: 'packages-local/widget', branch: 'main'}}});

  const deps = stubbed(appRoot);
  assert.equal(relink(deps), 0);
  const installs = deps.npmCalls();
  assert.equal(installs.length, 1, deps.output());
  assert.equal(installs[0].cwd, checkout);
  assert.notEqual(installs[0].cwd, appRoot, 'a postinstall that installs the root, recurses');
  assert.match(deps.output(), /1 of its dependencies are gone/);

  // A failed reinstall warns; the hook never fails an install.
  const failing = stubbed(appRoot, () => fail('ENETUNREACH'));
  assert.equal(relink(failing), 0);
  assert.match(failing.output(), /npm install in packages-local\/widget failed/);
});

test('relink with no manifest produces no output at all — the CI case', (t) => {
  const deps = stubbed(consumer(t));
  assert.equal(relink(deps), 0);
  assert.equal(deps.output(), '', 'any output here and people learn to ignore this hook');
  assert.equal(deps.calls.length, 0);
});

test('relink never fails an install, not even on an unusable manifest', (t) => {
  const appRoot = consumer(t);
  fs.writeFileSync(path.join(appRoot, 'local-packages.json'), '{ not json');
  const deps = stubbed(appRoot);
  assert.equal(relink(deps), 0);
  assert.match(deps.output(), /not valid JSON/);
});

test('relink warns and skips a missing checkout rather than erroring', (t) => {
  const appRoot = consumer(t);
  writeManifest(appRoot, {dir: 'packages-local', packages: {widget: {repo: 'r', path: 'packages-local/widget', branch: 'main'}}});
  const deps = stubbed(appRoot);
  assert.equal(relink(deps), 0);
  assert.match(deps.output(), /is recorded as local but packages-local\/widget is gone/);
  assert.equal(fs.existsSync(path.join(appRoot, 'node_modules', 'widget')), false);
});

test('relink finds a monorepo package\'s dependencies where the workspace hoisted them', (t) => {
  const appRoot = consumer(t);
  const clone = path.join(appRoot, 'packages-local', 'mono');
  const pkgDir = path.join(clone, 'packages', 'a');
  fs.mkdirSync(path.join(clone, 'node_modules', 'hoisted'), {recursive: true});
  fs.mkdirSync(pkgDir, {recursive: true});
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({name: 'a', version: '1.0.0', dependencies: {hoisted: '1'}}));
  writeManifest(appRoot, {
    dir: 'packages-local',
    packages: {a: {repo: 'r', path: 'packages-local/mono/packages/a', branch: 'main', subdir: 'packages/a'}},
  });

  const deps = stubbed(appRoot);
  assert.equal(relink(deps), 0);
  assert.equal(deps.npmCalls().length, 0, deps.output());
});

test('delocalize of a never-published package does not print a restore that would 404', (t) => {
  const appRoot = consumer(t);
  seedCheckout(appRoot, 'fresh');
  writeManifest(appRoot, {dir: 'packages-local', packages: {fresh: {path: 'packages-local/fresh', branch: 'main'}}});

  const deps = stubbed(appRoot);
  assert.equal(delocalize(['fresh'], {}, deps), 0, deps.output());
  assert.doesNotMatch(deps.output(), /npm install --no-save fresh@latest/);
  assert.match(deps.output(), /no registry copy to restore/);
});
