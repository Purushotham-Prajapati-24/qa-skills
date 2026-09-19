import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempState } from './helpers.mjs';
import * as state from '../engine/state-engine/index.mjs';
import * as execution from '../engine/execution-engine/index.mjs';
import * as uncertainty from '../engine/uncertainty-register/index.mjs';
import * as reporting from '../engine/reporting-engine/index.mjs';

/**
 * G-16: a field trial's admin had to interrogate the agent turn by turn ("why didnt you do
 * it? do you have any boundation from the .claude skills?") to learn that three untested
 * features were blocked by legitimate policy, not laziness or a bug. Even a report that
 * already says "BLOCKED: no explicit authorisation for load traffic" never told the admin
 * THEY were the one who could clear it -- the system knew what would unblock the item and
 * never offered. "Unblock these" surfaces exactly that, phrased as a direct offer, for the
 * subset of open blockers only the reader (not the agent) can resolve.
 */
function isolated(t, label) {
  const iso = useTempState(label);
  t.after(() => iso.cleanup());
}

function unblockSection(markdown) {
  return markdown.includes('## Unblock these')
    ? markdown.split('## Unblock these')[1].split(/\n## /)[0]
    : null;
}

test('a session with no open uncertainties at all has no "Unblock these" section', (t) => {
  isolated(t, 'unblock-none');
  state.startSession({ request: 'no uncertainties test' });
  const { markdown } = reporting.generate();
  assert.equal(unblockSection(markdown), null);
});

test('a user-owned blocking uncertainty is phrased as a direct offer, naming the blocked goal, the impact and the next action', (t) => {
  isolated(t, 'unblock-user-owned');
  state.startSession({ request: 'user owned blocker test' });
  const exec = execution.start({ goal: 'Live ImageKit upload/delete against a sandbox account', method: 'api-client', git: null });
  const u = uncertainty.raise({
    question: 'May the agent perform live ImageKit uploads/deletes against a sandbox account?',
    status: 'blocked',
    impact: 'cannot verify real upload/delete behaviour without a live third-party write',
    affectedScope: ['image-upload'],
    nextAction: 'Authorise a third-party write against a sandbox ImageKit account, or provide sandbox credentials.',
    owner: 'user',
    raisedByExecution: exec.execution_id,
  });
  execution.finish(exec.execution_id, { status: 'BLOCKED', statusReason: 'no authorisation', uncertainties: [u.id] });
  const { markdown } = reporting.generate();
  const section = unblockSection(markdown);
  assert.ok(section, 'expected an "Unblock these" section');
  assert.match(section, /Live ImageKit upload\/delete against a sandbox account/);
  assert.match(section, /cannot verify real upload\/delete behaviour/);
  assert.match(section, /Authorise a third-party write against a sandbox ImageKit account/);
});

test('an external-owned blocking uncertainty is included alongside user-owned ones', (t) => {
  isolated(t, 'unblock-external-owned');
  state.startSession({ request: 'external owned blocker test' });
  const u = uncertainty.raise({
    question: 'Is the staging payment sandbox reachable?',
    status: 'external-dependency',
    impact: 'cannot run the payment E2E suite',
    affectedScope: ['payment-e2e'],
    nextAction: 'Restore staging sandbox connectivity, or point the suite at a different environment.',
    owner: 'external',
  });
  const { markdown } = reporting.generate();
  const section = unblockSection(markdown);
  assert.ok(section);
  assert.match(section, /Restore staging sandbox connectivity/);
});

test('an agent-owned unresolved uncertainty is never offered here -- it is the agent\'s own job, not the reader\'s', (t) => {
  isolated(t, 'unblock-agent-owned');
  state.startSession({ request: 'agent owned test' });
  uncertainty.raise({
    question: 'Which of two equally-plausible root causes is correct?',
    status: 'unresolved',
    impact: 'cannot classify the failure precisely yet',
    affectedScope: ['checkout'],
    nextAction: 'Investigate further with an isolated repro.',
    owner: 'agent',
  });
  const { markdown } = reporting.generate();
  assert.equal(unblockSection(markdown), null,
    'an agent-owned open question must not appear as something the reader can unblock');
});

test('a non-blocking status (e.g. future-case) is never offered here even if owned by the user', (t) => {
  isolated(t, 'unblock-nonblocking-status');
  state.startSession({ request: 'non-blocking status test' });
  uncertainty.raise({
    question: 'Should this be covered in a future load-test pass?',
    status: 'future-case',
    impact: 'no coverage of sustained load yet',
    affectedScope: ['performance'],
    nextAction: 'Decide whether to schedule a dedicated load-testing session.',
    owner: 'user',
  });
  const { markdown } = reporting.generate();
  assert.equal(unblockSection(markdown), null,
    '"future-case" does not stall anything right now -- it must not be framed as an active blocker');
});

test('resolving the uncertainty removes it from "Unblock these" on the next report', (t) => {
  isolated(t, 'unblock-resolved');
  state.startSession({ request: 'resolved blocker test' });
  const u = uncertainty.raise({
    question: 'May the agent run load tests against production?',
    status: 'blocked',
    impact: 'cannot measure real load behaviour',
    affectedScope: ['load'],
    nextAction: 'Authorise a load test against staging instead.',
    owner: 'user',
  });
  assert.ok(unblockSection(reporting.generate().markdown), 'sanity: it starts out present');
  uncertainty.resolve(u.id, { answer: 'Authorised against staging.', resolvedBy: 'user' });
  const { markdown } = reporting.generate();
  assert.equal(unblockSection(markdown), null);
});

test('multiple unblockable items each render as their own bullet', (t) => {
  isolated(t, 'unblock-multiple');
  state.startSession({ request: 'multiple blockers test' });
  uncertainty.raise({
    question: 'Is item A authorised?', status: 'blocked', impact: 'blocks A', affectedScope: ['a'],
    nextAction: 'Do X.', owner: 'user',
  });
  uncertainty.raise({
    question: 'Is item B authorised?', status: 'user-input-required', impact: 'blocks B', affectedScope: ['b'],
    nextAction: 'Do Y.', owner: 'user',
  });
  const { markdown } = reporting.generate();
  const section = unblockSection(markdown);
  assert.match(section, /Do X\./);
  assert.match(section, /Do Y\./);
  assert.equal((section.match(/^- /gm) ?? []).length, 2);
});
