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
  const raw = decodeText(fs.readFileSync(file));
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Corrupt JSON at ${file}: ${err.message}`);
  }
}

/**
 * Decode a file's bytes, working around the encodings Windows tooling actually produces
 * rather than the one everything here writes (UTF-8, no BOM).
 *
 * This is not this tool's own output -- `writeJson`/`writeText` always write plain UTF-8 --
 * it is what a hand-authored fixture or a captured command's redirected output arrives in.
 * PowerShell 5.1's `>` redirect (unlike `Out-File -Encoding utf8`) writes UTF-16LE with a
 * BOM, which is exactly what turned `npx playwright test > results.json` into "Corrupt
 * JSON" instead of a readable file. Decoding it is the same judgment call already made for
 * the UTF-8 BOM below: this file did not lie about its encoding, it is not this tool's job
 * to reject a file merely for spelling text a different, equally standard way.
 */
function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString('utf16le').replace(/^﻿/, '');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // Node has no native UTF-16BE decoder; byte-swap into UTF-16LE first. swap16() requires
    // an even length, true of any file that actually starts with a 2-byte BOM.
    return Buffer.from(buf).swap16().toString('utf16le').replace(/^﻿/, '');
  }
  // Strip a UTF-8 BOM. Windows PowerShell's `Out-File -Encoding utf8` writes one
  // by default, so hand-authored fixtures on Windows routinely carry it.
  return buf.toString('utf8').replace(/^﻿/, '');
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

/**
 * `staleMs` must stay inside the retry budget, or it can never be reached.
 *
 * The budget is `retries` x the mean of [minDelayMs, maxDelayMs] = 250 x 22ms = 5500ms of
 * deliberate waiting, against a 5000ms deadline. That ordering is the point, and
 * `tests/concurrency.test.mjs` asserts it: the old 15000 was unreachable, so a caller
 * entitled to clear a lock spent its whole budget and threw instead.
 *
 * `retries` is 250 rather than 200 so the margin comes from the configured delays alone.
 * At 200 the expected budget is 4400ms and only per-attempt syscall cost pushed real
 * elapsed time past 5000 -- true on the filesystem this was measured on, and not something
 * to depend on.
 *
 * Only the `ownerPid === null` branch consults `staleMs` now; a confirmed-dead owner is
 * broken on the PID check alone. So this governs one case: a lock file with no parseable
 * owner. Writing one is a single small `writeFileSync`, so a live owner cannot leave its
 * lock unreadable for five continuous seconds -- anything that does is a partially-written
 * or corrupt file, not a running process.
 */
export const LOCK_DEFAULTS = { retries: 250, minDelayMs: 4, maxDelayMs: 40, staleMs: 5000 };

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
        // A confirmed-dead owner needs no grace period. The PID check is the real signal;
        // age is only a proxy for it. Requiring BOTH meant the case this recovery exists
        // for -- a process that crashed mid-update -- was the one case it could not handle:
        // the lock had to outlive staleMs, which was longer than the retry budget, so the
        // caller failed hard and told the user to delete a file by hand instead of just
        // recovering.
        //
        // Age still gates the ownerPid === null case, because there death cannot be
        // established either. See LOCK_DEFAULTS for why staleMs stays inside the budget.
        const ownerConfirmedGone = ownerPid !== null && !processAlive(ownerPid);
        const unreadableAndStale = ownerPid === null
          && Date.now() - fs.statSync(lockFile).mtimeMs > staleMs;
        if (ownerConfirmedGone || unreadableAndStale) {
          fs.rmSync(lockFile, { force: true });
          broke = true;
        }
      } catch { /* lock vanished between the failed write and this stat -- fine, loop retries */ }

      if (attempt >= retries) {
        throw new Error(`Timed out waiting for the lock on "${path.basename(file)}" after ${retries} attempts. The owner recorded in "${lockFile}" is still running, so the lock was not broken: either it is wedged, or its PID has been reused by an unrelated process. Check the PID in that file, then delete it if that process is not an ${path.basename(file)} writer.`);
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
