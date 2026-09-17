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
 * Run `fn` while holding an exclusive, cross-process lock on `file`.
 *
 * The lock is a sibling file created with the `wx` flag, which fails atomically
 * if the lock already exists -- this is the mechanism, not `rename()`, because
 * two processes racing to rename onto the same destination is exactly what
 * produces an EPERM crash on Windows. A lock older than `staleMs` is assumed to
 * belong to a process that died while holding it (this codebase never holds a
 * lock across anything but one read + one write) and is broken rather than
 * honoured forever, so a crashed process cannot wedge every future run.
 */
function withLock(file, fn, opts = {}) {
  const { retries, minDelayMs, maxDelayMs, staleMs } = { ...LOCK_DEFAULTS, ...opts };
  const lockFile = `${file}.lock`;
  ensureDir(path.dirname(file));

  let attempt = 0;
  for (;;) {
    try {
      fs.writeFileSync(lockFile, `${process.pid}\n`, { flag: 'wx' });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > staleMs) {
          fs.rmSync(lockFile, { force: true });
          continue; // retry immediately against the now-cleared lock, no backoff needed
        }
      } catch { /* lock vanished between the failed write and this stat -- fine, loop retries */ }
      if (attempt >= retries) {
        throw new Error(`Timed out waiting for the lock on "${path.basename(file)}" after ${retries} attempts. If another process is confirmed dead, delete "${lockFile}" manually.`);
      }
      attempt += 1;
      sleepSync(minDelayMs + Math.random() * (maxDelayMs - minDelayMs));
    }
  }

  try {
    return fn();
  } finally {
    try { fs.rmSync(lockFile, { force: true }); } catch { /* already gone */ }
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
export function updateJson(file, updateFn, fallback = undefined) {
  return withLock(file, () => {
    const current = readJson(file, fallback);
    const next = updateFn(current);
    writeJson(file, next);
    return next;
  });
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
