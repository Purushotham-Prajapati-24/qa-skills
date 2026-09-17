/**
 * Authorization gate + external-write ledger.
 *
 * Two jobs:
 *   1. Answer "may I do this?" from policy.json, defaulting to no.
 *   2. Remember every external write that was attempted, so the same issue is
 *      never filed twice and so the report can distinguish "created" from
 *      "tried to create".
 *
 * The ledger is the idempotency mechanism. It is keyed on a caller-supplied
 * stable key (a finding fingerprint, an execution ID) rather than on wording,
 * because wording changes between runs and identity must not.
 */
import path from 'node:path';
import { readJson, updateJson } from '../core/fsjson.mjs';
import { PACKAGE_ROOT, dir } from '../core/paths.mjs';
import { sha256String } from '../core/fsjson.mjs';
import { redact } from '../core/redact.mjs';

const POLICY = readJson(path.join(PACKAGE_ROOT, 'engine', 'authorization', 'policy.json'));

export function policy() {
  return POLICY;
}

/**
 * @param {object} req
 * @param {string} req.action                 Key in policy.actions.
 * @param {string} [req.target]               What is being written to.
 * @param {boolean} [req.userAuthorised=false] Did the user authorise THIS action in THIS session?
 * @param {string}  [req.authorisationQuote]  The user's own words granting it.
 * @param {string}  [req.assignee]            For assignment actions.
 * @param {string}  [req.environmentClass]    'production' | 'non-production' | 'unknown'
 */
export function check({
  action,
  target = '',
  userAuthorised = false,
  authorisationQuote = '',
  assignee = null,
  environmentClass = 'unknown',
} = {}) {
  const def = POLICY.actions[action];
  if (!def) {
    return {
      allowed: false,
      level: 'unknown',
      action,
      reason: `Action "${action}" is not in the authorization policy. Unlisted actions are denied by default; add it to engine/authorization/policy.json with an explicit level if it is legitimate.`,
      required_of_user: 'Decide the policy level for this action.',
    };
  }

  const base = { action, target, level: def.level, note: def.note ?? '' };

  switch (def.level) {
    case 'none':
      return { ...base, allowed: true, reason: 'Read-only / workspace-local action.' };

    case 'workspace-only':
      return {
        ...base,
        allowed: true,
        reason: 'Permitted inside the repository working tree.',
        constraint: 'Target must be inside the workspace. Writing outside it is a different action and is denied.',
      };

    case 'explicit':
      return userAuthorised
        ? { ...base, allowed: true, reason: `User authorised this action in this session: "${authorisationQuote || '(quote not recorded)'}"`, authorised_by: 'user-explicit' }
        : {
            ...base,
            allowed: false,
            reason: 'Requires explicit user authorisation for this specific action in this session.',
            required_of_user: `Confirm: "${action}" against "${target || 'the stated target'}".`,
          };

    case 'explicit-named-assignee':
      if (!userAuthorised) {
        return { ...base, allowed: false, reason: 'Requires explicit user authorisation.', required_of_user: `Confirm "${action}" and name the account.` };
      }
      if (!assignee) {
        return {
          ...base,
          allowed: false,
          reason: 'Authorised, but no assignee was named. The agent must never choose the person -- not from CODEOWNERS, not from git blame, not from who "seems responsible".',
          required_of_user: 'Name the GitHub/Jira account to assign, or state a mechanical rule to apply.',
        };
      }
      return { ...base, allowed: true, assignee, reason: `User named the assignee explicitly: ${assignee}.`, authorised_by: 'user-explicit' };

    case 'non-production-only': {
      if (environmentClass === 'non-production') {
        return { ...base, allowed: true, reason: 'Target environment is explicitly classified non-production in the repository profile.' };
      }
      const hint = classifyEnvironment(target);
      return {
        ...base,
        allowed: false,
        reason: `Environment class is "${environmentClass}". ${POLICY.environment_rules.why} An unclassified environment is treated as production.`,
        required_of_user: hint.looks_non_production
          ? `"${target}" looks non-production, but looking is not declaring. Classify it as "non-production" in the repository profile, or confirm which environment to use.`
          : 'Confirm which environment to use, or classify it in the repository profile.',
        environment_signals: hint,
      };
    }

    case 'prohibited-by-default':
      return {
        ...base,
        allowed: false,
        reason: 'Prohibited by default. This action is destructive, irreversible, or impersonates a human decision.',
        required_of_user: 'If you genuinely want this, restate the request knowing the consequence. The agent will not initiate it.',
      };

    default:
      return { ...base, allowed: false, reason: `Unrecognised policy level "${def.level}".` };
  }
}

/* -------------------------------------------------------- external writes */

