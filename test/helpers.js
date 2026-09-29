/**
 * Test helpers.
 *
 * `makeConsumer` builds a throwaway consumer root with a real filesystem --
 * never a mocked one. The whole tool is about what `node_modules/<name>`
 * actually is, and asserting against a model of symlinks rather than against
 * symlinks would prove nothing.
 *
 * `stubbed` replaces the subprocess runner and records every invocation, which
 * is how the recursion guard is asserted: no npm, on any code path. The
 * real-localize test deliberately does NOT use it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {makeRun} from '../src/run.js';

export function tmpdir(prefix = 'localrepo-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function makeConsumer({pkg} = {}) {
  const appRoot = tmpdir('localrepo-consumer-');
  fs.mkdirSync(path.join(appRoot, 'node_modules'), {recursive: true});
  fs.writeFileSync(
    path.join(appRoot, 'package.json'),
    JSON.stringify({name: 'consumer', version: '1.0.0', private: true, ...pkg}, null, 2) + '\n',
  );
  return appRoot;
}

/** Deps with a REAL subprocess runner. Used by the real-localize test. */
export function realDeps(appRoot) {
  const logs = [];
  const warns = [];
  const errors = [];
  return {
    appRoot,
    run: makeRun(appRoot),
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
    error: (m) => errors.push(m),
    logs,
    warns,
    errors,
    output: () => [...logs, ...warns, ...errors].join('\n'),
  };
}

/** Deps whose subprocesses are stubbed and recorded. */
export function stubbed(appRoot, handler) {
  const calls = [];
  const logs = [];
  const warns = [];
  const errors = [];
  return {
    appRoot,
    calls,
    logs,
    warns,
    errors,
    output: () => [...logs, ...warns, ...errors].join('\n'),
    npmCalls: () => calls.filter((c) => /(^|[/\\])npm(\.cmd)?$/.test(c.cmd)),
    run: (cmd, args, opts = {}) => {
      const inv = {cmd, args, cwd: opts.cwd};
      calls.push(inv);
      return handler?.(inv) ?? {status: 0, stdout: '', stderr: ''};
    },
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
    error: (m) => errors.push(m),
  };
}

export const ok = (stdout = '') => ({status: 0, stdout, stderr: ''});
export const fail = (stderr = 'boom', status = 1) => ({status, stdout: '', stderr});

export function rm(dir) {
  fs.rmSync(dir, {recursive: true, force: true});
}
