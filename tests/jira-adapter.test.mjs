import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempState } from './helpers.mjs';
import { writeJson, sha256String } from '../engine/core/fsjson.mjs';
import { p, LAYOUT } from '../engine/core/paths.mjs';
import * as state from '../engine/state-engine/index.mjs';
import * as defects from '../engine/defect-engine/index.mjs';
import * as auth from '../engine/authorization/index.mjs';
import * as caps from '../engine/capability-registry/index.mjs';
import { classifyProviderError } from '../engine/adapters/base.mjs';
import {
  createJiraAdapter, restExec, adfToText, textToAdf, acceptanceCriteriaFromText,
  parseIssueResult, parseCommentResult, verifyJiraWrite, preflight,
} from '../engine/adapters/jira.mjs';
import * as adapters from '../engine/adapters/index.mjs';

// drafts/03: Jira had capability verbs and a written contract but no executable module, so an
// agent followed integrations/jira/adapter.md by hand -- or inferred ticket content from
// commit messages and reported it as if it came from Jira.

const tmp = useTempState('jira');
test.after(() => tmp.cleanup());

const AUTHORISED = { userAuthorised: true, authorisationQuote: 'yes, file it in SHOP' };

function setProviders(map) {
  writeJson(p(LAYOUT.capabilities), {
    version: '1.0.0',
    checked_at: new Date().toISOString(),
    providers: Object.fromEntries(Object.entries(map).map(([k, v]) => [k, { available: v, method: 'test', detail: 'set by test' }])),
    declared: {},
  });
}

function fakeExec(result = {}) {
  const calls = [];
  const fn = async (argv) => {
    calls.push(argv);
    return { argv: argv.slice(0, 3).join(' '), stdout: '', stderr: '', exit_code: 0, duration_ms: 3, ...result };
  };
  fn.calls = calls;
  return fn;
}

function newFinding() {
  return defects.create({
    title: `Saved card not persisted ${Math.random()}`,
    kind: 'defect', severity: 'major', confidence: 0.85, epistemicClass: 'observed',
    component: `checkout-${Math.random()}`,
    reproduction: { expected: 'card saved', actual: 'card missing after reload', reproducible: 'always', attempts: 3 },
  });
}

const DESCRIPTION = {
  type: 'doc', version: 1,
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Guests can save a card. Ping ' }, { type: 'mention', attrs: { text: '@priya' } }] },
    { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Acceptance criteria' }] },
    { type: 'bulletList', content: [
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A saved card survives a reload' }] }] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: "Another user's card is never selectable" }] }] },
    ] },
    { type: 'codeBlock', content: [{ type: 'text', text: 'POST /api/cards' }] },
  ],
};

test('setup: a session and Jira REST credentials', () => {
  state.startSession({ request: 'jira adapter tests', git: null });
  setProviders({ 'jira-rest': true, 'mcp-atlassian': false, shell: true });
});

test('ADF becomes readable text, keeping headings, lists, code and mentions', () => {
  const text = adfToText(DESCRIPTION);
  assert.match(text, /Guests can save a card\. Ping @priya/);
  assert.match(text, /### Acceptance criteria/);
  assert.match(text, /- A saved card survives a reload/);
  assert.match(text, /```\nPOST \/api\/cards\n```/);
  assert.doesNotMatch(text, /"type"/, 'no raw ADF may leak into text');
  assert.deepEqual(acceptanceCriteriaFromText(text), ['A saved card survives a reload', "Another user's card is never selectable"]);
});

test('text round-trips through ADF', () => {
  const body = 'Evidence: EV-2026-00004\nsecond line\n\nNew paragraph';
  const adf = textToAdf(body);
  assert.equal(adf.type, 'doc');
  assert.equal(adf.content.length, 2);
  assert.equal(adfToText(adf), body);
});

test('restExec never leaks credentials and reports missing ones as unauthenticated', async () => {
  const r = await restExec(['jira-rest', 'GET', '/rest/api/3/myself'], { env: {} });
  assert.equal(r.exit_code, 1);
  assert.equal(classifyProviderError(r).kind, 'unauthenticated');

  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return { ok: false, status: 404, statusText: 'Not Found', text: async () => '{"errorMessages":["Issue does not exist"]}', headers: { get: () => null } };
  };
  const env = { JIRA_BASE_URL: 'https://acme.atlassian.net/', JIRA_EMAIL: 'bot@acme.test', JIRA_API_TOKEN: 'secret-token-123' };
  const nf = await restExec(['jira-rest', 'GET', '/rest/api/3/issue/SHOP-9'], { env, fetchImpl });
  assert.equal(seen[0].url, 'https://acme.atlassian.net/rest/api/3/issue/SHOP-9');
  assert.equal(seen[0].init.headers.Authorization, `Basic ${Buffer.from('bot@acme.test:secret-token-123').toString('base64')}`);
  assert.equal(classifyProviderError(nf).kind, 'not-found');
  assert.doesNotMatch(JSON.stringify(nf), /secret-token-123/);
});

