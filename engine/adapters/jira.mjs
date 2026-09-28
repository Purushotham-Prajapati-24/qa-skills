/**
 * JiraAdapter.
 *
 * Implements integrations/jira/adapter.md against Jira Cloud REST v3, and delegates to the
 * agent when the capability resolves to the Atlassian MCP server instead.
 *
 * Zero dependencies: HTTP goes through Node's built-in fetch. `restExec` returns the same
 * shape as `shellExec` (stdout / stderr / exit_code), so every gate in base.mjs -- the
 * ledger, error classification, delegation tickets -- applies to Jira unchanged. A request
 * is written as an argv (`['jira-rest', METHOD, path, body?]`) for the same reason: the
 * planned command in a dry run and the ledger read the same way for every system.
 */
import { sha256String } from '../core/fsjson.mjs';
import * as state from '../state-engine/index.mjs';
import * as defects from '../defect-engine/index.mjs';
import { performRead, performWrite, completeWrite, classifyProviderError, OUTCOME } from './base.mjs';

export const SYSTEM = 'jira';
const ENV = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'];

/* ------------------------------------------------------------ transport */

/**
 * Perform one Jira REST call. Never throws, like shellExec: an HTTP error is data.
 * Credentials come from the environment only and never appear in `argv`, stdout or stderr.
 */
export async function restExec(argv, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  const [, method = 'GET', urlPath = '/', body] = argv;
  const started = Date.now();
  const printable = ['jira-rest', method, urlPath].join(' ');
  const missing = ENV.filter((v) => !env[v]);
  if (missing.length) {
    return { argv: printable, stdout: '', stderr: `401 not configured: missing ${missing.join(', ')}`, exit_code: 1, duration_ms: 0 };
  }
  const base = env.JIRA_BASE_URL.replace(/\/+$/, '');
  const auth = Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}${urlPath}`, {
      method,
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body } : {}),
      signal: controller.signal,
    });
    const text = await res.text();
    return {
      argv: printable,
      stdout: text,
      stderr: res.ok ? '' : `HTTP ${res.status} ${res.statusText}${res.headers?.get?.('retry-after') ? ` retry-after ${res.headers.get('retry-after')}` : ''}`,
      exit_code: res.ok ? 0 : 1,
      http_status: res.status,
      duration_ms: Date.now() - started,
    };
  } catch (err) {
    const timedOut = err?.name === 'AbortError';
    return { argv: printable, stdout: '', stderr: timedOut ? 'timeout' : String(err?.cause?.code ?? err?.message ?? err), exit_code: 1, timed_out: timedOut, duration_ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ ADF */

/**
 * Atlassian Document Format -> readable text. Keeps list, heading and code structure,
 * because a test plan built from "{"type":"doc","content":[..." is worse than none.
 */
export function adfToText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  const kids = (n) => (n.content ?? []).map((c) => adfToText(c)).join('');
  switch (node.type) {
    case 'doc': return (node.content ?? []).map((c) => adfToText(c)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    case 'text': return node.text ?? '';
    case 'hardBreak': return '\n';
    case 'paragraph': return `${kids(node)}\n`;
    case 'heading': return `${'#'.repeat(node.attrs?.level ?? 2)} ${kids(node)}\n`;
    case 'bulletList': return (node.content ?? []).map((li) => `- ${adfToText(li).trim()}`).join('\n') + '\n';
    case 'orderedList': return (node.content ?? []).map((li, i) => `${i + 1}. ${adfToText(li).trim()}`).join('\n') + '\n';
    case 'listItem': return kids(node);
    case 'codeBlock': return `\`\`\`\n${kids(node)}\n\`\`\`\n`;
    case 'blockquote': return kids(node).split('\n').map((l) => (l ? `> ${l}` : l)).join('\n');
    case 'mention': return node.attrs?.text ?? '@someone';
    case 'emoji': return node.attrs?.text ?? node.attrs?.shortName ?? '';
    case 'inlineCard': case 'blockCard': return node.attrs?.url ?? '';
    case 'rule': return '---\n';
    default: return kids(node);
  }
}

/** Plain text -> ADF: blank lines separate paragraphs, single newlines become hard breaks. */
export function textToAdf(text) {
  const paragraphs = String(text ?? '').split(/\n\s*\n/).filter((p) => p.trim());
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map((p) => ({
      type: 'paragraph',
      content: p.split('\n').flatMap((line, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : [])]),
    })),
  };
}

/**
 * Acceptance criteria are either a custom field (whose ID differs per instance) or a
 * heading inside the description. Only the heading form can be found without asking.
 */
