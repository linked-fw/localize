/**
 * `--prune-provided` -- stop a checkout's own `node_modules` holding a second
 * copy of something the app already provides.
 *
 * Why it is needed. `npm install` inside a checkout (localize.js, step 3)
 * installs what the CHECKOUT's lockfile says: its own copy of every
 * dependency, often older than the app's. Node resolves a module from the
 * importer's REAL path and takes the first `node_modules` it meets going up,
 * so a localized `A` that imports `B` gets `A/node_modules/B` -- a registry
 * copy -- and never the localized `B`; and a framework package that holds a
 * registry of classes (or React) loads once per copy. Measured with three
 * localized `@_linked/*` packages: plain Node and `tsx` loaded three copies of
 * the same core.
 *
 * What it does. For every localized checkout, each package at the top of its
 * `node_modules` that is a CANDIDATE (below) is removed when the app provides
 * it -- `<appRoot>/node_modules/<name>` exists -- at a version that satisfies
 * every range that resolves to that copy: the checkout's own declaration and
 * that of every installed package that would load it. Node's upward search
 * then finds the app's copy instead. Nothing else in the checkout moves.
 *
 * Candidates are deliberately narrow; removing everything the app happens to
 * provide would make the checkout's tooling depend on the app's for no gain:
 *
 * - a **localized sibling** -- always counts as provided, whatever the range,
 *   because the live checkout is the point of localizing it. A range it does
 *   not satisfy is said out loud, never acted on;
 * - the checkout's **peerDependencies** -- by definition, the host's to provide;
 * - anything matching `provided` -- names or `@scope/*` patterns the caller
 *   passes (`@_linked/cli` passes its framework scope plus react/react-dom).
 *
 * Never removed, candidate or not:
 *
 * - a package with a `bin` -- that is tooling the checkout's scripts and
 *   `npm exec` look up in the checkout's own `node_modules/.bin`;
 * - a copy whose ranges the app's version does not satisfy -- kept, with a
 *   warning naming the package, the range and the app's version;
 * - anything in a checkout that is not under the app root, because then the
 *   upward search never reaches the app's `node_modules` and the removed
 *   package would simply be missing.
 *
 * It never runs npm and never touches the checkout's `package.json` or
 * `package-lock.json`. `npm install` in the checkout puts the copies back;
 * the next localize or `--relink` takes them out again.
 */
import fs from 'node:fs';
import path from 'node:path';

import {isInside, isSymlink, readJson} from './fsops.js';
import {satisfies} from './semver.js';

const REQUIRE_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];
const DECLARE_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/**
 * @param {Record<string, {path: string, subdir?: string}>} entries  the manifest's packages
 * @param {{provided?: string[]}} opts
 * @param {object} deps  `{appRoot, log, warn}`
 * @returns {{removed: object[], kept: object[]}}
 */
export function pruneProvided(entries, opts, deps) {
  const removed = [];
  const kept = [];
  const appRoot = realOrSelf(deps.appRoot);

  for (const [name, entry] of Object.entries(entries)) {
    const pkgDir = path.join(deps.appRoot, entry.path);
    if (!fs.existsSync(path.join(pkgDir, 'package.json'))) continue;
    if (!isInside(realOrSelf(pkgDir), appRoot)) {
      deps.log(
        `[localize] ${name}: ${entry.path} is outside the app root, so Node cannot reach the app's ` +
          `node_modules from it — its own dependencies are left as they are.`,
      );
      continue;
    }
    const ctx = {name, entry, pkgDir, pkg: readJson(path.join(pkgDir, 'package.json')) ?? {}, entries, opts, deps};
    for (const nm of nodeModulesRoots(pkgDir, entry)) {
      const result = pruneOne(nm, ctx);
      removed.push(...result.removed);
      kept.push(...result.kept);
    }
  }

  report(removed, kept, deps);
  return {removed, kept};
}

/**
 * Is `dep` -- declared by a checkout at `range` -- something the app provides,
 * so that its absence from the checkout's own `node_modules` is not a
 * dependency gone missing? `--relink` asks this before reinstalling a
 * checkout, so a copy pruned on purpose does not trigger a reinstall on every
 * postinstall.
 */
export function isProvidedByApp(dep, range, checkoutPkg, entries, opts, deps) {
  const app = appCopy(dep, deps);
  if (!app) return false;
  if (entries[dep]) return true;
  if (!isCandidate(dep, checkoutPkg, entries, opts)) return false;
  return range === undefined || satisfies(app.version, range) === true;
}

function pruneOne(nm, ctx) {
  const removed = [];
  const kept = [];
  const {name: owner, entry, pkg, entries, opts, deps} = ctx;

  for (const dep of topLevelPackages(nm)) {
    if (dep === owner) continue;
    if (!isCandidate(dep, pkg, entries, opts)) continue;
    const dir = path.join(nm, dep);
    const nested = readJson(path.join(dir, 'package.json'));
    if (!nested) continue;
    if (nested.bin) continue; // tooling: see the module header
    const app = appCopy(dep, deps);
    if (!app) continue; // the app does not provide it, so this copy is the only one
    if (realOrSelf(dir) === app.real) continue; // already the app's copy

    const where = path.relative(deps.appRoot, dir);
    const sibling = Boolean(entries[dep]);
    const ranges = rangesResolvingTo(nm, dep, pkg, owner);

    if (!sibling) {
      const unmet = ranges.filter((r) => satisfies(app.version, r.range) !== true);
      if (unmet.length) {
        kept.push({where, dep, version: nested.version, app: app.version, unmet, owner: entry.path});
        continue;
      }
    }

    fs.rmSync(dir, {recursive: true, force: true});
    removeEmptyScope(nm, dep);
    removed.push({
      owner: entry.path,
      dep,
      version: nested.version,
      app: app.version,
      sibling,
      drift: sibling ? ranges.filter((r) => satisfies(app.version, r.range) === false) : [],
    });
  }
  return {removed, kept};
}

