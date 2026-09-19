import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { useTempState } from './helpers.mjs';
import * as state from '../engine/state-engine/index.mjs';
import * as execution from '../engine/execution-engine/index.mjs';
import * as evidenceEngine from '../engine/evidence-engine/index.mjs';
import * as reporting from '../engine/reporting-engine/index.mjs';

/**
 * The orchestrator's own rule, stated twice in its skills: the Markdown report is
 * rendered from state, never hand-written. A field trial ignored it -- wrote a report by
 * hand, back-filled state afterwards -- and `ast validate` returned `valid: true`,
 * because nothing anywhere checked whether the report handed to the user was the one the
 * renderer actually produced.
 *
 * `report.digest` (set once, over the fully-built record, excluding itself) plus
 * `verify()` (recompute the digest, then re-render and compare byte for byte) is the
 * mechanism. It found a real, pre-existing bug on its first genuine run: `redact()`
 * silently corrupted `metrics.denominators.authorization_compliance` into "[REDACTED]"
 * on every write-then-reload, because the KEY_HINTS pattern matches "authorization" as an
 * unanchored substring. Fixed in engine/core/redact.mjs (SAFE_KEYS); a regression test for
 * that specific corruption lives here, not in redact's own test file, because it is a
 * report-round-trip property, not a redaction-shape property.
 */
const tmp = useTempState('report-verify');
test.after(() => tmp.cleanup());
state.startSession({ request: 'report-verify in-process test session' });

/** Build one real, evidenced, finished execution so generate() has something to report. */
function realExecution() {
  const exec = execution.start({ goal: 'typecheck', method: 'static-analysis', testCategory: 'sanity' });
  const ev = evidenceEngine.add({
    kind: 'static-analysis', summary: 'tsc --noEmit: 0 errors', executionId: exec.execution_id,
  });
  execution.finish(exec.execution_id, { status: 'PASSED', statusReason: 'clean typecheck', evidence: [ev.evidence_id] });
  return exec.execution_id;
}

