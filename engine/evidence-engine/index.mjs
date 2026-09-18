/**
 * Evidence Engine.
 *
 * Evidence is the only currency this system accepts for a claim of execution.
 * Everything here exists to keep two things apart that agents constantly
 * conflate:
 *
 *     "I did not observe a failure"   !=   "It works"
 *
 * `verifyClaim` is the gate. The reporting engine refuses to emit PASSED for a
 * goal that cannot get through it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { nextId } from '../core/ids.mjs';
import { provenance } from '../core/version.mjs';
import { sha256File, ensureDir } from '../core/fsjson.mjs';
import { redactText, containsSecret } from '../core/redact.mjs';
import { dir } from '../core/paths.mjs';
import * as state from '../state-engine/index.mjs';

/** Evidence kinds that can, on their own, support a PASSED/FAILED claim. */
export const EXECUTION_EVIDENCE = new Set([
  'command-output', 'test-report', 'assertion-result', 'trace', 'har',
  'coverage-report', 'performance-metric', 'database-snapshot',
  'accessibility-scan', 'dependency-scan', 'static-analysis',
]);

/** Kinds that corroborate but never suffice by themselves. */
export const CORROBORATING_EVIDENCE = new Set([
  'screenshot', 'video', 'console-log', 'server-log', 'network-request',
  'screenshot-diff', 'diff', 'file-content', 'github-object', 'jira-object',
  'document-revision', 'external-api-response', 'evidence-audit', 'other',
]);

/** Kinds that are explicitly NOT execution evidence. */
export const NON_EXECUTION = new Set(['user-statement']);

const EXCERPT_LIMIT = 8000;

/**
 * Store an evidence item. Large artefacts stay on disk; only a hash, a pointer
 * and a redacted excerpt go into state.
 */
export function add({
  kind,
  summary,
  epistemicClass = 'observed',
  executionId = null,
  git = null,
  environment = null,
  command = null,
  artifactPath = null,
  artifactUri = null,
  mediaType = null,
  excerpt = null,
  supports = [],
  skillName = 'testing-orchestrator',
  now = new Date(),
} = {}) {
  const session = state.loadSession();
  const id = nextId('evidence', now);

  const rec = {
    evidence_id: id,
    timestamp: now.toISOString(),
    kind,
    epistemic_class: epistemicClass,
    summary,
    supports,
    provenance: provenance({ sessionId: session?.session_id, skillName, now }),
  };
  if (session) rec.session_id = session.session_id;
  if (executionId) rec.execution_id = executionId;
  if (git) rec.git = git;
  if (environment) rec.environment = environment;
  if (command) rec.command = { ...command, argv: redactText(command.argv ?? '') };

  if (artifactPath || artifactUri) {
    rec.artifact = {};
    if (artifactPath) {
      const abs = path.resolve(artifactPath);
      if (!fs.existsSync(abs)) {
        throw new Error(`Evidence artifact does not exist: ${abs}. Never register an artefact that was not actually produced.`);
      }
      const stat = fs.statSync(abs);
      rec.artifact.path = abs;
      rec.artifact.bytes = stat.size;
      rec.artifact.sha256 = sha256File(abs);
    }
    if (artifactUri) rec.artifact.uri = artifactUri;
    if (mediaType) rec.artifact.media_type = mediaType;
  }

  if (excerpt) {
    const trimmed = String(excerpt).slice(0, EXCERPT_LIMIT);
    const clean = redactText(trimmed);
    rec.excerpt = clean;
    rec.redacted = clean !== trimmed || containsSecret(trimmed);
  }

  state.put('evidence', id, rec, 'evidence');
  state.telemetry({ event: 'evidence', evidence_id: id, kind, execution_id: executionId });
  return rec;
}

/** Convenience: capture a command's output as evidence, hashing it to disk. */
export function captureOutput({ argv, cwd, exitCode, durationMs, stdout = '', stderr = '', summary, executionId = null, git = null, environment = null, now = new Date() }) {
  const blobDir = ensureDir(path.join(dir('evidence'), 'blobs'));
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const file = path.join(blobDir, `output-${stamp}-${process.pid}.txt`);
  const raw = `$ ${argv}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n--- exit: ${exitCode} ---\n`;
  // The artefact on disk is redacted; the raw text is handed to `add`, which
  // redacts it again for the record AND sets the `redacted` flag honestly.
  // Redacting twice is cheap; mislabelling a record as clean is not.
  fs.writeFileSync(file, redactText(raw), 'utf8');

  return add({
    kind: 'command-output',
    summary: summary ?? `Command exited ${exitCode}`,
    epistemicClass: 'observed',
    executionId,
    git,
    environment,
    command: { argv, cwd, exit_code: exitCode, duration_ms: durationMs },
    artifactPath: file,
    mediaType: 'text/plain',
    excerpt: raw,
    now,
  });
}

/** A test-report describing zero executed cases, however it phrases it. */
const ZERO_CASES_PATTERN = /\b(?:0\s+(?:passing|tests?\s+(?:ran|found|collected|executed))|no\s+tests?\s+found|found\s+0\s+tests?|0\s+total)\b/i;

/**
 * The false-confidence gate.
 *
 * Checks evidence CONTENT, not just its kind and epistemic class -- kind and
 * class only prove the right shape of evidence was attached, never that it
 * actually says the claim is true or that it is even about this claim. All
 * three checks below are mechanically verifiable from data already recorded
 * on the evidence item; none of them require judging correctness.
 *
 * @param {object} claim
 * @param {string} claim.status       The status being claimed.
 * @param {string[]} claim.evidenceIds
 * @param {string} [claim.executionId]  The execution (or other subject, e.g. a
 *   test case ID) this claim is about. When supplied, at least one execution
 *   evidence item must actually be linked to it via `execution_id` or
 *   `supports` -- otherwise any evidence from any unrelated run would satisfy
 *   any claim.
 * @returns {{permitted: boolean, downgrade_to?: string, reasons: string[]}}
 */
