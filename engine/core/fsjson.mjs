/**
 * JSON persistence helpers.
 *
 * Writes go through a temp file + rename so a crashed or interrupted run can
 * never leave a half-written state file behind. That matters because the
 * whole recovery story depends on state files being parseable.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function exists(file) {
  return fs.existsSync(file);
}

export function readJson(file, fallback = undefined) {
  if (!fs.existsSync(file)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing file: ${file}`);
  }
  // Strip a UTF-8 BOM. Windows PowerShell's `Out-File -Encoding utf8` writes one
  // by default, so hand-authored fixtures on Windows routinely carry it.
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Corrupt JSON at ${file}: ${err.message}`);
  }
}

export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/** Zero-dependency synchronous sleep, used only to back off between lock attempts. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

const LOCK_DEFAULTS = { retries: 200, minDelayMs: 4, maxDelayMs: 40, staleMs: 15000 };

/**
 * Error codes that mean "someone else has the lock", not "the filesystem is broken".
 *
 * POSIX reports a losing `wx` open as EEXIST. Windows reports it that way too, except when
 * the loser arrives while the winner's file is *pending delete* -- a handle is closed but
 * the directory entry is still live -- and then it surfaces as EPERM or EACCES. Treating
 * those two as fatal turns an ordinary race into a crashed update, which is exactly the
 * failure `tests/concurrency.test.mjs` reproduces on Windows at a few percent per run.
 */
const LOCK_CONTENDED = new Set(['EEXIST', 'EPERM', 'EACCES']);

/** The PID recorded in a lock file, or null if it cannot be read or parsed. */
function lockOwnerPid(lockFile) {
  try {
    const pid = Number.parseInt(String(fs.readFileSync(lockFile, 'utf8')).trim().split(':')[0], 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Is `pid` still running? EPERM means it exists and belongs to another user. */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Run `fn` while holding an exclusive, cross-process lock on `file`.
 *
 * The lock is a sibling file created with the `wx` flag, which fails atomically
 * if the lock already exists -- this is the mechanism, not `rename()`, because
 * two processes racing to rename onto the same destination is exactly what
 * produces an EPERM crash on Windows.
 *
 * The lock carries an ownership token (`<pid>:<uuid>`) and that token decides both halves
 * of the lifecycle, because age on its own cannot:
 *
 *   - *Breaking* a lock. An old lock is not proof of a dead owner, only of a slow one. A
 *     holder whose callback outran `staleMs` would have its lock stolen and then write its
 *     now-stale value over the thief's update. So a lock is broken only when its owner PID
 *     is confirmed gone -- which is the case this is actually for, a process that crashed
 *     mid-update and left the file behind for the *next* run to clean up.
 *   - *Releasing* a lock. An unconditional unlink at the end deletes whatever lock is
 *     present, including a successor's, handing two processes the lock at once. Releasing
 *     only a lock whose token is still ours closes that.
 *
 * If the owner is alive but wedged, this times out with an actionable error rather than
 * silently double-entering the critical section. Failing loud beats losing a write.
 */
function withLock(file, fn, opts = {}) {
  const { retries, minDelayMs, maxDelayMs, staleMs } = { ...LOCK_DEFAULTS, ...opts };
  const lockFile = `${file}.lock`;
  ensureDir(path.dirname(file));

  const token = `${process.pid}:${crypto.randomUUID()}`;

  let attempt = 0;
  for (;;) {
    try {
      fs.writeFileSync(lockFile, `${token}\n`, { flag: 'wx' });
      break;
    } catch (err) {
      if (!LOCK_CONTENDED.has(err.code)) throw err;

      let broke = false;
      try {
        const ownerPid = lockOwnerPid(lockFile);
        if (Date.now() - fs.statSync(lockFile).mtimeMs > staleMs && (ownerPid === null || !processAlive(ownerPid))) {
          fs.rmSync(lockFile, { force: true });
          broke = true;
        }
      } catch { /* lock vanished between the failed write and this stat -- fine, loop retries */ }

      if (attempt >= retries) {
        throw new Error(`Timed out waiting for the lock on "${path.basename(file)}" after ${retries} attempts. If another process is confirmed dead, delete "${lockFile}" manually.`);
      }
      // Counted even when the lock was broken, so a lock that cannot be cleared terminates
      // with the message above instead of spinning forever.
      attempt += 1;
      if (!broke) sleepSync(minDelayMs + Math.random() * (maxDelayMs - minDelayMs));
    }
  }

  try {
    return fn();
  } finally {
    try {
      if (String(fs.readFileSync(lockFile, 'utf8')).trim() === token) fs.rmSync(lockFile, { force: true });
    } catch { /* already gone, or unreadable -- either way not ours to remove */ }
  }
}

/**
 * Atomic read-modify-write for a shared JSON file. `updateFn` receives the
 * current value (or `fallback` if the file does not exist yet) and returns the
 * value to persist. The read and the write happen under one exclusive lock, so
 * two processes updating the same `file` concurrently can never observe or
 * clobber each other's half of the update -- the failure mode a bare
 * `readJson()` followed by `writeJson()` cannot avoid.
 */
export function updateJson(file, updateFn, fallback = undefined, lockOpts = {}) {
  return withLock(file, () => {
    const current = readJson(file, fallback);
    const next = updateFn(current);
    writeJson(file, next);
    return next;
  }, lockOpts);
}

export function writeText(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/**
 * Compare two filenames so that digit runs compare numerically.
 *
 * IDs are zero-padded (`DEC-00042`), which makes a plain lexical sort agree with ID order
 * -- but only until a counter outgrows its pad width. `DEC-100000` sorts *before*
 * `DEC-99999` lexically, because '1' < '9'. Comparing digit runs as numbers keeps the order
 * correct across that boundary instead of silently scrambling every collection read.
 */
function compareNatural(a, b) {
  const split = (s) => s.match(/\d+|\D+/g) ?? [];
  const as = split(a);
  const bs = split(b);
  for (let i = 0; i < Math.min(as.length, bs.length); i += 1) {
    const x = as[i];
    const y = bs[i];
    const bothNumeric = /^\d/.test(x) && /^\d/.test(y);
    if (bothNumeric) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return as.length - bs.length;
}

/** Read every *.json file in a directory, sorted by filename (== ID order). */
export function readCollection(d) {
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith('.json'))
    .sort(compareNatural)
    .map((f) => readJson(path.join(d, f)));
}

/** Append one JSON object per line. Used for append-only telemetry. */
export function appendJsonl(file, value) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
  return file;
}

export function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Stable SHA-256 of a file's bytes. Used to make evidence tamper-evident. */
export function sha256File(file) {
  const buf = fs.readFileSync(file);
  return `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;
}

export function sha256String(str) {
  return `sha256:${crypto.createHash('sha256').update(str, 'utf8').digest('hex')}`;
}
