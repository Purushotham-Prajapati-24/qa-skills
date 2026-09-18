/**
 * The adapter contract, made executable.
 *
 * Until now the write protocol -- resolve the capability, check authorisation, check the
 * ledger, render the content, perform, record the provider's ACTUAL response -- held
 * because the agent remembered to follow `integrations/<system>/adapter.md`. That is a
 * behavioural guarantee, and behavioural guarantees decay.
 *
 * `performWrite` makes it structural. There is one function, it runs the gates in order,
 * and it is the only thing that writes to the ledger. A caller cannot use half of it.
 *
 * Two paths exist because of a real constraint:
 *
 *   - A COMMAND provider (the `gh` CLI) can be executed from here, so the whole protocol
 *     runs in one call.
 *   - An MCP provider cannot: this is a Node module, and MCP tools live in the agent's
 *     tool list. So the gates run here, a signed ticket is issued, the agent performs the
 *     call, and `completeWrite` finishes the protocol. A ledger entry cannot be created
 *     without a ticket, and a ticket cannot be issued without passing the gates.
 *
 * The second path is weaker than the first -- the agent could perform the call and never
 * come back. It cannot, however, fabricate a confirmed write: `completeWrite` treats
 * whatever the agent hands it as an unverified claim, not as the provider's own output,
 * and independently re-reads the claimed object (via `verifyRead`) before `confirmed` is
 * ever set to true. A ticket proves the gates ran; only a successful read-back proves the
 * write did.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { dir } from '../core/paths.mjs';
import { readJson, writeJson, ensureDir, sha256String } from '../core/fsjson.mjs';
import { redactText } from '../core/redact.mjs';
import * as caps from '../capability-registry/index.mjs';
import * as auth from '../authorization/index.mjs';
import * as evidence from '../evidence-engine/index.mjs';
import * as state from '../state-engine/index.mjs';

/** A ticket is useless after this long. Authorisation is per-session and does not keep. */
export const TICKET_TTL_MS = 60 * 60 * 1000;

/* --------------------------------------------------------------- outcomes */

/**
 * Every adapter call returns one of these. `status` maps onto the system's status model
 * so a caller can put it straight into an execution record.
 */
export const OUTCOME = {
  OK: 'COMPLETED',
  BLOCKED: 'BLOCKED',
  NEEDS_USER_INPUT: 'NEEDS_USER_INPUT',
  SKIPPED: 'SKIPPED',
  INCONCLUSIVE: 'INCONCLUSIVE',
  FAILED: 'FAILED',
};

function outcome(status, fields) {
  return { ok: status === OUTCOME.OK, status, ...fields };
}

/* ------------------------------------------------------------- execution */

/**
 * Run a provider command. Never throws: a non-zero exit is data, not an exception,
 * because "the command failed" and "the write did not happen" are different claims and
 * conflating them is how an agent reports an unconfirmed write as done.
 */
export function shellExec(argv, { cwd, timeoutMs = 60_000, input } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = execFile(argv[0], argv.slice(1), { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        argv: argv.join(' '),
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        exit_code: err?.code ?? 0,
        timed_out: err?.killed === true || err?.signal === 'SIGTERM',
        duration_ms: Date.now() - started,
      });
    });
    if (input !== undefined && child.stdin) {
      child.stdin.end(input);
    }
  });
}

/**
 * Map a provider failure onto the table in integrations/<system>/adapter.md.
 *
 * The row that matters most is `network-error`: `retry_safe` is false, because the write
 * may have landed. Retrying blindly is how duplicate issues get created.
 */
