import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { updateJson } from '../engine/core/fsjson.mjs';
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

/**
 * A lock left behind by a process that no longer exists must not wedge every future run --
 * that is the whole reason stale locks are breakable.
 */
test('a lock orphaned by a dead process is broken rather than honoured forever', () => {
  const file = path.join(tmp.dir, 'orphaned.json');
  const lockFile = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // PID 0 is never a real process, so the liveness check resolves it as dead. Backdating
  // the lock past the staleness deadline is what makes it a candidate for breaking.
  fs.writeFileSync(lockFile, '0:orphan\n', 'utf8');
  const old = Date.now() - 60_000;
  fs.utimesSync(lockFile, new Date(old), new Date(old));

  const result = updateJson(file, (current) => ({ n: (current?.n ?? 0) + 1 }), null);
  assert.equal(result.n, 1, 'the orphaned lock must not block the update');
  assert.equal(fs.existsSync(lockFile), false, 'the lock must be released afterwards');
});

/**
 * The mirror image: a lock held by a LIVE process is not stolen just because it is old.
 * Stealing it would let the slow owner write its stale value over the thief's update, so
 * the correct outcome is a loud timeout, not a silent second entry into the section.
 */
test('a lock held by a live process is never stolen, however old it is', () => {
  const file = path.join(tmp.dir, 'held.json');
  const lockFile = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // This test's own PID is definitionally alive.
  fs.writeFileSync(lockFile, `${process.pid}:someone-else\n`, 'utf8');
  const old = Date.now() - 60_000;
  fs.utimesSync(lockFile, new Date(old), new Date(old));

  assert.throws(
    () => updateJson(file, () => ({ n: 1 }), null, { retries: 3 }),
    /Timed out waiting for the lock/,
    'an old lock whose owner is still running must time out, not be broken',
  );
  assert.equal(fs.readFileSync(lockFile, 'utf8').trim(), `${process.pid}:someone-else`, 'the live owner keeps its lock');
  fs.rmSync(lockFile, { force: true });
});

/**
 * Releasing used to unlink whatever lock was present. If the lock had already been broken
 * and re-taken, that deleted the SUCCESSOR's lock and put two processes in the critical
 * section at once. Release is now conditional on the token still being ours.
 */
test('releasing a lock does not delete a successor lock that replaced ours', () => {
  const file = path.join(tmp.dir, 'successor.json');
  const lockFile = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  updateJson(file, (current) => {
    // Simulate another process having taken over mid-callback.
    fs.writeFileSync(lockFile, '0:successor\n', 'utf8');
    return { n: (current?.n ?? 0) + 1 };
  }, null);

  assert.equal(fs.existsSync(lockFile), true, 'the successor lock must survive our release');
  assert.equal(fs.readFileSync(lockFile, 'utf8').trim(), '0:successor');
  fs.rmSync(lockFile, { force: true });
});

/**
 * The case the stale-lock recovery actually exists for: a process that crashed mid-update.
 *
 * Breaking used to require the lock to be older than `staleMs` AND its owner to be gone.
 * The retry budget (retries x maxDelayMs, ~6s by default) expires long before the 15s
 * default `staleMs`, so a lock left by a process that died seconds ago was not breakable
 * within one call -- the caller burned its whole budget and threw, telling the user to
 * delete a file by hand. A confirmed-dead owner needs no grace period: the PID is the real
 * signal and age is only a proxy for it.
 */
test('a lock whose owner is confirmed dead is broken immediately, at any age', () => {
  // A PID that cannot be running. Linux caps at 2^22 and Windows PIDs are far below this.
  const deadPid = 4_194_305;
  for (const ageMs of [0, 1_000, 60_000]) {
    const file = path.join(tmp.dir, `dead-${ageMs}.json`);
    const lockFile = `${file}.lock`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(lockFile, `${deadPid}:crashed-owner\n`, 'utf8');
    const when = Date.now() - ageMs;
    fs.utimesSync(lockFile, new Date(when), new Date(when));

    const started = Date.now();
    const result = updateJson(file, (current) => ({ ...(current ?? {}), recovered: true }), null);
    assert.equal(result.recovered, true, `a ${ageMs}ms-old lock from a dead owner must be broken`);
    assert.ok(
      Date.now() - started < 2_000,
      `breaking a dead owner's lock must not wait out staleMs (took ${Date.now() - started}ms)`,
    );
    assert.equal(fs.existsSync(lockFile), false, 'the lock is released afterwards');
  }
});

/**
 * An unreadable lock still needs the age check, because a lock file with no parseable PID
 * proves nothing about its owner. This branch is reachable across invocations rather than
 * within one, which is the deliberate trade: an unreadable lock means a partially-written
 * or corrupt file, not an ordinary crash.
 */
test('a lock with no parseable owner is broken only once it is older than staleMs', () => {
  const file = path.join(tmp.dir, 'unreadable.json');
  const lockFile = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  fs.writeFileSync(lockFile, 'not-a-pid\n', 'utf8');
  assert.throws(
    () => updateJson(file, () => ({ n: 1 }), null, { retries: 3 }),
    /Timed out waiting for the lock/,
    'a fresh unreadable lock is not broken: nothing establishes that its owner is gone',
  );

  const old = Date.now() - 60_000;
  fs.utimesSync(lockFile, new Date(old), new Date(old));
  assert.equal(
    updateJson(file, () => ({ n: 2 }), null, { retries: 3 }).n,
    2,
    'once older than staleMs an unreadable lock is broken',
  );
  fs.rmSync(lockFile, { force: true });
});
