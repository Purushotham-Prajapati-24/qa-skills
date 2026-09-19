import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { useTempState } from './helpers.mjs';
import * as state from '../engine/state-engine/index.mjs';
import * as execution from '../engine/execution-engine/index.mjs';
import * as evidenceEngine from '../engine/evidence-engine/index.mjs';
import * as defects from '../engine/defect-engine/index.mjs';
import * as reporting from '../engine/reporting-engine/index.mjs';
import { captureGitInfo, inheritedGit } from '../engine/core/git.mjs';

/**
 * A field trial's report footer asserted traceability to a commit it never named, and
 * `reproducibility` (git.commit && environment && command) was structurally 0 in every
 * session, because `git` was agent-suppliable input that no trial ever supplied. This
 * closes the gap by auto-detecting it: `session start` captures it once, and
 * `exec start` / `evidence add` / `finding add` inherit it unless a caller explicitly
 * overrides -- including an explicit `git: null`, which must stay distinguishable from
 * simply omitting the field (see core/git.mjs's own comment on why the three call sites
 * destructure `git` with no default of their own).
 */

/* ------------------------------------------------------------- captureGitInfo, direct */

function freshGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-git-fixture-'));
  execSync('git init --quiet', { cwd: dir });
  execSync('git config user.email "t@t.com"', { cwd: dir });
  execSync('git config user.name "t"', { cwd: dir });
  return dir;
}

test('captureGitInfo in a real, committed repo returns a full 40-char commit and the real branch', () => {
  const dir = freshGitRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  execSync('git add . && git commit -m init --quiet', { cwd: dir });
  const info = captureGitInfo(dir);
  assert.match(info.commit, /^[0-9a-f]{40}$/);
  assert.equal(info.branch, execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir, encoding: 'utf8' }).trim());
  assert.equal(info.dirty, false);
});

test('captureGitInfo reflects a genuinely dirty working tree', () => {
  const dir = freshGitRepo();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  execSync('git add . && git commit -m init --quiet', { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'uncommitted change');
  assert.equal(captureGitInfo(dir).dirty, true);
});

test('captureGitInfo in a plain, non-git directory returns null, not a partial object', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-nongit-'));
  assert.equal(captureGitInfo(dir), null);
});

test('captureGitInfo in a git repo with no commits yet and no remote still returns a valid object -- repository falls back to the directory name', () => {
  const dir = freshGitRepo();
  const info = captureGitInfo(dir);
  assert.ok(info, 'must not return null just because there are no commits yet');
  assert.equal(info.repository, path.basename(dir));
  assert.equal(info.commit, undefined);
  assert.equal(info.branch, undefined);
});

test('captureGitInfo extracts an "owner/repo"-shaped name from a real origin remote', () => {
  const dir = freshGitRepo();
  execSync('git remote add origin https://github.com/acme/shop.git', { cwd: dir });
  assert.equal(captureGitInfo(dir).repository, 'acme/shop');
});

/* --------------------------------------------------------------------- inheritedGit */

test('inheritedGit: an omitted (undefined) value falls back to the session\'s captured git', () => {
  const session = { git: { repository: 'demo', commit: 'abc1234' } };
  assert.deepEqual(inheritedGit(undefined, session), session.git);
});

test('inheritedGit: an explicit git object always wins over the session\'s', () => {
  const session = { git: { repository: 'demo', commit: 'abc1234' } };
  const explicit = { repository: 'other/repo', commit: 'def5678' };
  assert.deepEqual(inheritedGit(explicit, session), explicit);
});

test('inheritedGit: an explicit null is respected as "no git for this record", distinct from omitted', () => {
  const session = { git: { repository: 'demo', commit: 'abc1234' } };
  assert.equal(inheritedGit(null, session), null);
});

test('inheritedGit: no session at all falls back to null when the value is omitted', () => {
  assert.equal(inheritedGit(undefined, null), null);
});

/* ------------------------------------------------------ engine-level inheritance, in-process */

const tmp = useTempState('git-provenance');
test.after(() => tmp.cleanup());

test('startSession auto-captures this real repo\'s git info when none is explicitly supplied', () => {
  const session = state.startSession({ request: 'auto-capture test' });
  // This test file itself runs inside a real git checkout, so auto-detection must have
  // found something real, not merely "did not crash".
  assert.ok(session.git, 'expected session.git to be auto-populated');
  assert.match(session.git.commit, /^[0-9a-f]{40}$/);
});

test('startSession respects an explicit git object over auto-detection', () => {
  const explicit = { repository: 'explicit/repo', commit: 'aaaaaaa' };
  const session = state.startSession({ request: 'explicit git test', git: explicit });
  assert.deepEqual(session.git, explicit);
});

test('execution.start inherits the session\'s git when not given its own', () => {
  const session = state.startSession({ request: 'inheritance test' });
  const exec = execution.start({ goal: 'smoke', method: 'static-analysis' });
  assert.deepEqual(exec.git, session.git);
});

test('execution.start respects an explicit git: null, overriding session inheritance', () => {
  state.startSession({ request: 'override test' });
  const exec = execution.start({ goal: 'smoke', method: 'static-analysis', git: null });
  assert.equal(exec.git, undefined, 'no git field should be set on the record at all');
});

test('evidence.add inherits the session\'s git when not given its own', () => {
  const session = state.startSession({ request: 'evidence inheritance test' });
  const ev = evidenceEngine.add({ kind: 'static-analysis', summary: 'typecheck clean' });
  assert.deepEqual(ev.git, session.git);
});

