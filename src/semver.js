/**
 * Just enough semver to answer one question: does the app's installed version
 * satisfy the range a checkout declares? `--prune-provided` removes a
 * checkout's own copy of a package only when the answer is yes.
 *
 * localize has no dependencies, so this is a deliberate subset rather than
 * `semver`: `^`, `~`, x-ranges (`1.x`, `1.2.*`, `*`, partial versions),
 * comparators (`>=`, `>`, `<`, `<=`, `=`), space-separated intersections,
 * `||` unions and hyphen ranges. Anything else -- a dist-tag, `file:`,
 * `npm:`, `workspace:`, a git URL -- returns `null`, "cannot tell", and the
 * caller keeps the copy. The failure mode is therefore always the safe one:
 * a copy kept that could have gone, never a copy removed that was needed.
 *
 * Prereleases follow npm's rule: `1.3.0-beta.1` satisfies a range only when
 * one of its comparators names a prerelease on the same `major.minor.patch`.
 */

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const PART = '(\\d+|[xX*])';
const COMPARATOR = new RegExp(
  `^(\\^|~>?|>=|<=|>|<|=)?v?${PART}(?:\\.${PART})?(?:\\.${PART})?(?:-([0-9A-Za-z.-]+))?(?:\\+[0-9A-Za-z.-]+)?$`,
);

/** @returns {{v: number[], pre: string[]}|null} */
export function parseVersion(version) {
  const m = VERSION.exec(String(version).trim());
  if (!m) return null;
  return {v: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : []};
}

/**
 * @returns {boolean|null} whether `version` satisfies `range`; `null` when
 *   either one is outside the subset this understands.
 */
export function satisfies(version, range) {
  const ver = parseVersion(version);
  if (!ver) return null;
  const sets = parseRange(range);
  if (!sets) return null;
  return sets.some((set) => setMatches(ver, set));
}

function setMatches(ver, set) {
  if (!set.every(([op, bound]) => test(ver, op, bound))) return false;
  if (!ver.pre.length) return true;
  // A prerelease only matches a range that opted into prereleases of that
  // exact major.minor.patch.
  return set.some(([, bound]) => bound.pre.length && cmpMain(bound.v, ver.v) === 0);
}

function test(ver, op, bound) {
  const c = compare(ver, bound);
  switch (op) {
    case '>=':
      return c >= 0;
    case '>':
      return c > 0;
    case '<=':
      return c <= 0;
    case '<':
      return c < 0;
    default:
      return c === 0;
  }
}

/** @returns {Array<Array<[string, {v: number[], pre: string[]}]>>|null} */
function parseRange(range) {
  if (typeof range !== 'string') return null;
  const sets = [];
  for (const raw of range.split('||')) {
    const set = parseSet(raw.trim());
    if (!set) return null;
    sets.push(set);
  }
  return sets.length ? sets : null;
}

function parseSet(raw) {
  if (raw === '' || raw === '*' || raw === 'x' || raw === 'X') return [['>=', at(0, 0, 0)]];
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(raw);
  if (hyphen) {
    const lo = parsePartial(hyphen[1]);
    const hi = parsePartial(hyphen[2]);
    if (!lo || !hi || lo.op || hi.op) return null;
    return [...(lo.parts[0] === null ? [] : [['>=', fill(lo)]]), ...upperOf(hi)];
  }
  const tokens = raw.replace(/(>=|<=|>|<|=|\^|~>?)\s+/g, '$1').split(/\s+/);
  const out = [];
  for (const token of tokens) {
    const comparators = expand(token);
    if (!comparators) return null;
    out.push(...comparators);
  }
  return out;
}

/** `{op, parts: [major|null, minor|null, patch|null], pre}` -- null is a wildcard or an omitted part. */
function parsePartial(token) {
  const m = COMPARATOR.exec(token);
  if (!m) return null;
  const parts = [m[2], m[3], m[4]].map((p) => (p === undefined || /^[xX*]$/.test(p) ? null : +p));
  // `1.x.3` is not a version anyone means.
  if (parts[0] === null && (parts[1] !== null || parts[2] !== null)) return null;
  if (parts[1] === null && parts[2] !== null) return null;
  return {op: m[1] ?? '', parts, pre: m[5] ? m[5].split('.') : []};
}

const at = (a, b, c, pre = []) => ({v: [a, b, c], pre});
const fill = ({parts, pre}) => at(parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, pre);
/** The exclusive upper bound of a version some of whose parts are wildcards. */
function nextUp([major, minor]) {
  return minor === null ? at(major + 1, 0, 0) : at(major, minor + 1, 0);
}
function upperOf(p) {
  if (p.parts[0] === null) return [];
  if (p.parts[2] !== null) return [['<=', fill(p)]];
  return [['<', nextUp(p.parts)]];
}

function expand(token) {
  const p = parsePartial(token);
  if (!p) return null;
  const [major, minor, patch] = p.parts;
  const full = patch !== null;
  switch (p.op) {
    case '':
    case '=':
      if (major === null) return [['>=', at(0, 0, 0)]];
      if (full) return [['=', fill(p)]];
      return [['>=', fill(p)], ['<', nextUp(p.parts)]];
    case '^': {
      if (major === null) return [['>=', at(0, 0, 0)]];
      const lower = ['>=', fill(p)];
      if (major > 0 || minor === null) return [lower, ['<', at(major + 1, 0, 0)]];
      if (minor > 0 || patch === null) return [lower, ['<', at(0, minor + 1, 0)]];
      return [lower, ['<', at(0, 0, patch + 1)]];
    }
    case '~':
    case '~>':
      if (major === null) return [['>=', at(0, 0, 0)]];
      return [['>=', fill(p)], ['<', minor === null ? at(major + 1, 0, 0) : at(major, minor + 1, 0)]];
    case '>=':
      return [['>=', fill(p)]];
    case '<':
      return major === null ? [['<', at(0, 0, 0)]] : [['<', fill(p)]];
    case '>':
      if (major === null) return [['<', at(0, 0, 0)]]; // `>*` matches nothing
      return full ? [['>', fill(p)]] : [['>=', nextUp(p.parts)]];
    case '<=':
      if (major === null) return [['>=', at(0, 0, 0)]];
      return full ? [['<=', fill(p)]] : [['<', nextUp(p.parts)]];
    default:
      return null;
  }
}

function cmpMain(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

function compare(a, b) {
  const main = cmpMain(a.v, b.v);
  if (main) return main;
  // A prerelease sorts before its release.
  if (!a.pre.length || !b.pre.length) return a.pre.length ? -1 : b.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return +x < +y ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
