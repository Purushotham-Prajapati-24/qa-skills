#!/usr/bin/env node
/**
 * `ast` -- the Autonomous Software Testing command line.
 *
 * This is the deterministic half of the system. Skills supply judgement; this
 * binary does the bookkeeping that judgement must not be trusted with:
 * allocating IDs, validating shapes, refusing unevidenced claims, suppressing
 * duplicate external writes, and computing metrics.
 *
 * Every subcommand prints JSON on stdout (unless --format md) so a skill can
 * pipe the result straight back into its reasoning.
 *
 * Usage:  node bin/ast.mjs <group> <command> [options]
 *         node bin/ast.mjs help
 */
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setStateRoot, stateRoot, dir } from '../engine/core/paths.mjs';
import { readJson } from '../engine/core/fsjson.mjs';
import { SYSTEM_VERSION } from '../engine/core/version.mjs';
import * as state from '../engine/state-engine/index.mjs';
import * as risk from '../engine/risk-engine/index.mjs';
import * as applicability from '../engine/applicability-engine/index.mjs';
import * as browser from '../engine/browser-decision/index.mjs';
import * as decisions from '../engine/decision-engine/index.mjs';
import * as evidence from '../engine/evidence-engine/index.mjs';
import * as execution from '../engine/execution-engine/index.mjs';
import * as defects from '../engine/defect-engine/index.mjs';
import * as uncertainty from '../engine/uncertainty-register/index.mjs';
import * as caps from '../engine/capability-registry/index.mjs';
import * as auth from '../engine/authorization/index.mjs';
import * as flakiness from '../engine/flakiness/index.mjs';
import * as trace from '../engine/traceability/index.mjs';
import * as reporting from '../engine/reporting-engine/index.mjs';
import * as evaluation from '../engine/evaluation-engine/index.mjs';
import * as processCompleteness from '../engine/evaluation-engine/process-completeness.mjs';
import * as adapters from '../engine/adapters/index.mjs';
import { compute as computeMetrics } from '../engine/evaluation-engine/metrics.mjs';
import { validate as validateSchema } from '../engine/schema/validate.mjs';
import { classify } from '../engine/failure-classifier/index.mjs';

/* ---------------------------------------------------------------- arg parse */

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  // Everything after a bare "--" is a literal command line for a subcommand to spawn (see
  // "evidence capture"), never flags of this CLI's own. Without this terminator, a token
  // like "--input" inside the spawned command would be consumed as ast's own --input flag
  // instead of being handed to the child process verbatim.
  let rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') { rest = argv.slice(i + 1); break; }
    if (a.startsWith('--')) {
      const [k, inlineValue] = a.slice(2).split('=');
      if (inlineValue !== undefined) flags[k] = inlineValue;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) { flags[k] = argv[i + 1]; i += 1; }
      else flags[k] = true;
    } else positional.push(a);
  }
  return { positional, flags, rest };
}

/**
 * JSON files are naturally written in snake_case; the engine functions take
 * camelCase options. Rather than making every caller remember which is which,
 * top-level snake_case keys get a camelCase alias. Nested values are untouched,
 * because those are data (risk factor names, signal names) and must stay exact.
 */
function aliasKeys(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = { ...obj };
  for (const [k, v] of Object.entries(obj)) {
    if (!k.includes('_')) continue;
    const camel = k.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
    if (!(camel in out)) out[camel] = v;
  }
  return out;
}

/** Read a JSON payload from --input <file|-> or --json '<literal>'. */
function payload(flags, shouldAlias = true) {
  if (flags.json) {
    const data = JSON.parse(flags.json);
    return shouldAlias ? aliasKeys(data) : data;
  }
  if (flags.input) {
    const data = flags.input === '-' ? JSON.parse(fs.readFileSync(0, 'utf8')) : readJson(flags.input);
    return shouldAlias ? aliasKeys(data) : data;
  }
  return {};
}

