import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempState } from './helpers.mjs';
import { writeJson, sha256String } from '../engine/core/fsjson.mjs';
import { p, LAYOUT } from '../engine/core/paths.mjs';
import * as state from '../engine/state-engine/index.mjs';
import * as defects from '../engine/defect-engine/index.mjs';
import * as auth from '../engine/authorization/index.mjs';
import { performWrite, completeWrite, classifyProviderError, readTicket, TICKET_TTL_MS } from '../engine/adapters/base.mjs';
import {
  createGitHubAdapter, parseIssueResult, parseCommentResult, preflight,
  verifyIssueRead, verifyCommentWrite, verifyGitHubWrite,
} from '../engine/adapters/github.mjs';
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

  // Completing it is NOT enough on its own: the response is a self-attestation, and an
  // independent read-back (here, a stubbed `gh issue view`) must confirm the same issue
  // actually exists before the write counts as done.
  const verifyExec = fakeExec({ stdout: JSON.stringify({ number: 418, url: ISSUE_URL, state: 'OPEN' }) });
  const done = await adapters.getAdapter('github', { exec: verifyExec }).complete({
    ticket: r.ticket,
    response: JSON.stringify({ number: 418, html_url: ISSUE_URL }),
  });
  assert.equal(done.ok, true);
  assert.equal(done.confirmed, true);
  assert.equal(done.verified, true);
  assert.equal(auth.listWrites('github').find((w) => w.idempotency_key === finding.fingerprint).confirmed, true);

  // The ticket is single-use.
  assert.equal(readTicket(r.ticket), null);
  setProviders({ 'gh-cli': true, shell: true });
});

test('a self-reported identifier that does not independently read back is NOT confirmed', async () => {
  setProviders({ 'mcp-github': true, 'gh-cli': false, shell: true });
  const finding = newFinding();

  const r = await createGitHubAdapter({ exec: fakeExec() }).createIssueFromFinding({
    findingId: finding.finding_id, repo: 'acme/shop', authorisation: AUTHORISED,
  });

  // The agent claims issue #4242 exists, but the independent read-back (stubbed to behave
  // like a real `gh issue view` on a nonexistent issue) says otherwise.
  const failingReadBack = fakeExec({ stdout: '', stderr: 'HTTP 404: Not Found', exit_code: 1 });
  const done = await adapters.getAdapter('github', { exec: failingReadBack }).complete({
    ticket: r.ticket,
    response: JSON.stringify({ number: 4242, html_url: 'https://github.com/acme/shop/issues/4242' }),
  });

  assert.equal(done.confirmed, false, 'a self-attestation must never be trusted without an independent read-back');
  assert.equal(done.verified, false);
  assert.match(done.verify_reason, /Independent read-back/);
  assert.equal(auth.listWrites('github').find((w) => w.idempotency_key === finding.fingerprint).confirmed, false);
  setProviders({ 'gh-cli': true, shell: true });
});

