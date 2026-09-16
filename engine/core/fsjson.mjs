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

export function writeText(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/** Read every *.json file in a directory, sorted by filename (== ID order). */
export function readCollection(d) {
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith('.json'))
    .sort()
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
