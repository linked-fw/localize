/**
 * `--prune-provided`: a checkout's own copy of something the app provides is
 * removed, so Node's upward search reaches the app's copy -- and only then.
 *
 * Real filesystem, stubbed subprocesses: what is being asserted is which
 * directories exist afterwards. That the checkout still builds and runs once
 * they are gone is a property of Node's resolution, measured in a real app
 * (see the changeset), not something a fake tree can show.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {localize} from '../src/localize.js';
import {adopt} from '../src/adopt.js';
import {relink} from '../src/relink.js';
import {writeManifest} from '../src/manifest.js';
import {checkoutNameFor} from '../src/resolve.js';
import {makeConsumer, ok, rm, stubbed, tmpdir} from './helpers.js';

const PROVIDED = {pruneProvided: true, provided: ['@fw/*']};

function consumer(t) {
  const root = makeConsumer();
  t.after(() => rm(root));
  return root;
}

/** Write `<dir>/package.json`, creating the directory. */
function pkgAt(dir, json) {
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(json));
  return dir;
}

/** The app's own installed copy: `<appRoot>/node_modules/<name>`. */
const appHas = (appRoot, name, version, extra = {}) =>
  pkgAt(path.join(appRoot, 'node_modules', name), {name, version, ...extra});

/** A checkout on disk with a `.git`, linked into the app. */
function checkout(appRoot, name, json, {dir = path.join(appRoot, 'packages-local', checkoutNameFor(name))} = {}) {
  pkgAt(dir, {name, version: '1.0.0', ...json});
  fs.mkdirSync(path.join(dir, '.git'), {recursive: true});
  const link = path.join(appRoot, 'node_modules', name);
  fs.mkdirSync(path.dirname(link), {recursive: true});
  fs.rmSync(link, {recursive: true, force: true});
  fs.symlinkSync(path.relative(path.dirname(link), dir), link, 'dir');
  return dir;
}

/** A copy inside a checkout's own node_modules, as `npm install` in the checkout leaves it. */
const nested = (co, name, version, extra = {}) => pkgAt(path.join(co, 'node_modules', name), {name, version, ...extra});
const has = (co, name) => fs.existsSync(path.join(co, 'node_modules', name));

const record = (appRoot, map) =>
  writeManifest(appRoot, {
    dir: 'packages-local',
    packages: Object.fromEntries(
      Object.entries(map).map(([name, p]) => [name, {repo: 'r', path: path.relative(appRoot, p), branch: 'main'}]),
    ),
  });

/**
 * The case this exists for: A depends on B, both localized. A's install left
 * a registry B and an older core in A's node_modules.
 */
function twoSiblings(t) {
  const appRoot = consumer(t);
  appHas(appRoot, '@fw/core', '2.25.0');
  const b = checkout(appRoot, '@fw/b', {version: '1.3.2', dependencies: {'@fw/core': '^2.22.8'}});
  const a = checkout(appRoot, '@fw/a', {dependencies: {'@fw/core': '^2.22.8', '@fw/b': '^1.1.2'}});
  nested(a, '@fw/core', '2.22.8');
  nested(a, '@fw/b', '1.1.2', {dependencies: {'@fw/core': '^2.22.8'}});
  nested(b, '@fw/core', '2.22.8');
  record(appRoot, {'@fw/a': a, '@fw/b': b});
  return {appRoot, a, b};
}

test('localize --prune-provided removes, from EVERY checkout, the copies the app provides', (t) => {
  const {appRoot, a, b} = twoSiblings(t);
  const deps = stubbed(appRoot);

  // adopt shares forEachName with localize; it is the stub-free way in.
  assert.equal(adopt(['@fw/b'], {...PROVIDED, dir: 'packages-local'}, deps), 0, deps.output());

  assert.equal(has(a, '@fw/b'), false, "A's registry copy of its localized sibling B is gone");
  assert.equal(has(a, '@fw/core'), false, "A's older core is gone: the app's 2.25.0 satisfies ^2.22.8");
  assert.equal(has(b, '@fw/core'), false);
  assert.equal(fs.existsSync(path.join(a, 'node_modules', '@fw')), false, 'an emptied scope directory goes too');
  assert.match(deps.output(), /packages-local\/fw-a: removed its own copies of what the app provides — .*@fw\/b@1\.1\.2 \(app: localized, 1\.3\.2\)/);
  assert.match(deps.output(), /@fw\/core@2\.22\.8 \(app: 2\.25\.0\)/);
  assert.equal(deps.npmCalls().filter((c) => c.cwd === appRoot).length, 0, 'never npm at the root');
});