export function classifyProviderError({ exit_code = 0, stderr = '', stdout = '', timed_out = false } = {}) {
  const text = `${stderr}\n${stdout}`;
  const hit = (re) => re.test(text);

  if (timed_out) {
    return { kind: 'timeout', retry_safe: false, caller_should: 'Verify whether the write landed before retrying. A timeout is not a failure.', status: OUTCOME.INCONCLUSIVE };
  }
  if (exit_code === 0) return null;

  if (hit(/\b401\b|not logged|authentication required|bad credentials/i)) {
    return { kind: 'unauthenticated', retry_safe: true, caller_should: 'Treat the capability as unavailable and report BLOCKED. Do not try another credential.', status: OUTCOME.BLOCKED };
  }
  if (hit(/\b403\b|forbidden|insufficient scope|resource not accessible/i)) {
    return { kind: 'forbidden', retry_safe: true, caller_should: 'The token lacks the scope for this action. Report BLOCKED and say which scope is missing.', status: OUTCOME.BLOCKED };
  }
  if (hit(/\b404\b|not found|could not resolve/i)) {
    return { kind: 'not-found', retry_safe: true, caller_should: 'Verify the target. On a private repository this is usually a scope problem, not a missing resource.', status: OUTCOME.BLOCKED };
  }
  if (hit(/\b422\b|validation failed|unprocessable/i)) {
    return { kind: 'validation', retry_safe: true, caller_should: 'Fix the payload. Do not retry unchanged.', status: OUTCOME.FAILED };
  }
  if (hit(/\b429\b|rate limit|abuse detection|secondary rate/i)) {
    return { kind: 'rate-limited', retry_safe: true, caller_should: 'Back off once, then report BLOCKED. Do not hammer.', status: OUTCOME.BLOCKED };
  }
  if (hit(/ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|network|dial tcp|connection reset/i)) {
    return { kind: 'network-error', retry_safe: false, caller_should: 'Do NOT retry blindly -- the write may have landed. Verify by searching for the target first.', status: OUTCOME.INCONCLUSIVE };
  }
  return { kind: 'unknown', retry_safe: false, caller_should: 'Read the provider output before deciding anything. Treat the write as unconfirmed.', status: OUTCOME.INCONCLUSIVE };
}

/* ---------------------------------------------------------------- tickets */

function ticketDir() {
  return ensureDir(path.join(dir('ledger'), 'pending'));
}

function ticketFile(id) {
  return path.join(ticketDir(), `${id}.json`);
}

function issueTicket(fields, now) {
  const id = `WT-${crypto.randomBytes(8).toString('hex')}`;
  const rec = {
    ticket: id,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + TICKET_TTL_MS).toISOString(),
    ...fields,
  };
  writeJson(ticketFile(id), rec);
  return rec;
}

export function readTicket(id) {
  return readJson(ticketFile(id), null);
}

export function listTickets() {
  const d = ticketDir();
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(d, f)));
}

function consumeTicket(id) {
  const f = ticketFile(id);
  if (fs.existsSync(f)) fs.rmSync(f);
}

/* -------------------------------------------------------------- read path */

/**
 * A read. No authorisation required, but the capability still has to resolve, and the
 * result is registered as evidence so a later claim can cite it.
 *
 * Read evidence is always CORROBORATING. A pull request description is not proof that a
 * test ran, and classing it as execution evidence would let it support a PASSED claim.
 */
export async function performRead({
  verb,
  system,
  summary,
  build,
  parse = (r) => r.stdout,
  exec = shellExec,
  recordEvidence = true,
  now = new Date(),
} = {}) {
  const resolved = caps.resolve(verb);
  if (!resolved.available) {
    return outcome(OUTCOME.BLOCKED, {
      verb,
      reason: resolved.reason,
      candidates: resolved.candidates,
      caller_should: 'Report this capability as unavailable. Do not simulate it.',
    });
  }
  if (resolved.provider.startsWith('mcp-')) {
    return outcome(OUTCOME.NEEDS_USER_INPUT, {
      verb,
      provider: resolved.provider,
      delegate: true,
      reason: `Capability resolved to "${resolved.provider}", which lives in the agent's tool list and cannot be invoked from Node.`,
      caller_should: 'Perform the read with your own MCP tools, then continue. No ledger entry is needed for a read.',
    });
  }

  const argv = build(resolved);
  const raw = await exec(argv);
  const failure = classifyProviderError(raw);

  if (failure) {
    return outcome(failure.status, {
      verb,
      provider: resolved.provider,
      error: failure,
      command: redactText(raw.argv),
      stderr: redactText(raw.stderr).slice(0, 2000),
    });
  }

  let data;
  try {
    data = parse(raw);
  } catch (err) {
    return outcome(OUTCOME.INCONCLUSIVE, {
      verb,
      provider: resolved.provider,
      reason: `The provider returned output this adapter could not parse: ${err.message}`,
      caller_should: 'Do not guess at the content. Read the raw output.',
      excerpt: redactText(raw.stdout).slice(0, 1000),
    });
  }

  let evidenceId = null;
  if (recordEvidence) {
    const ev = evidence.add({
      kind: `${system}-object`,
      summary: summary ?? `${verb} via ${resolved.provider}`,
      epistemicClass: 'observed',
      command: { argv: raw.argv, exit_code: raw.exit_code, duration_ms: raw.duration_ms },
      excerpt: raw.stdout,
      skillName: `${system}-adapter`,
      now,
    });
    evidenceId = ev.evidence_id;
  }

  return outcome(OUTCOME.OK, { verb, provider: resolved.provider, data, evidence_id: evidenceId, duration_ms: raw.duration_ms });
}

