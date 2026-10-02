/**
 * `local-packages.json` -- the record of which packages are currently localized.
 *
 * The filename and schema are deliberately the SAME as the ones `@semantu/cli`
 * already writes (schema version 1, keys are npm package names). A developer
 * with a half-localized tree must be able to switch tools without re-cloning,
 * and the consumer's `postinstall` must keep working across the switch.
 *
 * One relaxation since 0.1.0: `repo` is optional, because an adopted checkout
 * may have no remote. localize 0.1.0 skips such an entry as partial, with a
 * warning, and keeps the rest; other readers of this schema were not checked.
 *
 * Two properties are load-bearing:
 *
 * 1. **It is never repaired.** Unparseable JSON, an unknown `version` or a
 *    `packages` that is not an object is a refusal (exit 3) with no write.
 *    This file is the only record of what a developer intended; silently
 *    resetting it is how a half-localized tree becomes invisible.
 * 2. **Writes are atomic** -- `<file>.tmp` then `rename` -- so a killed run
 *    cannot leave a truncated file behind.
 *
 * A *partial entry* is different from a malformed file: it is skipped with a
 * warning and its siblings still process, because one bad entry must not cost
 * a developer the other nine.
 */
import fs from 'node:fs';
import path from 'node:path';

import {EXIT_BAD_FILE, LocalizeError} from './errors.js';

export const MANIFEST_FILENAME = 'local-packages.json';

/** The only schema version this build understands. */
export const SCHEMA_VERSION = 1;

/** Default checkout directory, relative to the consumer root. */
export const DEFAULT_DIR = 'packages-local';

export function manifestPath(appRoot) {
  return path.join(appRoot, MANIFEST_FILENAME);
}

/**
 * Read and validate the manifest.
 *
 * A missing file is NOT an error: it is the CI case and the fresh-clone case,
 * and reads as an empty set. That is also why no `if (CI)` branch exists
 * anywhere in this package -- the file is gitignored, so CI is a natural no-op.
 *
 * @throws {LocalizeError} code 3. Nothing is written in any failure case.
 */
export function readManifest(appRoot, io = {warn: console.warn}) {
  const file = manifestPath(appRoot);

  if (!fs.existsSync(file)) {
    return {file, exists: false, version: SCHEMA_VERSION, dir: DEFAULT_DIR, entries: {}, malformed: []};
  }

  const raw = fs.readFileSync(file, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new LocalizeError(
      `${file} is not valid JSON: ${e.message}\n` +
        `Refusing to read or rewrite it -- it is the only record of what was localized. ` +
        `Fix it by hand, or delete it to start over.`,
      EXIT_BAD_FILE,
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LocalizeError(
      `${file} does not contain a JSON object.\n` +
        `Refusing to read or rewrite it. Expected {"version":${SCHEMA_VERSION},"packages":{…}}.`,
      EXIT_BAD_FILE,
    );
  }

  if (parsed.version !== SCHEMA_VERSION) {
    throw new LocalizeError(
      `${file} has schema version ${JSON.stringify(parsed.version)}; this version of localize understands ` +
        `only version ${SCHEMA_VERSION}.\n` +
        `Refusing to read or rewrite it -- guessing at a schema it did not write is how intent ` +
        `gets lost. Upgrade localize, or delete the file and re-localize.`,
      EXIT_BAD_FILE,
    );
  }

  if (parsed.packages === null || typeof parsed.packages !== 'object' || Array.isArray(parsed.packages)) {
    throw new LocalizeError(
      `${file} has a "packages" field that is not an object (found ` +
        `${Array.isArray(parsed.packages) ? 'an array' : typeof parsed.packages}).\n` +
        `Refusing to read or rewrite it.`,
      EXIT_BAD_FILE,
    );
  }

  const dir = typeof parsed.dir === 'string' && parsed.dir.length > 0 ? parsed.dir : DEFAULT_DIR;

  const entries = {};
  const malformed = [];

  for (const [name, value] of Object.entries(parsed.packages)) {
    const reason = validateEntry(value);
    if (reason) {
      malformed.push({name, reason});
      io.warn(
        `[localize] ${name}: malformed entry in ${MANIFEST_FILENAME} (${reason}) -- skipped. ` +
          `The other entries are unaffected. \`linked-localize ${name}\` rewrites it.`,
      );
      continue;
    }
    entries[name] = {
      ...(typeof value.repo === 'string' && value.repo ? {repo: value.repo} : {}),
      path: value.path,
      branch: value.branch,
      ...(typeof value.subdir === 'string' ? {subdir: value.subdir} : {}),
      ...(typeof value.range === 'string' ? {range: value.range} : {}),
    };
  }

  return {file, exists: true, version: SCHEMA_VERSION, dir, entries, malformed};
}

/**
 * @returns {string|null} a reason the entry is unusable, else null.
 *
 * `repo` is optional: an adopted checkout may have no remote at all -- a
 * package created locally that has not been pushed anywhere yet.
 */
function validateEntry(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'not an object';
  const missing = ['path', 'branch'].filter(
    (k) => typeof value[k] !== 'string' || value[k].length === 0,
  );
  return missing.length ? `missing ${missing.join(', ')}` : null;
}

/**
 * Write the manifest atomically: a `.tmp` in the SAME directory, so `rename`
 * is atomic on one filesystem, then `rename` over the original.
 *
 * An empty `packages` object is written rather than the file being deleted, so
 * a non-default `dir` survives delocalizing the last entry.
 */
export function writeManifest(appRoot, data) {
  const target = manifestPath(appRoot);
  const tmp = `${target}.tmp`;

  const out = {
    version: SCHEMA_VERSION,
    ...(data.dir && data.dir !== DEFAULT_DIR ? {dir: data.dir} : {}),
    packages: data.packages ?? {},
  };

  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, target);
  return target;
}
