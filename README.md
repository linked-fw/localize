# @_linked/localize

**Edit one of your npm dependencies as a git checkout, without touching your
`package.json` or your lockfile.**

The binary is `linked-localize`. Framework users reach the same command as
`linked localize`, through [`@_linked/cli`](https://github.com/linked-fw/cli).

```sh
npx linked-localize some-dependency
```

That clones `some-dependency`'s repository into `packages-local/`, installs its
dependencies **inside the checkout**, and symlinks
`node_modules/some-dependency` at it. Your app now runs the checkout. Edit it,
commit it, push it. When you are done:

```sh
npx linked-localize remove some-dependency
```

No dependencies of its own. No build step. Node 18.17+.

---

## The problem

You are working on an app, and you find a bug in one of its dependencies — a
package you also maintain. You want to fix it and see the fix in the running
app, before publishing anything.

Every existing way of doing that has a catch:

| | the catch |
|---|---|
| `npm link` | writes into a global directory, and its symlink resolution surprises people in ways that are hard to debug |
| `npm install ../path` | **rewrites `package.json` and the lockfile.** You now have a diff you must remember not to commit, and CI installs something different from what you tested |
| `"dependency": "file:../path"` in `package.json` | same, but permanent and committed |
| npm/pnpm/yarn workspaces | you have to restructure the repository, and the package becomes part of *your* project |
| a monorepo tool | you have to adopt a monorepo tool |

`localize` does the one thing none of them do: it makes the change **entirely
outside the files npm reads**. Your `package.json` and `package-lock.json` come
out byte-for-byte identical — the tool hashes them before and after and refuses
with a non-zero exit if they moved. CI, which never has the checkout, installs
from the registry as always and never knows this happened.

## How it works

```
npm package name
  → the published `repository` field           (data, not a guess)
  → git clone into packages-local/<name>
  → npm install INSIDE the checkout            (not from your project)
  → fs.symlink node_modules/<name> → checkout  (not npm link)
  → record it in local-packages.json           (gitignored)
```

Four of those five deserve a sentence.

**The repository comes from the registry.** `localize` runs
`npm view <name> repository`, which is metadata the package already published.
There is no mapping table to maintain, no GitHub org to configure, and no
guessing — which also means it works for a private registry, because `npm view`
uses whatever registry and token you already have configured. If a package
publishes no `repository`, `localize` refuses and tells you to pass `--repo`
once; it never tries to find the source some other way.

**`npm install` runs inside the checkout, and this is not negotiable.** Node
resolves a symlinked package's dependencies from the symlink's *real* path —
`packages-local/<name>/` — whose parent directories contain no `node_modules`.
A checkout that does not carry its own installed tree cannot resolve its own
dependencies, and the failure shows up as a missing module at runtime, far from
the cause. (This is not theoretical. It is why this tool exists in this shape,
and `test/real-localize.test.js` runs a real clone and a real install to hold
the line.)

**The symlink is written with `fs.symlink`, not by invoking npm.** npm is never
run against your project, by any code path — partly because the peer-dependency
resolution it brings along breaks the checkout, and partly because a
`postinstall` hook that invokes an install would recurse.

**The record is a gitignored file, which makes CI a no-op by construction.**
There is no `if (process.env.CI)` anywhere in this package. CI has no
`local-packages.json`, so `--relink` finds nothing and prints nothing.

## Install

```sh
npm install --save-dev @_linked/localize   # or just use npx
```

Add these two to your `.gitignore`:

```gitignore
packages-local/
local-packages.json
```

And, so an `npm install` or `npm ci` does not quietly undo your links:

```json
{
  "scripts": {
    "postinstall": "linked-localize --relink"
  }
}
```

`npm ci` deletes `node_modules` and exits 0, taking the symlink with it and
leaving you running the registry copy while you edit the checkout. That is the
state that costs hours, because nothing reports it. `--relink` restores the
links, always exits 0, and prints nothing at all when there is nothing to do.

## Commands

```sh
linked-localize <package…>            clone, install, link
linked-localize --list                what is localized, and whether it really is
linked-localize --list --check        exit 1 if something recorded is not linked
linked-localize --relink              recreate the recorded links (for postinstall)
linked-localize remove <package…>     unlink and forget; keep the checkout
linked-localize remove                undo everything
linked-localize remove <pkg> --purge  also delete the checkout (refuses on unsaved work)
```

Packages are named exactly as npm names them: `lodash`, `@scope/thing`. There
are no short names and no aliases.

| option | |
|---|---|
| `--dir <path>` | where checkouts live. Default `packages-local` |
| `--repo <git-url>` | clone this instead of the published `repository`, and remember it |
| `--subdir <path>` | where the package lives inside the repository (monorepos) |
| `--build "<cmd>"` | run this in the checkout after installing. A failure only warns |
| `--force` | replace a symlink pointing outside `--dir`; with `--purge`, delete anyway |

### Packages published from a monorepo

If the package sets `repository.directory` — npm's own field for this —
`localize` uses it: it clones the whole repository, and installs and links the
package's directory inside it. Nothing to configure.

If it does not, `localize` will clone the repository, see that the root is a
different package, and **refuse rather than link the wrong thing**. Tell it
where to look, once:

```sh
linked-localize @scope/thing --subdir packages/thing
```

Both `--repo` and `--subdir` are written into `local-packages.json`, so you
pass them the first time and never again.

### Building the checkout

`localize` has no idea how your package is built and does not look for a
builder. If the checkout needs a build step before your app can use it, say so:

```sh
linked-localize @scope/thing --build "npm run build"
```

If the build fails, you get a warning and the package is linked anyway — a
package whose build is broken is usually exactly the thing you are about to
fix. Many projects need nothing here, because their dev server reads the
checkout's source directly.

## `linked-localize --list`

The record of what you *intended* and the symlinks that are actually there can
disagree. `--list` reads the symlinks first and reports the disagreement:

```
@scope/thing   linked       packages-local/scope-thing   main
other-pkg      NOT LINKED   packages-local/other-pkg     main       checkout present
gone-pkg       NOT LINKED   packages-local/gone-pkg      —          CHECKOUT MISSING
stray          linked       ../elsewhere/stray           —          not in local-packages.json

1 linked · 2 not linked · 1 untracked link
```

- **`checkout present`** — the checkout is there, the symlink is not. This is
  what an `npm install`/`npm ci` leaves behind. `linked-localize --relink` fixes it.
- **`CHECKOUT MISSING`** — recorded, but nothing on disk. Run `linked-localize <name>`
  to clone it again.
- **`not in local-packages.json`** — a symlink `localize` did not create. It is
  reported and never touched.

`--list` never writes and always exits 0. Add `--check` in a script to get exit
1 when something recorded is not actually linked.

## `local-packages.json`

```json
{
  "version": 1,
  "packages": {
    "@scope/thing": {
      "repo": "https://github.com/scope/thing.git",
      "path": "packages-local/scope-thing",
      "branch": "main",
      "range": "^2.1.0"
    }
  }
}
```

Gitignored, written atomically, and **never repaired**: if it is unparseable or
carries a schema version this build does not know, `localize` refuses to read
*or* rewrite it and tells you where it is. It is the only record of what you
intended, and silently resetting it is how a half-localized tree becomes
invisible.

`range` is informational. **npm matches a linked package by name and never
checks its version**, so a checkout at `2.0.99` satisfies `^3.0.0` as far as
your tree is concerned and `npm ls` will not flag it. `localize` warns about
that drift and never uses it to decide anything.

## Exit codes

| | |
|---|---|
| 0 | fine |
| 1 | `--list --check` found something recorded but not linked |
| 2 | bad command line |
| 3 | `local-packages.json` is unusable; nothing was read or written |
| 4 | no repository could be resolved. Pass `--repo` |
| 5 | something was warned about and skipped; the rest worked |
| 6 | a guard refused. `--force` overrides |
| 7 | `npm install` failed inside the checkout. Nothing linked, nothing recorded |
| 8 | your `package.json` or lockfile changed while the command ran |

Each package on the command line is processed independently, and the exit code
is the highest of the per-package codes — a failure on the second name does not
undo the first.

## What it never does

- run an install against *your* project
- edit `package.json`, `package-lock.json`, `.gitignore`, `workspaces`, or any
  bundler configuration
- invoke `npm link`
- delete a checkout you have not committed or pushed (without `--force`)
- guess at a repository URL

## Programmatic use

```js
import {localize, delocalize, list, relink, defaultDeps} from '@_linked/localize';

const deps = defaultDeps(process.cwd());
const code = localize(['@scope/thing'], {build: 'npm run build'}, deps);
```

Every function takes a `deps` object — `{appRoot, run, log, warn, error}` — so
you can point it at another directory or capture its output. `defaultDeps()`
builds the usual one.

## Tests

```sh
npm test         # everything, including a real clone and a real install
npm run test:fast  # skips the slow ones
```

`npm test` is the default for a reason. The suite's most important test does
not stub anything: it builds a real git repository and a real package tarball
in a temp directory, runs a real `localize` against them, and asserts that the
dependency landed in **the checkout's** `node_modules` and not in the
consumer's. That single assertion is what stops someone simplifying the install
back to the project root, which is the one change that would quietly break
every consumer.

## License

MIT