test('a freshly generated report carries a digest, and verifying its own rendered text succeeds', () => {
  realExecution();
  const { report, markdown } = reporting.generate();
  assert.match(report.digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(markdown, /digest `sha256:[0-9a-f]{64}`/);

  const result = reporting.verify(markdown);
  assert.equal(result.rendered, true);
  assert.equal(result.report_id, report.report_id);
  assert.equal(result.digest, report.digest);
});

test('the digest survives a full write-then-reload round trip through real state (this is the redaction bug this mechanism actually caught)', () => {
  const { report } = reporting.generate();
  const reloaded = state.get('reports', report.report_id);
  assert.equal(reloaded.digest, report.digest);
  // The specific corruption: denominators.authorization_compliance is a metric name, not
  // a credential, and must survive redact() unredacted.
  assert.equal(reloaded.metrics?.denominators?.authorization_compliance, report.metrics?.denominators?.authorization_compliance);
  assert.notEqual(reloaded.metrics?.denominators?.authorization_compliance, '[REDACTED]');
});

test('a single character changed anywhere in the rendered text fails verification and names the first differing line', () => {
  const { markdown } = reporting.generate();
  const lines = markdown.split('\n');
  const targetLine = lines.findIndex((l) => l.includes('typecheck'));
  assert.ok(targetLine >= 0, 'fixture must contain a locatable line to tamper with');
  lines[targetLine] = lines[targetLine].replace('typecheck', 'TYPECHECK-TAMPERED');
  const tampered = lines.join('\n');

  const result = reporting.verify(tampered);
  assert.equal(result.rendered, false);
  assert.match(result.reason, /does not reproduce this text byte for byte/);
  assert.equal(result.first_diff_line, targetLine + 1);
});

test('CRLF line endings alone (no content change) do not fail verification', () => {
  const { markdown } = reporting.generate();
  const crlf = markdown.replace(/\n/g, '\r\n');
  const result = reporting.verify(crlf);
  assert.equal(result.rendered, true, 'an incidental line-ending conversion is not a content edit');
});

test('text with no report title line at all is rejected as not looking like this system\'s output', () => {
  const result = reporting.verify('# Some Other Report\n\nThis was written by hand.\n');
  assert.equal(result.rendered, false);
  assert.match(result.reason, /No report title line found/);
});

test('a title line naming a report_id with no stored record is rejected, distinctly from a tampered one', () => {
  const result = reporting.verify('# Testing Report · REPORT-2026-09999\n\nfabricated\n');
  assert.equal(result.rendered, false);
  assert.equal(result.report_id, 'REPORT-2026-09999');
  assert.match(result.reason, /No stored record/);
});

test('a stored record whose digest does not match its own content is rejected as altered after being written', () => {
  const { report } = reporting.generate();
  state.put('reports', report.report_id, { ...report, executive_summary: { ...report.executive_summary, headline: 'quietly edited on disk' } }, 'report');
  const result = reporting.verify(reporting.render(state.get('reports', report.report_id)));
  // Re-rendering the (now-altered) stored record reproduces itself byte for byte, so this
  // must be caught by the digest mismatch, one check earlier -- not by the render diff.
  assert.equal(result.rendered, false);
  assert.match(result.reason, /digest does not match its own content/);
});

test('a report with no digest field at all is rejected as predating this check', () => {
  const { report } = reporting.generate();
  const { digest, ...withoutDigest } = report;
  state.put('reports', report.report_id, withoutDigest, 'report');
  const result = reporting.verify(reporting.render(withoutDigest));
  assert.equal(result.rendered, false);
  assert.match(result.reason, /carries no digest/);
});

/* ---------------------------------------------------------- CLI: ast report verify */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AST = path.join(ROOT, 'bin', 'ast.mjs');

function freshState(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ast-report-verify-${label}-`));
}

function ast(args, stateDir) {
  return execFileSync(process.execPath, [AST, '--state', stateDir, ...args], { encoding: 'utf8', timeout: 15_000 });
}

function astInput(args, payload, stateDir) {
  const file = path.join(stateDir, `input-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  return ast([...args, '--input', file], stateDir);
}

function generateRealReport(dir) {
  ast(['session', 'start', '--request', 'cli report verify test'], dir);
  const execOut = JSON.parse(astInput(['exec', 'start'], { goal: 'smoke', method: 'static-analysis' }, dir));
  astInput(['exec', 'finish', execOut.execution_id], { status: 'PASSED', statusReason: 'ok' }, dir);
  return JSON.parse(ast(['report', 'generate'], dir));
}

test('CLI: "ast report verify <REPORT-ID>" reads the stored copy under state/reports/ and succeeds', () => {
  const dir = freshState('by-id');
  const { report_id: reportId } = generateRealReport(dir);
  const out = JSON.parse(ast(['report', 'verify', reportId], dir));
  assert.equal(out.rendered, true);
  assert.equal(out.report_id, reportId);
});

test('CLI: "ast report verify <path>" reads an arbitrary file path and succeeds for a genuine copy', () => {
  const dir = freshState('by-path');
  const { report_id: reportId, markdown_path: mdPath } = generateRealReport(dir);
  const out = JSON.parse(ast(['report', 'verify', mdPath], dir));
  assert.equal(out.rendered, true);
  assert.equal(out.report_id, reportId);
});

test('CLI: "ast report verify" exits non-zero when the report does not verify', () => {
  const dir = freshState('exit-code');
  generateRealReport(dir);
  const fakePath = path.join(dir, 'fake.md');
  fs.writeFileSync(fakePath, '# Not A Real Report\n\nhand-written\n');
  assert.throws(
    () => ast(['report', 'verify', fakePath], dir),
    (err) => {
      assert.equal(err.status, 1);
      const out = JSON.parse(err.stdout);
      assert.equal(out.rendered, false);
      return true;
    },
  );
});

test('CLI: "ast report verify" with no argument is a clear error, not a crash', () => {
  const dir = freshState('no-arg');
  assert.throws(
    () => ast(['report', 'verify'], dir),
    (err) => err.status === 1 && /requires a path/.test(err.stderr),
  );
});
