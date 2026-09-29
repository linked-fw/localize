/**
 * Resolution is exactly one path: npm name -> registry metadata ->
 * `repository` -> clone. These tests pin that there is no second path -- no
 * org probing, no name guessing, no fallback search.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {EXIT_NOT_FOUND} from '../src/errors.js';
import {checkoutNameFor, normalizeGitUrl, resolvePackage} from '../src/resolve.js';
import {makeConsumer, ok, rm, stubbed} from './helpers.js';

const consumer = (t) => {
  const root = makeConsumer();
  t.after(() => rm(root));
  return root;
};

/** npm's real output shapes, copied from `npm view <pkg> repository name --json`. */
const viewing = (payload) => (inv) =>
  inv.cmd === 'npm' && inv.args[0] === 'view' ? ok(JSON.stringify(payload)) : ok();

test('the repository comes from the registry, and nothing else is probed', (t) => {
  const deps = stubbed(consumer(t), viewing({repository: {url: 'git+https://github.com/lodash/lodash.git', type: 'git'}, name: 'lodash'}));
  const r = resolvePackage('lodash', deps);

  assert.equal(r.npmName, 'lodash');
  assert.equal(r.repo, 'https://github.com/lodash/lodash.git');
  assert.equal(r.subdir, undefined);

  // One subprocess, and it is not `git ls-remote`.
  assert.equal(deps.calls.length, 1);
  assert.deepEqual(deps.calls[0].args, ['view', 'lodash', 'repository', 'name', '--json']);
  assert.equal(
    deps.calls.some((c) => c.cmd === 'git'),
    false,
    'resolution never probes a git remote',
  );
});

test('a bare repository object (npm one-field output) is accepted too', (t) => {
  const deps = stubbed(consumer(t), viewing({url: 'git+https://github.com/a/b.git', type: 'git'}));
  assert.equal(resolvePackage('b', deps).repo, 'https://github.com/a/b.git');
});

test('repository.directory becomes the subdir, so monorepos resolve without help', (t) => {
  const deps = stubbed(
    consumer(t),
    viewing({url: 'https://github.com/babel/babel.git', type: 'git', directory: 'packages/babel-core'}),
  );
  const r = resolvePackage('@babel/core', deps);
  assert.equal(r.repo, 'https://github.com/babel/babel.git');
  assert.equal(r.subdir, 'packages/babel-core');
  assert.equal(r.checkoutName, 'babel-core');
});

test('a missing repository field is a refusal naming --repo, never a guess', (t) => {
  const deps = stubbed(consumer(t), viewing({name: 'orphan'}));
  assert.throws(
    () => resolvePackage('orphan', deps),
    (e) => {
      assert.equal(e.code, EXIT_NOT_FOUND);
      assert.match(e.message, /publishes no usable "repository" field/);
      assert.match(e.message, /linked-localize orphan --repo <git-url>/);
      assert.match(e.message, /never guesses/);
      return true;
    },
  );
});

test('an empty npm response is the same refusal, not a parse error', (t) => {
  const deps = stubbed(consumer(t), () => ok('\n'));
  assert.throws(
    () => resolvePackage('orphan', deps),
    (e) => e.code === EXIT_NOT_FOUND && /no usable "repository" field/.test(e.message),
  );
});

test('an unreachable or unpublished package names the override too', (t) => {
  const deps = stubbed(consumer(t), () => ({status: 1, stdout: '', stderr: 'npm error code E404'}));
  assert.throws(
    () => resolvePackage('nope', deps),
    (e) => e.code === EXIT_NOT_FOUND && /--repo <git-url>/.test(e.message),
  );
});

test('--repo skips the registry entirely', (t) => {
  const deps = stubbed(consumer(t), () => {
    throw new Error('the registry must not be consulted when --repo is given');
  });
  const r = resolvePackage('@scope/thing', deps, {repo: 'git@github.com:me/thing.git', subdir: './pkgs/thing/'});
  assert.equal(r.repo, 'git@github.com:me/thing.git');
  assert.equal(r.subdir, 'pkgs/thing');
  assert.equal(deps.calls.length, 0);
});

test('a subdir that escapes the repository is refused', (t) => {
  const deps = stubbed(consumer(t));
  assert.throws(
    () => resolvePackage('x', deps, {repo: 'r', subdir: '../../etc'}),
    (e) => e.code === EXIT_NOT_FOUND && /points outside the repository/.test(e.message),
  );
});

test('npm URL spellings normalise to something git clone accepts', () => {
  for (const [input, expected] of [
    ['git+https://github.com/a/b.git', 'https://github.com/a/b.git'],
    ['git+ssh://git@github.com/a/b.git', 'ssh://git@github.com/a/b.git'],
    ['git://github.com/a/b.git', 'https://github.com/a/b.git'],
    ['github:a/b', 'https://github.com/a/b.git'],
    ['a/b', 'https://github.com/a/b.git'],
    ['git@github.com:a/b.git', 'git@github.com:a/b.git'],
    ['https://github.com/a/b.git', 'https://github.com/a/b.git'],
  ]) {
    assert.equal(normalizeGitUrl(input), expected, input);
  }
});

test('a scope is flattened into the directory name, never dropped', () => {
  // Dropping it would make `@b/thing` silently reuse `@a/thing`'s checkout.
  assert.equal(checkoutNameFor('@a/thing'), 'a-thing');
  assert.equal(checkoutNameFor('@b/thing'), 'b-thing');
  assert.equal(checkoutNameFor('thing'), 'thing');
});
