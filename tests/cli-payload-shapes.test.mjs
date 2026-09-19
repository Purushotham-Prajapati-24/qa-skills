import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * `risk score`, `browser decide` and `applicability eval` each take a JSON payload whose
 * data must be nested under a named key (`factors`, `factors`, `signals`). Two field
 * trials hit the same defect from opposite directions: `risk score` had a flat-body
 * fallback that collided with key-aliasing and threw an error naming identifiers the
 * caller never wrote, while `browser decide` accepted a flat/empty body silently and
 * returned a confidently-precise-looking zero score for every candidate. This file proves
 * both failure modes are now loud, correctly attributed, and never instruct the caller to
 * edit the engine's own configuration file to work around a typo.
 *
 * Run as a subprocess (not by importing the engine) because the defect lived partly in
 * `bin/ast.mjs`'s own argument handling (`aliasKeys`, the `?? body` fallback), which an
 * in-process import of the engine functions would not exercise.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AST = path.join(ROOT, 'bin', 'ast.mjs');

function freshState(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ast-shapes-${label}-`));
}

function run(args, stateDir) {
  return execFileSync(process.execPath, [AST, ...args, '--state', stateDir], { encoding: 'utf8', timeout: 15_000 });
}

function runInput(args, payload, stateDir) {
  const file = path.join(stateDir, 'input.json');
  fs.writeFileSync(file, JSON.stringify(payload));
  return run([...args, '--input', file], stateDir);
}

/* --------------------------------------------------------------- risk score */

test('a flat risk factors body is rejected before it ever reaches the engine, naming the caller\'s own keys', () => {
  const dir = freshState('risk-flat');
  assert.throws(
    () => runInput(['risk', 'score'], { business_criticality: 0.9, security_sensitivity: 0.9 }, dir),
    (err) => err.status === 1 && /requires a "factors" object/.test(err.stderr) && !/businessCriticality/.test(err.stderr),
    'must reject before aliasing can twin the flat keys into unrecognisable camelCase names',
  );
});

test('the flat-body rejection points at the correct shape and at skills/risk-analysis, not at an empty message', () => {
  const dir = freshState('risk-flat-msg');
  assert.throws(
    () => runInput(['risk', 'score'], { coverage_deficit: 0.8 }, dir),
    (err) => /"factors":\s*\{/.test(err.stderr) && /risk-analysis\/SKILL\.md/.test(err.stderr),
  );
});

test('a genuinely unknown factor name inside a correctly-nested body never tells the caller to edit weights.json', () => {
  const dir = freshState('risk-typo');
  assert.throws(
    () => runInput(['risk', 'score'], { factors: { bussiness_criticality: { value: 0.9, basis: 'typo' } } }, dir),
    (err) => err.status === 1
      && /Unknown risk factor\(s\): bussiness_criticality/.test(err.stderr)
      && !/weights\.json/.test(err.stderr)
      && /ast risk profiles/.test(err.stderr),
  );
});

test('a correctly-nested risk payload still scores exactly as before -- the fix changes rejection, not scoring', () => {
  const dir = freshState('risk-good');
  const out = runInput(['risk', 'score'], {
    profile: 'balanced',
    factors: {
      business_criticality: { value: 0.9, basis: 'checkout is the only revenue path' },
      security_sensitivity: { value: 0.9, basis: 'diff touches auth middleware' },
      coverage_deficit: { value: 1.0, basis: 'grep found no test exercising this branch' },
    },
  }, dir);
  const assessment = JSON.parse(out);
  assert.equal(assessment.confidence_band, 'low');
  assert.ok(assessment.risk_score > 0);
  assert.deepEqual(assessment.unscored_factors.includes('business_criticality'), false);
});

test('an empty (but present) factors object still degrades gracefully to a low-confidence result, not an error', () => {
  // Deliberately NOT throwing here: unlike browser-decision, risk-engine's whole design is
  // "unevidenced factors are excluded, not guessed" -- a confidence_warning is the correct,
  // already-loud signal for zero evidence, and forcing an exception would fight a mechanism
  // that is working as designed and is separately relied on by the confidence-band system.
  const dir = freshState('risk-empty');
  const out = runInput(['risk', 'score'], { factors: {} }, dir);
  const assessment = JSON.parse(out);
  assert.equal(assessment.risk_score, 0);
  assert.equal(assessment.confidence_band, 'low');
  assert.match(assessment.confidence_warning, /Only 0 of \d+ weighted factors could be evidenced/);
});

/* ----------------------------------------------------------- browser decide */

test('browser decide never returns a real "selected" value at the same time as escalate: true', () => {
  const dir = freshState('browser-tie');
  // Fully empty factors: every affinity contribution is absent, so every eligible
  // candidate scores exactly 0 and ties -- the ambiguity gate must fire.
  const out = runInput(['browser', 'decide'], {
    factors: {},
    capabilities: { 'browser.run_deterministic_test': true, 'browser.explore': true },
  }, dir);
  const d = JSON.parse(out);
  assert.equal(d.escalate, true);
  assert.equal(d.selected, null);
  assert.ok(typeof d.top_candidate === 'string' && d.top_candidate.length > 0,
    'the tied candidate must still be visible, under a name that does not imply it is safe to use');
});

test('browser decide with no eligible capability also nulls selected, and never surfaces a top_candidate that is blocked', () => {
  const dir = freshState('browser-nocap');
  const out = runInput(['browser', 'decide'], {
    factors: { exploratory_value: 0.8, repeatability: 0.9 },
    // no capabilities supplied at all -- everything is blocked
  }, dir);
  const d = JSON.parse(out);
  assert.equal(d.selected, null);
  assert.equal(d.escalate, true);
  assert.equal(d.top_candidate, undefined,
    'there is no tied candidate to surface when every candidate was removed by a hard rule or missing capability');
});

test('a correctly-nested, unambiguous browser decide payload still selects normally -- the fix changes ties, not clear wins', () => {
  const dir = freshState('browser-clear');
  const out = runInput(['browser', 'decide'], {
    factors: { ui_known: 0.2, exploratory_value: 0.8, repeatability: 0.85, business_criticality: 0.9, existing_automation: 0.3 },
    capabilities: { 'browser.explore': true },
  }, dir);
  const d = JSON.parse(out);
  assert.equal(d.escalate, false);
  assert.equal(d.selected, 'hybrid');
  assert.equal(d.top_candidate, undefined, 'top_candidate only appears while escalating');
});

test('a genuinely unknown browser-decision factor name never tells the caller to edit matrix.json', () => {
  const dir = freshState('browser-typo');
  assert.throws(
    () => runInput(['browser', 'decide'], { factors: { repeatabilty: 0.9 } }, dir),
    (err) => err.status === 1
      && /Unknown browser-decision factor\(s\): repeatabilty/.test(err.stderr)
      && !/matrix\.json/.test(err.stderr)
      && /ast browser matrix/.test(err.stderr),
  );
});

/* ------------------------------------------------------- applicability eval */

test('a genuinely unknown applicability signal never tells the caller to edit catalog.json', () => {
  const dir = freshState('applicability-typo');
  assert.throws(
    () => runInput(['applicability', 'eval'], { signals: ['databse'] }, dir),
    (err) => err.status === 1
      && /Unknown repository signal\(s\): databse/.test(err.stderr)
      && !/catalog\.json/.test(err.stderr)
      && /ast applicability catalog/.test(err.stderr),
  );
});

test('an empty signals array is a legitimate input, not an error -- only "any repository" categories apply', () => {
  const dir = freshState('applicability-empty');
  const out = runInput(['applicability', 'eval'], { signals: [] }, dir);
  const result = JSON.parse(out);
  assert.ok(Array.isArray(result.matrix) && result.matrix.length > 0);
  const sanity = result.matrix.find((r) => r.category === 'sanity');
  assert.ok(sanity && sanity.applicable, 'a category requiring "any repository" must still be reachable with zero signals');
});