export function acceptanceCriteriaFromText(text) {
  const lines = String(text ?? '').split('\n');
  const start = lines.findIndex((l) => /^#+\s*acceptance criteria\b/i.test(l.trim()) || /^acceptance criteria:?$/i.test(l.trim()));
  if (start < 0) return [];
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (/^#+\s/.test(l.trim())) break;
    const m = l.match(/^\s*(?:[-*]|\d+\.)\s+(.+)/);
    if (m) out.push(m[1].trim());
  }
  return out;
}

/* -------------------------------------------------------------- parsers */

function json(raw) {
  try { return JSON.parse(String(raw?.stdout ?? '')); } catch { return null; }
}

/** A created issue returns { id, key, self }. No key, no confirmation. */
export function parseIssueResult(raw) {
  const j = json(raw);
  if (!j?.key || !/^[A-Z][A-Z0-9_]+-\d+$/.test(j.key)) return { confirmed: false, result_id: null, url: null };
  return { confirmed: true, result_id: j.key, url: j.self ?? null };
}

/** A created comment returns { id, self, ... } -- the issue key comes from the request. */
export function parseCommentResult(raw, key) {
  const j = json(raw);
  const issueKey = key ?? /\/issue\/([A-Z][A-Z0-9_]+-\d+)\//.exec(j?.self ?? '')?.[1];
  if (!j?.id || !issueKey) return { confirmed: false, result_id: null, url: null };
  return { confirmed: true, result_id: `${issueKey}-comment-${j.id}`, url: j.self ?? null };
}

/** A transition returns 204 with an empty body, so success is the status, verified by read-back. */
export function parseTransitionResult(raw, key) {
  return raw?.exit_code === 0 && key ? { confirmed: true, result_id: `${key}-transition`, url: null } : { confirmed: false, result_id: null, url: null };
}

/** Dispatch by content, for finishing a delegated write. */
export function parseJiraResult(raw) {
  const j = json(raw);
  if (j?.key) return parseIssueResult(raw);
  return parseCommentResult(raw);
}

const COMMENT_RESULT = /^([A-Z][A-Z0-9_]+-\d+)-comment-(\d+)$/;

/* ------------------------------------------------------------- adapter */

const TICKET_FIELDS = ['summary', 'description', 'status', 'issuetype', 'priority', 'labels', 'components', 'issuelinks'];

function ticketView(issue) {
  const f = issue?.fields ?? {};
  const description = adfToText(f.description);
  return {
    key: issue.key,
    summary: f.summary ?? null,
    status: f.status?.name ?? null,
    type: f.issuetype?.name ?? null,
    priority: f.priority?.name ?? null,
    labels: f.labels ?? [],
    components: (f.components ?? []).map((c) => c.name),
    description,
    acceptance_criteria: acceptanceCriteriaFromText(description),
    links: (f.issuelinks ?? []).map((l) => ({ type: l.type?.name, key: l.outwardIssue?.key ?? l.inwardIssue?.key })).filter((l) => l.key),
    epistemic_note: 'Ticket content is a claim by a person (reported-by-user), not a test result.',
  };
}

export function createJiraAdapter({ exec = restExec } = {}) {
  return {
    system: SYSTEM,
    capabilities: ['jira.search', 'jira.read_ticket', 'jira.comment', 'jira.create_issue', 'jira.transition'],

    readTicket: ({ key } = {}) => performRead({
      verb: 'jira.read_ticket', system: SYSTEM, exec,
      summary: `Jira ${key}`,
      build: () => ['jira-rest', 'GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${TICKET_FIELDS.join(',')}`],
      parse: (r) => ticketView(JSON.parse(r.stdout)),
    }),

    search: ({ jql, limit = 20 } = {}) => performRead({
      verb: 'jira.search', system: SYSTEM, exec,
      summary: `Jira search: ${jql}`,
      build: () => ['jira-rest', 'GET', `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${limit}&fields=${TICKET_FIELDS.join(',')}`],
      parse: (r) => (JSON.parse(r.stdout).issues ?? []).map(ticketView),
    }),

    createIssueFromFinding: async ({ findingId, project, issueType = 'Bug', authorisation = {}, decisionId = null, dryRun = false } = {}) => {
      const finding = state.get('findings', findingId);
      if (!finding) return { ok: false, status: OUTCOME.FAILED, reason: `No such finding: ${findingId}` };
      if (!project) return { ok: false, status: OUTCOME.NEEDS_USER_INPUT, reason: 'Which Jira project key? The agent never guesses one.' };
      const promo = defects.assessPromotion(findingId, {
        system: SYSTEM,
        userAuthorised: Boolean(authorisation.userAuthorised),
        authorisationQuote: authorisation.authorisationQuote ?? '',
      });
      if (!promo.may_file) {
        return {
          ok: false,
          status: promo.blockers.some((b) => /[Dd]uplicate|[Aa]lready written/.test(b)) ? OUTCOME.SKIPPED : OUTCOME.NEEDS_USER_INPUT,
          gate: 'promotion', finding_id: findingId, blockers: promo.blockers, warnings: promo.warnings,
        };
      }
      return performWrite({
        verb: 'jira.create_issue', action: 'jira.create_issue', system: SYSTEM,
        idempotencyKey: finding.fingerprint,
        target: project,
        authorisation, decisionId, dryRun, exec,
        render: () => ({ ...defects.renderIssue(findingId), warnings: promo.warnings }),
        build: (_r, content) => ['jira-rest', 'POST', '/rest/api/3/issue', JSON.stringify({
          fields: {
            project: { key: project },
            issuetype: { name: issueType },
            summary: content.title.slice(0, 254),
            description: textToAdf(content.body),
            labels: (content.labels ?? []).map((l) => l.replace(/\s+/g, '-')),
          },
        })],
        parseResult: parseIssueResult,
      });
    },

    comment: ({ key, body, idempotencyKey, authorisation = {}, decisionId = null, dryRun = false } = {}) => performWrite({
      verb: 'jira.comment', action: 'jira.comment', system: SYSTEM,
      idempotencyKey: idempotencyKey ?? `${key}:${sha256String(body ?? '')}`,
      target: key,
      authorisation, decisionId, dryRun, exec,
      render: () => ({ body }),
      build: (_r, content) => ['jira-rest', 'POST', `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, JSON.stringify({ body: textToAdf(content.body) })],
      parseResult: (raw) => parseCommentResult(raw, key),
    }),

    /** Prohibited by default (policy.json): moving a ticket asserts work is done, a human call. */
    transition: ({ key, transitionId, authorisation = {}, decisionId = null, dryRun = false } = {}) => performWrite({
      verb: 'jira.transition', action: 'jira.transition', system: SYSTEM,
      idempotencyKey: `${key}:transition:${transitionId}`,
      target: key,
      authorisation, decisionId, dryRun, exec,
      render: () => ({ transitionId }),
      build: (_r, content) => ['jira-rest', 'POST', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, JSON.stringify({ transition: { id: String(content.transitionId) } })],
      parseResult: (raw) => parseTransitionResult(raw, key),
    }),

    complete: ({ ticket, response }) => completeWrite({
      ticket, response, parseResult: parseJiraResult,
      verifyRead: (claim) => verifyJiraWrite(claim, { exec }),
    }),
  };
}

/**
 * Independently confirm a delegated write by reading it back over REST -- never through
 * the agent's MCP tools that performed it. Needs the REST credentials; without them the
 * write is unverifiable, which is reported as such rather than as confirmed.
 */
export async function verifyJiraWrite({ resultId, contentSha256 } = {}, { exec = restExec } = {}) {
  const id = String(resultId ?? '');
  const comment = COMMENT_RESULT.exec(id);
  const key = comment?.[1] ?? (/^[A-Z][A-Z0-9_]+-\d+$/.test(id) ? id : null);
  if (!key) {
    return { exists: false, verification: 'unavailable', failure_kind: 'no-identifier', retry_safe: false, reason: `Could not read a Jira key from "${id}". This does not refute the write.` };
  }
  const urlPath = comment
    ? `/rest/api/3/issue/${key}/comment/${comment[2]}`
    : `/rest/api/3/issue/${key}?fields=summary`;
  const raw = await exec(['jira-rest', 'GET', urlPath]);
  if (raw.exit_code !== 0) {
    const failure = classifyProviderError(raw) ?? { kind: 'unknown' };
    const refuted = failure.kind === 'not-found';
    return {
      exists: false,
      verification: refuted ? 'refuted' : 'unavailable',
      failure_kind: failure.kind,
      retry_safe: refuted,
      reason: refuted
        ? `Independent read-back refuted the claim: GET ${urlPath} reports it does not exist. Safe to retry.`
        : `Independent read-back could not run (GET ${urlPath}: ${failure.kind}). This does not refute the write; confirm by hand before retrying.`,
    };
  }
  const j = json(raw);
  if (comment && contentSha256 && sha256String(adfToText(j?.body)) !== contentSha256) {
    return { exists: true, verification: 'refuted', failure_kind: 'body-mismatch', retry_safe: false, reason: `Comment ${comment[2]} exists on ${key}, but its body does not match what was sent.`, data: j };
  }
  return { exists: true, verification: 'confirmed', retry_safe: false, reason: `Confirmed by GET ${urlPath}.`, data: j };
}

/** What the credentials can actually do, before any write is attempted. */
export async function preflight({ exec = restExec } = {}) {
  const raw = await exec(['jira-rest', 'GET', '/rest/api/3/myself']);
  const j = json(raw);
  return {
    authenticated: raw.exit_code === 0 && Boolean(j?.accountId),
    account: j?.emailAddress ?? j?.displayName ?? null,
    error: raw.exit_code === 0 ? null : (classifyProviderError(raw)?.kind ?? 'unknown'),
    note: raw.exit_code === 0
      ? 'Authenticated. Project-level permissions are checked per write; a 403 on create means this account cannot file in that project.'
      : `Not usable: ${raw.stderr}. Set ${ENV.join(', ')}, or declare the Atlassian connector with caps declare.`,
  };
}