test('a ledger entry cannot be created without a ticket', async () => {
  const r = await completeWrite({ ticket: 'WT-deadbeefdeadbeef', response: ISSUE_URL, parseResult: parseIssueResult });
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
  const done = await completeWrite({ ticket: r.ticket, response: ISSUE_URL, parseResult: parseIssueResult, now: later });
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

/**
 * The read-back is the whole point of the write protocol: a claim this process cannot
 * independently confirm is not confirmed. It therefore has to survive every shape a ticket
 * target actually takes -- `create` stores `owner/repo`, but `comment`, `updateIssue` and
 * `assign` store `owner/repo#42`, and `current repo#42` when no repository was given.
 */
test('the read-back extracts a repo slug from every shape a ticket target takes', async () => {
  const seen = [];
  const exec = async (argv) => {
    seen.push(argv);
    return { exit_code: 0, stdout: JSON.stringify({ number: 42, url: ISSUE_URL, state: 'open' }), stderr: '' };
  };

  const repoOf = async (target) => {
    seen.length = 0;
    const result = await verifyIssueRead({ resultId: '#42', target }, { exec });
    assert.equal(result.exists, true, `read-back should confirm for target ${JSON.stringify(target)}`);
    const i = seen[0].indexOf('--repo');
    return i === -1 ? null : seen[0][i + 1];
  };

  assert.equal(await repoOf('acme/shop'), 'acme/shop', 'a bare slug passes through');
  assert.equal(await repoOf('acme/shop#42'), 'acme/shop', 'the issue suffix must be stripped');
  assert.equal(await repoOf('gh.acme.com/acme/shop#42'), 'gh.acme.com/acme/shop', 'a HOST/OWNER/REPO slug survives');
  assert.equal(await repoOf('the current repository'), null, 'the create-verb sentinel means no --repo');
  assert.equal(await repoOf('current repo#42'), null, 'the numbered sentinel means no --repo either');
  assert.equal(await repoOf(undefined), null, 'a missing target means no --repo');
});

test('verifyIssueRead alone only confirms the parent issue, not the comment itself', async () => {
  // This documents verifyIssueRead's own, narrower scope -- it is what verifyGitHubWrite
  // falls back to for a plain issue write. For a comment, verifyGitHubWrite below routes to
  // verifyCommentWrite instead, which is what actually closes the self-attestation gap.
  const seen = [];
  const exec = async (argv) => {
    seen.push(argv);
    return { exit_code: 0, stdout: JSON.stringify({ number: 418, url: ISSUE_URL, state: 'open' }), stderr: '' };
  };

  const check = await verifyIssueRead(
    { resultId: '#418-comment-987654321', target: 'acme/shop#418' },
    { exec },
  );

  assert.equal(check.exists, true, 'the parent issue is real, so this narrower check confirms');
  assert.deepEqual(
    seen[0],
    ['gh', 'issue', 'view', '418', '--repo', 'acme/shop', '--json', 'number,url,state'],
    'the argv handed to gh must be one gh actually accepts',
  );
});

/**
 * The gap CHANGELOG 0.8.0 named: a fabricated comment identifier against a real issue used
 * to confirm, because the only read-back available checked the issue, not the comment.
 * `verifyCommentWrite` reads the comment itself back via `gh api .../issues/comments/<id>`
 * and, when given the hash of what was sent, checks its actual body.
 */
test('verifyCommentWrite confirms only when the comment itself exists with matching content', async () => {
  const body = 'Filed by the QA agent: see FIND-00042.';
  const hash = sha256String(body);
  const seen = [];

  const confirmed = await verifyCommentWrite(
    { resultId: '#418-comment-987654321', target: 'acme/shop#418', contentSha256: hash },
    { exec: async (argv) => { seen.push(argv); return { exit_code: 0, stdout: JSON.stringify({ id: 987654321, body }), stderr: '' }; } },
  );
  assert.equal(confirmed.exists, true);
  assert.equal(confirmed.verification, 'confirmed');
  assert.deepEqual(seen[0], ['gh', 'api', 'repos/acme/shop/issues/comments/987654321']);

  const mismatched = await verifyCommentWrite(
    { resultId: '#418-comment-987654321', target: 'acme/shop#418', contentSha256: hash },
    { exec: async () => ({ exit_code: 0, stdout: JSON.stringify({ id: 987654321, body: 'a different comment entirely' }), stderr: '' }) },
  );
  assert.equal(mismatched.exists, true, 'the identifier resolves to a real object');
  assert.equal(mismatched.verification, 'refuted', 'but its body is not what was sent, so it cannot confirm');
  assert.equal(mismatched.failure_kind, 'body-mismatch');
  assert.equal(mismatched.retry_safe, false, 'the comment exists, just not this one -- retrying would duplicate it');

  const fabricated = await verifyCommentWrite(
    { resultId: '#418-comment-000000000', target: 'acme/shop#418', contentSha256: hash },
    { exec: async () => ({ exit_code: 1, stdout: '', stderr: 'HTTP 404: Not Found' }) },
  );
  assert.equal(fabricated.exists, false);
  assert.equal(fabricated.verification, 'refuted', 'a genuinely fabricated comment ID reads back as 404');
  assert.equal(fabricated.retry_safe, true);

  const unreachable = await verifyCommentWrite(
    { resultId: '#418-comment-987654321', target: 'acme/shop#418', contentSha256: hash },
    { exec: async () => ({ exit_code: 1, stdout: '', stderr: 'dial tcp: lookup api.github.com: ENOTFOUND' }) },
  );
  assert.equal(unreachable.verification, 'unavailable');
  assert.equal(unreachable.retry_safe, false, 'a network failure does not refute a write that may have landed');
});

test('verifyGitHubWrite dispatches by the shape of the result ID, not by the caller knowing which it is', async () => {
  const issueCalls = [];
  const commentCalls = [];
  const exec = async (argv) => {
    (argv[1] === 'api' ? commentCalls : issueCalls).push(argv);
    return argv[1] === 'api'
      ? { exit_code: 0, stdout: JSON.stringify({ id: 987654321, body: 'x' }), stderr: '' }
      : { exit_code: 0, stdout: JSON.stringify({ number: 418, url: ISSUE_URL, state: 'open' }), stderr: '' };
  };

  await verifyGitHubWrite({ resultId: '#418', target: 'acme/shop' }, { exec });
  assert.equal(issueCalls.length, 1, 'a plain issue result ID routes to the issue read-back');
  assert.equal(commentCalls.length, 0);

  await verifyGitHubWrite({ resultId: '#418-comment-987654321', target: 'acme/shop#418' }, { exec });
  assert.equal(commentCalls.length, 1, 'a comment result ID routes to the comment read-back');
});

/**
 * "The object is not there" and "this process could not look" are different findings with
 * opposite consequences, and the read-back used to report both as a bare `exists: false`.
 *
 * A refuted write did not happen, so retrying it is safe. An unverifiable write may well
 * have landed -- the agent performed it with its own MCP tools -- so retrying files a
 * duplicate, which is the exact failure the write ledger exists to prevent. Only a genuine
 * 404 may license a retry.
 */
test('the read-back separates a refuted write from one it could not verify', async () => {
  const exec = (out) => async () => out;

  const refuted = await verifyIssueRead(
    { resultId: '#4242', target: 'acme/shop' },
    { exec: exec({ exit_code: 1, stdout: '', stderr: 'could not resolve to an Issue: 404 Not Found' }) },
  );
  assert.equal(refuted.exists, false);
  assert.equal(refuted.verification, 'refuted', 'a 404 refutes the claim');
  assert.equal(refuted.retry_safe, true, 'a write that provably did not happen is safe to retry');
  assert.match(refuted.reason, /safe to retry/);

  // Every way of being prevented from looking must read the same: not refuted.
  const blind = {
    unauthenticated: { exit_code: 1, stdout: '', stderr: 'gh: Bad credentials (HTTP 401)' },
    forbidden: { exit_code: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible' },
    'network-error': { exit_code: 1, stdout: '', stderr: 'dial tcp: lookup api.github.com: ENOTFOUND' },
  };
  for (const [kind, out] of Object.entries(blind)) {
    const check = await verifyIssueRead({ resultId: '#4242', target: 'acme/shop' }, { exec: exec(out) });
    assert.equal(check.exists, false, `${kind} cannot confirm`);
    assert.equal(check.verification, 'unavailable', `${kind} must not be reported as a refutation`);
    assert.equal(check.retry_safe, false, `${kind} must never license a retry -- the write may have landed`);
    assert.equal(check.failure_kind, kind, 'the provider failure is classified, not flattened');
  }

  const confirmed = await verifyIssueRead(
    { resultId: '#4242', target: 'acme/shop' },
    { exec: exec({ exit_code: 0, stdout: JSON.stringify({ number: 4242, url: ISSUE_URL, state: 'open' }), stderr: '' }) },
  );
  assert.equal(confirmed.exists, true);
  assert.equal(confirmed.verification, 'confirmed');
});

test('a response with no usable identifier is unverifiable, not refuted', async () => {
  const check = await verifyIssueRead(
    { resultId: 'not-a-number', target: 'acme/shop' },
    { exec: async () => { throw new Error('gh must not be called when there is nothing to look up'); } },
  );
  assert.equal(check.exists, false);
  assert.equal(check.verification, 'unavailable');
  assert.equal(check.retry_safe, false, 'nothing was refuted, so a retry could still duplicate');
});

/**
 * The retry verdict has to survive the trip back to the caller, because the caller is what
 * decides whether to try again. Two unconfirmed writes that look identical in the ledger
 * but differ in retry-safety is precisely how a duplicate gets filed.
 */
test('completeWrite tells the caller whether an unconfirmed write is safe to retry', async () => {
  setProviders({ 'mcp-github': true, 'gh-cli': false, shell: true });

  const attempt = async (readBack) => {
    const finding = newFinding();
    const r = await createGitHubAdapter({ exec: fakeExec() }).createIssueFromFinding({
      findingId: finding.finding_id, repo: 'acme/shop', authorisation: AUTHORISED,
    });
    const done = await adapters.getAdapter('github', { exec: fakeExec(readBack) }).complete({
      ticket: r.ticket,
      response: JSON.stringify({ number: 4242, html_url: 'https://github.com/acme/shop/issues/4242' }),
    });
    return done;
  };

  const refuted = await attempt({ stdout: '', stderr: 'could not resolve to an Issue: 404 Not Found', exit_code: 1 });
  assert.equal(refuted.confirmed, false);
  assert.equal(refuted.verification, 'refuted');
  assert.equal(refuted.retry_safe, true, 'a provably absent issue is safe to re-file');
  assert.match(refuted.caller_should, /retry is safe/);

  const blind = await attempt({ stdout: '', stderr: 'dial tcp: lookup api.github.com: ENOTFOUND', exit_code: 1 });
  assert.equal(blind.confirmed, false);
  assert.equal(blind.verification, 'unavailable');
  assert.equal(blind.retry_safe, false, 'an unreachable provider must never license a retry');
  assert.match(blind.caller_should, /duplicate/);

  setProviders({ 'gh-cli': true, shell: true });
});