/* ------------------------------------------------------------- write path */

/**
 * The enforced write protocol.
 *
 * @param {object}   o
 * @param {string}   o.verb            capability verb, e.g. 'github.create_issue'
 * @param {string}   o.action          authorization policy action (usually the same)
 * @param {string}   o.system          'github' | 'jira' | 'google-docs'
 * @param {string}   o.idempotencyKey  stable identity -- a finding fingerprint, an execution ID
 * @param {string}   o.target          what is being written to
 * @param {function} o.render          () => content. Called before performing, so a dry run shows it.
 * @param {function} o.build           (resolved, content) => argv, for command providers
 * @param {function} o.parseResult     (raw) => { confirmed, result_id, url }
 * @param {object}   o.authorisation   { userAuthorised, authorisationQuote, assignee }
 */
export async function performWrite({
  verb,
  action = verb,
  system,
  idempotencyKey,
  target,
  render = () => null,
  build,
  parseResult,
  authorisation = {},
  decisionId = null,
  environmentClass = 'unknown',
  dryRun = false,
  exec = shellExec,
  now = new Date(),
} = {}) {
  if (!idempotencyKey) {
    throw new Error(`performWrite("${verb}") requires an idempotencyKey. Without a stable identity the ledger cannot suppress duplicates, which is the whole point of it.`);
  }

  /* 1. capability -------------------------------------------------------- */
  const resolved = caps.resolve(verb);
  if (!resolved.available) {
    return outcome(OUTCOME.BLOCKED, { verb, gate: 'capability', reason: resolved.reason, candidates: resolved.candidates });
  }

  /* 2. authorisation ----------------------------------------------------- */
  const authCheck = auth.check({
    action,
    target,
    userAuthorised: Boolean(authorisation.userAuthorised),
    authorisationQuote: authorisation.authorisationQuote ?? '',
    assignee: authorisation.assignee ?? null,
    environmentClass,
  });
  if (!authCheck.allowed) {
    return outcome(OUTCOME.NEEDS_USER_INPUT, {
      verb,
      gate: 'authorization',
      reason: authCheck.reason,
      required_of_user: authCheck.required_of_user,
      level: authCheck.level,
    });
  }

  /* 3. duplicate suppression -------------------------------------------- */
  const dup = auth.alreadyWritten({ system, action, idempotencyKey });
  if (dup.duplicate) {
    return outcome(OUTCOME.SKIPPED, { verb, gate: 'ledger', duplicate: true, reason: dup.reason, previous: dup.previous });
  }

  /* 4. render ------------------------------------------------------------ */
  const content = render();
  const contentHash = sha256String(JSON.stringify(content ?? null));

  /* 5a. dry run ---------------------------------------------------------- */
  if (dryRun) {
    return outcome(OUTCOME.OK, {
      verb,
      provider: resolved.provider,
      dry_run: true,
      gates_passed: ['capability', 'authorization', 'ledger'],
      content,
      planned_command: build && !resolved.provider.startsWith('mcp-') ? redactText(build(resolved, content).join(' ')) : null,
      unconfirmed_warning: dup.previous ? dup.reason : null,
    });
  }

  /* 5b. MCP provider: issue a ticket, hand the call to the agent ---------- */
  if (resolved.provider.startsWith('mcp-')) {
    const ticket = issueTicket({
      system, verb, action, idempotency_key: idempotencyKey, target,
      provider: resolved.provider,
      content_sha256: contentHash,
      authorised_by: 'user-explicit',
      decision_id: decisionId,
      session_id: state.loadSession()?.session_id ?? null,
    }, now);

    return outcome(OUTCOME.NEEDS_USER_INPUT, {
      verb,
      provider: resolved.provider,
      delegate: true,
      ticket: ticket.ticket,
      expires_at: ticket.expires_at,
      content,
      gates_passed: ['capability', 'authorization', 'ledger'],
      caller_should:
        `The gates have passed. Perform this with your ${resolved.provider} tools using the content above, then run ` +
        `\`ast adapter complete --ticket ${ticket.ticket} --json '<the provider response>'\`. ` +
        'Until you do, nothing is recorded and the write counts as unconfirmed.',
    });
  }

  /* 6. perform ----------------------------------------------------------- */
  const argv = build(resolved, content);
  const raw = await exec(argv, { input: content?.stdin });
  const failure = classifyProviderError(raw);

  /* 7-9. parse, record, evidence ----------------------------------------- */
  return finalise({
    verb, action, system, idempotencyKey, target, decisionId,
    provider: resolved.provider, raw, failure, parseResult, now,
  });
}