test('reading a ticket returns text and extracted acceptance criteria, never raw ADF', async () => {
  const exec = fakeExec({ stdout: JSON.stringify({ key: 'SHOP-412', fields: { summary: 'Saved cards', description: DESCRIPTION, status: { name: 'In Progress' }, labels: ['checkout'] } }) });
  const r = await createJiraAdapter({ exec }).readTicket({ key: 'SHOP-412' });
  assert.equal(r.ok, true);
  assert.equal(r.data.key, 'SHOP-412');
  assert.equal(r.data.status, 'In Progress');
  assert.equal(r.data.acceptance_criteria.length, 2);
  assert.match(r.data.epistemic_note, /reported-by-user/);
  assert.equal(exec.calls[0][1], 'GET');
  assert.match(exec.calls[0][2], /^\/rest\/api\/3\/issue\/SHOP-412\?fields=/);
});

test('search uses the current /search/jql endpoint', async () => {
  const exec = fakeExec({ stdout: JSON.stringify({ issues: [{ key: 'SHOP-1', fields: { summary: 'a' } }] }) });
  const r = await createJiraAdapter({ exec }).search({ jql: 'project = SHOP', limit: 5 });
  assert.match(exec.calls[0][2], /^\/rest\/api\/3\/search\/jql\?jql=project%20%3D%20SHOP&maxResults=5/);
  assert.equal(r.data[0].key, 'SHOP-1');
});

test('filing an issue needs authorisation and a named project, and never reaches Jira without them', async () => {
  const exec = fakeExec({ stdout: JSON.stringify({ id: '10001', key: 'SHOP-501', self: 'https://acme.atlassian.net/rest/api/3/issue/10001' }) });
  const jira = createJiraAdapter({ exec });
  const f = newFinding();
  assert.equal((await jira.createIssueFromFinding({ findingId: f.finding_id, project: 'SHOP' })).status, 'NEEDS_USER_INPUT');
  assert.equal((await jira.createIssueFromFinding({ findingId: f.finding_id, authorisation: AUTHORISED })).status, 'NEEDS_USER_INPUT');
  assert.equal(exec.calls.length, 0);

  const r = await jira.createIssueFromFinding({ findingId: f.finding_id, project: 'SHOP', authorisation: AUTHORISED });
  assert.equal(r.confirmed, true);
  assert.equal(r.result_id, 'SHOP-501');
  const [, method, urlPath, body] = exec.calls[0];
  assert.equal(method, 'POST');
  assert.equal(urlPath, '/rest/api/3/issue');
  const sent = JSON.parse(body).fields;
  assert.equal(sent.project.key, 'SHOP');
  assert.equal(sent.description.type, 'doc', 'the description is sent as ADF, not a string');
  assert.equal(auth.listWrites('jira').find((w) => w.idempotency_key === f.fingerprint).confirmed, true);

  const again = await jira.createIssueFromFinding({ findingId: f.finding_id, project: 'SHOP', authorisation: AUTHORISED });
  assert.equal(again.ok, false, 'the same finding cannot be filed twice');
  assert.equal(exec.calls.length, 1);
});

