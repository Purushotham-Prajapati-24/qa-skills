import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * G-12: `session start --input goals.json` failed for a field trial's agent with no
 * goals.json to point at and no example anywhere in its reading path -- it read the
 * session schema cold, then gave up and ran with just --request. `risk score`'s payload
 * WAS documented with a worked example, but only in a sibling skill (risk-analysis/SKILL.md)
 * the agent had not loaded; the contract was correct and unreachable at the moment of use.
 *
 * `--example` prints a valid, realistic payload directly from the CLI for any command that
 * declares one -- payload contracts belong to the tool itself, not to prose an agent may
 * never read. These tests prove each of the four commands the field trial named
 * (session start, risk score, browser decide, report generate) round-trips through the
 * real command unmodified, not just that the flag prints *something*.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AST = path.join(ROOT, 'bin', 'ast.mjs');

function freshState(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ast-example-${label}-`));
}

function ast(args, stateDir) {
  return execFileSync(process.execPath, [AST, '--state', stateDir, ...args], { encoding: 'utf8', timeout: 15_000 });
}

function writeInput(dir, payload) {
  const file = path.join(dir, `example-input-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, payload);
  return file;
}

test('"ast <cmd> --example" for a command with no declared example is a clear error, not a crash', () => {
  const dir = freshState('undeclared');
  ast(['session', 'start', '--request', 'x'], dir);
  assert.throws(
    () => ast(['evidence', 'list', '--example'], dir),
    /no example payload is defined yet for "evidence list"/,
  );
});

test('"session start --example" prints a payload that round-trips through the real command', () => {
  const dir = freshState('session-start');
  const printed = ast(['session', 'start', '--example'], dir);
  const parsed = JSON.parse(printed);
  assert.ok(parsed.request);
  assert.ok(Array.isArray(parsed.goals) && parsed.goals.length > 0);
  const file = writeInput(dir, printed);
  const out = JSON.parse(ast(['session', 'start', '--input', file], dir));
  assert.equal(out.user_request, parsed.request);
  assert.equal(out.goals.length, parsed.goals.length);
});

test('"risk score --example" prints a payload that round-trips and produces a real score', () => {
  const dir = freshState('risk-score');
  const printed = ast(['risk', 'score', '--example'], dir);
  const parsed = JSON.parse(printed);
  assert.ok(parsed.factors && typeof parsed.factors === 'object');
  for (const factor of Object.values(parsed.factors)) {
    assert.ok(factor.basis, 'every factor in the example must carry a basis -- the engine throws without one');
  }
  const file = writeInput(dir, printed);
  const out = JSON.parse(ast(['risk', 'score', '--input', file], dir));
  assert.equal(typeof out.risk_score, 'number');
  assert.ok(out.risk_score > 0);
});

test('"browser decide --example" prints a payload that round-trips through the real command', () => {
  const dir = freshState('browser-decide');
  const printed = ast(['browser', 'decide', '--example'], dir);
  const parsed = JSON.parse(printed);
  assert.ok(parsed.factors && typeof parsed.factors === 'object');
  const file = writeInput(dir, printed);
  const out = JSON.parse(ast(['browser', 'decide', '--input', file], dir));
  assert.ok(Array.isArray(out.candidates) && out.candidates.length > 0);
});

test('"report generate --example" prints a payload that round-trips and generates a real report', () => {
  const dir = freshState('report-generate');
  ast(['session', 'start', '--request', 'x'], dir);
  const printed = ast(['report', 'generate', '--example'], dir);
  const parsed = JSON.parse(printed);
  assert.ok(Array.isArray(parsed.recommendations) && parsed.recommendations.length > 0);
  const file = writeInput(dir, printed);
  const out = JSON.parse(ast(['report', 'generate', '--input', file], dir));
  assert.ok(out.report_id);
});

test('--example never executes the command -- no session or state is created as a side effect', () => {
  const dir = freshState('no-side-effect');
  ast(['session', 'start', '--example'], dir);
  // A real "session start" would have created the state directory's session file.
  assert.equal(fs.existsSync(path.join(dir, 'testing-state.json')), false);
});