test('without --prune-provided nothing is removed — the behaviour before the flag', (t) => {
  const {appRoot, a, b} = twoSiblings(t);
  const deps = stubbed(appRoot);
  assert.equal(adopt(['@fw/b'], {dir: 'packages-local'}, deps), 0, deps.output());
  assert.ok(has(a, '@fw/b'));
  assert.ok(has(a, '@fw/core'));
  assert.ok(has(b, '@fw/core'));
});

test('a copy the app does not satisfy is KEPT, with a warning naming package, range and app version', (t) => {
  const appRoot = consumer(t);
  appHas(appRoot, '@fw/core', '2.25.0');
  const a = checkout(appRoot, '@fw/a', {dependencies: {'@fw/core': '^3.0.0'}});
  nested(a, '@fw/core', '3.1.0');
  record(appRoot, {'@fw/a': a});

  const deps = stubbed(appRoot);
  relink(deps, PROVIDED);
  assert.ok(has(a, '@fw/core'), 'removing it would hand A a core outside its range');
  assert.match(
    deps.warns.join('\n'),
    /kept packages-local\/fw-a\/node_modules\/@fw\/core@3\.1\.0: @fw\/a asks @fw\/core@\^3\.0\.0, and the app has @fw\/core@2\.25\.0/,
  );
});

test('a range from ANOTHER installed package that would load the copy counts too', (t) => {
  const appRoot = consumer(t);
  appHas(appRoot, '@fw/core', '2.25.0');
  const a = checkout(appRoot, '@fw/a', {dependencies: {'@fw/core': '^2.0.0', '@fw/ui': '^1.0.0'}});
  nested(a, '@fw/core', '2.30.0');
  // @fw/ui has no copy of its own, so it resolves to A's -- and asks for more than the app has.
  nested(a, '@fw/ui', '1.0.0', {dependencies: {'@fw/core': '^2.30.0'}});
  record(appRoot, {'@fw/a': a});

  const deps = stubbed(appRoot);
  relink(deps, {pruneProvided: true, provided: ['@fw/core']});
  assert.ok(has(a, '@fw/core'));
  assert.match(deps.warns.join('\n'), /@fw\/ui@1\.0\.0 asks @fw\/core@\^2\.30\.0, and the app has @fw\/core@2\.25\.0/);

  // ...but not when that package has its own copy, which it then loads instead.
  nested(path.join(a, 'node_modules', '@fw/ui'), '@fw/core', '2.30.0');
  const again = stubbed(appRoot);
  relink(again, {pruneProvided: true, provided: ['@fw/core']});
  assert.equal(has(a, '@fw/core'), false, again.output());
});

test('only candidates go: tooling with a bin, unlisted packages and what the app lacks all stay', (t) => {
  const appRoot = consumer(t);
  appHas(appRoot, '@fw/cli', '1.39.0', {bin: {fw: 'bin.js'}});
  appHas(appRoot, 'typescript', '5.9.3');
  appHas(appRoot, 'react', '19.1.0');
  const a = checkout(appRoot, '@fw/a', {
    devDependencies: {'@fw/cli': '^1.19.0', typescript: '^5.0.0'},
    peerDependencies: {react: '^19.0.0'},
  });
  nested(a, '@fw/cli', '1.19.1', {bin: {fw: 'bin.js'}});
  nested(a, 'typescript', '5.9.3');
  nested(a, '@fw/only-here', '1.0.0');
  nested(a, 'react', '19.0.0');
  record(appRoot, {'@fw/a': a});

  const deps = stubbed(appRoot);
  relink(deps, PROVIDED);
  assert.ok(has(a, '@fw/cli'), 'a package with a bin is tooling the checkout runs from its own .bin');
  assert.ok(has(a, 'typescript'), 'not a candidate: neither listed, nor a peer, nor a sibling');
  assert.ok(has(a, '@fw/only-here'), 'the app does not provide it, so this is the only copy');
  assert.equal(has(a, 'react'), false, 'a peerDependency is the host\'s to provide, with no list needed');
});

