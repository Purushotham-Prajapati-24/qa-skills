/**
 * GitHubAdapter.
 *
 * Implements the contract in integrations/github/adapter.md against the `gh` CLI, and
 * delegates to the agent when the capability resolves to the GitHub MCP server instead.
 *
 * The parsers are the interesting part. `gh issue create` prints the new issue's URL on
 * stdout; if no URL comes back, the write is NOT confirmed regardless of exit code. A `gh`
 * command can exit 0 having printed a warning and created nothing, so exit status is not
 * evidence of anything.
 */
import path from 'node:path';
import fs from 'node:fs';
import { dir } from '../core/paths.mjs';
import { ensureDir, writeText, sha256String } from '../core/fsjson.mjs';
import * as state from '../state-engine/index.mjs';
import * as defects from '../defect-engine/index.mjs';
import { performRead, performWrite, completeWrite, shellExec, OUTCOME } from './base.mjs';

export const SYSTEM = 'github';

/* --------------------------------------------------------------- parsers */

// The anchor is captured as part of the URL on purpose: a comment is identified by
// `#issuecomment-N`, and dropping it would leave parseCommentResult with only the issue
// URL to work from -- which does not identify the comment at all.
const ISSUE_URL = /(https:\/\/[^\s]*github[^\s]*\/[^/\s]+\/[^/\s]+\/(?:issues|pull)\/(\d+)(?:#issuecomment-\d+)?)/;
const COMMENT_ANCHOR = /#issuecomment-(\d+)/;

/**
 * Pull an identifier out of whatever the provider said.
 *
 * Handles both shapes: the `gh` CLI prints a bare URL, while the MCP server returns JSON
 * with `html_url` and `number`. Anything else yields confirmed:false, which is the correct
 * answer rather than an optimistic guess.
 */
export function parseIssueResult(raw) {
  const text = String(raw?.stdout ?? '').trim();
  if (!text) return { confirmed: false, result_id: null, url: null };

  // MCP / API shape first -- it is unambiguous when present.
  try {
    const json = JSON.parse(text);
    const url = json.html_url ?? json.url ?? null;
    const number = json.number ?? (url ? ISSUE_URL.exec(url)?.[2] : null);
    if (number) {
      return { confirmed: true, result_id: `#${number}`, url };
    }
  } catch {
    // Not JSON. Fall through to URL scraping, which is the CLI's shape.
  }

  const m = ISSUE_URL.exec(text);
  if (!m) return { confirmed: false, result_id: null, url: null };
  return { confirmed: true, result_id: `#${m[2]}`, url: m[1] };
}

export function parseCommentResult(raw) {
  const base = parseIssueResult(raw);
  if (!base.confirmed) return base;
  const anchor = COMMENT_ANCHOR.exec(base.url ?? '');
  return anchor
    ? { ...base, result_id: `${base.result_id}-comment-${anchor[1]}` }
    // A comment URL without an anchor is the issue URL, which does not identify the
    // comment. Report it unconfirmed rather than pretending the issue URL will do.
    : { confirmed: false, result_id: null, url: base.url };
}

/* ----------------------------------------------------------- body storage */

/**
 * Persist the exact body that was sent. It is genuinely evidence: "what did the agent
 * actually put in that issue?" is otherwise unanswerable after the fact.
 */
function writeBody(content) {
  const d = ensureDir(path.join(dir('ledger'), 'bodies'));
  const name = `${sha256String(content).replace('sha256:', '').slice(0, 16)}.md`;
  const file = path.join(d, name);
  if (!fs.existsSync(file)) writeText(file, content);
  return file;
}

/* ------------------------------------------------------------------ reads */

const JSON_FIELDS = {
  repo: 'name,owner,defaultBranchRef,visibility,isPrivate,description',
  pr: 'number,title,body,state,files,additions,deletions,baseRefName,headRefName,commits,author,mergeable',
  issues: 'number,title,state,labels,createdAt,updatedAt,author',
  runs: 'databaseId,name,status,conclusion,headBranch,event,createdAt',
};

export function createGitHubAdapter({ exec = shellExec } = {}) {
  const repoArgs = (repo) => (repo ? ['--repo', repo] : []);

  return {
    system: SYSTEM,

    capabilities: [
      'github.read_repo', 'github.read_pr', 'github.list_changed_files',
      'github.search_issues', 'ci.read_runs',
      'github.create_issue', 'github.update_issue', 'github.comment', 'github.assign_issue',
    ],

    /* ------------------------------------------------------------- reads */

    readRepo: ({ repo } = {}) => performRead({
      verb: 'github.read_repo', system: SYSTEM, exec,
      summary: `Repository metadata for ${repo ?? 'the current repository'}`,
      build: () => ['gh', 'repo', 'view', ...(repo ? [repo] : []), '--json', JSON_FIELDS.repo],
      parse: (r) => JSON.parse(r.stdout),
    }),

    readPr: ({ repo, number } = {}) => performRead({
      verb: 'github.read_pr', system: SYSTEM, exec,
      summary: `Pull request #${number} in ${repo ?? 'the current repository'}`,
      build: () => ['gh', 'pr', 'view', String(number), ...repoArgs(repo), '--json', JSON_FIELDS.pr],
      parse: (r) => JSON.parse(r.stdout),
    }),

    listChangedFiles: ({ repo, number } = {}) => performRead({
      verb: 'github.list_changed_files', system: SYSTEM, exec,
      summary: `Files changed in #${number}`,
      build: () => ['gh', 'pr', 'diff', String(number), ...repoArgs(repo), '--name-only'],
      parse: (r) => r.stdout.split(/\r?\n/).filter(Boolean),
    }),

    searchIssues: ({ repo, query, state: issueState = 'all', limit = 30 } = {}) => performRead({
      verb: 'github.search_issues', system: SYSTEM, exec,
      summary: `Issue search: ${query}`,
      build: () => ['gh', 'issue', 'list', ...repoArgs(repo), '--search', query, '--state', issueState, '--limit', String(limit), '--json', JSON_FIELDS.issues],
      parse: (r) => JSON.parse(r.stdout),
    }),

    readRuns: ({ repo, branch, limit = 10 } = {}) => performRead({
      verb: 'ci.read_runs', system: SYSTEM, exec,
      summary: `CI runs${branch ? ` on ${branch}` : ''}`,
      build: () => ['gh', 'run', 'list', ...repoArgs(repo), ...(branch ? ['--branch', branch] : []), '--limit', String(limit), '--json', JSON_FIELDS.runs],
      parse: (r) => JSON.parse(r.stdout),
    }),

    /* ------------------------------------------------------------ writes */

    /**
     * File a finding as an issue.
     *
     * Deliberately takes a findingId rather than a title and body: the idempotency key
     * MUST be the finding's fingerprint, and accepting free text would let a caller
     * supply a different key and defeat duplicate suppression.
     */
    createIssueFromFinding: async ({ findingId, repo, authorisation = {}, decisionId = null, dryRun = false } = {}) => {
      const finding = state.get('findings', findingId);
      if (!finding) {
        return { ok: false, status: OUTCOME.FAILED, reason: `No such finding: ${findingId}` };
      }

      // Re-run the promotion assessment here rather than trusting the caller to have done
      // it. Duplicates, observations and low confidence all need to be caught even when
      // performWrite's own gates would let the call through.
      const promo = defects.assessPromotion(findingId, {
        system: SYSTEM,
        userAuthorised: Boolean(authorisation.userAuthorised),
        authorisationQuote: authorisation.authorisationQuote ?? '',
      });
      if (!promo.may_file) {
        return {
          ok: false,
          status: promo.blockers.some((b) => /[Dd]uplicate|[Aa]lready written/.test(b)) ? OUTCOME.SKIPPED : OUTCOME.NEEDS_USER_INPUT,
          gate: 'promotion',
          finding_id: findingId,
          blockers: promo.blockers,
          warnings: promo.warnings,
        };
      }

      return performWrite({
        verb: 'github.create_issue', action: 'github.create_issue', system: SYSTEM,
        idempotencyKey: finding.fingerprint,
        target: repo ?? 'the current repository',
        authorisation, decisionId, dryRun, exec,
        render: () => {
          const issue = defects.renderIssue(findingId);
          return { ...issue, warnings: promo.warnings };
        },
        build: (_resolved, content) => [
          'gh', 'issue', 'create', ...repoArgs(repo),
          '--title', content.title,
          '--body-file', writeBody(content.body),
          ...content.labels.flatMap((l) => ['--label', l]),
        ],
        parseResult: parseIssueResult,
      });
    },

    comment: ({ repo, number, body, idempotencyKey, authorisation = {}, decisionId = null, dryRun = false } = {}) =>
      performWrite({
        verb: 'github.comment', action: 'github.comment', system: SYSTEM,
        idempotencyKey: idempotencyKey ?? `${repo}#${number}:${sha256String(body ?? '')}`,
        target: `${repo ?? 'current repo'}#${number}`,
        authorisation, decisionId, dryRun, exec,
        render: () => ({ body }),
        build: (_r, content) => ['gh', 'issue', 'comment', String(number), ...repoArgs(repo), '--body-file', writeBody(content.body)],
        parseResult: parseCommentResult,
      }),

    updateIssue: ({ repo, number, body, idempotencyKey, authorisation = {}, decisionId = null, dryRun = false } = {}) =>
      performWrite({
        verb: 'github.update_issue', action: 'github.update_issue', system: SYSTEM,
        idempotencyKey: idempotencyKey ?? `${repo}#${number}:${sha256String(body ?? '')}`,
        target: `${repo ?? 'current repo'}#${number}`,
        authorisation, decisionId, dryRun, exec,
        render: () => ({ body }),
        build: (_r, content) => ['gh', 'issue', 'edit', String(number), ...repoArgs(repo), '--body-file', writeBody(content.body)],
        parseResult: parseIssueResult,
      }),

    /**
     * Assignment. The policy level is `explicit-named-assignee`, so performWrite refuses
     * this without a user-named account -- the agent can never choose the person.
     */
    assign: ({ repo, number, assignee, authorisation = {}, decisionId = null, dryRun = false } = {}) =>
      performWrite({
        verb: 'github.assign_issue', action: 'github.assign_issue', system: SYSTEM,
        idempotencyKey: `${repo}#${number}:assign:${assignee ?? 'none'}`,
        target: `${repo ?? 'current repo'}#${number}`,
        authorisation: { ...authorisation, assignee },
        decisionId, dryRun, exec,
        render: () => ({ assignee }),
        build: (_r, content) => ['gh', 'issue', 'edit', String(number), ...repoArgs(repo), '--add-assignee', content.assignee],
        parseResult: parseIssueResult,
      }),

    /* -------------------------------------------------------- delegation */

    complete: ({ ticket, response }) => completeWrite({
      ticket, response, parseResult: parseGitHubResult,
      verifyRead: (claim) => verifyIssueRead(claim, { exec }),
    }),
  };
}

/**
 * Parser used when finishing a delegated write.
 *
 * A comment is the only GitHub object whose URL needs a different reading, and its URL
 * carries the `#issuecomment-` anchor that identifies it -- so the response itself says
 * which parser applies. Dispatching on content rather than on the ticket's verb keeps
 * `completeWrite` from needing to know anything GitHub-specific.
 */
export function parseGitHubResult(raw) {
  return COMMENT_ANCHOR.test(String(raw?.stdout ?? '')) ? parseCommentResult(raw) : parseIssueResult(raw);
}

/**
 * Independently confirm a delegated write actually happened, by reading the claimed issue
 * back with `gh` -- run directly by this process, never through the agent's MCP tools that
 * performed the write. This is deliberately NOT routed through `caps.resolve()` /
 * `performRead`: if the agent already declared its MCP provider available, capability
 * resolution would prefer it and hand the "verification" straight back to the same agent
 * being verified, which proves nothing. Shelling out to `gh` here is the actual
 * independence the write protocol promises.
 *
 * Only confirms the ISSUE exists and its number matches. A comment's `result_id` embeds
 * the issue number as its leading segment (`#4242-comment-987654321`), so a fabricated
 * comment against a real issue is not caught by this -- catching that would need
 * `gh api repos/.../issues/comments/<id>`, out of scope for the fabrication this closes.
 */
export async function verifyIssueRead({ resultId, target } = {}, { exec = shellExec } = {}) {
  const number = /^#?(\d+)/.exec(String(resultId ?? ''))?.[1];
  if (!number) {
    return { exists: false, reason: `Could not extract an issue number from "${resultId}"; nothing to verify.` };
  }

  const repoArgs = target && target !== 'the current repository' ? ['--repo', target] : [];
  const raw = await exec(['gh', 'issue', 'view', number, ...repoArgs, '--json', 'number,url,state']);
  if (raw.exit_code !== 0) {
    return {
      exists: false,
      reason: `Independent read-back via \`gh issue view ${number}\` failed (exit ${raw.exit_code}). ` +
        'Either the issue does not exist, or `gh` cannot reach it from here. A number the agent ' +
        'reported that this process cannot independently confirm is not confirmed.',
    };
  }

  try {
    const parsed = JSON.parse(raw.stdout);
    return Number(parsed.number) === Number(number)
      ? { exists: true, reason: `Confirmed by \`gh issue view\`: issue #${parsed.number} exists.`, data: parsed }
      : { exists: false, reason: `\`gh issue view ${number}\` returned issue #${parsed.number}, which does not match.` };
  } catch (err) {
    return { exists: false, reason: `Read-back output could not be parsed: ${err.message}` };
  }
}

/**
 * Report what the `gh` token can actually do.
 *
 * `gh auth status` succeeding is not the same as having the scopes for a write. Reads can
 * work while writes fail, and a failed write is recorded unconfirmed rather than retried
 * -- so it is worth knowing before starting.
 */
export async function preflight({ exec = shellExec } = {}) {
  const raw = await exec(['gh', 'auth', 'status']);
  const text = `${raw.stdout}\n${raw.stderr}`;
  const scopes = /Token scopes:\s*(.+)/i.exec(text)?.[1]?.split(/[,\s]+/).map((s) => s.replace(/['"]/g, '')).filter(Boolean) ?? [];
  const account = /Logged in to \S+ account (\S+)/i.exec(text)?.[1] ?? null;

  const needed = { 'github.create_issue': 'repo', 'github.update_issue': 'repo', 'github.comment': 'repo', 'github.assign_issue': 'repo', 'ci.read_runs': 'repo' };
  const missing = Object.entries(needed)
    .filter(([, scope]) => !scopes.includes(scope))
    .map(([verb, scope]) => ({ verb, needs: scope }));

  return {
    authenticated: raw.exit_code === 0,
    account,
    scopes,
    writes_available: missing.length === 0,
    missing_scopes: missing,
    note: missing.length
      ? 'Reads may still work. A write attempted without the scope will be recorded as unconfirmed, not retried.'
      : 'Token carries the scopes needed for the write verbs this adapter implements.',
  };
}
