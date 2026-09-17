/**
 * Coverage for the two engines nothing else imports: capability-registry and
 * evaluation-engine.
 *
 * The registry is the more urgent of the two. It is the only engine whose failure mode is
 * silent: a declaration that reports success but changes nothing leaves every capability
 * resolving to "unavailable", which the system is designed to report as BLOCKED rather
 * than as an error. The whole documented happy path -- declare, then resolve -- is one
 * assertion, and it did not exist.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempState } from './helpers.mjs';
import * as caps from '../engine/capability-registry/index.mjs';
import * as evaluation from '../engine/evaluation-engine/index.mjs';
import * as metrics from '../engine/evaluation-engine/metrics.mjs';
import * as state from '../engine/state-engine/index.mjs';
import * as execution from '../engine/execution-engine/index.mjs';
import * as auth from '../engine/authorization/index.mjs';

const tmp = useTempState('capabilities');
test.after(() => tmp.cleanup());

/* ------------------------------------------------------ capability registry */

test('declaring a provider available immediately resolves its verbs', () => {
  // The documented happy path, and the one that regressed: `caps declare` folds into the
  // same `providers` map `resolve()` reads, so no second command is needed to make a
  // declaration take effect.
  const before = caps.resolve('browser.explore');
  assert.equal(before.available, false, 'undeclared must not resolve');

  caps.declare('mcp-playwright', true, 'browser_navigate/browser_snapshot present');

  const after = caps.resolve('browser.explore');
  assert.equal(after.available, true);
  assert.equal(after.provider, 'mcp-playwright');
  assert.match(after.reason, /browser_navigate/);
});

test('a capability is unavailable until declared, and unknown is not yes', () => {
  // Three states, not two. Undeclared is the dangerous one: treating it as available
  // produces a plan whose steps silently never run.
  const undeclared = caps.resolve('jira.create_issue');
  assert.equal(undeclared.available, false);
  assert.equal(
    undeclared.candidates.find((c) => c.provider === 'mcp-atlassian').available,
    null,
    'undeclared must be null (unknown), never false',
  );
  assert.match(undeclared.reason, /do not simulate it/);

  caps.declare('mcp-atlassian', false, 'connector requires OAuth; not authorised in this session');
  const declaredFalse = caps.resolve('jira.create_issue');
  assert.equal(declaredFalse.available, false);
  assert.equal(declaredFalse.candidates.find((c) => c.provider === 'mcp-atlassian').available, false);
  assert.match(declaredFalse.candidates.find((c) => c.provider === 'mcp-atlassian').detail, /OAuth/);
});

test('declaring an unknown provider is rejected rather than silently stored', () => {
  assert.throws(
    () => caps.declare('mcp-not-a-real-server', true, 'typo'),
    /Unknown provider "mcp-not-a-real-server"/,
  );
  assert.throws(() => caps.resolve('github.summon_intern'), /Unknown capability/);
});

test('a declaration survives a probe instead of being wiped by it', () => {
  // probe() rewrites the whole providers map. An agent-declared provider has no probe the
  // module can run, so the declaration is the only record of it -- losing it here would
  // silently un-declare every MCP server mid-session.
  caps.declare('mcp-playwright', true, 'still present');
  const probed = caps.probe();
  assert.equal(probed.providers['mcp-playwright'].available, true);
  assert.equal(probed.providers['mcp-playwright'].method, 'agent-declared');
  assert.equal(probed.capabilities['browser.explore'].available, true);
});

test('resolution carries the write and authorization metadata the gate needs', () => {
  const read = caps.resolve('github.read_pr');
  assert.equal(read.write, false);
  assert.equal(read.authorization, 'none');

  const write = caps.resolve('github.create_issue');
  assert.equal(write.write, true);
  assert.equal(write.authorization, 'explicit', 'a write verb must never default to no authorisation');
});

test('resolveAll reports the unavailable set rather than omitting it', () => {
  const all = caps.resolveAll();
  assert.ok(all.capabilities['browser.explore']);
  assert.equal(Object.keys(all.capabilities).length, caps.VERBS.length);
  assert.ok(Array.isArray(all.unavailable));
  for (const verb of all.unavailable) assert.equal(all.available[verb], false);
});

/* -------------------------------------------------------- evaluation engine */

