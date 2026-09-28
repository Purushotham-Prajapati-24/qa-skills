import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { useTempState, sampleProfile } from './helpers.mjs';
import * as browser from '../engine/browser-decision/index.mjs';
import * as auth from '../engine/authorization/index.mjs';
import { signalsFromProfile, evaluate } from '../engine/applicability-engine/index.mjs';
import { classify, unknownSignals } from '../engine/failure-classifier/index.mjs';
import { parseJUnit } from '../engine/core/junit.mjs';
import * as state from '../engine/state-engine/index.mjs';
import * as execution from '../engine/execution-engine/index.mjs';
import * as evidenceEngine from '../engine/evidence-engine/index.mjs';
import * as defects from '../engine/defect-engine/index.mjs';
import * as reporting from '../engine/reporting-engine/index.mjs';
import * as evaluation from '../engine/evaluation-engine/index.mjs';

// Field trial 3 (AgentDesk, 2026-09-28): the first run of the skills against a deployed URL.
// Each test below pins one defect that session hit. See evaluation/regression-suite/reg-00*.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AST = path.join(ROOT, 'bin', 'ast.mjs');

function tmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ast-ft3-${label}-`));
}
function ast(args, stateDir, opts = {}) {
  return JSON.parse(execFileSync(process.execPath, [AST, '--state', stateDir, ...args], { encoding: 'utf8', timeout: 20_000, ...opts }));
}
function input(dir, obj) {
  const f = path.join(dir, `in-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
}

const EXPLORE_FACTORS = { ui_known: 0.3, exploratory_value: 0.8, repeatability: 0.85, business_criticality: 0.9, existing_automation: 0.0 };
const CAPS = { 'browser.explore': true, 'browser.run_deterministic_test': true };

/* ------------------------------------------------ browser decide: environment */

test('browser decide treats an undeclared environment as production', () => {
  const d = browser.decide({ factors: EXPLORE_FACTORS, capabilities: CAPS });
  assert.deepEqual(d.environment, { class: 'unknown', treated_as_production: true });
  assert.ok(d.fired_rules.some((r) => r.id === 'no-exploration-on-production'));
  assert.notEqual(d.selected, 'hybrid');
  assert.notEqual(d.selected, 'playwright-mcp');
  assert.match(d.reason.join(' '), /Environment not declared, so it is treated as production/);
});

test('browser decide allows exploration only when the environment is declared non-production', () => {
  assert.equal(browser.decide({ factors: EXPLORE_FACTORS, capabilities: CAPS, environment: 'non-production' }).selected, 'hybrid');
  assert.equal(browser.decide({ factors: EXPLORE_FACTORS, capabilities: CAPS, environmentIsProduction: false }).selected, 'hybrid',
    'the legacy boolean still works when it is stated');
  assert.notEqual(browser.decide({ factors: EXPLORE_FACTORS, capabilities: CAPS, environmentIsProduction: true }).selected, 'hybrid');
});

test('browser decide rejects an environment value it does not know', () => {
  assert.throws(() => browser.decide({ factors: EXPLORE_FACTORS, environment: 'staging' }), /must be "production", "non-production" or "unknown"/);
});

test('browser decide --example shows the environment field', () => {
  const dir = tmp('example');
  const printed = execFileSync(process.execPath, [AST, '--state', dir, 'browser', 'decide', '--example'], { encoding: 'utf8' });
  assert.equal(JSON.parse(printed).environment, 'unknown');
});

/* ------------------------------------------ profile environments + declared signals */

function agentDeskProfile() {
  return {
    ...sampleProfile(),
    profile_version: '1.1.0',
    technologies: [
      { name: 'Next.js', kind: 'framework', evidence: ['package.json'] },
      { name: 'Qdrant', kind: 'database', evidence: ['package.json'] },
      { name: 'Gemini', kind: 'llm', evidence: ['src/lib/embeddings.ts'] },
    ],
    environments: [
      { name: 'production', url: 'https://agentdeskbot.vercel.app', class: 'production', evidence: ['user named it'] },
      { name: 'local', url: 'http://localhost:3000', class: 'non-production', evidence: ['package.json#scripts.dev'] },
    ],
    declared_signals: [{ signal: 'responsive', evidence: ['breakpoint classes in src/app/page.tsx'] }],
  };
}

