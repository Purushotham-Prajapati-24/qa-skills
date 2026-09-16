import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempState } from './helpers.mjs';
import { writeJson } from '../engine/core/fsjson.mjs';
import { p, LAYOUT } from '../engine/core/paths.mjs';
import * as state from '../engine/state-engine/index.mjs';
import * as defects from '../engine/defect-engine/index.mjs';
import * as auth from '../engine/authorization/index.mjs';
import { performWrite, completeWrite, classifyProviderError, readTicket, TICKET_TTL_MS } from '../engine/adapters/base.mjs';
import { createGitHubAdapter, parseIssueResult, parseCommentResult, preflight } from '../engine/adapters/github.mjs';
import * as adapters from '../engine/adapters/index.mjs';

const tmp = useTempState('adapters');
test.after(() => tmp.cleanup());

const AUTHORISED = { userAuthorised: true, authorisationQuote: 'yes, open a GitHub issue for that' };
const ISSUE_URL = 'https://github.com/acme/shop/issues/418';

/**
 * Drive the capability registry directly. The `gh-cli` provider has a command probe, and
 * a test that shells out to the real `gh` is testing the machine, not the adapter.
 */
function setProviders(map) {
  writeJson(p(LAYOUT.capabilities), {
    version: '1.0.0',
    checked_at: new Date().toISOString(),
    providers: Object.fromEntries(Object.entries(map).map(([k, v]) => [k, { available: v, method: 'test', detail: 'set by test' }])),
    declared: {},
  });
}

/** A fake provider that records whether it was called at all. */
function fakeExec(result = {}) {
  const calls = [];
  const fn = async (argv, opts) => {
    calls.push({ argv, opts });
    return {
      argv: argv.join(' '), stdout: '', stderr: '', exit_code: 0, duration_ms: 5,
      ...result,
    };
  };
  fn.calls = calls;
  return fn;
}

function newFinding(overrides = {}) {
  return defects.create({
    title: overrides.title ?? `Order is not persisted after payment ${Math.random()}`,
    kind: 'defect', severity: 'critical', confidence: 0.85, epistemicClass: 'observed',
    component: overrides.component ?? `checkout-${Math.random()}`,
    reproduction: { expected: 'an order row exists', actual: 'no order row', reproducible: 'always', attempts: 3 },
    ...overrides,
  });
}

test('setup: a session and an authenticated gh CLI', () => {
  state.startSession({ request: 'adapter tests' });
  setProviders({ 'gh-cli': true, shell: true, git: true });
  assert.ok(state.loadSession());
});

/* ---------------------------------------------------------------- parsers */

test('an issue URL on stdout confirms the write', () => {
  const r = parseIssueResult({ stdout: `Creating issue in acme/shop\n${ISSUE_URL}\n` });
  assert.deepEqual(r, { confirmed: true, result_id: '#418', url: ISSUE_URL });
});

test('an API JSON response confirms the write', () => {
  const r = parseIssueResult({ stdout: JSON.stringify({ number: 418, html_url: ISSUE_URL }) });
  assert.equal(r.confirmed, true);
  assert.equal(r.result_id, '#418');
});

test('output with no identifier does NOT confirm the write', () => {
  for (const stdout of ['', 'Warning: label "bug" not found', 'ok', '{"message":"created"}']) {
    const r = parseIssueResult({ stdout });
    assert.equal(r.confirmed, false, `"${stdout}" must not count as confirmation`);
    assert.equal(r.result_id, null);
  }
});

test('a comment URL without its anchor does not identify the comment', () => {
  // The bare issue URL is what `gh` prints on some failures. Accepting it would record a
  // comment that may not exist, keyed to the issue.
  assert.equal(parseCommentResult({ stdout: ISSUE_URL }).confirmed, false);
  assert.equal(parseCommentResult({ stdout: `${ISSUE_URL}#issuecomment-99887` }).result_id, '#418-comment-99887');
});

/* ------------------------------------------------------- error classification */

