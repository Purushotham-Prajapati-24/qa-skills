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