test('signalsFromProfile derives rag and deploy-config and honours declared signals', () => {
  const signals = signalsFromProfile(agentDeskProfile());
  for (const s of ['rag', 'deploy-config', 'responsive', 'llm', 'web-ui']) assert.ok(signals.includes(s), `missing ${s}`);
  const applicable = evaluate({ signals }).applicable;
  for (const c of ['responsive', 'mobile-viewport', 'deployment', 'rag-evaluation']) assert.ok(applicable.includes(c), `${c} should apply`);
});

test('a declared signal outside the catalog is rejected, and profile save refuses it', () => {
  const bad = { ...agentDeskProfile(), declared_signals: [{ signal: 'responsiv', evidence: ['typo'] }] };
  assert.throws(() => signalsFromProfile(bad), /not a signal in the applicability catalog/);
  const dir = tmp('badsignal');
  assert.throws(() => ast(['profile', 'save', '--input', input(dir, bad)], dir, { stdio: 'pipe' }), /not a signal in the applicability catalog/);
});

test('declaredClassFromProfile matches by name or hostname, never by substring', () => {
  const p = agentDeskProfile();
  assert.equal(auth.declaredClassFromProfile('local', p).class, 'non-production');
  assert.equal(auth.declaredClassFromProfile('http://localhost:3000/checkout', p).class, 'non-production');
  assert.equal(auth.declaredClassFromProfile('agentdeskbot.vercel.app', p).class, 'production');
  assert.equal(auth.declaredClassFromProfile('https://staging.agentdeskbot.vercel.app', p), null);
});

test('the CLI reads profile environments for browser decide, auth check and classify-env', () => {
  const dir = tmp('envs');
  ast(['session', 'start', '--request', 'x'], dir);
  ast(['profile', 'save', '--input', input(dir, agentDeskProfile())], dir);

  const local = ast(['browser', 'decide', '--input', input(dir, { factors: EXPLORE_FACTORS, capabilities: CAPS, target: 'http://localhost:3000' })], dir);
  assert.equal(local.environment.class, 'non-production');
  assert.equal(local.selected, 'hybrid');
  const prod = ast(['browser', 'decide', '--input', input(dir, { factors: EXPLORE_FACTORS, capabilities: CAPS, target: 'https://agentdeskbot.vercel.app' })], dir);
  assert.equal(prod.environment.class, 'production');
  assert.notEqual(prod.selected, 'hybrid');

  const allowed = ast(['auth', 'check', '--input', input(dir, { action: 'db.read_non_production', target: 'http://localhost:3000' })], dir);
  assert.equal(allowed.allowed, true);
  const classified = ast(['auth', 'classify-env', 'http://localhost:3000'], dir);
  assert.equal(classified.environment_class, 'non-production');
  assert.equal(classified.basis, 'declared');
});

/* ----------------------------------------------------------------- caps probe */

test('playwright-cli is available only when @playwright/test resolves from the repository', () => {
  const dir = tmp('probe');
  const without = tmp('repo-without');
  fs.mkdirSync(path.join(without, 'node_modules', 'playwright'), { recursive: true });
  fs.writeFileSync(path.join(without, 'node_modules', 'playwright', 'package.json'), '{"name":"playwright","main":"index.js"}');
  fs.writeFileSync(path.join(without, 'node_modules', 'playwright', 'index.js'), '');
  assert.equal(ast(['caps', 'probe'], dir, { cwd: without }).providers['playwright-cli'], false,
    'the playwright library alone cannot run `playwright test`');

  const withRunner = tmp('repo-with');
  const pkg = path.join(withRunner, 'node_modules', '@playwright', 'test');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"@playwright/test","main":"index.js"}');
  fs.writeFileSync(path.join(pkg, 'index.js'), '');
  assert.equal(ast(['caps', 'probe'], dir, { cwd: withRunner }).providers['playwright-cli'], true);
});

test('caps probe prints a compact summary by default and the full resolution with --verbose', () => {
  const dir = tmp('probe-size');
  const brief = execFileSync(process.execPath, [AST, '--state', dir, 'caps', 'probe'], { encoding: 'utf8' });
  const full = execFileSync(process.execPath, [AST, '--state', dir, 'caps', 'probe', '--verbose'], { encoding: 'utf8' });
  assert.ok(brief.length < 4000, `summary is ${brief.length} bytes`);
  assert.ok(JSON.parse(full).capabilities['browser.explore'].candidates);
});

/* ---------------------------------------------------------- failure classifier */

