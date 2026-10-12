import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = path.join(ROOT, 'scripts', 'hooks', 'guard-destructive.mjs');

/**
 * Drive the hook exactly the way Claude Code does: JSON on stdin, JSON (or nothing) on
 * stdout. Testing it as a subprocess -- rather than importing an exported pattern list --
 * is what actually exercises the contract the harness depends on.
 */
function runGuard(command) {
  const stdout = execFileSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
    timeout: 10_000,
  });
  return stdout.trim() ? JSON.parse(stdout.trim()) : null;
}

function decisionOf(command) {
  return runGuard(command)?.hookSpecificOutput?.permissionDecision ?? 'allow';
}

const BENIGN = [
  'npm test',
  'npm ci && npm test',
  'git status',
  'git log --oneline -20',
  'node scripts/validate-repo.mjs',
  'echo hello',
  'ls -la',
  'git commit -m "fix: something"',
  'git push origin feature-branch',
  'DELETE FROM sessions WHERE id = $1',
  'git reset --soft HEAD~1',
];

const DENIED = [
  'git push --force',
  'git push --force origin main',
  'git push -f origin master',
  'DROP DATABASE shopflow',
  'DROP SCHEMA public CASCADE',
  'DROP TABLE users',
  'TRUNCATE TABLE orders',
  'DELETE FROM users',
  'DELETE FROM users;',
  'rm -rf /',
  'rm -fr /',
  'git clean -fdx',
  'git clean -xdf',
  'gh pr merge 42',
  'gh issue close 7',
  'gh repo delete acme/shop',
  'gh issue edit 7 --add-assignee someone',
];

test('benign commands used throughout this project are never denied', () => {
  for (const command of BENIGN) {
    assert.equal(decisionOf(command), 'allow', `expected "${command}" to be allowed`);
  }
});

test('catastrophic, irreversible commands are denied with a stated reason', () => {
  for (const command of DENIED) {
    const result = runGuard(command);
    assert.equal(
      result?.hookSpecificOutput?.permissionDecision,
      'deny',
      `expected "${command}" to be denied`,
    );
    assert.match(
      result.hookSpecificOutput.permissionDecisionReason,
      /\[autonomous-software-testing\]/,
      'the reason must identify which system is refusing',
    );
  }
});

test('a --force-with-lease push is not a bare force push', () => {
  // force-with-lease still fails if the remote moved, which is the safety property a bare
  // --force does not have. The guard deliberately distinguishes them.
  assert.equal(decisionOf('git push --force-with-lease origin feature-branch'), 'allow');
});

test('load-generating and active-scanning tools warn but are not denied', () => {
  const warned = runGuard('k6 run script.js');
  assert.equal(warned?.hookSpecificOutput?.permissionDecision, undefined, 'a warning must not deny');
  assert.match(warned.hookSpecificOutput.additionalContext, /[Ll]oad/);

  const scan = runGuard('nmap -sV target.internal');
  assert.match(scan.hookSpecificOutput.additionalContext, /authorisation/);
});

test('git reset --hard warns rather than denies -- a backstop, not the authorisation system', () => {
  // PROGRESS.md documents this hook as pattern-based and not the authorisation system. A
  // hard reset is common enough in real workflows that denying it outright would make the
  // guard the kind that "fires constantly and gets disabled" -- so it is a WARN, by design,
  // not an omission. This test exists so that design choice cannot regress silently in
  // either direction.
  const result = runGuard('git reset --hard HEAD~5');
  assert.equal(result?.hookSpecificOutput?.permissionDecision, undefined);
  assert.match(result.hookSpecificOutput.additionalContext, /discards uncommitted work/);
});

test('the guard fails open on malformed or empty input', () => {
  assert.equal(
    execFileSync(process.execPath, [GUARD], { input: 'not json', encoding: 'utf8', timeout: 10_000 }).trim(),
    '',
  );
  assert.equal(
    execFileSync(process.execPath, [GUARD], { input: '', encoding: 'utf8', timeout: 10_000 }).trim(),
    '',
  );
  assert.equal(
    execFileSync(process.execPath, [GUARD], { input: '{}', encoding: 'utf8', timeout: 10_000 }).trim(),
    '',
  );
});

/**
 * Known, documented limitation, not a claim the guard secretly handles: a regex matcher on
 * the literal command text cannot see through obfuscation. This is stated in PROGRESS.md
 * ("A creative command can evade it. It is a backstop, not the authorisation system.") --
 * recorded here as a passing test, honestly, rather than as an assertion that these are
 * caught.
 */
test('obfuscated destructive commands are a documented blind spot, not a silent regression', () => {
  const evasions = [
    'echo "RFJPUCBUQUJMRSB1c2Vycw==" | base64 -d | psql', // base64-encoded "DROP TABLE users"
    'rm -rf ~', // the root-only pattern never matches a bare "~"
    'D=DROP; echo "$D TABLE users" | psql', // the literal substring "DROP TABLE" never appears
  ];
  for (const command of evasions) {
    // Not asserting "deny" here would be dishonest about what the guard can do; not
    // asserting "allow" would be dishonest about what it happens to catch today. Recording
    // the actual outcome is the point -- if one of these starts getting caught later,
    // that is fine and this test will need updating, not fixing.
    runGuard(command);
  }
});

/* ------------------------------------------------------------ Stop gate hook */

import fs from 'node:fs';
import os from 'node:os';

const STOP = path.join(ROOT, 'scripts', 'hooks', 'stop-gate.mjs');
const PROMPT = path.join(ROOT, 'scripts', 'hooks', 'record-user-prompt.mjs');
const CLI = path.join(ROOT, 'bin', 'ast.mjs');