/**
 * Merge the last capability probe into a command's `capabilities` map so that
 * `browser decide` / `applicability eval` see the environment's real, resolved
 * state instead of an agent-supplied guess. Nothing tells an agent to run
 * `caps probe` before these commands, so the binary does it for them; an
 * explicit value in the input still wins, since that's how a skill overrides
 * a specific verb (e.g. to test a blocked path) without re-probing everything.
 */
function withResolvedCapabilities(explicit = {}) {
  const resolved = caps.resolveAll().available;
  return { ...resolved, ...explicit };
}

function out(value, flags = {}) {
  if (flags.format === 'text' && typeof value === 'string') process.stdout.write(`${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message, hint = null) {
  process.stderr.write(`ast: ${message}\n`);
  if (hint) process.stderr.write(`hint: ${hint}\n`);
  process.exitCode = 1;
}

/* ----------------------------------------------------------------- commands */

const COMMANDS = {
  /* ---- setup ---- */
  'init': {
    help: 'Create the state directory scaffolding.',
    run: () => ({ state_root: state.init(), system_version: SYSTEM_VERSION }),
  },
  'version': { help: 'Print version info.', run: () => ({ system: SYSTEM_VERSION, node: process.version, state_root: stateRoot() }) },

  /* ---- capabilities ---- */
  'caps probe': {
    help: 'Detect which capability providers are actually available.',
    run: () => caps.probe(),
  },
  'caps declare': {
    help: 'Declare an MCP/builtin provider availability: caps declare <provider> <true|false> [--note "..."]',
    run: ({ positional, flags }) => caps.declare(positional[2], positional[3] === 'true', flags.note ?? ''),
  },
  'caps resolve': {
    help: 'Resolve one capability verb to a provider: caps resolve github.create_issue',
    run: ({ positional }) => caps.resolve(positional[2]),
  },
  'caps list': { help: 'List all capability verbs and their current resolution.', run: () => caps.resolveAll() },

  /* ---- session ---- */
  'session start': {
    help: 'Start a session: session start --request "..." [--trigger ...] [--input goals.json]',
    run: ({ flags }) => {
      const body = payload(flags);
      return state.startSession({
        request: flags.request ?? body.request,
        trigger: flags.trigger ?? body.trigger ?? 'user-request',
        git: body.git ?? null,
        goals: body.goals ?? [],
      });
    },
  },
  'session show': { help: 'Print the current session state.', run: () => state.requireSession() },
  'session phase': {
    help: 'Move to a phase: session phase execute --note "..."',
    run: ({ positional, flags }) => state.setPhase(positional[2], flags.note),
  },
  'session next': {
    help: 'Set the next action: session next "Run the API suite"',
    run: ({ positional }) => state.setNextAction(positional.slice(2).join(' ')),
  },
  'session interrupt': {
    help: 'Record an interruption: session interrupt --kind user --note "..."',
    run: ({ flags }) => state.recordInterruption({ kind: flags.kind ?? 'user', note: flags.note }),
  },
  'session resume': {
    help: 'Run the recovery protocol and print what to do next.',
    run: () => state.recover(),
  },

  /* ---- repository profile ---- */
  'profile save': { help: 'Persist a repository profile: profile save --input profile.json', run: ({ flags }) => state.saveProfile(payload(flags, false)) },
  'profile show': { help: 'Print the stored repository profile.', run: () => state.loadProfile() ?? { error: 'No profile stored. Run repository-intelligence first.' } },
  'profile signals': {
    help: 'Derive applicability signals from the stored profile.',
    run: () => {
      const p = state.loadProfile();
      if (!p) throw new Error('No repository profile stored.');
      return { signals: applicability.signalsFromProfile(p) };
    },
  },

  /* ---- risk ---- */
  'risk score': {
    help: 'Score risk: risk score --input factors.json [--profile balanced]',
    run: ({ flags }) => {
      // shouldAlias=false: `factors` is a map of FACTOR NAMES to {value, basis} objects, not
      // an options bag. Aliasing would twin every factor name that contains an underscore
      // (which is most of them) with a camelCase duplicate, and a flat body -- one with no
      // top-level "factors" key at all -- would then present every one of those twins to the
      // engine as an "unknown factor", naming identifiers the caller never wrote. There is
      // also deliberately no `?? body` fallback: a flat body is a shape error, not an
      // alternate shape, and must fail as one rather than being silently reinterpreted.
      const body = payload(flags, false);
      if (!body.factors || typeof body.factors !== 'object' || Array.isArray(body.factors)) {
        throw new Error(
          'risk score requires a "factors" object: { "factors": { "<name>": { "value": 0-1, "basis": "..." } } }. '
          + 'See: node bin/ast.mjs risk profiles, or skills/risk-analysis/SKILL.md for a worked example.',
        );
      }
      const assessment = risk.score({ profile: flags.profile ?? body.profile ?? 'balanced', factors: body.factors });
      return flags.explain ? { ...assessment, explanation: risk.explain(assessment) } : assessment;
    },
  },
  'risk profiles': { help: 'List risk weighting profiles and factors.', run: () => ({ profiles: risk.profiles(), factors: risk.factorCatalog() }) },

  /* ---- applicability ---- */
  'applicability eval': {
    help: 'Compute the test applicability matrix: applicability eval --input input.json',
    run: ({ flags }) => {
      const body = payload(flags);
      return applicability.evaluate({ ...body, capabilities: withResolvedCapabilities(body.capabilities) });
    },
  },
  'applicability catalog': { help: 'Show the category catalog and known signals.', run: () => applicability.catalog() },

  /* ---- browser method ---- */
  'browser decide': {
    help: 'Choose a browser testing method: browser decide --input factors.json',
    run: ({ flags }) => {
      const body = payload(flags);
      return browser.decide({ ...body, capabilities: withResolvedCapabilities(body.capabilities) });
    },
  },
  'browser should-automate': {
    help: 'Decide whether an explored scenario should become a committed test.',
    run: ({ flags }) => browser.shouldAutomate(payload(flags)),
  },
  'browser matrix': { help: 'Print the browser decision matrix.', run: () => browser.matrix() },

  /* ---- decisions ---- */
  'decide': {
    help: 'Record a decision: decide --input decision.json',
    run: ({ flags }) => decisions.record(payload(flags)),
  },
  'decision assess': {
    help: 'Record a decision outcome: decision assess DEC-00001 --verdict correct --note "..."',
    run: ({ positional, flags }) => decisions.assess(positional[2], { verdict: flags.verdict, note: flags.note ?? '' }),
  },
  'decision next': {
    help: 'Ask what to do after a result: decision next --input {"status":"FAILED","failureClass":"..."}',
    run: ({ flags }) => decisions.nextAction(payload(flags)),
  },
  'decision list': { help: 'List decision records.', run: () => state.list('decisions') },

  /* ---- evidence ---- */
  'evidence add': { help: 'Register evidence: evidence add --input evidence.json', run: ({ flags }) => evidence.add(payload(flags)) },
  'evidence capture': {
    help: 'Run a command and register its real output as evidence: '
      + 'evidence capture --exec EXEC-2026-00001 [--summary "..."] [--cwd dir] [--timeout ms] -- <command> [args...]',
    run: ({ flags, rest }) => {
      if (!rest.length) {
        throw new Error(
          'evidence capture requires a command after "--", e.g.: '
          + 'ast evidence capture --exec EXEC-2026-00001 -- npm run lint',
        );
      }
      if (!flags.exec) {
        throw new Error('evidence capture requires --exec <EXECUTION_ID> naming the execution this evidence supports.');
      }
      if (!state.get('executions', flags.exec)) {
        throw new Error(`No such execution: ${flags.exec}. Open one first with "exec start" -- never capture evidence for an execution that does not exist.`);
      }

      const cwd = flags.cwd ?? process.cwd();
      const timeout = Number(flags.timeout ?? 600_000);
      const argvString = rest.join(' ');
      const isWin = process.platform === 'win32';
      // shell: true on Windows matches the existing precedent in capability-registry/
      // index.mjs -- it is what lets "npm" resolve to "npm.cmd". But per Node's own
      // documentation, shell:true on Windows makes QUOTING the caller's job: cmd.exe
      // splits on whitespace before spawnSync ever sees the string, so an unquoted
      // absolute path containing a space (e.g. `process.execPath` itself, wherever Node
      // is installed under "Program Files") silently mis-parses into "the command is
      // 'C:\Program'", fails, and reports a real-looking exit code that never came from
      // the intended program at all. Quote every element that contains whitespace;
      // leave everything else untouched so the common case (bare names, unspaced paths)
      // is not needlessly rewritten.
      const winShellQuote = (a) => (/\s/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
      const spawnCommand = isWin ? winShellQuote(rest[0]) : rest[0];
      const spawnArgs = isWin ? rest.slice(1).map(winShellQuote) : rest.slice(1);
      const started = Date.now();
      const r = spawnSync(spawnCommand, spawnArgs, {
        encoding: 'utf8',
        cwd,
        timeout,
        maxBuffer: 32 * 1024 * 1024,
        shell: isWin,
      });
      const durationMs = Date.now() - started;

      // The capture MECHANISM failing (command not found, timed out, killed by signal
      // before producing an exit code) is not the same thing as the CAPTURED command
      // failing (a real, meaningful non-zero exit, e.g. `npm audit` finding
      // vulnerabilities). Only the former is this command's own problem to report --
      // whether the latter is good or bad news is the calling skill's judgement to make
      // from the recorded exit code, never this CLI's to decide.
      const mechanismFailed = Boolean(r.error) || r.status === null;
      if (mechanismFailed) {
        const detail = r.error
          ? r.error.message
          : `terminated by signal ${r.signal ?? 'unknown'} (likely the ${timeout}ms timeout)`;
        const ev = evidence.captureOutput({
          argv: argvString,
          cwd,
          durationMs,
          stdout: r.stdout ?? '',
          stderr: `${r.stderr ?? ''}\n[ast evidence capture] did not complete: ${detail}`.trim(),
          summary: flags.summary ?? `Command did not complete: ${detail}`,
          executionId: flags.exec,
        });
        process.exitCode = 1;
        return { ...ev, ok: false, run_error: detail };
      }

      return evidence.captureOutput({
        argv: argvString,
        cwd,
        exitCode: r.status,
        durationMs,
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
        summary: flags.summary,
        executionId: flags.exec,
      });
    },
  },
  'evidence verify': {
    help: 'Check whether a status claim is supported: evidence verify --input {"status":"PASSED","evidenceIds":[...]}',
    run: ({ flags }) => evidence.verifyClaim(payload(flags)),
  },
  'evidence list': { help: 'List evidence items.', run: () => state.list('evidence') },

  /* ---- execution ---- */
  'exec start': { help: 'Open an execution record: exec start --input exec.json', run: ({ flags }) => execution.start(payload(flags)) },
  'exec finish': {
    help: 'Finalise an execution: exec finish EXEC-2026-00001 --input result.json',
    run: ({ positional, flags }) => execution.finish(positional[2], payload(flags)),
  },
  'exec not-run': {
    help: 'Document work that was NOT executed: exec not-run --input {"goal":"...","status":"BLOCKED","reason":"..."}',
    run: ({ flags }) => execution.recordNonExecution(payload(flags)),
  },
  'exec list': { help: 'List executions.', run: () => state.list('executions') },
  'exec summary': { help: 'Aggregate execution statuses.', run: () => execution.summarise() },

  /* ---- failure ---- */
  'failure classify': {
    help: 'Classify a failure: failure classify --input {"signals":["http-500"]}',
    run: ({ flags }) => classify(payload(flags)),
  },

  /* ---- findings ---- */
  'finding add': { help: 'Record a finding: finding add --input finding.json', run: ({ flags }) => defects.create(payload(flags)) },
  'finding promote': {
    help: 'Check whether a finding may be filed: finding promote FIND-00001 [--authorised] [--quote "..."] [--assignee name]',
    run: ({ positional, flags }) => defects.assessPromotion(positional[2], {
      system: flags.system ?? 'github',
      userAuthorised: Boolean(flags.authorised),
      authorisationQuote: flags.quote ?? '',
      assignee: flags.assignee ?? null,
    }),
  },
  'finding render': { help: 'Render the issue title/body/labels for a finding.', run: ({ positional }) => defects.renderIssue(positional[2]) },
  'finding list': { help: 'List findings, most severe first.', run: () => defects.bySeverity() },

  /* ---- uncertainty ---- */
  'uncertainty raise': { help: 'Raise an uncertainty: uncertainty raise --input u.json', run: ({ flags }) => uncertainty.raise(payload(flags)) },
  'uncertainty resolve': {
    help: 'Resolve one: uncertainty resolve U-00001 --answer "..."',
    run: ({ positional, flags }) => uncertainty.resolve(positional[2], { answer: flags.answer, resolvedBy: flags.by ?? 'user' }),
  },
  'uncertainty partition': {
    help: 'Split planned scenarios into runnable vs blocked: uncertainty partition --input scenarios.json',
    run: ({ flags }) => uncertainty.partitionWork(payload(flags).scenarios ?? payload(flags)),
  },
  'uncertainty list': { help: 'List open uncertainties.', run: () => uncertainty.open() },

  /* ---- authorization + external writes ---- */
  'auth check': {
    help: 'Authorization gate: auth check --input {"action":"github.create_issue","userAuthorised":true}',
    run: ({ flags }) => auth.check(payload(flags)),
  },
  'auth policy': { help: 'Print the authorization policy.', run: () => auth.policy() },
  'auth classify-env': {
    help: 'Classify a host for the non-production-only gate: auth classify-env https://staging.example.com [--declared non-production]',
    run: ({ positional, flags }) => auth.classifyEnvironment(positional[2] ?? '', flags.declared ?? null),
  },
  'write check': {
    help: 'Duplicate-suppression check before an external write.',
    run: ({ flags }) => auth.alreadyWritten(payload(flags)),
  },
  'write record': {
    help: 'Record the confirmed/unconfirmed outcome of an external write.',
    run: ({ flags }) => auth.recordWrite(payload(flags)),
  },
  'write list': { help: 'List every external write attempted.', run: () => auth.listWrites() },

  /* ---- analysis ---- */
  'flaky analyse': { help: 'Analyse per-test pass/fail history.', run: () => flakiness.analyse() },
  'trace query': {
    help: 'Traceability query: trace query what-remains-untested | what-validates REQ-1 | why-this-method EXEC-...',
    run: ({ positional }) => trace.query(positional[2], positional[3] ?? null),
  },
  'trace graph': { help: 'Dump the traceability graph.', run: () => trace.build() },
  'trace queries': { help: 'List available traceability queries.', run: () => trace.queries() },

  /* ---- reporting ---- */
  'report generate': {
    help: 'Generate the report: report generate [--input context.json] [--format md]',
    run: ({ flags }) => {
      const body = payload(flags);
      const result = reporting.generate(body);
      return flags.format === 'md' ? result.markdown : { report_id: result.report.report_id, markdown_path: result.markdown_path, integrity: result.report.integrity };
    },
    raw: (flags) => flags.format === 'md',
  },
  'report show': { help: 'Print a stored report: report show REPORT-2026-00001', run: ({ positional }) => state.get('reports', positional[2]) },
  'report verify': {
    help: 'Prove a rendered report was actually produced by this system, not hand-written or '
      + 'edited after the fact: report verify <path/to/report.md | REPORT-2026-00001>',
    run: ({ positional }) => {
      const target = positional[2];
      if (!target) {
        throw new Error('report verify requires a path to a rendered .md file, or a bare REPORT-ID (e.g. REPORT-2026-00002) to check the stored copy under state/reports/.');
      }
      let text;
      if (/^REPORT-\d{4}-\d{5,}$/.test(target)) {
        const storedPath = path.join(dir('reports'), `${target}.md`);
        if (!fs.existsSync(storedPath)) throw new Error(`No stored report file at ${storedPath}.`);
        text = fs.readFileSync(storedPath, 'utf8');
      } else {
        if (!fs.existsSync(target)) throw new Error(`No such file: ${target}`);
        text = fs.readFileSync(target, 'utf8');
      }
      const result = reporting.verify(text);
      if (!result.rendered) process.exitCode = 1;
      return result;
    },
  },

  /* ---- metrics + evaluation ---- */
  'metrics': { help: 'Compute evaluation metrics for the current state.', run: ({ flags }) => computeMetrics(payload(flags)) },
  'eval run': { help: 'Run the benchmark suite: eval run [--only case-03]', run: ({ flags }) => evaluation.run({ only: flags.only ?? null }) },
  'eval cases': { help: 'List benchmark cases.', run: () => evaluation.loadCases().map((c) => ({ id: c.id, title: c.title, file: c.file })) },

  /* ---- adapters: the enforced external-write path ---- */
  'github preflight': {
    help: 'Report what the GitHub token can actually do (auth is not the same as scope).',
    run: () => adapters.preflight('github'),
  },
  'github read': {
    help: 'Read from GitHub: github read repo|pr|files|issues|runs --input args.json',
    run: ({ positional, flags }) => {
      const gh = adapters.getAdapter('github');
      const args = payload(flags);
      const ops = { repo: gh.readRepo, pr: gh.readPr, files: gh.listChangedFiles, issues: gh.searchIssues, runs: gh.readRuns };
      const op = ops[positional[2]];
      if (!op) throw new Error(`Unknown read "${positional[2]}". One of: ${Object.keys(ops).join(', ')}`);
      return op(args);
    },
  },
  'github file-issue': {
    help: 'File a finding as a GitHub issue, through every gate: github file-issue FIND-00001 --repo owner/name [--authorised --quote "..."] [--dry-run]',
    run: ({ positional, flags }) => adapters.getAdapter('github').createIssueFromFinding({
      findingId: positional[2],
      repo: flags.repo,
      decisionId: flags.decision ?? null,
      dryRun: Boolean(flags['dry-run']),
      authorisation: { userAuthorised: Boolean(flags.authorised), authorisationQuote: flags.quote ?? '' },
    }),
  },
  'github comment': {
    help: 'Comment on an issue: github comment --repo owner/name --number 412 --input body.json [--authorised]',
    run: ({ flags }) => adapters.getAdapter('github').comment({
      repo: flags.repo, number: flags.number, body: payload(flags).body,
      idempotencyKey: flags.key, decisionId: flags.decision ?? null,
      dryRun: Boolean(flags['dry-run']),
      authorisation: { userAuthorised: Boolean(flags.authorised), authorisationQuote: flags.quote ?? '' },
    }),
  },
  'github assign': {
    help: 'Assign an issue to a USER-NAMED account: github assign --repo owner/name --number 412 --assignee octocat --authorised',
    run: ({ flags }) => adapters.getAdapter('github').assign({
      repo: flags.repo, number: flags.number, assignee: flags.assignee ?? null,
      decisionId: flags.decision ?? null, dryRun: Boolean(flags['dry-run']),
      authorisation: { userAuthorised: Boolean(flags.authorised), authorisationQuote: flags.quote ?? '' },
    }),
  },
  'adapter complete': {
    help: 'Finish a delegated (MCP) write: adapter complete --ticket WT-... --json \'<provider response>\'',
    run: ({ flags }) => {
      const ticket = adapters.readTicket(flags.ticket);
      if (!ticket) throw new Error(`No such ticket: ${flags.ticket}. Run \`ast adapter pending\` to list open ones.`);
      return adapters.getAdapter(ticket.system).complete({
        ticket: flags.ticket,
        response: flags.json ? JSON.parse(flags.json) : payload(flags),
      });
    },
  },
  'adapter pending': {
    help: 'List delegated writes that were authorised but never completed.',
    run: () => adapters.pending(),
  },
  'adapter systems': {
    help: 'List systems with an executable adapter.',
    run: () => ({ implemented: adapters.SYSTEMS, contracts_only: ['jira', 'google-docs', 'google-drive'] }),
  },

  /* ---- integrity ---- */
  'validate': {
    help: 'Validate schemas + referential integrity, plus process-completeness warnings. '
      + 'Add --final (the orchestrator\'s "before you tell the user you are done" gate) to '
      + 'promote blocking process gaps (no decisions; blocked work never raised as an '
      + 'uncertainty) into failures.',
    run: ({ flags }) => validateAll({ final: Boolean(flags.final) }),
  },
};