test('a harness invocation error classifies as test-defect', () => {
  assert.equal(classify({ signals: ['harness-invocation-error'], evidenceIds: ['EV-1'] }).class, 'test-defect');
  assert.equal(classify({ signals: ['no-tests-executed'], evidenceIds: ['EV-1'] }).class, 'test-defect');
});

test('unknown signal tokens are named, and a class name passed as a signal is called out', () => {
  assert.deepEqual(unknownSignals(['http-500', 'module-not-found']), ['module-not-found']);
  const r = classify({ signals: ['module-not-found', 'test-defect'] });
  assert.equal(r.class, 'unclassified');
  assert.match(r.signals.join(' '), /unknown signal token\(s\) ignored: module-not-found, test-defect/);
  assert.match(r.signals.join(' '), /test-defect is a class, not a signal/);
  const mixed = classify({ signals: ['http-500', 'typo-token'], evidenceIds: ['EV-1'] });
  assert.equal(mixed.class, 'product-defect');
  assert.match(mixed.signals.join(' '), /typo-token/);
});

test('failure classify on the CLI returns unknown_signals, and failure signals lists the vocabulary', () => {
  const dir = tmp('classify');
  const out = ast(['failure', 'classify', '--json', '{"signals":["module-not-found"]}'], dir);
  assert.deepEqual(out.unknown_signals, ['module-not-found']);
  const vocab = ast(['failure', 'signals'], dir);
  assert.ok(vocab['test-defect'].includes('harness-invocation-error'));
});

/* ------------------------------------------------------------------- goals */

test('session goal records an assessed status through the evidence gate, and rolls criteria up', () => {
  const t = useTempState('goals');
  try {
    state.startSession({ request: 'x', git: null, goals: [{ goal: 'site loads', success_criteria: ['home 200', 'no console errors'] }] });
    const exec = execution.start({ goal: 'smoke', method: 'playwright-script' });
    const ev = evidenceEngine.captureOutput({ argv: 'node -e 0', cwd: t.dir, exitCode: 0, durationMs: 5, stdout: 'ok 1', summary: 'smoke', executionId: exec.execution_id });

    const dir = t.dir;
    const unevidenced = ast(['session', 'goal', 'G-01', '--criterion', '1', '--status', 'PASSED'], dir);
    assert.equal(unevidenced.recorded, 'INCONCLUSIVE');
    assert.equal(unevidenced.downgraded, true);

    ast(['session', 'goal', 'G-01', '--criterion', '1', '--status', 'PASSED', '--evidence', ev.evidence_id], dir);
    const after = ast(['session', 'goal', 'G-01', '--criterion', '2', '--status', 'PASSED', '--evidence', ev.evidence_id], dir);
    assert.equal(after.goal.success_criteria[1].status, 'PASSED');
    assert.equal(after.goal.status, 'PASSED', 'all criteria passed, so the goal rolls up to PASSED');
    assert.ok(after.goal.assessed_at);
  } finally {
    t.cleanup();
  }
});

test('the report renders a never-assessed criterion as "not assessed", not as its placeholder status', () => {
  const t = useTempState('goals-report');
  try {
    state.startSession({ request: 'x', git: null, goals: [{ goal: 'site loads', success_criteria: ['home 200'] }] });
    const r = reporting.generate({});
    const md = fs.readFileSync(r.markdown_path, 'utf8');
    assert.match(md, /\| G-01 \| site loads \| home 200 \| _not assessed_ \|/);
    assert.doesNotMatch(md, /\| home 200 \| NEEDS_USER_INPUT \|/);
  } finally {
    t.cleanup();
  }
});

/* --------------------------------------------- per-test results + deployed target */

const JUNIT = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testcase name="home returns 200" time="1.5" classname="test"/>
  <testcase name="headers &amp; HSTS present" time="0.2" classname="test"/>
  <testcase name="robots points at the deployed sitemap" time="0.3" classname="test" failure="expected x">
    <failure type="testCodeFailure" message="expected https://a got https://b">stack</failure>
  </testcase>
  <testcase name="skipped one" time="0"><skipped/></testcase>