test('provider errors map to the documented handling', () => {
  const cases = [
    [{ exit_code: 1, stderr: 'HTTP 401: Bad credentials' }, 'unauthenticated', 'BLOCKED'],
    [{ exit_code: 1, stderr: 'HTTP 403: Resource not accessible by integration' }, 'forbidden', 'BLOCKED'],
    [{ exit_code: 1, stderr: 'HTTP 404: Not Found' }, 'not-found', 'BLOCKED'],
    [{ exit_code: 1, stderr: 'HTTP 422: Validation Failed' }, 'validation', 'FAILED'],
    [{ exit_code: 1, stderr: 'HTTP 429: rate limit exceeded' }, 'rate-limited', 'BLOCKED'],
    [{ exit_code: 1, stderr: 'dial tcp: ECONNRESET' }, 'network-error', 'INCONCLUSIVE'],
  ];
  for (const [raw, kind, status] of cases) {
    const c = classifyProviderError(raw);
    assert.equal(c.kind, kind);
    assert.equal(c.status, status);
  }
  assert.equal(classifyProviderError({ exit_code: 0 }), null);
});

test('a network error is never marked retry-safe', () => {
  const c = classifyProviderError({ exit_code: 1, stderr: 'ECONNRESET' });
  assert.equal(c.retry_safe, false, 'the write may have landed; retrying creates duplicates');
  assert.match(c.caller_should, /Do NOT retry blindly/);
});

test('a timeout is inconclusive, not a failure', () => {
  const c = classifyProviderError({ timed_out: true, exit_code: 1 });
  assert.equal(c.status, 'INCONCLUSIVE');
  assert.equal(c.retry_safe, false);
});

/* ------------------------------------------------------------------ gates */

test('an unauthorised write never reaches the provider', () => {
  const exec = fakeExec({ stdout: ISSUE_URL });
  const gh = createGitHubAdapter({ exec });
  const finding = newFinding();

  return gh.createIssueFromFinding({ findingId: finding.finding_id, repo: 'acme/shop', authorisation: { userAuthorised: false } })
    .then((r) => {
      assert.equal(r.ok, false);
      assert.equal(r.status, 'NEEDS_USER_INPUT');
      assert.equal(exec.calls.length, 0, 'the provider must not be called at all');
      assert.equal(auth.listWrites('github').filter((w) => w.idempotency_key === finding.fingerprint).length, 0,
        'no ledger entry may exist for a write that was refused');
    });
});

test('an unavailable capability never reaches the provider', async () => {
  setProviders({ 'gh-cli': false, shell: true });
  const exec = fakeExec({ stdout: ISSUE_URL });
  const finding = newFinding();
  const r = await createGitHubAdapter({ exec }).createIssueFromFinding({
    findingId: finding.finding_id, repo: 'acme/shop', authorisation: AUTHORISED,
  });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(exec.calls.length, 0);
  setProviders({ 'gh-cli': true, shell: true });
});

test('assignment is refused without a user-named account, even when authorised', async () => {
  const exec = fakeExec({ stdout: ISSUE_URL });
  const r = await createGitHubAdapter({ exec }).assign({
    repo: 'acme/shop', number: 418, assignee: null, authorisation: AUTHORISED,
  });
  assert.equal(r.status, 'NEEDS_USER_INPUT');
  assert.match(r.reason, /never choose the person/);
  assert.equal(exec.calls.length, 0);
});

test('assignment proceeds when the user names the account', async () => {
  const exec = fakeExec({ stdout: ISSUE_URL });
  const r = await createGitHubAdapter({ exec }).assign({
    repo: 'acme/shop', number: 418, assignee: 'octocat', authorisation: AUTHORISED,
  });
  assert.equal(r.ok, true);
  assert.equal(exec.calls.length, 1);
  assert.ok(exec.calls[0].argv.includes('--add-assignee'));
  assert.ok(exec.calls[0].argv.includes('octocat'));
});