test('defects.create inherits the session\'s git when not given its own', () => {
  const session = state.startSession({ request: 'finding inheritance test' });
  const f = defects.create({
    title: 'a real finding', kind: 'defect', severity: 'minor', confidence: 0.9,
    summary: 'a real defect', component: 'app', impact: 'breaks things', recommendedAction: 'fix it',
  });
  assert.deepEqual(f.git, session.git);
});

// The four tests below each aggregate over ALL state in the session (metrics.compute()
// and reporting.generate() both do) rather than checking one freshly-created record's own
// fields -- so, unlike the inheritance tests above, they cannot share the module-level
// `tmp` state root: earlier tests' executions (several deliberately missing
// command/environment, or deliberately git-less) would still be sitting in the same
// state directory and pollute the aggregate. Each gets its own isolated state via the
// test context's own `t.after`, which nothing after this block depends on being reverted
// -- the CLI tests that follow use their own explicit `--state` directories regardless of
// what this process's in-memory state root currently points to.
function realExecution(overrides = {}) {
  const exec = execution.start({ goal: 'typecheck', method: 'static-analysis', ...overrides });
  const ev = evidenceEngine.add({ kind: 'static-analysis', summary: 'tsc: 0 errors', executionId: exec.execution_id });
  execution.finish(exec.execution_id, { status: 'PASSED', statusReason: 'ok', evidence: [ev.evidence_id] });
  return exec.execution_id;
}

test('reproducibility is non-zero end to end once git, environment and command are all present', async (t) => {
  const iso = useTempState('reproducibility-e2e');
  t.after(() => iso.cleanup());
  const { compute } = await import('../engine/evaluation-engine/metrics.mjs');
  state.startSession({ request: 'reproducibility end-to-end test' });
  const exec = execution.start({
    goal: 'typecheck', method: 'static-analysis',
    command: 'npm run lint', environment: 'local',
  });
  const ev = evidenceEngine.add({ kind: 'static-analysis', summary: 'tsc: 0 errors', executionId: exec.execution_id });
  execution.finish(exec.execution_id, { status: 'PASSED', statusReason: 'clean typecheck', evidence: [ev.evidence_id] });
  const m = compute();
  assert.equal(m.metrics.reproducibility, 1);
});

/* ------------------------------------------------------------- report footer rendering */

test('report footer states plain "no commit was recorded" rather than a false traceability claim, when git is absent', (t) => {
  const iso = useTempState('footer-no-commit');
  t.after(() => iso.cleanup());
  // git: null on the SESSION itself, not just the execution -- the footer reads
  // session.git (report.git), not any individual execution's own git field, so
  // suppressing it only on the execution while the session still auto-captures real git
  // (this file runs inside a real checkout) would not actually construct this scenario.
  state.startSession({ request: 'no-commit footer test', git: null });
  realExecution({ git: null });
  const { markdown } = reporting.generate();
  assert.match(markdown, /No commit was recorded for this session/);
  assert.doesNotMatch(markdown, /Every row above executed against the commit named at the top/);
});

test('report footer states the commit plainly when the tree is clean', (t) => {
  const iso = useTempState('footer-clean');
  t.after(() => iso.cleanup());
  state.startSession({ request: 'clean footer test', git: { repository: 'demo/repo', commit: 'a'.repeat(40), dirty: false } });
  realExecution();
  const { markdown } = reporting.generate();
  assert.match(markdown, /Every row above executed against the commit named at the top/);
  assert.doesNotMatch(markdown, /uncommitted changes/);
});

test('report footer adds an uncommitted-changes qualifier when the tree was dirty at capture time', (t) => {
  const iso = useTempState('footer-dirty');
  t.after(() => iso.cleanup());
  state.startSession({ request: 'dirty footer test', git: { repository: 'demo/repo', commit: 'b'.repeat(40), dirty: true } });
  realExecution();
  const { markdown } = reporting.generate();
  assert.match(markdown, /with uncommitted changes in the working tree/);
  assert.match(markdown, new RegExp('b'.repeat(7)), 'the short commit hash should appear in the qualified sentence');
});

/* ------------------------------------------------------------------------- CLI, subprocess */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AST = path.join(ROOT, 'bin', 'ast.mjs');

function freshState(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ast-git-cli-${label}-`));
}

function ast(args, stateDir) {
  return execFileSync(process.execPath, [AST, '--state', stateDir, ...args], { encoding: 'utf8', timeout: 15_000 });
}

test('CLI: "ast session start" auto-captures real git info through the real argument-parsing path', () => {
  // This is the actual regression: the CLI wrapper used to force `git: body.git ?? null`,
  // which made startSession's own auto-detect default unreachable even after it existed.
  const dir = freshState('session-start');
  const out = JSON.parse(ast(['session', 'start', '--request', 'cli git test'], dir));
  assert.ok(out.git, 'expected the CLI path to auto-capture git, not just the direct engine call');
  assert.match(out.git.commit, /^[0-9a-f]{40}$/);
});

test('CLI: an explicit git in the --input body still overrides auto-detection', () => {
  const dir = freshState('session-start-explicit');
  const file = path.join(dir, 'in.json');
  fs.writeFileSync(file, JSON.stringify({ request: 'explicit', git: { repository: 'explicit/repo', commit: 'c'.repeat(40) } }));
  const out = JSON.parse(ast(['session', 'start', '--input', file], dir));
  assert.equal(out.git.repository, 'explicit/repo');
});