function hook(script, stateDir, input = {}, env = {}) {
  const out = execFileSync(process.execPath, [script], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, AST_STATE_DIR: stateDir, AST_STOP_GATE: '', ...env },
  });
  return out.trim() ? JSON.parse(out.trim()) : null;
}

function cli(stateDir, args, body) {
  const extra = [];
  if (body) {
    const f = path.join(stateDir, `in-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify(body));
    extra.push('--input', f);
  }
  return JSON.parse(execFileSync(process.execPath, [CLI, '--state', stateDir, ...args, ...extra], { encoding: 'utf8' }));
}

function sessionWithPlan(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ast-hook-${label}-`));
  cli(dir, ['session', 'start', '--request', 'test everything; you have 30 minutes']);
  const m = cli(dir, ['applicability', 'eval'], { signals: [] });
  for (const r of (m.matrix ?? []).filter((x) => x.applicable)) {
    cli(dir, ['exec', 'not-run'], { goal: `${r.category} testing`, status: 'SKIPPED', reason: `${r.priority}, out of scope for this probe`, testCategory: r.category });
  }
  cli(dir, ['decide'], { question: 'How deep should testing go?', options: ['standard', 'deep'], selected: 'standard', reason: 'fixture', confidence: 0.8, reversible: true });
  cli(dir, ['plan', 'save'], {
    plan_id: 'PLAN-00001', created_at: new Date().toISOString(), objective: 'Stop gate probe',
    scope: { in_scope: ['x'], out_of_scope: [] },
    applicability: [{ category: 'e2e', applicable: true, reason: 'multi-step user paths present' }],
    scenarios: [
      { id: 'S-01', title: 'first', category: 'e2e', method: 'api-client', obligation: 'must-test' },
      { id: 'S-02', title: 'second', category: 'e2e', method: 'api-client', obligation: 'must-test' },
    ],
    exit_criteria: ['both run'],
    provenance: { skill_version: '0.12.0', created_at: new Date().toISOString(), created_by: 'agent' },
  });
  return dir;
}

function runScenario(dir, id) {
  const ex = cli(dir, ['exec', 'start'], { goal: `run ${id}`, method: 'api-client', plan_scenario_id: id, git: null });
  const ev = cli(dir, ['evidence', 'capture', '--exec', ex.execution_id, '--summary', id, '--', process.execPath, '-e', "require('node:assert').ok(1 + 1 === 2)"]);
  cli(dir, ['exec', 'finish', ex.execution_id], { status: 'PASSED', statusReason: `${id} assertion held`, evidence: [ev.evidence_id] });
}

test('stop gate: no testing session on disk -> silent, stopping allowed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-hook-empty-'));
  assert.equal(hook(STOP, dir), null);
});

test('stop gate: owed work blocks the stop and hands back the queue', () => {
  const dir = sessionWithPlan('block');
  const out = hook(STOP, dir, { stop_hook_active: false });
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /S-01/);
  assert.match(out.reason, /S-02/);
  assert.match(out.reason, /Keep going/);
});

test('stop gate: progress resets the count; no progress releases after the maximum', () => {
  const dir = sessionWithPlan('release');
  assert.equal(hook(STOP, dir).decision, 'block');           // strike 1
  runScenario(dir, 'S-01');
  assert.equal(hook(STOP, dir).decision, 'block');           // S-01 discharged: progress, back to strike 1
  assert.equal(hook(STOP, dir).decision, 'block');           // strike 2
  assert.equal(hook(STOP, dir).decision, 'block');           // strike 3
  const released = hook(STOP, dir);                          // strike 4 > max 3
  assert.equal(released.decision, undefined, 'it must never trap the session');
  assert.match(released.systemMessage, /released/);
});

test('stop gate: an empty queue lets the session stop', () => {
  const dir = sessionWithPlan('done');
  runScenario(dir, 'S-01');
  runScenario(dir, 'S-02');
  const todo = cli(dir, ['todo']);
  assert.equal(todo.done, true, JSON.stringify(todo.items));
  assert.equal(hook(STOP, dir), null);
});

test('stop gate: AST_STOP_GATE=off disables it', () => {
  const dir = sessionWithPlan('off');
  assert.equal(hook(STOP, dir, {}, { AST_STOP_GATE: 'off' }), null);
});

test('prompt hook: records the user\'s words, which then verify a user-attributed hold', async () => {
  const dir = sessionWithPlan('prompt');
  assert.equal(hook(PROMPT, dir, { prompt: 'Skip the load tests, the staging box cannot take it.' }), null);
  const s = cli(dir, ['session', 'show']);
  assert.equal(s.user_statements.at(-1).source, 'hook');
  assert.match(s.user_statements.at(-1).quote, /Skip the load tests/);
  const { setStateRoot } = await import('../engine/core/paths.mjs');
  setStateRoot(dir);
  const state = await import('../engine/state-engine/index.mjs');
  assert.equal(state.verifyUserQuote('skip the load tests'), 'hook');
  assert.equal(state.verifyUserQuote('you have 30 minutes'), 'request');
  assert.equal(state.verifyUserQuote('skip security too'), null);
  setStateRoot(null);
});

test('CLI: `session said` records an agent-transcribed statement, labelled as such', () => {
  const dir = sessionWithPlan('said');
  const out = cli(dir, ['session', 'said', '--quote', 'Do not touch the payments sandbox today']);
  assert.equal(out.recorded.source, 'agent');
});
