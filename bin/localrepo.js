#!/usr/bin/env node
/**
 * localrepo's command line.
 *
 * Hand-rolled argument parsing rather than a parser dependency: localrepo has
 * no dependencies at all, which is worth more to a build tool than the few
 * lines this saves. `node:util`'s parseArgs is not used either, because its
 * strict mode rejects the `--` free-form values people type and its error
 * messages are worse than these.
 */
import process from 'node:process';

import {defaultDeps} from '../src/run.js';
import {localize} from '../src/localize.js';
import {delocalize} from '../src/delocalize.js';
import {list} from '../src/list.js';
import {relink} from '../src/relink.js';

const USAGE = `
localrepo — develop an npm dependency from a git checkout.

  localrepo <package…> [options]     clone, install inside the checkout, symlink it in
  localrepo --list [--check]         report what is localized, and whether it really is
  localrepo --relink                 recreate the recorded symlinks (use from postinstall)
  localrepo remove <package…>        undo: unlink and forget, keeping the checkout
  localrepo remove                   undo every localized package

Packages are named exactly as npm names them: \`lodash\`, \`@scope/thing\`.
The repository is read from the package's published \`repository\` field.

Options
  --dir <path>       where checkouts live (default: packages-local)
  --repo <git-url>   clone this instead of the published repository, and record it
  --subdir <path>    the package's directory inside the repository (monorepos)
  --build "<cmd>"    run this in the checkout after installing; a failure only warns
  --force            overwrite a symlink pointing outside --dir; with --purge, delete anyway
  --purge            with remove: also delete the checkout
  --check            with --list: exit 1 when something recorded is not linked
  -h, --help         this
  -v, --version      print the version

Exit codes
  0 ok · 1 --check found a problem · 3 unusable manifest · 4 no repository resolved
  5 warned and skipped · 6 refused (--force overrides) · 7 install failed in the checkout
  8 the consumer's package.json or package-lock.json changed — the failure this prevents
`.trim();

const FLAGS = new Set(['--list', '--check', '--relink', '--force', '--purge', '-h', '--help', '-v', '--version']);
const VALUED = new Set(['--dir', '--repo', '--subdir', '--build']);

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
      fatal(`unknown option ${a}. \`localrepo --help\` for the list.`);
    } else {
      names.push(a);
    }
  }
  return {opts, names};
}

function fatal(msg) {
  console.error(`[localrepo] ${msg}`);
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

if (opts.relink) {
  process.exitCode = relink(deps);
} else if (names[0] === 'remove' || names[0] === 'delocalize') {
  process.exitCode = delocalize(names.slice(1), {purge: opts.purge, force: opts.force}, deps);
} else if (opts.list || names.length === 0) {
  process.exitCode = list({check: opts.check}, deps);
} else {
  process.exitCode = localize(
    names,
    {force: opts.force, dir: opts.dir, repo: opts.repo, subdir: opts.subdir, build: opts.build},
    deps,
  );
}