export function verifyClaim({ status, evidenceIds = [], statement = '', executionId = null } = {}) {
  const reasons = [];
  const needsExecution = ['PASSED', 'FAILED', 'COMPLETED', 'PARTIAL'];

  if (!needsExecution.includes(status)) {
    return { permitted: true, reasons: [`Status "${status}" makes no claim about execution, so no execution evidence is required.`] };
  }

  if (evidenceIds.length === 0) {
    return {
      permitted: false,
      downgrade_to: 'INCONCLUSIVE',
      reasons: [`"${status}" claims something was executed, but no evidence is attached. Absence of failure is not proof of correctness.`],
    };
  }

  const items = evidenceIds.map((id) => ({ id, rec: state.get('evidence', id) }));
  const missing = items.filter((i) => !i.rec).map((i) => i.id);
  if (missing.length) {
    return {
      permitted: false,
      downgrade_to: 'INCONCLUSIVE',
      reasons: [`Referenced evidence does not exist on disk: ${missing.join(', ')}. A dangling reference is worse than none.`],
    };
  }

  const kinds = items.map((i) => i.rec.kind);
  const hasExecution = kinds.some((k) => EXECUTION_EVIDENCE.has(k));
  const onlyUserStatement = kinds.every((k) => NON_EXECUTION.has(k));

  if (onlyUserStatement) {
    return {
      permitted: false,
      downgrade_to: 'INCONCLUSIVE',
      reasons: ['The only evidence is a user statement. That is testimony, not verification.'],
    };
  }

  if (!hasExecution) {
    return {
      permitted: false,
      downgrade_to: 'INCONCLUSIVE',
      reasons: [
        `Evidence kinds [${[...new Set(kinds)].join(', ')}] are corroborating only. A "${status}" claim needs at least one of: ${[...EXECUTION_EVIDENCE].join(', ')}.`,
        'A screenshot shows what a page looked like; it does not show that an assertion held.',
      ],
    };
  }

  const claimsSuccess = ['PASSED', 'COMPLETED'].includes(status);

  if (claimsSuccess) {
    const failedCommand = items.find((i) => Number.isInteger(i.rec.command?.exit_code) && i.rec.command.exit_code !== 0);
    if (failedCommand) {
      return {
        permitted: false,
        downgrade_to: 'INCONCLUSIVE',
        reasons: [`Evidence ${failedCommand.id} recorded a non-zero exit code (${failedCommand.rec.command.exit_code}), which directly contradicts a "${status}" claim. A command that failed cannot be used as evidence that it passed.`],
      };
    }
  }

  if (executionId) {
    const executionEvidence = items.filter((i) => EXECUTION_EVIDENCE.has(i.rec.kind));
    const linked = executionEvidence.filter(
      (i) => i.rec.execution_id === executionId || (i.rec.supports ?? []).includes(executionId),
    );
    if (executionEvidence.length && linked.length === 0) {
      return {
        permitted: false,
        downgrade_to: 'INCONCLUSIVE',
        reasons: [`None of the attached execution evidence is linked to ${executionId}: each item's "execution_id" points elsewhere (or is unset) and none lists ${executionId} in "supports". Evidence from an unrelated run cannot back this claim.`],
      };
    }
  }

  if (claimsSuccess) {
    const emptyReport = items.find(
      (i) => i.rec.kind === 'test-report' && ZERO_CASES_PATTERN.test(`${i.rec.summary ?? ''} ${i.rec.excerpt ?? ''}`),
    );
    if (emptyReport) {
      return {
        permitted: false,
        downgrade_to: 'INCONCLUSIVE',
        reasons: [`Evidence ${emptyReport.id} is a test-report describing zero executed cases ("${emptyReport.rec.summary}"). A report that nothing ran cannot support a "${status}" claim.`],
      };
    }
  }

  const inferred = items.filter((i) => ['inferred', 'assumed', 'expected'].includes(i.rec.epistemic_class));
  if (inferred.length === items.length) {
    return {
      permitted: false,
      downgrade_to: 'INCONCLUSIVE',
      reasons: [`Every evidence item is classed ${[...new Set(inferred.map((i) => i.rec.epistemic_class))].join('/')}. Inference must never be reported as observation.`],
    };
  }

  reasons.push(`Backed by ${items.length} evidence item(s), including execution evidence of kind(s): ${kinds.filter((k) => EXECUTION_EVIDENCE.has(k)).join(', ')}.`);
  if (statement && /\bworks?\b|\bfine\b|\ball good\b|\bno issues?\b/i.test(statement) && !/\bTC-|\bEXEC-|assertion/i.test(statement)) {
    reasons.push('WARNING: the statement is vague ("works"/"fine"). Rewrite it to name the scenario, the commit and the assertions that held.');
  }
  return { permitted: true, reasons };
}

/** Bulk audit used by the reporting engine's integrity block. */
export function auditClaims(claims) {
  const results = claims.map((c) => ({ ...c, verdict: verifyClaim(c) }));
  const passClaims = results.filter((r) => ['PASSED', 'COMPLETED'].includes(r.status));
  const unevidenced = passClaims.filter((r) => !r.verdict.permitted);
  return {
    total_claims: results.length,
    pass_claims: passClaims.length,
    unevidenced_pass_claims: unevidenced.length,
    false_confidence_rate: passClaims.length === 0 ? 0 : Number((unevidenced.length / passClaims.length).toFixed(4)),
    violations: unevidenced.map((r) => `${r.id ?? r.statement ?? 'claim'}: ${r.verdict.reasons.join(' ')}`),
    results,
  };
}
