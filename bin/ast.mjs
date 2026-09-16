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
import { setStateRoot, stateRoot } from '../engine/core/paths.mjs';
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
import { compute as computeMetrics } from '../engine/evaluation-engine/metrics.mjs';
import { validate as validateSchema } from '../engine/schema/validate.mjs';
import { classify } from '../engine/failure-classifier/index.mjs';

/* ---------------------------------------------------------------- arg parse */

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inlineValue] = a.slice(2).split('=');
      if (inlineValue !== undefined) flags[k] = inlineValue;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) { flags[k] = argv[i + 1]; i += 1; }
      else flags[k] = true;
    } else positional.push(a);
  }
  return { positional, flags };
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
function payload(flags) {
  if (flags.json) return aliasKeys(JSON.parse(flags.json));
  if (flags.input) {
    if (flags.input === '-') return aliasKeys(JSON.parse(fs.readFileSync(0, 'utf8')));
    return aliasKeys(readJson(flags.input));
  }
  return {};
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
  'profile save': { help: 'Persist a repository profile: profile save --input profile.json', run: ({ flags }) => state.saveProfile(payload(flags)) },
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
      const body = payload(flags);
      const assessment = risk.score({ profile: flags.profile ?? body.profile ?? 'balanced', factors: body.factors ?? body });
      return flags.explain ? { ...assessment, explanation: risk.explain(assessment) } : assessment;
    },
  },
  'risk profiles': { help: 'List risk weighting profiles and factors.', run: () => ({ profiles: risk.profiles(), factors: risk.factorCatalog() }) },

  /* ---- applicability ---- */
  'applicability eval': {
    help: 'Compute the test applicability matrix: applicability eval --input input.json',
    run: ({ flags }) => applicability.evaluate(payload(flags)),
  },
  'applicability catalog': { help: 'Show the category catalog and known signals.', run: () => applicability.catalog() },

  /* ---- browser method ---- */
  'browser decide': {
    help: 'Choose a browser testing method: browser decide --input factors.json',
    run: ({ flags }) => browser.decide(payload(flags)),
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

  /* ---- metrics + evaluation ---- */
  'metrics': { help: 'Compute evaluation metrics for the current state.', run: ({ flags }) => computeMetrics(payload(flags)) },
  'eval run': { help: 'Run the benchmark suite: eval run [--only case-03]', run: ({ flags }) => evaluation.run({ only: flags.only ?? null }) },
  'eval cases': { help: 'List benchmark cases.', run: () => evaluation.loadCases().map((c) => ({ id: c.id, title: c.title, file: c.file })) },

  /* ---- integrity ---- */
  'validate': {
    help: 'Validate every stored record against its schema and check referential integrity.',
    run: () => validateAll(),
  },
};

/* ------------------------------------------------------------ ast validate */

const COLLECTION_SCHEMAS = {
  decisions: 'decision',
  executions: 'execution',
  evidence: 'evidence',
  findings: 'finding',
  uncertainties: 'uncertainty',
  reports: 'report',
};

function validateAll() {
  const problems = [];
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

  for (const [collection, schemaName] of Object.entries(COLLECTION_SCHEMAS)) {
    const items = state.list(collection);
    counts[collection] = items.length;
    for (const item of items) {
      const r = validateSchema(item, schemaName);
      const id = item.decision_id ?? item.execution_id ?? item.evidence_id ?? item.finding_id ?? item.id ?? item.report_id;
      if (known[collection]) known[collection].add(id);
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

  return { valid: problems.length === 0, counts, problems, state_root: stateRoot() };
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

function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);

  if (flags.state) setStateRoot(flags.state);
  if (positional.length === 0 || positional[0] === 'help' || flags.help) { printHelp(); return; }

  const twoWord = positional.slice(0, 2).join(' ');
  const key = COMMANDS[twoWord] ? twoWord : COMMANDS[positional[0]] ? positional[0] : null;

  if (!key) {
    fail(`unknown command "${positional.slice(0, 2).join(' ')}"`, 'run `node bin/ast.mjs help` for the command list');
    return;
  }

  try {
    const result = COMMANDS[key].run({ positional, flags });
    if (COMMANDS[key].raw?.(flags)) process.stdout.write(`${result}\n`);
    else out(result, flags);
    if (result && result.valid === false) process.exitCode = 1;
  } catch (err) {
    fail(err.message, err.hint);
    if (flags.debug) process.stderr.write(`${err.stack}\n`);
  }
}

main();