test('a localized sibling always counts as provided; a range it misses is said, not acted on', (t) => {
  const appRoot = consumer(t);
  const b = checkout(appRoot, '@fw/b', {version: '2.0.0'});
  const a = checkout(appRoot, '@fw/a', {dependencies: {'@fw/b': '^1.0.0'}});
  nested(a, '@fw/b', '1.4.0');
  record(appRoot, {'@fw/a': a, '@fw/b': b});

  const deps = stubbed(appRoot);
  relink(deps, {pruneProvided: true}); // no `provided` list: siblings need none
  assert.equal(has(a, '@fw/b'), false);
  assert.match(deps.warns.join('\n'), /@fw\/a asks @fw\/b@\^1\.0\.0; the localized checkout is 2\.0\.0/);
});

test('relink --prune-provided does not reinstall a checkout for a copy it pruned on purpose', (t) => {
  const appRoot = consumer(t);
  appHas(appRoot, '@fw/core', '2.25.0');
  const a = checkout(appRoot, '@fw/a', {dependencies: {'@fw/core': '^2.22.8'}, devDependencies: {tool: '1'}});
  nested(a, 'tool', '1.0.0');
  record(appRoot, {'@fw/a': a}); // core is already absent from A: pruned by an earlier run

  const deps = stubbed(appRoot);
  assert.equal(relink(deps, PROVIDED), 0);
  assert.equal(deps.npmCalls().length, 0, `a postinstall must stay silent and fast\n${deps.output()}`);

  // Without the flag, the same tree reads as pruned by a root install -- as before.
  const plain = stubbed(appRoot);
  relink(plain);
  assert.equal(plain.npmCalls().length, 1);
  assert.equal(plain.npmCalls()[0].cwd, a);
});

test('relink --prune-provided reinstalls when a pruned dependency is NOT provided, then prunes', (t) => {
  const appRoot = consumer(t);
  appHas(appRoot, '@fw/core', '2.25.0');
  const a = checkout(appRoot, '@fw/a', {dependencies: {'@fw/core': '^2.22.8', tool: '1'}});
  record(appRoot, {'@fw/a': a});

  // The reinstall a root install made necessary puts core back with `tool`...
  const deps = stubbed(appRoot, (inv) => {
    if (inv.cmd === 'npm') {
      nested(a, 'tool', '1.0.0');
      nested(a, '@fw/core', '2.22.8');
    }
    return ok();
  });
  assert.equal(relink(deps, PROVIDED), 0);
  assert.equal(deps.npmCalls().length, 1);
  assert.ok(has(a, 'tool'));
  assert.equal(has(a, '@fw/core'), false, '...and the prune that follows takes it out again');
});

test('a checkout outside the app root is left alone: Node would never reach the app from there', (t) => {
  const appRoot = consumer(t);
  const outside = tmpdir('localize-outside-');
  t.after(() => rm(outside));
  appHas(appRoot, '@fw/core', '2.25.0');
  const a = checkout(appRoot, '@fw/a', {dependencies: {'@fw/core': '^2.0.0'}}, {dir: path.join(outside, 'a')});
  nested(a, '@fw/core', '2.22.8');
  writeManifest(appRoot, {
    dir: 'packages-local',
    packages: {'@fw/a': {repo: 'r', path: path.relative(appRoot, a), branch: 'main'}},
  });

  const deps = stubbed(appRoot);
  relink(deps, PROVIDED);
  assert.ok(has(a, '@fw/core'));
  assert.match(deps.output(), /outside the app root/);
});

test('localize itself passes the flag through: the named package and its siblings are pruned', (t) => {
  const {appRoot, a, b} = twoSiblings(t);
  const deps = stubbed(appRoot);
  // B already sits where the clone would go, so localize refreshes it instead of cloning.
  assert.equal(localize(['@fw/b'], {...PROVIDED, repo: 'https://example.invalid/b.git'}, deps), 0, deps.output());
  assert.equal(has(a, '@fw/b'), false);
  assert.equal(has(b, '@fw/core'), false);
});