/**
 * Turn a provider response into a ledger entry and evidence.
 *
 * `confirmed` comes from parsing the provider's own output for an identifier. It is
 * never derived from an exit code: a `gh` command can exit 0 having printed a warning
 * and created nothing.
 */
function finalise({ verb, action, system, idempotencyKey, target, decisionId, provider, raw, failure, parseResult, now }) {
  let parsed = { confirmed: false, result_id: null, url: null };
  let parseError = null;

  if (!failure) {
    try {
      parsed = { confirmed: false, result_id: null, url: null, ...(parseResult(raw) ?? {}) };
    } catch (err) {
      parseError = err.message;
    }
  }

  // A parsed identifier is the ONLY thing that justifies confirmed: true.
  const confirmed = Boolean(!failure && !parseError && parsed.confirmed && parsed.result_id);

  const entry = auth.recordWrite({
    system, action, idempotencyKey, target,
    confirmed,
    resultId: parsed.result_id,
    url: parsed.url,
    decisionId,
    authorisedBy: 'user-explicit',
    error: failure ? `${failure.kind}: ${redactText(raw.stderr).slice(0, 300)}` : parseError,
    now,
  });

  const ev = evidence.add({
    kind: `${system}-object`,
    summary: confirmed
      ? `${action} confirmed by ${provider}: ${parsed.result_id}`
      : `${action} attempted via ${provider} but NOT confirmed`,
    // Unconfirmed means we are inferring that something happened, not observing it.
    epistemicClass: confirmed ? 'observed' : 'inferred',
    command: raw.argv ? { argv: raw.argv, exit_code: raw.exit_code, duration_ms: raw.duration_ms } : undefined,
    artifactUri: parsed.url ?? undefined,
    excerpt: [raw.stdout, raw.stderr].filter(Boolean).join('\n'),
    skillName: `${system}-adapter`,
    now,
  });

  if (failure) {
    return outcome(failure.status, {
      verb, provider, confirmed: false, error: failure,
      ledger_entry: entry.key, evidence_id: ev.evidence_id,
      caller_should: failure.caller_should,
    });
  }
  if (parseError || !confirmed) {
    return outcome(OUTCOME.INCONCLUSIVE, {
      verb, provider, confirmed: false,
      reason: parseError
        ? `The provider's response could not be parsed for an identifier: ${parseError}`
        : parsed.result_id
          ? `An identifier (${parsed.result_id}) was reported but could not be independently confirmed. Without confirmation the write cannot be treated as done.`
          : 'The provider returned success but no identifier could be parsed from its output. Without an identifier the write cannot be confirmed.',
      ledger_entry: entry.key, evidence_id: ev.evidence_id,
      caller_should: 'Report this as attempted, not done. Verify the target before any retry.',
      excerpt: redactText(raw.stdout ?? '').slice(0, 1000),
    });
  }

  return outcome(OUTCOME.OK, {
    verb, provider, confirmed: true,
    result_id: parsed.result_id,
    url: parsed.url,
    ledger_entry: entry.key,
    evidence_id: ev.evidence_id,
    duration_ms: raw.duration_ms,
  });
}

