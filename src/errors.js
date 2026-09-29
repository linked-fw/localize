/**
 * Every refusal in localize throws a LocalizeError carrying an exit code, so
 * callers can branch on `.code` rather than matching on a message.
 *
 * The codes are a public contract: scripts depend on them.
 */

/** The manifest file is unusable and localize refuses to touch it. */
export const EXIT_BAD_FILE = 3;
/** No git repository could be resolved for the package name. */
export const EXIT_NOT_FOUND = 4;
/** Something was warned about and skipped; the command otherwise worked. */
export const EXIT_WARNED = 5;
/** A guard refused to act. `--force` overrides. */
export const EXIT_REFUSED = 6;
/** The install inside the checkout failed: nothing linked, nothing recorded. */
export const EXIT_INSTALL_FAILED = 7;
/** package.json / package-lock.json changed -- the failure this tool exists to prevent. */
export const EXIT_MANIFEST_DIRTY = 8;

export class LocalizeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LocalizeError';
    this.code = code;
  }
}