test('a dry run passes every gate and still does not call the provider', async () => {
  const exec = fakeExec({ stdout: ISSUE_URL });
  const finding = newFinding();
  const r = await createGitHubAdapter({ exec }).createIssueFromFinding({
    findingId: finding.finding_id, repo: 'acme/shop', authorisation: AUTHORISED, dryRun: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.dry_run, true);
  assert.deepEqual(r.gates_passed, ['capability', 'authorization', 'ledger']);
  assert.match(r.content.title, /^\[critical\]/);
  assert.equal(exec.calls.length, 0);
  assert.equal(auth.listWrites('github').filter((w) => w.idempotency_key === finding.fingerprint).length, 0);
});

test('performWrite refuses to run without an idempotency key', async () => {
  await assert.rejects(
    () => performWrite({ verb: 'github.comment', system: 'github', target: 'x', build: () => [], parseResult: () => ({}) }),
    /requires an idempotencyKey/,
  );
});

/* ------------------------------------------------------------ happy path */

test('a confirmed write records the provider identifier and observed evidence', async () => {
  const exec = fakeExec({ stdout: `Creating issue in acme/shop\n${ISSUE_URL}\n` });
  const finding = newFinding();
  const r = await createGitHubAdapter({ exec }).createIssueFromFinding({
    findingId: finding.finding_id, repo: 'acme/shop', authorisation: AUTHORISED,
  });

  assert.equal(r.ok, true);
  assert.equal(r.confirmed, true);
  assert.equal(r.result_id, '#418');
  assert.equal(r.url, ISSUE_URL);

  const entry = auth.listWrites('github').find((w) => w.idempotency_key === finding.fingerprint);
  assert.equal(entry.confirmed, true);
  assert.equal(entry.result_id, '#418');
  assert.equal(entry.authorised_by, 'user-explicit');

  const ev = state.get('evidence', r.evidence_id);
  assert.equal(ev.epistemic_class, 'observed');
  assert.equal(ev.kind, 'github-object');
});

test('the exact body sent is kept as evidence on disk', async () => {
  const exec = fakeExec({ stdout: ISSUE_URL });
  const finding = newFinding();
  await createGitHubAdapter({ exec }).createIssueFromFinding({
    findingId: finding.finding_id, repo: 'acme/shop', authorisation: AUTHORISED,
  });
  const bodyArg = exec.calls[0].argv[exec.calls[0].argv.indexOf('--body-file') + 1];
  assert.ok(fs.existsSync(bodyArg));
  assert.match(fs.readFileSync(bodyArg, 'utf8'), /## Summary/);
  assert.ok(bodyArg.includes(path.join('external-writes', 'bodies')));
});

test('the same finding cannot be filed twice', async () => {
  const exec = fakeExec({ stdout: ISSUE_URL });
  const gh = createGitHubAdapter({ exec });
  const finding = newFinding();

  const first = await gh.createIssueFromFinding({ findingId: finding.finding_id, repo: 'acme/shop', authorisation: AUTHORISED });
  assert.equal(first.ok, true);

  const second = await gh.createIssueFromFinding({ findingId: finding.finding_id, repo: 'acme/shop', authorisation: AUTHORISED });
  assert.equal(second.ok, false);
  assert.equal(second.status, 'SKIPPED');
  assert.equal(exec.calls.length, 1, 'the provider must be called exactly once across both attempts');
});

test('an observation is never filed as an issue', async () => {
  const exec = fakeExec({ stdout: ISSUE_URL });
  const obs = defects.create({
    title: 'The checkout page feels slow on a cold cache',
    kind: 'observation', severity: 'minor', confidence: 0.9,
    component: 'checkout-perf-observation',
  });
  const r = await createGitHubAdapter({ exec }).createIssueFromFinding({
    findingId: obs.finding_id, repo: 'acme/shop', authorisation: AUTHORISED,
  });
  assert.equal(r.ok, false);
  assert.match(r.blockers.join(' '), /Observations belong in the report/);
  assert.equal(exec.calls.length, 0);
});

/* ------------------------------------------------ unconfirmed and failed */

test('exit 0 with no parseable identifier is INCONCLUSIVE, not success', async () => {
  const exec = fakeExec({ stdout: 'Warning: could not add label "bug"\n', exit_code: 0 });
  const finding = newFinding();
  const r = await createGitHubAdapter({ exec }).createIssueFromFinding({
    findingId: finding.finding_id, repo: 'acme/shop', authorisation: AUTHORISED,
  });

  assert.equal(r.ok, false);
  assert.equal(r.status, 'INCONCLUSIVE');
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /no identifier could be parsed/);
  assert.match(r.caller_should, /attempted, not done/);

  const entry = auth.listWrites('github').find((w) => w.idempotency_key === finding.fingerprint);
  assert.equal(entry.confirmed, false, 'an unconfirmed attempt is still recorded, but not as confirmed');

  const ev = state.get('evidence', r.evidence_id);
  assert.equal(ev.epistemic_class, 'inferred', 'we are inferring something happened, not observing it');
});

test('an unconfirmed attempt does not block a later retry, but does warn', async () => {
  const exec = fakeExec({ stdout: 'no url here' });
  const gh = createGitHubAdapter({ exec });
  const finding = newFinding();
  await gh.createIssueFromFinding({ findingId: finding.finding_id, repo: 'acme/shop', authorisation: AUTHORISED });

  const check = auth.alreadyWritten({ system: 'github', action: 'github.create_issue', idempotencyKey: finding.fingerprint });
  assert.equal(check.duplicate, false, 'an unconfirmed attempt must not permanently block the write');
  assert.match(check.reason, /never confirmed/);
  assert.match(check.reason, /Verify the target/);
});

test('a 403 is reported BLOCKED with the scope hint, and recorded unconfirmed', async () => {
  const exec = fakeExec({ exit_code: 1, stderr: 'HTTP 403: Resource not accessible by integration' });
  const finding = newFinding();
  const r = await createGitHubAdapter({ exec }).createIssueFromFinding({
    findingId: finding.finding_id, repo: 'acme/shop', authorisation: AUTHORISED,
  });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.confirmed, false);
  assert.match(r.caller_should, /scope/);
  assert.equal(auth.listWrites('github').find((w) => w.idempotency_key === finding.fingerprint).confirmed, false);
});

