import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * `ast evidence capture` is the fix for a specific field-trial defect: `evidence add`
 * accepts a hand-typed summary with no artifact behind it, and the false-confidence gate
 * can only catch what the evidence actually contains -- so a PASSED claim built on a
 * typed sentence sailed through unchallenged. This command spawns the real command,
 * hashes its real output, and records its real exit code and duration, giving the
 * existing gate (unchanged; see evidence-engine.test.mjs) something honest to check.
 *
 * Run as a subprocess: the defect this closes lived partly in argument parsing
 * (`bin/ast.mjs`'s new "--" terminator), which an in-process import would not exercise,
 * and the whole point is proving the real child_process path -- real exit codes, real
 * wall-clock duration, a real file on disk.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AST = path.join(ROOT, 'bin', 'ast.mjs');

function freshState(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ast-capture-${label}-`));
}

function writeScript(dir, name, source) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, source, 'utf8');
  return file;
}

function ast(args, stateDir) {
  // "--state" MUST precede any literal "--" the caller passes (evidence capture's own
  // command terminator) -- anything after "--" is handed verbatim to the spawned child
  // and never reaches ast's own flag parser. Placing it first is always safe: nothing
  // else in the CLI cares about --state's position relative to the command name.
  return execFileSync(process.execPath, [AST, '--state', stateDir, ...args], { encoding: 'utf8', timeout: 20_000 });
}

function astInput(args, payload, stateDir) {
  const file = path.join(stateDir, `input-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  return ast([...args, '--input', file], stateDir);
}

/** Start a session and one execution; returns the execution id. */
function openExecution(dir, goal = 'smoke') {
  ast(['session', 'start', '--request', 'evidence-capture test'], dir);
  const out = JSON.parse(astInput(['exec', 'start'], { goal, method: 'static-analysis' }, dir));
  return out.execution_id;
}

test('-- hands every following token to the child process verbatim, including tokens shaped like ast flags', () => {
  const dir = freshState('dashdash');
  const exec = openExecution(dir);
  const script = writeScript(dir, 'echo-argv.mjs', 'console.log(JSON.stringify(process.argv.slice(2)));');
  const out = JSON.parse(ast(['evidence', 'capture', '--exec', exec, '--summary', 'argv check', '--',
    process.execPath, script, '--input', 'not-a-real-flag', '--state', 'also-not-a-flag'], dir));
  // The evidence's own excerpt contains the child's real stdout -- proving the child, not
  // ast's own parser, received these tokens.
  assert.match(out.excerpt, /\["--input","not-a-real-flag","--state","also-not-a-flag"\]/);
});

test('flags before "--" still parse normally; the terminator only changes what comes after it', () => {
  const dir = freshState('flags-before-dashdash');
  const exec = openExecution(dir);
  const script = writeScript(dir, 'ok2.mjs', 'process.exit(0);');
  // --summary and --exec both sit before "--" here and must reach ast's own flags exactly
  // as they would with no "--" present at all.
  const ev = JSON.parse(ast(['evidence', 'capture', '--exec', exec, '--summary', 'flags survive the terminator', '--',
    process.execPath, script], dir));
  assert.equal(ev.summary, 'flags survive the terminator');
  assert.equal(ev.execution_id, exec);
});

test('a command form that never uses "--" is completely unaffected by the terminator existing', () => {
  // Regression guard for the terminator itself: every command that predates "--" must see
  // an empty rest and behave exactly as before. risk profiles takes no positional data at
  // all, making it a clean canary for "did adding the terminator change argument parsing
  // for commands that never touch it".
  const dir = freshState('rest-inert');
  const out = JSON.parse(ast(['risk', 'profiles'], dir));
  assert.ok(Array.isArray(out.profiles) && out.profiles.length > 0);
});

test('capturing a zero-exit command records exit 0, a real hashed artifact on disk, and a positive byte count', () => {
  const dir = freshState('zero-exit');
  const exec = openExecution(dir);
  const script = writeScript(dir, 'ok.mjs', "console.log('all good'); process.exit(0);");
  const ev = JSON.parse(ast(['evidence', 'capture', '--exec', exec, '--summary', 'ok script', '--',
    process.execPath, script], dir));
  assert.equal(ev.command.exit_code, 0);
  assert.ok(ev.artifact.sha256.startsWith('sha256:'));
  assert.ok(ev.artifact.bytes > 0);
  assert.ok(fs.existsSync(ev.artifact.path), 'the hashed blob must actually exist on disk');
});

test('the recorded duration is the spawned command\'s wall-clock time, not the caller\'s', () => {
  const dir = freshState('duration');
  const exec = openExecution(dir);
  const script = writeScript(dir, 'slow.mjs', 'await new Promise((r) => setTimeout(r, 350)); process.exit(0);');
  const ev = JSON.parse(ast(['evidence', 'capture', '--exec', exec, '--summary', 'slow script', '--',
    process.execPath, script], dir));
  // Real spawn timing: comfortably above the 350ms sleep, comfortably below "the whole test
  // file's runtime" (which is what duration_ms measures on executions today -- see G-06).
  assert.ok(ev.command.duration_ms >= 300, `expected >= 300ms, got ${ev.command.duration_ms}`);
  assert.ok(ev.command.duration_ms < 5000, `expected a real command duration, not accumulated test-harness time, got ${ev.command.duration_ms}`);
});

test('capturing a non-zero-exit command records the real exit code, does not throw, and does not set ast\'s own exit code', () => {
  const dir = freshState('nonzero-exit');
  const exec = openExecution(dir);
  const script = writeScript(dir, 'fails.mjs', 'process.exit(3);');
  // execFileSync throws on a non-zero exit code from AST ITSELF -- so simply not throwing
  // here is part of the assertion: the target command failing is not ast's problem to
  // report as a failure. Deciding whether exit 3 is good or bad news belongs to the
  // calling skill's judgement, via the evidence gate, not to this command.
  let ev;
  assert.doesNotThrow(() => {
    ev = JSON.parse(ast(['evidence', 'capture', '--exec', exec, '--summary', 'audit-like run', '--',
      process.execPath, script], dir));
  });
  assert.equal(ev.command.exit_code, 3);
  assert.equal(ev.ok, undefined, 'a normal non-zero exit is not a capture-mechanism failure');
});

test('a captured non-zero exit code then blocks a false PASSED claim through the existing, unchanged gate', () => {
  const dir = freshState('gate-proof');
  const exec = openExecution(dir);
  const script = writeScript(dir, 'audit.mjs', 'process.exit(1);');
  const ev = JSON.parse(ast(['evidence', 'capture', '--exec', exec, '--summary', 'npm audit (simulated)', '--',
    process.execPath, script], dir));
  const verdict = JSON.parse(astInput(['evidence', 'verify'], { status: 'PASSED', evidenceIds: [ev.evidence_id] }, dir));
  assert.equal(verdict.permitted, false);
  assert.equal(verdict.downgrade_to, 'INCONCLUSIVE');
  assert.match(verdict.reasons.join(' '), /non-zero exit code/);
});

test('a secret in the child\'s stdout is redacted in both the excerpt and the on-disk blob, and marked redacted: true', () => {
  const dir = freshState('redact');
  const exec = openExecution(dir);
  const script = writeScript(dir, 'leaky.mjs', "console.log('AWS key in output: AKIAABCDEFGHIJKLMNOP');");
  const ev = JSON.parse(ast(['evidence', 'capture', '--exec', exec, '--summary', 'leaky script', '--',
    process.execPath, script], dir));
  assert.equal(ev.redacted, true);
  assert.doesNotMatch(ev.excerpt, /AKIAABCDEFGHIJKLMNOP/);
  assert.match(ev.excerpt, /\[REDACTED:aws-access-key-id\]/);
  const blob = fs.readFileSync(ev.artifact.path, 'utf8');
  assert.doesNotMatch(blob, /AKIAABCDEFGHIJKLMNOP/);
});

test('"--exec" naming a missing execution fails before spawning anything', () => {
  const dir = freshState('missing-exec');
  fs.mkdirSync(dir, { recursive: true });
  const script = writeScript(dir, 'sentinel.mjs', "fs = require('fs'); fs.writeFileSync(process.argv[2], 'ran');");
  const sentinel = path.join(dir, 'sentinel.txt');
  assert.throws(
    () => ast(['evidence', 'capture', '--exec', 'EXEC-9999-99999', '--',
      process.execPath, script, sentinel], dir),
    (err) => err.status === 1 && /No such execution: EXEC-9999-99999/.test(err.stderr),
  );
  assert.ok(!fs.existsSync(sentinel), 'the command must never run when the named execution does not exist');
});

test('no command after "--" is a clear, immediate error, not a hang or a spawn of nothing', () => {
  const dir = freshState('no-command');
  const exec = openExecution(dir);
  assert.throws(
    () => ast(['evidence', 'capture', '--exec', exec, '--'], dir),
    (err) => err.status === 1 && /requires a command after/.test(err.stderr),
  );
});

test('omitting "--" entirely (no command at all) fails the same way as an empty one', () => {
  const dir = freshState('no-dashdash');
  const exec = openExecution(dir);
  assert.throws(
    () => ast(['evidence', 'capture', '--exec', exec, '--summary', 'nothing to run'], dir),
    (err) => err.status === 1 && /requires a command after/.test(err.stderr),
  );
});

test('a command that never produces an exit code (killed by timeout) is a mechanism failure: no exit_code, ast exits non-zero, evidence is still recorded', () => {
  const dir = freshState('timeout');
  const exec = openExecution(dir);
  const script = writeScript(dir, 'hangs.mjs', 'await new Promise((r) => setTimeout(r, 10_000));');
  assert.throws(
    () => ast(['evidence', 'capture', '--exec', exec, '--timeout', '300', '--',
      process.execPath, script], dir),
    (err) => {
      assert.equal(err.status, 1);
      const ev = JSON.parse(err.stdout);
      assert.equal(ev.ok, false);
      assert.equal(ev.command.exit_code, undefined, 'no real exit code exists for a command that never finished');
      assert.ok(ev.command.duration_ms >= 250 && ev.command.duration_ms < 5000,
        `duration should track the ~300ms timeout, got ${ev.command.duration_ms}`);
      assert.ok(fs.existsSync(ev.artifact.path), 'evidence of the attempt must still be recorded, honestly, with no exit code');
      return true;
    },
  );
});
