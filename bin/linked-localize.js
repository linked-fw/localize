#!/usr/bin/env node
/**
 * localize's command line.
 *
 * Hand-rolled argument parsing rather than a parser dependency: localize has
 * no dependencies at all, which is worth more to a build tool than the few
 * lines this saves. `node:util`'s parseArgs is not used either, because its
 * strict mode rejects the `--` free-form values people type and its error
 * messages are worse than these.
 */
import process from 'node:process';

import {defaultDeps} from '../src/run.js';
import {localize} from '../src/localize.js';
import {adopt} from '../src/adopt.js';
import {delocalize} from '../src/delocalize.js';
import {list} from '../src/list.js';
import {relink} from '../src/relink.js';

const USAGE = `
localize — develop an npm dependency from a git checkout.

  linked-localize <package…> [options]     clone, install inside the checkout, symlink it in
  linked-localize adopt <package…>         link a checkout already in --dir: no clone, no pull
  linked-localize --list [--check]         report what is localized, and whether it really is
  linked-localize --relink                 recreate the recorded symlinks (use from postinstall)
  linked-localize remove <package…>        undo: unlink and forget, keeping the checkout
  linked-localize remove                   undo every localized package

Packages are named exactly as npm names them: \`lodash\`, \`@scope/thing\`.
The repository is read from the package's published \`repository\` field.

Options
  --dir <path>       where checkouts live (default: packages-local)
  --repo <git-url>   clone this instead of the published repository, and record it
                     (with adopt: record this instead of the checkout's origin)
  --subdir <path>    the package's directory inside the repository (monorepos)
  --build "<cmd>"    run this in the checkout after installing; a failure only warns
  --provided <list>  more names the app provides, comma-separated; a trailing * matches
                     a prefix ("@scope/*,react"). See "Pruning" below
  --no-prune         leave every checkout's node_modules exactly as npm installed it
  --force            overwrite a symlink pointing outside --dir; with --purge, delete anyway
  --purge            with remove: also delete the checkout
  --check            with --list: exit 1 when something recorded is not linked
  -h, --help         this
  -v, --version      print the version

Pruning
  After installing, and on every --relink, each checkout's own copy of a package the
  app provides is removed from its node_modules when the app's version satisfies the
  checkout's range, so Node reaches the app's copy: a localized sibling (always), the
  checkout's peerDependencies, and whatever --provided names. A copy the app's version
  does not satisfy is kept, and said so. --no-prune turns this off.

Exit codes
  0 ok · 1 --check found a problem · 3 unusable manifest · 4 no repository resolved
  5 warned and skipped · 6 refused (--force overrides) · 7 install failed in the checkout
  8 the consumer's package.json or package-lock.json changed — the failure this prevents
`.trim();

const FLAGS = new Set([
  '--list',
  '--check',
  '--relink',
  '--force',
  '--purge',
  '--no-prune',
  '-h',
  '--help',
  '-v',
  '--version',
]);
const VALUED = new Set(['--dir', '--repo', '--subdir', '--build', '--provided']);

function parse(argv) {
  const opts = {};
  const names = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUED.has(a)) {
      const v = argv[++i];
      if (v === undefined) fatal(`${a} needs a value.`);
      opts[a.slice(2)] = v;
    } else if (a.startsWith('--') && a.includes('=') && VALUED.has(a.slice(0, a.indexOf('=')))) {
      opts[a.slice(2, a.indexOf('='))] = a.slice(a.indexOf('=') + 1);
    } else if (FLAGS.has(a)) {
      opts[a.replace(/^-+/, '')] = true;
    } else if (a.startsWith('-')) {
      fatal(`unknown option ${a}. \`linked-localize --help\` for the list.`);
    } else {
      names.push(a);
    }
  }
  return {opts, names};
}

function fatal(msg) {
  console.error(`[localize] ${msg}`);
  process.exit(2);
}

const {opts, names} = parse(process.argv.slice(2));

if (opts.h || opts.help) {
  console.log(USAGE);
  process.exit(0);
}
if (opts.v || opts.version) {
  // Read, not `import ... with {type:'json'}`: import attributes are not in
  // every Node this package supports.
  const {readFileSync} = await import('node:fs');
  const {fileURLToPath} = await import('node:url');
  const here = fileURLToPath(new URL('../package.json', import.meta.url));
  console.log(JSON.parse(readFileSync(here, 'utf8')).version);
  process.exit(0);
}

const deps = defaultDeps(process.cwd());
const prune = {
  prune: !opts['no-prune'],
  provided: opts.provided ? opts.provided.split(',').map((s) => s.trim()).filter(Boolean) : [],
};
if (opts.provided && !prune.prune) fatal('--provided means nothing with --no-prune.');

if (opts.relink) {
  process.exitCode = relink(deps, prune);
} else if (names[0] === 'remove' || names[0] === 'delocalize') {
  process.exitCode = delocalize(names.slice(1), {purge: opts.purge, force: opts.force}, deps);
} else if (names[0] === 'adopt') {
  if (names.length === 1) fatal('adopt needs at least one package name.');
  process.exitCode = adopt(
    names.slice(1),
    {force: opts.force, dir: opts.dir, repo: opts.repo, build: opts.build, ...prune},
    deps,
  );
} else if (opts.list || names.length === 0) {
  process.exitCode = list({check: opts.check}, deps);
} else {
  process.exitCode = localize(
    names,
    {force: opts.force, dir: opts.dir, repo: opts.repo, subdir: opts.subdir, build: opts.build, ...prune},
    deps,
  );
}