test('a created issue without a key in the response is NOT confirmed', () => {
  assert.equal(parseIssueResult({ stdout: '{}' }).confirmed, false);
  assert.equal(parseIssueResult({ stdout: 'created!' }).confirmed, false);
  assert.equal(parseCommentResult({ stdout: '{"id":"77"}' }, 'SHOP-1').result_id, 'SHOP-1-comment-77');
  assert.equal(parseCommentResult({ stdout: '{"id":"77"}' }).confirmed, false, 'no issue key, no comment identity');
});

test('comments are posted as ADF and confirmed by the comment id', async () => {
  const exec = fakeExec({ stdout: JSON.stringify({ id: '20002', self: 'https://acme.atlassian.net/rest/api/3/issue/SHOP-412/comment/20002' }) });
  const r = await createJiraAdapter({ exec }).comment({ key: 'SHOP-412', body: 'Reproduced: EV-2026-00002', authorisation: AUTHORISED });
  assert.equal(r.result_id, 'SHOP-412-comment-20002');
  assert.equal(JSON.parse(exec.calls[0][3]).body.type, 'doc');
});

test('transitions stay prohibited even when the user says yes in passing', async () => {
  const exec = fakeExec();
  const r = await createJiraAdapter({ exec }).transition({ key: 'SHOP-412', transitionId: '31', authorisation: AUTHORISED });
  assert.equal(r.ok, false);
  assert.equal(exec.calls.length, 0);
});

test('with the Atlassian connector, writes are delegated and confirmed only by an independent REST read-back', async () => {
  setProviders({ 'mcp-atlassian': true, 'jira-rest': false, shell: true });
  const r = await createJiraAdapter({ exec: fakeExec() }).comment({ key: 'SHOP-412', body: 'Delegated comment', authorisation: AUTHORISED });
  assert.equal(r.delegate, true);
  assert.match(r.caller_should, /adapter complete --ticket WT-[0-9a-f]+ --input response\.json/);

  const readBack = fakeExec({ stdout: JSON.stringify({ id: '30003', body: textToAdf('Delegated comment') }) });
  const done = await adapters.getAdapter('jira', { exec: readBack }).complete({
    ticket: r.ticket,
    response: JSON.stringify({ id: '30003', self: 'https://acme.atlassian.net/rest/api/3/issue/SHOP-412/comment/30003' }),
  });
  assert.equal(done.confirmed, true);
  assert.equal(done.verified, true);
  assert.equal(readBack.calls[0][2], '/rest/api/3/issue/SHOP-412/comment/30003');
  setProviders({ 'jira-rest': true, 'mcp-atlassian': false, shell: true });
});

test('a read-back 404 refutes a delegated write; a missing credential only makes it unverifiable', async () => {
  const refuted = await verifyJiraWrite({ resultId: 'SHOP-9' }, { exec: fakeExec({ exit_code: 1, stderr: 'HTTP 404 Not Found' }) });
  assert.equal(refuted.verification, 'refuted');
  assert.equal(refuted.retry_safe, true);
  const unknown = await verifyJiraWrite({ resultId: 'SHOP-9' }, { exec: fakeExec({ exit_code: 1, stderr: 'ECONNRESET' }) });
  assert.equal(unknown.verification, 'unavailable');
  assert.equal(unknown.retry_safe, false, 'the write may have landed; retrying would duplicate it');
  const mismatch = await verifyJiraWrite({ resultId: 'SHOP-9-comment-5', contentSha256: sha256String('what we sent') },
    { exec: fakeExec({ stdout: JSON.stringify({ body: textToAdf('something else') }) }) });
  assert.equal(mismatch.failure_kind, 'body-mismatch');
});

test('preflight reports the account, and jira is no longer a manual-only system', async () => {
  const ok = await preflight({ exec: fakeExec({ stdout: JSON.stringify({ accountId: 'abc', emailAddress: 'bot@acme.test' }) }) });
  assert.equal(ok.authenticated, true);
  assert.equal(ok.account, 'bot@acme.test');
  assert.ok(adapters.SYSTEMS.includes('jira'));
  assert.notEqual(caps.resolve('jira.comment').executable, false);
});
