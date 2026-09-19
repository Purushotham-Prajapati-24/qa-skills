import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { useTempState } from './helpers.mjs';
import * as state from '../engine/state-engine/index.mjs';
import * as execution from '../engine/execution-engine/index.mjs';
import * as decisions from '../engine/decision-engine/index.mjs';
import * as uncertainty from '../engine/uncertainty-register/index.mjs';
import { check as checkCompleteness } from '../engine/evaluation-engine/process-completeness.mjs';

/**
 * `ast validate` checks schemas and referential integrity. Neither says anything about
 * whether the PROCESS the orchestrator's skill describes actually happened: a session can
 * run real executions, record zero decisions, and leave blocked work unraised as an
 * uncertainty, and validate said "No problems found." A field trial did exactly this and
 * confessed to it only in a hand-written appendix nothing in the tool's own output echoed.
 *
 * These tests cover `process-completeness.check()` directly (in-process -- it is a pure
 * function over state) plus `ast validate [--final]`'s promotion of "blocking" findings
 * (subprocess -- that merge logic lives in bin/ast.mjs, not in any importable engine).
 */
const tmp = useTempState('process-completeness');
test.after(() => tmp.cleanup());
// One session, built up sequentially by the tests below (each depends on state the
// previous one left behind, matching how a real session accumulates) -- node:test runs
// top-level tests in declaration order within a file, which this relies on.
state.startSession({ request: 'process-completeness in-process test session' });

function openRealExecution(goal = 'typecheck') {
  return execution.start({ goal, method: 'static-analysis', testCategory: 'sanity' });
}

test('a session with no real executions at all raises no findings -- nothing has happened yet to be incomplete', () => {
  const findings = checkCompleteness();
  assert.deepEqual(findings, []);
});

test('a "not-executed" record (BLOCKED/SKIPPED placeholder) alone does not trigger the no-decisions check', () => {
  execution.recordNonExecution({ goal: 'Load test', status: 'DEFERRED', reason: 'no isolated environment' });
  const findings = checkCompleteness();
  assert.equal(findings.find((f) => f.check === 'no-decisions'), undefined,
    'a record that only documents work which never ran is not "real work with no decision behind it"');
});

test('a real execution with zero decision records is a blocking finding', () => {
  const exec = openRealExecution();
  execution.finish(exec.execution_id, { status: 'PARTIAL', statusReason: 'still running' });
  const findings = checkCompleteness();
  const f = findings.find((c) => c.check === 'no-decisions');
  assert.ok(f, 'expected a no-decisions finding');
  assert.equal(f.severity, 'blocking');
  assert.match(f.message, /cannot be reconstructed/);
});

test('recording a decision clears the no-decisions finding', () => {
  decisions.record({
    question: 'Which browser method?',
    options: ['playwright-script', 'playwright-mcp'],
    selected: 'playwright-script',
    reason: 'deterministic and produces a regression asset',
    confidence: 0.8,
    reversible: true,
  });
  const findings = checkCompleteness();
  assert.equal(findings.find((f) => f.check === 'no-decisions'), undefined);
});

test('a BLOCKED execution with no uncertainty raised is a blocking finding naming the execution', () => {
  const blocked = execution.start({ goal: 'Live payment E2E', method: 'playwright-script', testCategory: 'e2e' });
  execution.finish(blocked.execution_id, { status: 'BLOCKED', statusReason: 'no sandbox credentials' });
  const findings = checkCompleteness();
  const f = findings.find((c) => c.check === 'blocked-without-uncertainty');
  assert.ok(f, 'expected a blocked-without-uncertainty finding');
  assert.equal(f.severity, 'blocking');
  assert.match(f.message, new RegExp(blocked.execution_id));
});

test('raising the uncertainty clears the blocked-without-uncertainty finding', () => {
  uncertainty.raise({
    question: 'Should payment tests use real provider credentials?',
    impact: 'cannot safely execute a real transaction',
    affectedScope: ['payment-e2e'],
    nextAction: 'ask the user which environment and credentials to use',
  });
  const findings = checkCompleteness();
  assert.equal(findings.find((f) => f.check === 'blocked-without-uncertainty'), undefined);
});

