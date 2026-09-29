/**
 * npm package name -> git repository.
 *
 * There is exactly ONE resolution path, and keeping it to one is the design:
 *
 *     npm name -> registry metadata -> `repository` (+ `directory`) -> clone
 *
 * No org probing, no name guessing, no mapping table, no pluggable resolver.
 * The `repository` field is data the package already published, so it is the
 * authoritative answer rather than an inference -- and an inference that is
 * wrong here costs a clone and a full install of the wrong repository.
 *
 * A consumer that wants to accept short names, or to search several GitHub
 * orgs, resolves that to a full package name ITSELF and then calls localpkg.
 * That behaviour is specific to whoever has it, and localpkg deliberately
 * offers no seam for it.
 *
 * Metadata is read with `npm view`, not with an HTTP request to
 * registry.npmjs.org, so a private registry, a scoped registry, a proxy and an
 * auth token all work without localpkg knowing any of them exist.
 */
import path from 'node:path';

import {EXIT_NOT_FOUND, LocalpkgError} from './errors.js';

/**
 * @typedef {object} Resolved
 * @property {string} npmName    the package name, as it is imported and as
 *                               `node_modules/<npmName>` is spelled
 * @property {string} repo       a git URL that `git clone` accepts
 * @property {string} checkoutName  directory name for the clone
 * @property {string} [subdir]   package location inside the clone, when the
 *                               repository holds more than this one package
 */

/**
 * @param {string} name  a full npm package name (`lodash`, `@scope/thing`)
 * @param {object} deps
 * @param {object} [override]  `{repo, subdir}` from `--repo`/`--subdir` or from
 *   a manifest entry recorded by an earlier run
 * @returns {Resolved}
 * @throws {LocalpkgError} code 4 when the registry has no usable `repository`.
 */
export function resolvePackage(name, deps, override) {
  if (override?.repo) {
    return {
      npmName: name,
      repo: override.repo,
      checkoutName: checkoutNameFor(name),
      ...(override.subdir ? {subdir: normalizeSubdir(override.subdir)} : {}),
    };
  }

  const meta = fetchMetadata(name, deps);
  const {url, directory} = readRepositoryField(meta, name);

  return {
    npmName: name,
    repo: url,
    checkoutName: checkoutNameFor(name),
    ...(directory ? {subdir: directory} : {}),
  };
}

/** Ask npm for the published metadata. `npm view` inherits the user's registry config. */
function fetchMetadata(name, deps) {
  const r = deps.run('npm', ['view', name, 'repository', 'name', '--json']);
  if (r.status !== 0) {
    throw new LocalpkgError(
      `cannot read registry metadata for "${name}":\n${(r.stderr || r.stdout).trim()}\n` +
        `localpkg resolves a repository only from the published package. If the package is not ` +
        `published, or you are not authenticated for its registry, pass the repository ` +
        `explicitly:  localpkg ${name} --repo <git-url>`,
      EXIT_NOT_FOUND,
    );
  }
  // A published package with no `repository` field at all: npm exits 0 and
  // prints nothing. That is "missing", not "malformed" -- let the caller's
  // missing-field refusal handle it, since it is the one that names the fix.
  if (r.stdout.trim() === '') return null;
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    throw new LocalpkgError(
      `npm returned metadata for "${name}" that is not JSON (${e.message}).`,
      EXIT_NOT_FOUND,
    );
  }
}

/**
 * Pull the repository out of the metadata and normalise it to something
 * `git clone` accepts.
 *
 * Refuses rather than guesses when the field is absent. Plenty of published
 * packages have no `repository` at all, and there is no honest way to find
 * their source from the registry -- so the answer is an explicit override, not
 * a search.
 */
function readRepositoryField(meta, name) {
  // `npm view <name> <field> --json` returns the bare field value; with several
  // fields it returns an object keyed by field name. Accept either, and accept
  // the array npm returns when several versions match.
  let node = meta;
  if (Array.isArray(node)) node = node[0];
  if (node && typeof node === 'object' && 'repository' in node) node = node.repository;

  const missing = () =>
    new LocalpkgError(
      `"${name}" publishes no usable "repository" field, so there is nothing to clone.\n` +
        `localpkg never guesses at a repository URL. Pass it once:\n` +
        `  localpkg ${name} --repo <git-url> [--subdir <path-inside-the-repo>]\n` +
        `It is recorded in local-packages.json, so you only pass it the first time.`,
      EXIT_NOT_FOUND,
    );

  if (!node) throw missing();

  let raw;
  let directory;
  if (typeof node === 'string') {
    raw = node;
  } else if (typeof node === 'object') {
    raw = typeof node.url === 'string' ? node.url : undefined;
    directory = typeof node.directory === 'string' ? node.directory : undefined;
  }
  if (!raw) throw missing();

  return {url: normalizeGitUrl(raw), directory: directory ? normalizeSubdir(directory) : undefined};
}

/**
 * npm accepts several spellings in `repository.url`; `git clone` accepts fewer.
 *
 * Handled: the `git+` prefix npm recommends, the `git://` scheme many older
 * packages still carry, and the `github:owner/repo` / bare `owner/repo`
 * shorthands npm normalises on publish but not always in a package's source.
 */
export function normalizeGitUrl(raw) {
  let url = raw.trim();
  if (url.startsWith('git+')) url = url.slice(4);
  if (url.endsWith('.git/')) url = url.slice(0, -1);

  const shorthand = /^(?:github:)?([\w.-]+)\/([\w.-]+)$/.exec(url);
  if (shorthand) return `https://github.com/${shorthand[1]}/${shorthand[2]}.git`;

  if (url.startsWith('git://')) return 'https://' + url.slice('git://'.length);
  return url;
}

/** A repo-relative POSIX path with no leading `./` and no escape. */
function normalizeSubdir(dir) {
  const clean = path.posix.normalize(dir.replace(/\\/g, '/')).replace(/^\.\//, '').replace(/\/+$/, '');
  if (clean === '.' || clean === '') return undefined;
  if (clean.startsWith('..') || path.posix.isAbsolute(clean)) {
    throw new LocalpkgError(
      `the package directory "${dir}" points outside the repository. Refusing to use it.`,
      EXIT_NOT_FOUND,
    );
  }
  return clean;
}

/**
 * Directory name for the clone. The scope is flattened rather than dropped, so
 * `@a/thing` and `@b/thing` can both be localized in one tree -- dropping it
 * would make the second clone silently reuse the first.
 */
export function checkoutNameFor(npmName) {
  return npmName.startsWith('@') ? npmName.slice(1).replace(/\//g, '-') : npmName;
}
