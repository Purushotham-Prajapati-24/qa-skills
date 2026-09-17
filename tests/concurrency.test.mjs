import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { useTempState } from './helpers.mjs';
import { PACKAGE_ROOT } from '../engine/core/paths.mjs';

const tmp = useTempState('concurrency');
test.after(() => tmp.cleanup());

const IDS_MODULE = pathToFileURL(path.join(PACKAGE_ROOT, 'engine', 'core', 'ids.mjs')).href;

/**
 * Allocate `count` IDs of `kind` in a brand-new OS process, pointed at
 * `stateDir` via $AST_STATE_DIR (the same mechanism `bin/ast.mjs` honours).
 * A real child process is essential here: two async calls in one process
 * never race on the filesystem the way the reported incident did.
 */
function allocateInChildProcess(stateDir, kind, count) {
  const script = `
    const { nextId } = await import(${JSON.stringify(IDS_MODULE)});
    const ids = [];
    for (let i = 0; i < ${count}; i += 1) ids.push(nextId(${JSON.stringify(kind)}));
    process.stdout.write(JSON.stringify(ids));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, AST_STATE_DIR: stateDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`worker exited ${code}: ${err}`));
      else resolve(JSON.parse(out));
    });
  });
}

test('nextId allocates unique IDs when called from several concurrent processes sharing one state root', async () => {
  const PROCS = 4;
  const PER_PROC = 25;

  const results = await Promise.all(
    Array.from({ length: PROCS }, () => allocateInChildProcess(tmp.dir, 'finding', PER_PROC)),
  );

  const all = results.flat();
  assert.equal(all.length, PROCS * PER_PROC, 'every process must get all the IDs it asked for');
  assert.equal(new Set(all).size, all.length, 'no two processes may be handed the same ID');
});
