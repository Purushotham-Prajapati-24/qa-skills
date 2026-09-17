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
