import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {EXIT_BAD_FILE} from '../src/errors.js';
import {DEFAULT_DIR, manifestPath, readManifest, writeManifest} from '../src/manifest.js';
import {makeConsumer, rm} from './helpers.js';

const quiet = {warn: () => {}};
const write = (root, body) => fs.writeFileSync(manifestPath(root), body);
const consumer = (t) => {
  const root = makeConsumer();
  t.after(() => rm(root));
  return root;
};

test('a missing manifest reads as an empty set, not an error', (t) => {
  const r = readManifest(consumer(t), quiet);
  assert.equal(r.exists, false);
  assert.deepEqual(r.entries, {});
  assert.equal(r.dir, DEFAULT_DIR);
});

test('a malformed manifest is refused and never rewritten', (t) => {
  for (const [body, why] of [
    ['{ not json', 'unparseable'],
    ['[]', 'an array'],
    ['"a string"', 'a string'],
    ['{"version":99,"packages":{}}', 'an unknown schema version'],
    ['{"version":1,"packages":[]}', 'packages is an array'],
    ['{"version":1,"packages":"x"}', 'packages is a string'],
  ]) {
    const root = consumer(t);
    write(root, body);
    assert.throws(
      () => readManifest(root, quiet),
      (e) => e.code === EXIT_BAD_FILE,
      why,
    );
    // The point of the refusal: the bytes are still there afterwards.
    assert.equal(fs.readFileSync(manifestPath(root), 'utf8'), body, `${why}: file untouched`);
  }
});

test('a partial entry is skipped with a warning; its siblings still load', (t) => {
  const root = consumer(t);
  write(
    root,
    JSON.stringify({
      version: 1,
      packages: {
        good: {repo: 'https://x/y.git', path: 'packages-local/good', branch: 'main'},
        bad: {repo: 'https://x/z.git'},
        alsobad: 'nope',
      },
    }),
  );
  const warns = [];
  const r = readManifest(root, {warn: (m) => warns.push(m)});
  assert.deepEqual(Object.keys(r.entries), ['good']);
  assert.deepEqual(
    r.malformed.map((m) => m.name),
    ['bad', 'alsobad'],
  );
  assert.equal(warns.length, 2);
  assert.match(warns[0], /missing path, branch/);
});

test('writes are atomic and leave no .tmp behind', (t) => {
  const root = consumer(t);
  writeManifest(root, {dir: DEFAULT_DIR, packages: {a: {repo: 'r', path: 'p', branch: 'b'}}});
  assert.equal(fs.existsSync(`${manifestPath(root)}.tmp`), false);
  assert.deepEqual(Object.keys(readManifest(root, quiet).entries), ['a']);
});

test('a non-default dir survives removing the last entry; the default is not written', (t) => {
  const root = consumer(t);
  writeManifest(root, {dir: 'vendor', packages: {}});
  assert.equal(readManifest(root, quiet).dir, 'vendor');

  writeManifest(root, {dir: DEFAULT_DIR, packages: {}});
  assert.equal('dir' in JSON.parse(fs.readFileSync(manifestPath(root), 'utf8')), false);
});

test('the manifest is written where a consumer gitignores it', (t) => {
  const root = consumer(t);
  assert.equal(manifestPath(root), path.join(root, 'local-packages.json'));
});