test('no execution carries a commit is an advisory finding, never blocking -- there is no auto-capture path yet to hold sessions to', () => {
  const findings = checkCompleteness();
  const f = findings.find((c) => c.check === 'no-git-provenance');
  assert.ok(f, 'expected a no-git-provenance finding');
  assert.equal(f.severity, 'advisory');
});

test('an execution carrying a real commit clears the no-git-provenance finding', () => {
  const withGit = execution.start({
    goal: 'build', method: 'static-analysis',
    git: { repository: 'demo', branch: 'main', commit: 'abc1234' },
  });
  execution.finish(withGit.execution_id, { status: 'PASSED', statusReason: 'build ok' });
  const findings = checkCompleteness();
  assert.equal(findings.find((f) => f.check === 'no-git-provenance'), undefined);
});

test('a fully-compliant session (decisions recorded, no blocked work, commit present) raises nothing at all', () => {
  // Guards against a check that fires unconditionally regardless of what actually happened.
  const findings = checkCompleteness();
  assert.deepEqual(findings, []);
});

/* --------------------------------------------------- CLI: ast validate [--final] */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AST = path.join(ROOT, 'bin', 'ast.mjs');

function freshState(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ast-validate-${label}-`));
}

function ast(args, stateDir) {
  return execFileSync(process.execPath, [AST, '--state', stateDir, ...args], { encoding: 'utf8', timeout: 15_000 });
}

function astInput(args, payload, stateDir) {
  const file = path.join(stateDir, `input-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  return ast([...args, '--input', file], stateDir);
}

test('CLI: "ast validate" reports a blocking process gap as a warning and stays valid: true', () => {
  const dir = freshState('warn');
  ast(['session', 'start', '--request', 'x'], dir);
  const execOut = JSON.parse(astInput(['exec', 'start'], { goal: 'smoke', method: 'static-analysis' }, dir));
  // Finished, not left open -- an open execution fails validate on its own (a real,
  // separate, unrelated check), which would make this test pass for the wrong reason.
  astInput(['exec', 'finish', execOut.execution_id], { status: 'PASSED', statusReason: 'ok' }, dir);
  const out = JSON.parse(ast(['validate'], dir));
  assert.equal(out.valid, true);
  assert.ok(out.warnings.some((w) => /no-decisions|No decision records/.test(w)));
});

test('CLI: "ast validate --final" promotes the same gap to a failure', () => {
  const dir = freshState('promote');
  ast(['session', 'start', '--request', 'x'], dir);
  const execOut = JSON.parse(astInput(['exec', 'start'], { goal: 'smoke', method: 'static-analysis' }, dir));
  astInput(['exec', 'finish', execOut.execution_id], { status: 'PASSED', statusReason: 'ok' }, dir);
  let out;
  let threw = false;
  try {
    ast(['validate', '--final'], dir);
  } catch (err) {
    threw = true;
    assert.equal(err.status, 1);
    out = JSON.parse(err.stdout);
  }
  assert.ok(threw, '--final must exit non-zero when a blocking process gap exists');
  assert.equal(out.valid, false);
  // Confirms failure comes from the process gap specifically, not from some other,
  // unrelated validate problem coincidentally also being true.
  assert.equal(out.problems.length, 1);
  assert.ok(out.problems.some((p) => /No decision records/.test(p)));
});

test('CLI: "ast validate --final" never promotes the advisory-only no-git-provenance finding', () => {
  const dir = freshState('git-advisory');
  ast(['session', 'start', '--request', 'x'], dir);
  const execOut = JSON.parse(astInput(['exec', 'start'], { goal: 'smoke', method: 'static-analysis' }, dir));
  astInput(['decide'], {
    question: 'How deep should this pass go?', options: ['shallow', 'deep'], selected: 'shallow',
    reason: 'time-boxed', confidence: 0.7, reversible: true,
  }, dir);
  astInput(['exec', 'finish', execOut.execution_id], { status: 'PASSED', statusReason: 'ok' }, dir);

  const out = JSON.parse(ast(['validate', '--final'], dir));
  assert.equal(out.valid, true, 'no-git-provenance alone must never fail --final');
  assert.ok(out.warnings.some((w) => /no-git-provenance|Nothing in this session is reproducible/.test(w)));
});
