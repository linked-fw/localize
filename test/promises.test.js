/**
 * The two promises localrepo makes to the consumer, tested as promises rather
 * than as implementation:
 *
 *   1. it never changes package.json or package-lock.json, and says so loudly
 *      if something else did while it ran;
 *   2. the command line is usable without reading the source.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {localize} from '../src/localize.js';
import {makeConsumer, ok, rm, stubbed} from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/localrepo.js', import.meta.url));

const consumer = (t, pkg) => {
  const root = makeConsumer({pkg});
  t.after(() => rm(root));
  return root;
};

test('a manifest changed during the run is exit 8, even when the work succeeded', (t) => {
  const appRoot = consumer(t);
  const deps = stubbed(appRoot, (inv) => {
    if (inv.args[0] === 'clone') {
      const dest = inv.args[2];
      fs.mkdirSync(path.join(dest, '.git'), {recursive: true});
      fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({name: 'widget', version: '1.0.0'}));
      return ok();
    }
    if (inv.cmd === 'npm' && inv.args[0] === 'install') {
      // Stand in for a "simplification" that let npm near the consumer root.
      fs.writeFileSync(path.join(appRoot, 'package-lock.json'), '{"lockfileVersion":3}\n');
      return ok();
    }
    if (inv.args[0] === 'rev-parse') return ok('main\n');
    return ok();
  });

  assert.equal(localize(['widget'], {repo: 'r'}, deps), 8);
  assert.match(deps.output(), /package-lock\.json \(created\)/);
  assert.match(deps.output(), /the exact failure localrepo exists to prevent/);
});

test('an uncommitted package.json is NOT a failure', (t) => {
  // The check compares content hashes taken when the command started, not
  // `git status` against HEAD. An earlier tool compared against HEAD and so
  // reported every correct run as a failure in any tree with an uncommitted
  // package.json -- which, in a repo where localize is part of the loop, is
  // most of them.
  const appRoot = consumer(t);
  execFileSync('git', ['init', '-q'], {cwd: appRoot});
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
});

test('the CLI is self-describing and exits 0 on --help and --version', () => {
  const help = execFileSync(process.execPath, [BIN, '--help'], {encoding: 'utf8'});
  for (const expected of ['localrepo <package…>', '--relink', '--subdir', '--build', 'Exit codes']) {
    assert.ok(help.includes(expected), `--help mentions ${expected}`);
  }
  assert.match(execFileSync(process.execPath, [BIN, '--version'], {encoding: 'utf8'}), /^\d+\.\d+\.\d+/);
});

test('an unknown option is rejected rather than silently ignored', () => {
  assert.throws(
    () => execFileSync(process.execPath, [BIN, '--nope'], {encoding: 'utf8', stdio: 'pipe'}),
    (e) => e.status === 2 && /unknown option --nope/.test(String(e.stderr)),
  );
});

test('the CLI in a tree with nothing localized is silent and exits 0', (t) => {
  const appRoot = consumer(t);
  const out = execFileSync(process.execPath, [BIN, '--list'], {cwd: appRoot, encoding: 'utf8'});
  assert.equal(out, '');
});

test('`localrepo --relink` from a postinstall is a no-op with no manifest', (t) => {
  const appRoot = consumer(t);
  const out = execFileSync(process.execPath, [BIN, '--relink'], {cwd: appRoot, encoding: 'utf8'});
  assert.equal(out, '');
  assert.equal(fs.existsSync(path.join(appRoot, 'local-packages.json')), false, 'it did not create one');
});