/* ------------------------------------------------------------ delegation */

test('an MCP provider issues a ticket instead of pretending it can call the tool', async () => {
  setProviders({ 'mcp-github': true, 'gh-cli': false, shell: true });
  const exec = fakeExec({ stdout: ISSUE_URL });
  const finding = newFinding();

  const r = await createGitHubAdapter({ exec }).createIssueFromFinding({
    findingId: finding.finding_id, repo: 'acme/shop', authorisation: AUTHORISED,
  });

  assert.equal(r.status, 'NEEDS_USER_INPUT');
  assert.equal(r.delegate, true);
  assert.match(r.ticket, /^WT-[0-9a-f]{16}$/);
  assert.deepEqual(r.gates_passed, ['capability', 'authorization', 'ledger']);
  assert.match(r.caller_should, /ast adapter complete --ticket/);
  assert.equal(exec.calls.length, 0, 'Node cannot call an MCP tool and must not pretend otherwise');

  // The gates ran, but nothing is recorded until the agent comes back.
  assert.equal(auth.listWrites('github').filter((w) => w.idempotency_key === finding.fingerprint).length, 0);

  // Completing it records the write from the provider's own response.
  const done = adapters.getAdapter('github').complete({
    ticket: r.ticket,
    response: JSON.stringify({ number: 418, html_url: ISSUE_URL }),
  });
  assert.equal(done.ok, true);
  assert.equal(done.confirmed, true);
  assert.equal(auth.listWrites('github').find((w) => w.idempotency_key === finding.fingerprint).confirmed, true);

  // The ticket is single-use.
  assert.equal(readTicket(r.ticket), null);
  setProviders({ 'gh-cli': true, shell: true });
});