/* ------------------------------------------------------------ ast validate */

/**
 * Collection -> { schema, the field holding THAT record's own ID }.
 *
 * The ID field must be pinned per collection. A fallback chain like
 * `item.decision_id ?? item.execution_id ?? ...` looks harmless and is not: an execution
 * carries a `decision_id`, and evidence and findings carry an `execution_id`, so the chain
 * keys every record by a foreign ID and then reports every real reference as dangling.
 */
const COLLECTION_SCHEMAS = {
  decisions: { schema: 'decision', idField: 'decision_id' },
  executions: { schema: 'execution', idField: 'execution_id' },
  evidence: { schema: 'evidence', idField: 'evidence_id' },
  findings: { schema: 'finding', idField: 'finding_id' },
  uncertainties: { schema: 'uncertainty', idField: 'id' },
  reports: { schema: 'report', idField: 'report_id' },
};

function validateAll({ final = false } = {}) {
  const problems = [];
  const warnings = [];
  const counts = {};

  const session = state.loadSession();
  if (session) {
    const r = validateSchema(session, 'session-state');
    counts.session = 1;
    if (!r.valid) problems.push(...r.errors.map((e) => `session-state ${e.path}: ${e.message}`));
  }

  const profile = state.loadProfile();
  if (profile) {
    const r = validateSchema(profile, 'repository-profile');
    counts.profile = 1;
    if (!r.valid) problems.push(...r.errors.map((e) => `repository-profile ${e.path}: ${e.message}`));
  }

  const known = { evidence: new Set(), decisions: new Set(), findings: new Set(), uncertainties: new Set(), executions: new Set() };

  for (const [collection, { schema: schemaName, idField }] of Object.entries(COLLECTION_SCHEMAS)) {
    const items = state.list(collection);
    counts[collection] = items.length;
    for (const item of items) {
      const id = item[idField];
      if (!id) {
        problems.push(`${collection}: a record is missing its "${idField}"`);
        continue;
      }
      if (known[collection]) known[collection].add(id);
      const r = validateSchema(item, schemaName);
      if (!r.valid) problems.push(...r.errors.map((e) => `${collection}/${id} ${e.path}: ${e.message}`));
    }
  }

  /* referential integrity */
  const dangling = (ids, pool, where) =>
    (ids ?? []).filter((i) => !pool.has(i)).forEach((i) => problems.push(`${where} references missing ${i}`));

  for (const e of state.list('executions')) {
    dangling(e.evidence, known.evidence, `executions/${e.execution_id}.evidence`);
    dangling(e.findings, known.findings, `executions/${e.execution_id}.findings`);
    dangling(e.uncertainties, known.uncertainties, `executions/${e.execution_id}.uncertainties`);
    if (e.decision_id && !known.decisions.has(e.decision_id)) problems.push(`executions/${e.execution_id}.decision_id references missing ${e.decision_id}`);
    if (!e.finished_at && e.status !== 'PARTIAL') problems.push(`executions/${e.execution_id} has no finished_at but status ${e.status}`);
  }
  for (const f of state.list('findings')) {
    dangling(f.evidence, known.evidence, `findings/${f.finding_id}.evidence`);
    if (f.duplicate_of && !known.findings.has(f.duplicate_of)) problems.push(`findings/${f.finding_id}.duplicate_of references missing ${f.duplicate_of}`);
  }
  for (const d of state.list('decisions')) {
    dangling(d.evidence_refs, known.evidence, `decisions/${d.decision_id}.evidence_refs`);
  }
  if (session) {
    dangling(session.decisions, known.decisions, 'session.decisions');
    dangling(session.findings, known.findings, 'session.findings');
    dangling(session.uncertainties, known.uncertainties, 'session.uncertainties');
    if (session.open_executions?.length) {
      problems.push(`session has ${session.open_executions.length} open execution(s): ${session.open_executions.join(', ')}. Run "ast session resume" to finalise them as INTERRUPTED.`);
    }
  }

  // Schema and referential-integrity problems above are always fatal. Process-completeness
  // findings are advisory by default -- correct at any point mid-session -- and a
  // "blocking"-severity one is promoted into `problems` only under --final, the
  // orchestrator's own finishing gate. See process-completeness.mjs for why the split
  // exists and why "no git provenance" never promotes today.
  for (const f of processCompleteness.check()) {
    if (f.severity === 'blocking' && final) problems.push(`process: ${f.message}`);
    else warnings.push(`process (${f.severity}): ${f.message}`);
  }

  return { valid: problems.length === 0, counts, problems, warnings, state_root: stateRoot() };
}