function report(removed, kept, deps) {
  const byOwner = new Map();
  for (const r of removed) byOwner.set(r.owner, [...(byOwner.get(r.owner) ?? []), r]);
  for (const [owner, list] of byOwner) {
    deps.log(
      `[localize] ${owner}: removed its own copies of what the app provides — ` +
        list
          .map((r) => `${r.dep}@${r.version} (app: ${r.sibling ? `localized, ${r.app}` : r.app})`)
          .join(', '),
    );
    for (const r of list) {
      for (const d of r.drift) {
        deps.warn(
          `[localize] ${owner}: ${d.from} asks ${r.dep}@${d.range}; the localized checkout is ${r.app}. ` +
            `It is used anyway — that is what localizing it means — but the range is now fiction.`,
        );
      }
    }
  }
  for (const k of kept) {
    deps.warn(
      `[localize] kept ${k.where}@${k.version}: ` +
        k.unmet.map((u) => `${u.from} asks ${k.dep}@${u.range}`).join(', ') +
        `, and the app has ${k.dep}@${k.app}${
          k.unmet.some((u) => satisfies(k.app, u.range) === null) ? ' (or the range is one localize cannot read)' : ''
        }. ` +
        `${k.owner} loads its own copy, so the app loads two. Align the ranges, or update the app's ${k.dep}.`,
    );
  }
}

/**
 * Every range that resolves to `<nm>/<dep>`: the checkout's own declaration,
 * plus each installed package under `nm` that requires `dep` and has no copy
 * of its own between itself and `nm`.
 */
function rangesResolvingTo(nm, dep, checkoutPkg, owner) {
  const out = [];
  const own = declared(checkoutPkg, DECLARE_FIELDS, dep);
  if (own !== undefined) out.push({from: owner, range: own});

  const walk = (dir, chain) => {
    for (const name of topLevelPackages(dir)) {
      const pkgDir = path.join(dir, name);
      if (isSymlink(pkgDir)) continue; // resolves from its real path, which is not here
      const pkg = readJson(path.join(pkgDir, 'package.json'));
      const range = pkg && name !== dep ? declared(pkg, REQUIRE_FIELDS, dep) : undefined;
      const inner = path.join(pkgDir, 'node_modules');
      const shadowed = [...chain, inner].some((d) => fs.existsSync(path.join(d, dep)));
      if (range !== undefined && !shadowed) out.push({from: `${name}@${pkg.version}`, range});
      if (fs.existsSync(inner)) walk(inner, [...chain, inner]);
    }
  };
  walk(nm, []);
  return out;
}

function declared(pkg, fields, dep) {
  for (const f of fields) if (pkg[f]?.[dep] !== undefined) return pkg[f][dep];
  return undefined;
}

function isCandidate(dep, checkoutPkg, entries, opts) {
  if (entries[dep]) return true;
  if (checkoutPkg.peerDependencies?.[dep] !== undefined) return true;
  return (opts.provided ?? []).some((p) => matches(dep, p));
}

/** `name` exactly, or `@scope/*` / any trailing-`*` prefix. */
export function matches(name, pattern) {
  return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

/** The app's own copy of `dep`: `<appRoot>/node_modules/<dep>`, followed through a link. */
function appCopy(dep, deps) {
  const dir = path.join(deps.appRoot, 'node_modules', dep);
  const pkg = readJson(path.join(dir, 'package.json'));
  if (!pkg?.version) return null;
  return {version: pkg.version, real: realOrSelf(dir)};
}

/** The package dir's `node_modules`, and the clone root's when the package is a monorepo subdir. */
function nodeModulesRoots(pkgDir, entry) {
  const roots = [path.join(pkgDir, 'node_modules')];
  if (entry.subdir) {
    const rel = path.normalize(entry.subdir);
    if (pkgDir.endsWith(path.sep + rel)) roots.push(path.join(pkgDir.slice(0, -(rel.length + 1)), 'node_modules'));
  }
  return roots.filter((d) => fs.existsSync(d));
}

/** Package names directly under a `node_modules`, scoped ones as `@scope/name`. */
function topLevelPackages(nm) {
  const out = [];
  let items;
  try {
    items = fs.readdirSync(nm, {withFileTypes: true});
  } catch {
    return out;
  }
  for (const item of items) {
    if (item.name.startsWith('.')) continue;
    if (item.name.startsWith('@')) {
      let inner = [];
      try {
        inner = fs.readdirSync(path.join(nm, item.name));
      } catch {
        /* not a directory */
      }
      for (const sub of inner) if (!sub.startsWith('.')) out.push(`${item.name}/${sub}`);
    } else {
      out.push(item.name);
    }
  }
  return out;
}

function removeEmptyScope(nm, dep) {
  if (!dep.startsWith('@')) return;
  const scope = path.join(nm, dep.split('/')[0]);
  try {
    if (!fs.readdirSync(scope).length) fs.rmdirSync(scope);
  } catch {
    /* already gone */
  }
}

function realOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}
