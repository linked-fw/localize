---
date: 2026-10-02
summary: >
  0.2.0 adds `adopt` — install, build, link and record a git checkout that is already in the
  checkout directory, with no clone, pull or registry lookup — and makes the manifest's `repo`
  optional so a checkout with no remote can be recorded. relink now reinstalls a checkout whose
  dependencies a root `npm install` pruned (measured: npm deletes them for any checkout under the
  project root). Also fixed: an unborn branch recorded as `HEAD`, and `subdir` lost on read.
---

# 001 — `adopt`, an optional `repo`, and the relink reinstall

## Why

`localize` gets its checkout one way: resolve the published `repository`, clone it. Two kinds of
checkout belong in `packages-local/` yet cannot come from there:

- a package created locally and never published, perhaps with no remote yet — what
  `linked create-package --location packages-local` now produces;
- a clone put in place by hand.

`@_linked/cli`'s report 009 (`create-package` locations) is the consumer that drove this.

## `adopt`

```sh
linked-localize adopt <package…> [--dir] [--repo <url>] [--build "<cmd>"] [--force]
```
```js
import {adopt, defaultDeps} from '@_linked/localize';
const code = adopt(['@scope/thing'], {build: 'npm run build'}, defaultDeps(process.cwd()));
```

Per name:

1. The checkout must exist at `<dir>/<checkoutNameFor(name)>` — the same name `localize` clones
   to, so the two can never disagree about where a package lives.
2. It must be a git checkout (localize tracks a branch), and its `package.json` must declare that
   name. Each failure is exit 6 with a message naming the fix; nothing is installed.
3. The foreign-link guard, as for `localize`.
4. `repo` = `--repo` (normalised), else `git remote get-url origin`, else the previously recorded
   one, else absent. Read only — never fetched.
5. Then exactly `localize`'s tail: `npm install` inside the checkout, the configured build (a
   failure warns, exit 5), the symlink, the manifest entry, and the "consumer manifests untouched"
   post-condition (exit 8).

`--repo` with several names is refused (exit 6) before anything runs — a repository belongs to
one package. `adopt` never clones, pulls or fetches; a test asserts there is no `git clone`,
`pull` or `fetch` and no `npm view` on its path.

`localize <name>` on an unpublished package whose checkout already exists now appends to its
"cannot read registry metadata" refusal: `linked-localize adopt <name>`.

### Structure

`localize.js` now exports two pieces both commands share:

- `forEachName(names, opts, deps, one)` — snapshot the consumer manifests, read the manifest
  once, run `one` per name, write the manifest after each (an interruption keeps what worked),
  then assert the links and the untouched manifests.
- `installLinkAndRecord({npmName, clone, relPkg, pkgDir, repo, subdir}, opts, deps)` — install,
  build, link, describe the entry. It knows nothing about how the checkout got there.

`guardForeignLink` is exported for `adopt.js`.

## The manifest

- **`repo` is optional** (`path` and `branch` stay required). An entry without it relinks, lists
  and delocalizes like any other. This relaxes the schema shared with `@semantu/cli`: an older
  reader — including localize 0.1.0 — skips such an entry as partial, with a warning, and keeps
  the rest. **Consumers must run 0.2.0** wherever repo-less entries exist; the CLI that creates
  them requires it.
- **`subdir` survives `readManifest`.** It was dropped on read, so a re-localize of a monorepo
  package without `--subdir` lost it.

## `currentBranch` on an unborn branch

`git rev-parse --abbrev-ref HEAD` fails in a repository with no commits, and the fallback
recorded `HEAD` — which is what every package adopted straight after `git init` got.
`git symbolic-ref --short -q HEAD` names an unborn branch too; `rev-parse` remains the fallback
for a detached head (still `HEAD`). Tested against real git.

## relink reinstalls a pruned checkout

Measured on npm 11.19.1:

| Checkout | Root `npm install` |
|---|---|
| under the project root, package not declared | link removed, checkout's deps **deleted** |
| under the root, a localized *published* dependency (declared range) | link swapped for the registry copy, checkout's deps **deleted** |
| under the root, with workspaces / with an absolute link | same — deleted |
| outside the project root | link removed, deps kept |
| any, `npm ci` | link removed, deps kept |

npm counts a linked checkout under the root as part of the root's tree (`npm ls` marks its deps
`extraneous`) and prunes them against the lockfile. relink restored the link, never the deps, so
the checkout could no longer build.

Now relink checks each recorded checkout's declared `dependencies` and `devDependencies` against
its own `node_modules`; when any are missing it runs `npm install --no-audit --no-fund` **inside
that checkout**, logs one line saying why, warns on failure, and still exits 0. The hook's rule
is now "never runs npm at the consumer root" — the property that prevents recursion — and an
intact checkout still costs nothing and prints nothing. The cost: npm prunes again on every root
install, so the reinstall repeats each time (~12 s for three small checkouts in validation).

Rejected: moving checkouts outside the project root. It avoids the prune, but consumers' build
discovery, bundler config and docs all assume the checkout directory sits inside the project.

## Tests

51 tests, all passing (`npm test`, including the slow real-clone tests):

- `test/adopt.test.js` (new, 8) — links and records without clone/pull/fetch/view; no-remote entry
  relinks and lists; `--repo` wins over origin; `--repo` with several names refused; missing,
  non-git, wrong-name and nameless checkouts refused; consumer `package.json` untouched and the
  build runs in the checkout; `localize` points at `adopt`; an unborn branch is recorded by name.
- `test/manifest.test.js` (+2) — repo-less entry valid; `subdir` survives a read.
- `test/commands.test.js` — the relink test now asserts no npm for an intact checkout; new ones
  assert the reinstall runs in the checkout (never the root) and a failure only warns, that a
  monorepo package's hoisted dependencies count as present, and that delocalizing a
  never-published package prints no `@latest` restore that would 404.

## Smaller consequences of a repo-less entry

- relink's "checkout is gone" warning names `adopt` (restore by hand) instead of a re-clone that
  would 404.
- `delocalize` of an entry with no `repo` and no declared range says there is no registry copy,
  rather than printing `npm install --no-save <name>@latest`.
- The reinstall check looks in the clone root too for a `subdir` entry, where an npm-workspaces
  monorepo hoists dependencies — otherwise every postinstall would reinstall it.
- Re-adopting a name recorded inside a monorepo warns that the entry is replaced.

## Release

`package.json` is 0.2.0. This repository has no publish workflow; publish by hand, before the
`@_linked/cli` release that depends on `^0.2.0`.