function ledgerFile(system) {
  return path.join(dir('ledger'), `${system}.json`);
}

function loadLedger(system) {
  return readJson(ledgerFile(system), { system, entries: {} });
}

/** Stable key for an intended write. */
export function writeKey({ system, action, idempotencyKey }) {
  return sha256String(`${system}|${action}|${idempotencyKey}`);
}

/**
 * Has this exact write already been performed and confirmed?
 * Call BEFORE attempting a write. This is what stops FIND-00042 becoming three
 * identical GitHub issues across three sessions.
 */
export function alreadyWritten({ system, action, idempotencyKey }) {
  const key = writeKey({ system, action, idempotencyKey });
  const entry = loadLedger(system).entries[key];
  if (!entry) return { duplicate: false, key };
  return {
    duplicate: entry.confirmed === true,
    key,
    previous: entry,
    reason: entry.confirmed
      ? `Already written on ${entry.at} as ${entry.result_id ?? '(no id captured)'}. Update it instead of creating a second one.`
      : `A previous attempt on ${entry.at} was never confirmed. Verify the target before retrying, or you may create a duplicate.`,
  };
}

/**
 * Record the outcome of a write. `confirmed` must come from the provider's own
 * response -- never set it because the call "looked like it worked".
 */
export function recordWrite({ system, action, idempotencyKey, target, confirmed, resultId = null, url = null, decisionId = null, authorisedBy = 'not-authorised', error = null, now = new Date() }) {
  const key = writeKey({ system, action, idempotencyKey });
  // Locked read-modify-write: this ledger is the ONLY thing standing between a
  // real external write and a duplicate one (the same finding filed twice).
  // Two processes racing an unlocked read here could each see zero prior
  // attempts and both proceed to write -- exactly the duplicate this ledger
  // exists to prevent.
  const db = updateJson(ledgerFile(system), (current) => {
    const prior = current.entries[key];
    current.entries[key] = redact({
      key,
      system,
      action,
      idempotency_key: idempotencyKey,
      target,
      confirmed: Boolean(confirmed),
      result_id: resultId,
      url,
      decision_id: decisionId,
      authorised_by: authorisedBy,
      error: error ? String(error).slice(0, 500) : null,
      at: now.toISOString(),
      attempts: (prior?.attempts ?? 0) + 1,
    });
    return current;
  }, { system, entries: {} });
  return db.entries[key];
}

export function listWrites(system = null) {
  const systems = system ? [system] : ['github', 'jira', 'google-docs', 'other'];
  const out = [];
  for (const s of systems) {
    const db = readJson(ledgerFile(s), null);
    if (db) out.push(...Object.values(db.entries));
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

const NON_PRODUCTION_HINTS = /localhost|127\.0\.0\.1|\.local\b|staging|stage\b|dev\b|test\b|sandbox|preview/;

/**
 * Classify a host for the `non-production-only` gate.
 *
 * Returns `environment_class` in exactly the vocabulary `check()` compares against --
 * 'production' | 'non-production' | 'unknown' -- because a value the gate cannot recognise
 * is the same as no classification at all, only harder to debug.
 *
 * Only an explicit declaration from the repository profile yields 'non-production'. A URL
 * that merely looks like staging yields 'unknown', which the gate denies. That is
 * policy.json's own rule: these markers are heuristics for warning, not for permission.
 * `looks_non_production` carries the hint so a denial can tell the user which declaration
 * would unblock them.
 */
export function classifyEnvironment(nameOrUrl, declared = null) {
  const target = String(nameOrUrl ?? '');
  const s = target.toLowerCase();
  const looksNonProduction = NON_PRODUCTION_HINTS.test(s);
  const productionMarkers = POLICY.environment_rules.production_markers.filter((m) => s.includes(m));

  if (declared === 'non-production' || declared === 'production') {
    return {
      environment_class: declared,
      target,
      basis: 'declared',
      looks_non_production: looksNonProduction,
      production_markers: productionMarkers,
      reason: `Declared "${declared}" in the repository profile. A declaration always beats a heuristic.`,
    };
  }

  return {
    environment_class: POLICY.environment_rules.default_environment_classification,
    target,
    basis: 'undeclared',
    looks_non_production: looksNonProduction,
    production_markers: productionMarkers,
    reason: looksNonProduction
      ? `Looks non-production, but nothing declared it. ${POLICY.environment_rules.why} Declare it as "non-production" in the repository profile to unblock non-production-only actions.`
      : `Nothing declared this environment${productionMarkers.length ? ` and it carries production marker(s): ${productionMarkers.join(', ')}` : ''}. ${POLICY.environment_rules.why}`,
    treated_as: POLICY.environment_rules.unknown_is_treated_as,
  };
}
