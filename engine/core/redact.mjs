/**
 * Secret redaction.
 *
 * Testing logs are the single most likely place for a token to leak, because
 * they capture commands, environment and network traffic verbatim. Everything
 * written to state/ passes through here first.
 *
 * This is defence in depth, not a guarantee: it cannot recognise a secret that
 * looks like ordinary text. The authorization policy still forbids deliberately
 * capturing credential material as evidence.
 */

/**
 * Field names whose VALUES are masked.
 *
 * Two lessons are baked into this pattern, both learned the hard way:
 *
 *  - `pass` must not match on its own. An earlier version used `pass(word|phrase)?`,
 *    which made the suffix optional -- so it matched `passed` and redacted test pass
 *    counts into "[REDACTED]", corrupting every execution record with totals.
 *  - `token` must match as a whole segment (`access_token`, `token`) rather than as a
 *    prefix, or it swallows `tokens_used` and similar metric fields.
 *
 * Over-redaction is not a safe failure. It destroys the records this module exists to
 * protect, and it does so silently.
 */
const KEY_HINTS =
  /(password|passphrase|passwd|secret|(^|[-_])token([-_]|$)|credential|api[-_]?key|apikey|access[-_]?key|private[-_]?key|bearer|cookie|authorization|authorisation|connection[-_]?string|dsn)/i;

/**
 * Field names this system uses for its own record-keeping. They win over
 * KEY_HINTS, because several of them (session_id, authorised_by) look like
 * secrets to a pattern matcher and are not. Without this list the redactor
 * corrupts the very records it is protecting.
 */
const SAFE_KEYS = new Set([
  'session_id', 'decision_id', 'execution_id', 'evidence_id', 'finding_id',
  'uncertainty_id', 'report_id', 'plan_id', 'test_case_id', 'tool_use_id',
  'authorised_by', 'authorized_by', 'authorization', 'auth_required',
  'idempotency_key', 'key', 'result_id', 'fingerprint', 'sha256',
]);

/** Value-shaped patterns, applied to free text. Order matters: longest first. */
const VALUE_PATTERNS = [
  [/-----BEGIN[^-]+PRIVATE KEY-----[\s\S]*?-----END[^-]+PRIVATE KEY-----/g, '[REDACTED:private-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED:github-token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED:github-pat]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED:api-key]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED:slack-token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-access-key-id]'],
  [/\bya29\.[A-Za-z0-9._-]{20,}\b/g, '[REDACTED:google-oauth-token]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED:jwt]'],
  [/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/g, '[REDACTED:url-credentials]@'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [REDACTED]'],
  [/\bBasic\s+[A-Za-z0-9+/=]{16,}/gi, 'Basic [REDACTED]'],
];

export function redactText(input) {
  if (typeof input !== 'string') return input;
  let out = input;
  for (const [re, replacement] of VALUE_PATTERNS) out = out.replace(re, replacement);
  // `KEY=value` / `KEY: value` / `"KEY": "value"` where KEY looks sensitive.
  out = out.replace(
    /(["']?[A-Za-z0-9_.-]*(?:pass(?:word)?|secret|token|api[-_]?key|apikey|credential|bearer|private[-_]?key|client[-_]?secret|access[-_]?key)[A-Za-z0-9_.-]*["']?\s*[:=]\s*)(["']?)([^\s"',;)]{4,})\2/gi,
    (_m, head, quote) => `${head}${quote}[REDACTED]${quote}`,
  );
  return out;
}

/**
 * Deep-redact an arbitrary JSON-serialisable value.
 *
 * `stack` tracks the current DFS path, not every node visited. That distinction matters:
 * records routinely hold the SAME array in two places (an execution's `evidence` and its
 * `failure_classification.evidence_refs` are often one array). A visited-set treats the
 * second reference as a cycle and replaces it with "[circular]", producing a record that
 * fails its own schema. Only a genuine ancestor is a cycle.
 */
export function redact(value, stack = new Set()) {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (stack.has(value)) return '[circular]';

  stack.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => redact(v, stack));

    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (!SAFE_KEYS.has(k) && KEY_HINTS.test(k) && (typeof v === 'string' || typeof v === 'number')) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redact(v, stack);
      }
    }
    return out;
  } finally {
    stack.delete(value);
  }
}

/** True when the value still contains something that looks like a live secret. */
export function containsSecret(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return redactText(text) !== text;
}
