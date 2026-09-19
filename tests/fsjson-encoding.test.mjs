import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson } from '../engine/core/fsjson.mjs';

/**
 * `readJson` already stripped a UTF-8 BOM (PowerShell's `Out-File -Encoding utf8` writes
 * one). A field trial hit the sibling gap: PowerShell 5.1's `>` redirect -- what
 * `npx playwright test > results.json` actually uses -- writes UTF-16LE, and that came
 * back as "Corrupt JSON" with no clue why, since the bytes are not corrupt at all, only
 * spelled differently. This file decodes the encoding directly rather than merely making
 * the error message nicer, matching the judgment already made for the UTF-8 BOM case:
 * this tool did not write the file, and text is still text.
 */
function tempFile(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ast-fsjson-${label}-`));
  return path.join(dir, 'data.json');
}

test('reads a plain UTF-8 file with no BOM, unchanged from before', () => {
  const file = tempFile('utf8-plain');
  fs.writeFileSync(file, JSON.stringify({ hello: 'world' }), 'utf8');
  assert.deepEqual(readJson(file), { hello: 'world' });
});

test('strips a UTF-8 BOM, as it already did', () => {
  const file = tempFile('utf8-bom');
  fs.writeFileSync(file, `﻿${JSON.stringify({ hello: 'world' })}`, 'utf8');
  assert.deepEqual(readJson(file), { hello: 'world' });
});

test('decodes a UTF-16LE file with a BOM -- what PowerShell 5.1\'s ">" redirect writes', () => {
  const file = tempFile('utf16le');
  const text = JSON.stringify({ passed: 18, failed: 0 });
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  fs.writeFileSync(file, buf);
  assert.deepEqual(readJson(file), { passed: 18, failed: 0 });
});

test('decodes a UTF-16BE file with a BOM', () => {
  const file = tempFile('utf16be');
  const text = JSON.stringify({ ok: true });
  const buf = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);
  fs.writeFileSync(file, buf);
  assert.deepEqual(readJson(file), { ok: true });
});

test('a UTF-16LE file with non-ASCII content still decodes correctly', () => {
  const file = tempFile('utf16le-unicode');
  const text = JSON.stringify({ note: 'café — passed' });
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  fs.writeFileSync(file, buf);
  assert.deepEqual(readJson(file), { note: 'café — passed' });
});

test('a genuinely corrupt file (no BOM, not valid JSON) still raises the actionable "Corrupt JSON" error', () => {
  const file = tempFile('corrupt');
  fs.writeFileSync(file, '{not valid json', 'utf8');
  assert.throws(() => readJson(file), /Corrupt JSON at/);
});

test('a missing file with no fallback still throws "Missing file", unaffected by decoding', () => {
  const file = tempFile('missing');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  assert.throws(() => readJson(file), /Missing file:/);
});

test('a missing file with a fallback returns the fallback, unaffected by decoding', () => {
  const file = tempFile('missing-fallback');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  assert.deepEqual(readJson(file, { fallback: true }), { fallback: true });
});
