import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempState } from './helpers.mjs';
import { declare, resolve, probe } from '../engine/capability-registry/index.mjs';

const tmp = useTempState('capability-registry');
test.after(() => tmp.cleanup());

test('declaring a provider makes a dependent capability resolve as available immediately, with no re-probe', () => {
  const before = resolve('browser.explore');
  assert.equal(before.available, false, 'undeclared providers must resolve as unavailable, not unknown-but-passing');

  declare('mcp-playwright', true, 'browser_* tools present');

  const after = resolve('browser.explore');
  assert.equal(after.available, true, 'resolve() must see a declaration without a separate `caps probe` step');
  assert.equal(after.provider, 'mcp-playwright');
});

test('a later probe() re-derives providers from declared state rather than losing the declaration', () => {
  declare('mcp-playwright', true, 'browser_* tools present');
  probe();

  const after = resolve('browser.explore');
  assert.equal(after.available, true, 'probe() must not wipe out an existing agent declaration');
});

test('declaring a provider false makes the dependent capability resolve as unavailable', () => {
  declare('mcp-playwright', true, 'present');
  declare('mcp-playwright', false, 'tool list changed, no longer present');

  const after = resolve('browser.explore');
  assert.equal(after.available, false);
});

/**
 * PROGRESS.md names this as the worst state a capability can be in: verbs exist, a
 * credential is present, and `available: true` -- with no adapter module behind it. An
 * agent that stops at `available` may hand-roll the call, or worse, infer the answer from
 * somewhere else and report it as if this system produced it. `resolve()` has to say so
 * every time, not just in a table this specific call site might not read.
 */
test('a capability resolving true for a system with no executable adapter still says so', () => {
  // Google Docs is still manual-only (Jira gained an adapter in 0.11.0). local-doc-mirror
  // always probes available, which is exactly the "available but not executable" case.
  probe();
  const r = resolve('docs.read');
  assert.equal(r.available, true, 'the always-available fallback genuinely resolves');
  assert.equal(r.executable, false, 'available and executable are different claims');
  assert.match(r.reason, /No executable adapter exists for "docs"/);
  assert.match(r.reason, /Perform this call by hand/);
});

test('jira verbs no longer carry the manual-only warning once the adapter exists', () => {
  process.env.JIRA_BASE_URL = 'https://example.atlassian.net';
  process.env.JIRA_EMAIL = 'agent@example.com';
  process.env.JIRA_API_TOKEN = 'not-a-real-token';
  try {
    probe();
    const r = resolve('jira.read_ticket');
    assert.equal(r.available, true);
    assert.equal(r.executable, null);
    assert.doesNotMatch(r.reason, /No executable adapter/);
  } finally {
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_EMAIL;
    delete process.env.JIRA_API_TOKEN;
  }
});

test('a capability for a system with a real adapter carries no manual-only warning', () => {
  declare('gh-cli', true, 'authenticated');
  const r = resolve('github.read_repo');
  assert.equal(r.executable, null, 'github has an executable adapter, so this field does not apply');
  assert.doesNotMatch(r.reason, /No executable adapter/);
});
