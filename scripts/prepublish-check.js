#!/usr/bin/env node
// Refuses `npm publish` unless the tarball is built from the default branch as
// it is on the remote. 0.3.0 was published from a checkout that sat on an old
// main with only the version bumped, so the tarball shipped without the prune
// code it advertised. Each check below would have stopped that publish.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const run = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const failures = [];

// 1. Nothing uncommitted or untracked: what is packed is what is committed.
const dirty = run('git', ['status', '--porcelain']);
if (dirty) failures.push(`the working tree is not clean:\n${dirty}`);

// 2. HEAD is the remote default branch, fetched now.
const symref = run('git', ['ls-remote', '--symref', 'origin', 'HEAD']);
const branch = /ref: refs\/heads\/(\S+)\s+HEAD/.exec(symref)?.[1];
if (!branch) {
  failures.push(`could not read origin's default branch from:\n${symref}`);
} else {
  run('git', ['fetch', '--quiet', 'origin', branch]);
  const head = run('git', ['rev-parse', 'HEAD']);
  const remote = run('git', ['rev-parse', `origin/${branch}`]);
  if (head !== remote) {
    failures.push(`HEAD ${head.slice(0, 7)} is not origin/${branch} ${remote.slice(0, 7)}`);
  }
}

// 3. The tarball holds every tracked file the `files` field selects -- and
// explicitly src/prune.js, the file 0.3.0 was missing.
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const [pack] = JSON.parse(run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts']));
const packed = new Set(pack.files.map((f) => f.path));
const tracked = run('git', ['ls-files', '--', ...pkg.files]).split('\n').filter(Boolean);
const missing = [...new Set([...tracked, 'src/prune.js'])].filter((f) => !packed.has(f));
if (missing.length) failures.push(`the tarball is missing:\n  ${missing.join('\n  ')}`);

if (failures.length) {
  console.error(`prepublish-check: refusing to publish ${pkg.name}@${pkg.version}\n`);
  for (const f of failures) console.error(`- ${f}\n`);
  process.exit(1);
}
console.log(`prepublish-check: ${pkg.name}@${pkg.version} -- ${packed.size} files, HEAD is origin/${branch}`);