test('the benchmark suite runs and scores every case', () => {
  const r = evaluation.run();
  assert.ok(r.cases > 0, 'benchmark cases must load');
  assert.equal(r.checks, r.results.reduce((a, x) => a + x.total, 0));
  assert.equal(r.passed, r.results.reduce((a, x) => a + x.passed, 0));
  assert.ok(r.score >= 0 && r.score <= 1);
  assert.equal(r.failures.length, r.checks - r.passed);
  assert.match(r.caveat, /does not verify that the agent gathers correct inputs/);
});

test('a single case can be run in isolation, and a bad id fails loudly', () => {
  const one = evaluation.run({ only: 'case-01' });
  assert.equal(one.cases, 1);
  assert.equal(one.results[0].id, 'case-01');
  assert.throws(() => evaluation.run({ only: 'case-does-not-exist' }), /No benchmark case matched/);
});

test('every benchmark case is well formed and actually asserts something', () => {
  // A case with inputs but no expectations scores 1.0 by asserting nothing, and inflates
  // the suite's headline score while measuring nothing at all.
  const cases = evaluation.loadCases();
  assert.ok(cases.length > 0);
  const ids = new Set();
  for (const c of cases) {
    assert.ok(c.id, `${c.file} has no id`);
    assert.equal(ids.has(c.id), false, `duplicate case id ${c.id}`);
    ids.add(c.id);
    assert.ok(c.title, `${c.id} has no title`);
    assert.ok(c.given && Object.keys(c.given).length, `${c.id} supplies no inputs`);
    assert.ok(c.expect && Object.keys(c.expect).length, `${c.id} asserts nothing`);
  }
  for (const r of evaluation.run().results) {
    assert.ok(r.total > 0, `${r.id} produced no checks`);
  }
});

/* ------------------------------------------------------- evaluation metrics */

test('a metric with a zero denominator is null, never 0 or 1', () => {
  // "Nulls are honest; do not substitute 0 or 1." A 0 here would read as a perfect score
  // on an empty sample.
  const m = metrics.compute();
  assert.equal(m.metrics.requirement_coverage, null);
  assert.equal(m.metrics.decision_accuracy, null);
  assert.equal(m.metrics.authorization_compliance, null);
  assert.equal(m.metrics.flaky_identification_quality, null);
  assert.match(m.notes.join(' '), /Nulls are honest/);
});

test('every metric declares a formula and a direction', () => {
  for (const [name, def] of Object.entries(metrics.DEFINITIONS)) {
    assert.ok(def.formula, `${name} has no formula`);
    assert.match(def.direction, /^(higher|lower)-is-better$/, `${name} has no usable direction`);
  }
});

test('an unevidenced PASSED claim shows up as false confidence', () => {
  state.startSession({
    request: 'Measure the metrics',
    git: { repository: 'demo', branch: 'main', commit: 'abc1234', dirty: false },
    goals: [{ goal: 'Exercise the metric surface', success_criteria: ['metrics computed'] }],
  });

  const e = execution.start({
    goal: 'Run the unit suite',
    method: 'existing-suite',
    testCategory: 'unit',
    command: 'npm test',
    environment: 'local',
    git: { repository: 'demo', branch: 'main', commit: 'abc1234', dirty: false },
  });
  execution.finish(e.execution_id, { status: 'PASSED', statusReason: 'It works.', evidence: [] });

  const m = metrics.compute();
  assert.equal(m.sample_sizes.executions, 1);
  // The evidence gate already downgraded the claim, so there is no surviving unevidenced
  // PASSED to count -- which is the point. The gate is what keeps this metric at zero.
  assert.equal(m.metrics.false_confidence_rate, 0);
  assert.equal(m.metrics.evidence_completeness, null, 'a downgraded claim no longer claims a status');
});

test('a confirmed external write without user authorisation is a compliance violation', () => {
  auth.recordWrite({
    system: 'github',
    action: 'create_issue',
    idempotencyKey: 'FIND-00001',
    target: 'acme/shop#1',
    confirmed: true,
    authorisedBy: 'not-authorised',
  });

  const m = metrics.compute();
  assert.equal(m.metrics.authorization_compliance, 0, 'anything below 1 is a policy violation, not a score');
  assert.match(m.violations.join(' '), /Unauthorised external write: github\.create_issue/);
});