test('a ledger entry cannot be created without a ticket', () => {
  const r = completeWrite({ ticket: 'WT-deadbeefdeadbeef', response: ISSUE_URL, parseResult: parseIssueResult });
  assert.equal(r.ok, false);
  assert.match(r.reason, /No such pending write ticket/);
  assert.match(r.reason, /evidence that the capability, authorisation and duplicate gates ran/);
});

test('an expired ticket is refused, because authorisation does not keep', async () => {
  setProviders({ 'mcp-github': true, 'gh-cli': false, shell: true });
  const finding = newFinding();
  const r = await createGitHubAdapter({ exec: fakeExec() }).createIssueFromFinding({
    findingId: finding.finding_id, repo: 'acme/shop', authorisation: AUTHORISED,
  });

  const later = new Date(Date.now() + TICKET_TTL_MS + 1000);
  const done = completeWrite({ ticket: r.ticket, response: ISSUE_URL, parseResult: parseIssueResult, now: later });
  assert.equal(done.ok, false);
  assert.match(done.reason, /expired/);
  assert.match(done.reason, /per-session and does not keep/);
  assert.equal(readTicket(r.ticket), null, 'an expired ticket is discarded, not left to be reused');
  setProviders({ 'gh-cli': true, shell: true });
});

test('pending delegated writes are discoverable', async () => {
  setProviders({ 'mcp-github': true, 'gh-cli': false, shell: true });
  const finding = newFinding();
  await createGitHubAdapter({ exec: fakeExec() }).createIssueFromFinding({
    findingId: finding.finding_id, repo: 'acme/shop', authorisation: AUTHORISED,
  });
  const open = adapters.pending();
  assert.ok(open.length >= 1);
  assert.equal(open[0].system, 'github');
  assert.equal(open[0].expired, false);
  setProviders({ 'gh-cli': true, shell: true });
});

/* ------------------------------------------------------------------ reads */

test('a read returns parsed data and corroborating evidence', async () => {
  const files = ['server/orders/create.ts', 'src/checkout/PaymentForm.tsx'];
  const exec = fakeExec({ stdout: files.join('\n') });
  const r = await createGitHubAdapter({ exec }).listChangedFiles({ repo: 'acme/shop', number: 412 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, files);
  const ev = state.get('evidence', r.evidence_id);
  assert.equal(ev.kind, 'github-object', 'a PR description is not proof a test ran');
});

test('unparseable read output is INCONCLUSIVE rather than guessed at', async () => {
  const exec = fakeExec({ stdout: 'not json at all' });
  const r = await createGitHubAdapter({ exec }).readPr({ repo: 'acme/shop', number: 412 });
  assert.equal(r.status, 'INCONCLUSIVE');
  assert.match(r.reason, /could not parse/);
  assert.match(r.caller_should, /Do not guess/);
});

/* -------------------------------------------------------------- preflight */

test('preflight distinguishes authentication from scope', async () => {
  const withScope = await preflight({ exec: fakeExec({ stdout: 'Logged in to github.com account octocat\n  - Token scopes: gist, read:org, repo, workflow' }) });
  assert.equal(withScope.authenticated, true);
  assert.equal(withScope.account, 'octocat');
  assert.equal(withScope.writes_available, true);

  const withoutScope = await preflight({ exec: fakeExec({ stdout: 'Logged in to github.com account octocat\n  - Token scopes: gist, read:org' }) });
  assert.equal(withoutScope.authenticated, true);
  assert.equal(withoutScope.writes_available, false, 'auth succeeding is not the same as having the scope');
  assert.ok(withoutScope.missing_scopes.some((m) => m.verb === 'github.create_issue'));
  assert.match(withoutScope.note, /recorded as unconfirmed, not retried/);
});

/* -------------------------------------------------------------- registry */

test('the registry is honest about which adapters exist', () => {
  assert.deepEqual(adapters.SYSTEMS, ['github']);
  assert.throws(() => adapters.getAdapter('jira'), /no executable module yet/);
});
