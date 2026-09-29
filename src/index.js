/**
 * localrepo's programmatic API.
 *
 * Every function takes `deps` -- `{appRoot, run, log, warn, error}` -- so a
 * caller can point it at another root or capture its output. `defaultDeps()`
 * builds the normal one.
 */
export {localize} from './localize.js';
export {delocalize} from './delocalize.js';
export {list, collect} from './list.js';
export {relink} from './relink.js';
export {resolvePackage, normalizeGitUrl, checkoutNameFor} from './resolve.js';
export {readManifest, writeManifest, manifestPath, MANIFEST_FILENAME, SCHEMA_VERSION, DEFAULT_DIR} from './manifest.js';
export {defaultDeps, makeRun} from './run.js';
export {
  LocalpkgError,
  EXIT_BAD_FILE,
  EXIT_NOT_FOUND,
  EXIT_WARNED,
  EXIT_REFUSED,
  EXIT_INSTALL_FAILED,
  EXIT_MANIFEST_DIRTY,
} from './errors.js';
