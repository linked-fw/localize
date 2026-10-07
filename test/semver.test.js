/**
 * The semver subset pruning decides with. A wrong `true` removes a
 * copy a checkout needed; a wrong `false` only keeps one. So every row here
 * that expects `true` is a claim worth checking against npm's own `semver`,
 * and anything outside the subset must come back `null`, never a guess.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {satisfies} from '../src/semver.js';

const rows = [
  // caret
  ['2.25.0', '^2.22.8', true],
  ['2.22.7', '^2.22.8', false],
  ['3.0.0', '^2.22.8', false],
  ['0.2.5', '^0.2.3', true],
  ['0.3.0', '^0.2.3', false],
  ['0.0.3', '^0.0.3', true],
  ['0.0.4', '^0.0.3', false],
  ['1.9.0', '^1.2', true],
  ['2.0.0', '^1.x', false],
  ['0.9.0', '^0.x', true],
  ['1.0.0', '^0.x', false],
  // tilde
  ['1.2.9', '~1.2.3', true],
  ['1.3.0', '~1.2.3', false],
  ['1.9.0', '~1', true],
  ['1.2.0', '~>1.2', true],
  // x-ranges and partials
  ['1.4.0', '1.x', true],
  ['2.0.0', '1.x', false],
  ['1.2.7', '1.2.*', true],
  ['1.3.0', '1.2', false],
  ['1.0.6', '^1.0', true],
  ['9.9.9', '*', true],
  ['9.9.9', '', true],
  ['1.2.3', '1.2.3', true],
  ['1.2.4', '=1.2.3', false],
  // comparators, intersections, unions, hyphens
  ['1.5.0', '>=1.2.0 <2.0.0', true],
  ['2.0.0', '>=1.2.0 <2.0.0', false],
  ['1.5.0', '>= 1.2 < 2', true],
  ['1.3.0', '>1.2', true],
  ['1.2.9', '>1.2', false],
  ['1.2.9', '<=1.2', true],
  ['1.3.0', '<=1.2', false],
  ['3.1.0', '^1.0.0 || ^3.0.0', true],
  ['2.1.0', '^1.0.0 || ^3.0.0', false],
  ['1.5.0', '1.2.3 - 1.6', true],
  ['1.7.0', '1.2.3 - 1.6', false],
  ['2.3.4', '1.2.3 - 2.3.4', true],
  // prereleases need a comparator that opts in on the same major.minor.patch
  ['2.0.0-beta.2', '^2.0.0-beta.1', true],
  ['2.0.0-alpha.9', '^2.0.0-beta.1', false],
  ['2.1.0-beta.1', '^2.0.0', false],
  ['2.0.0', '^2.0.0-beta.1', true],
  ['1.0.0-rc.10', '>=1.0.0-rc.2', true],
  // outside the subset: cannot tell, so the caller keeps the copy
  ['1.0.0', 'latest', null],
  ['1.0.0', 'file:../x', null],
  ['1.0.0', 'npm:other@^1', null],
  ['1.0.0', 'workspace:*', null],
  ['1.0.0', 'github:org/repo', null],
  ['not-a-version', '^1.0.0', null],
];

for (const [version, range, expected] of rows) {
  test(`satisfies(${version}, ${JSON.stringify(range)}) === ${expected}`, () => {
    assert.equal(satisfies(version, range), expected);
  });
}