</testsuites>`;

test('parseJUnit reads pass, fail, skip, durations and entities', () => {
  const r = parseJUnit(JUNIT);
  assert.deepEqual(r.map((t) => t.status), ['PASSED', 'PASSED', 'FAILED', 'SKIPPED']);
  assert.equal(r[1].name, 'headers & HSTS present');
  assert.equal(r[0].duration_ms, 1500);
  assert.match(r[2].message, /expected https:\/\/a/);
  assert.throws(() => parseJUnit('<html></html>'), /Not a JUnit XML document/);
});

test('passing tests inside a failed run reach "What was proven", and a deployed target gets its own provenance note', () => {
  const t = useTempState('proven');
  try {
    state.startSession({ request: 'x', git: { repository: 'o/r', branch: 'main', commit: 'a'.repeat(40), dirty: true } });
    const exec = execution.start({ goal: 'deployed smoke', method: 'playwright-script', target: { url: 'https://agentdeskbot.vercel.app' } });
    const ev = evidenceEngine.captureOutput({ argv: 'node --test', cwd: t.dir, exitCode: 1, durationMs: 80, stdout: '# pass 2\n# fail 1', summary: 'smoke', executionId: exec.execution_id });
    const junit = path.join(t.dir, 'junit.xml');
    fs.writeFileSync(junit, JUNIT);
    const { record: done } = execution.finish(exec.execution_id, { status: 'FAILED', statusReason: '2 of 4 passed', evidence: [ev.evidence_id], junit, signals: ['wrong-value-rendered'] });
    assert.deepEqual(done.totals, { total: 4, passed: 2, failed: 1, skipped: 1, errored: 0 });
    assert.equal(done.target.url, 'https://agentdeskbot.vercel.app');

    const md = fs.readFileSync(reporting.generate({}).markdown_path, 'utf8');
    const proven = md.slice(md.indexOf('## What was proven'), md.indexOf('## What was not tested'));
    assert.match(proven, /home returns 200 _\(passed; run FAILED overall: 2\/4\)_/);
    assert.match(proven, /headers & HSTS present/);
    assert.doesNotMatch(proven, /robots points at the deployed sitemap/);
    assert.match(proven, /The deployed commit was not recorded/);
    assert.doesNotMatch(proven, /with uncommitted changes in the working tree/,
      'a dirty local tree says nothing about what was deployed');
  } finally {
    t.cleanup();
  }
});

/* ------------------------------------------------------- evidence back-links */

test('a finding records itself in the supports[] of every evidence item it cites', () => {
  const t = useTempState('supports');
  try {
    state.startSession({ request: 'x', git: null });
    const exec = execution.start({ goal: 'scan', method: 'static-analysis' });
    const ev = evidenceEngine.captureOutput({ argv: 'npm audit', cwd: t.dir, exitCode: 1, durationMs: 5, stdout: '8 vulnerabilities', summary: 'audit', executionId: exec.execution_id });
    const f = defects.create({ title: 'advisories', confidence: 0.7, evidence: [ev.evidence_id], executionId: exec.execution_id });
    assert.deepEqual(state.get('evidence', ev.evidence_id).supports, [f.finding_id]);
  } finally {
    t.cleanup();
  }
});

/* ------------------------------------------------------------ misc + examples */

test('session phase warns when moving past discovery with no profile stored', () => {
  const dir = tmp('phase');
  ast(['session', 'start', '--request', 'x'], dir);
  assert.match(ast(['session', 'phase', 'profile'], dir).warning, /No repository profile is stored/);
});

test('the new --example payloads (profile save, decide, applicability eval, exec start, finding add, uncertainty raise) round-trip through the real commands', () => {
  for (const cmd of [['profile', 'save'], ['decide'], ['applicability', 'eval'], ['exec', 'start'], ['finding', 'add'], ['uncertainty', 'raise']]) {
    const dir = tmp(cmd.join('-'));
    ast(['session', 'start', '--request', 'x'], dir);
    const printed = execFileSync(process.execPath, [AST, '--state', dir, ...cmd, '--example'], { encoding: 'utf8' });
    const out = ast([...cmd, '--input', input(dir, JSON.parse(printed))], dir);
    assert.ok(out && typeof out === 'object', cmd.join(' '));
  }
});

test('"exec finish --example" prints the junit field', () => {
  const dir = tmp('finish-example');
  const printed = JSON.parse(execFileSync(process.execPath, [AST, '--state', dir, 'exec', 'finish', '--example'], { encoding: 'utf8' }));
  assert.ok(printed.junit);
});

/* ------------------------------------------------------------ regression suite */

test('eval run includes the regression suite and every regression case passes', () => {
  const r = evaluation.run();
  const reg = r.results.filter((x) => x.suite === 'regression');
  assert.ok(reg.length >= 5, `found ${reg.length} regression cases`);
  assert.deepEqual(reg.filter((x) => x.passed !== x.total).map((x) => x.id), []);
});