/* --------------------------------------------------------------------- main */

function printHelp() {
  const groups = new Map();
  for (const [name, def] of Object.entries(COMMANDS)) {
    const group = name.includes(' ') ? name.split(' ')[0] : '(top level)';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push([name, def.help]);
  }
  const lines = [
    `ast — Autonomous Software Testing CLI v${SYSTEM_VERSION}`,
    '',
    'Usage: node bin/ast.mjs <group> <command> [--input file.json | --json \'{...}\'] [--state <dir>]',
    '',
    'Skills call this binary for everything that must be deterministic:',
    'ID allocation, schema validation, evidence gating, duplicate suppression, metrics.',
    '',
  ];
  for (const [group, cmds] of groups) {
    lines.push(`${group}:`);
    for (const [name, help] of cmds) lines.push(`  ${name.padEnd(28)} ${help}`);
    lines.push('');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  const { positional, flags, rest } = parseArgs(argv);

  if (flags.state) setStateRoot(flags.state);
  if (positional.length === 0 || positional[0] === 'help' || flags.help) { printHelp(); return; }

  const twoWord = positional.slice(0, 2).join(' ');
  const key = COMMANDS[twoWord] ? twoWord : COMMANDS[positional[0]] ? positional[0] : null;

  if (!key) {
    fail(`unknown command "${positional.slice(0, 2).join(' ')}"`, 'run `node bin/ast.mjs help` for the command list');
    return;
  }

  try {
    // Adapter commands talk to providers and are async. Awaiting unconditionally keeps
    // the synchronous commands working unchanged -- and without it a promise serialises
    // as "{}", which looks exactly like a successful empty result.
    const result = await COMMANDS[key].run({ positional, flags, rest });
    if (COMMANDS[key].raw?.(flags)) process.stdout.write(`${result}\n`);
    else out(result, flags);

    // A refused or blocked adapter call is not a crash, but it is not success either.
    // Exit non-zero so a caller scripting this cannot mistake one for the other.
    if (result && (result.valid === false || result.ok === false)) process.exitCode = 1;
  } catch (err) {
    fail(err.message, err.hint);
    if (flags.debug) process.stderr.write(`${err.stack}\n`);
  }
}

await main();