/**
 * Finish a delegated (MCP) write. The ticket proves the gates ran; without one there is
 * no way to create a ledger entry through this module.
 *
 * `response` is whatever the agent hands in -- it is a self-attestation, not a provider
 * response this module obtained itself, so parsing an identifier out of it is NOT proof
 * anything happened (an agent can type a plausible-looking JSON object without ever
 * calling its MCP tools). `verifyRead` closes that gap: it independently re-reads the
 * claimed object -- e.g. `gh issue view <number>` run directly from this process, not
 * through the agent -- and `confirmed: true` is only set when that read-back succeeds.
 * Without a `verifyRead`, the parsed identifier is downgraded to unconfirmed rather than
 * trusted, because a self-attestation alone is exactly the fabrication this exists to stop.
 *
 * @param {function} [o.verifyRead]  async ({ resultId, url, target, contentSha256 }) => { exists, reason }.
 *                                   `contentSha256` is the hash of what `render()` produced when the gates
 *                                   ran, passed through so a verifier can check the read-back object's
 *                                   actual content, not just that some object with a matching ID exists.
 */
export async function completeWrite({ ticket, response, parseResult, verifyRead, now = new Date() } = {}) {
  const rec = readTicket(ticket);
  if (!rec) {
    return outcome(OUTCOME.FAILED, {
      gate: 'ticket',
      reason: `No such pending write ticket: ${ticket}. A ledger entry cannot be created without one, because the ticket is the evidence that the capability, authorisation and duplicate gates ran.`,
    });
  }
  if (new Date(rec.expires_at) < now) {
    consumeTicket(ticket);
    return outcome(OUTCOME.FAILED, {
      gate: 'ticket',
      reason: `Ticket ${ticket} expired at ${rec.expires_at}. Authorisation is per-session and does not keep. Re-request it.`,
    });
  }

  const raw = {
    argv: `[delegated to ${rec.provider}]`,
    stdout: typeof response === 'string' ? response : JSON.stringify(response ?? null),
    stderr: '',
    exit_code: 0,
    duration_ms: 0,
  };

  let claimed = { confirmed: false, result_id: null, url: null };
  try {
    claimed = { confirmed: false, result_id: null, url: null, ...(parseResult(raw) ?? {}) };
  } catch {
    // Left unconfirmed; `finalise` re-runs parseResult and reports the same parse error.
  }

  let verifyReason = 'No independent read-back is configured for this adapter, so a self-reported identifier cannot be confirmed. Treating the write as unconfirmed.';
  let verified = false;
  // Three outcomes, not two. "Refuted" means the read-back looked and the object is not
  // there, so the write failed and retrying is safe. "Unavailable" means the read-back
  // could not look -- no `gh`, no auth, no network -- which does not refute anything: the
  // agent performed the call with its own tools and it may well have landed. Collapsing
  // those two into `verified: false` is how a retry files a duplicate.
  let verification = 'unavailable';
  let retrySafe = false;
  if (claimed.confirmed && claimed.result_id) {
    if (verifyRead) {
      const check = await verifyRead({
        resultId: claimed.result_id, url: claimed.url, target: rec.target, contentSha256: rec.content_sha256,
      });
      verified = check.exists === true;
      verifyReason = check.reason;
      verification = check.verification ?? (verified ? 'confirmed' : 'unavailable');
      retrySafe = check.retry_safe === true;
    }
  } else {
    verifyReason = 'The response contained no identifier to verify.';
    verification = 'no-identifier';
  }

  // Only a successful, independent read-back may set `confirmed: true`. The agent's own
  // claim is downgraded to a candidate otherwise, however plausible it looks.
  const attested = claimed.confirmed && !verified ? { ...claimed, confirmed: false } : claimed;

  const result = finalise({
    verb: rec.verb, action: rec.action, system: rec.system,
    idempotencyKey: rec.idempotency_key, target: rec.target,
    decisionId: rec.decision_id, provider: rec.provider,
    raw, failure: null, parseResult: () => attested, now,
  });

  consumeTicket(ticket);
  if (result.confirmed) {
    return { ...result, ticket, verified, verification };
  }
  return {
    ...result,
    ticket,
    verified,
    verification,
    retry_safe: retrySafe,
    verify_reason: verifyReason,
    caller_should: retrySafe
      ? 'The read-back refuted this write: the object is not there. Report it as failed, and a retry is safe.'
      : 'Report this as attempted, not done. The read-back could not refute it either, so the write may have '
        + 'landed. Confirm the target by hand before any retry, or the retry will duplicate it.',
  };
}
