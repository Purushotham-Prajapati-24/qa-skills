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
import { spawnSync, spawn } from 'node:child_process';

// Measured in characters (JavaScript string length), not bytes: output is decoded as UTF-8 first.
const CAPTURE_HALF = 4 * 1024 * 1024;

/** Keep the first and last CAPTURE_HALF characters of a decoded stream; drop and count the middle. */
function cappedSink() {
  let head = '';
  let tail = '';
  let dropped = 0;
  return {
    push(s) {
      if (head.length < CAPTURE_HALF) {
        const take = Math.min(s.length, CAPTURE_HALF - head.length);
        head += s.slice(0, take);
        if (take === s.length) return;
        tail += s.slice(take);
      } else {
        tail += s;
      }
      if (tail.length > CAPTURE_HALF) {
        dropped += tail.length - CAPTURE_HALF;
        tail = tail.slice(tail.length - CAPTURE_HALF);
      }
    },
    text() {
      return dropped ? `${head}\n[... ${dropped} characters of output truncated by ast evidence capture ...]\n${tail}` : head + tail;
    },
  };
}

/**
 * Run a command for `evidence capture`. Streams output (no buffer ceiling to overflow) and, on
 * timeout, kills the whole process tree: with a shell on Windows, killing only the shell left
 * the real process (a dev server started by mistake, a hung test) running, orphaned.
 */
function runCaptured(command, args, { cwd, timeout, shell }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd, shell, windowsHide: true, detached: process.platform !== 'win32' });
    } catch (error) {
      resolve({ status: null, signal: null, error, stdout: '', stderr: '' });
      return;
    }
    const out = cappedSink();
    const err = cappedSink();
    let timedOut = false;
    let settled = false;
    // The stream decoder carries an incomplete multibyte sequence over to the next chunk;
    // decoding each chunk on its own turned split characters into U+FFFD in the evidence.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c) => out.push(c));
    child.stderr?.on('data', (c) => err.push(c));
    const killTree = () => {
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else process.kill(-child.pid, 'SIGKILL');
      } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    };
    const timer = setTimeout(() => { timedOut = true; killTree(); }, timeout);
    const finish = (status, signal, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: timedOut ? null : status,
        signal: timedOut ? 'SIGKILL' : signal,
        error: error ?? (timedOut ? new Error(`timed out after ${timeout}ms; process tree killed`) : null),
        stdout: out.text(),
        stderr: err.text(),
      });
    };
    child.on('error', (e) => finish(null, null, e));
    child.on('close', (code, signal) => finish(code, signal));
  });
}
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
import { nextId } from '../engine/core/ids.mjs';
import * as integrity from '../engine/evaluation-engine/integrity.mjs';
import { classify, unknownSignals, signalsByClass as failureSignalsByClass } from '../engine/failure-classifier/index.mjs';

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
/**
 * The environment `browser decide` should assume: an explicit `environment` or
 * `environmentIsProduction` wins; else a `target` is looked up in the profile's
 * `environments`; else it stays unknown, which the engine treats as production.
 */
function environmentFor(body) {
  if (body.environment !== undefined || body.environmentIsProduction !== undefined || !body.target) return {};
  const declared = auth.declaredClassFromProfile(body.target, state.loadProfile());
  return declared ? { environment: declared.class } : {};
}

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
    help: 'Detect which capability providers are actually available. Prints a summary; --verbose prints every capability with its candidates.',
    // The full resolution was ~30 KB of JSON, most of it candidate lists an agent never
    // reads at this step. `caps resolve <verb>` gives the detail for one verb on demand.
    run: ({ flags }) => {
      const full = caps.probe();
      if (flags.verbose) return full;
      return {
        checked_at: full.checked_at,
        providers: Object.fromEntries(Object.entries(full.providers).map(([k, v]) => [k, v.available === null ? 'NOT DECLARED' : v.available])),
        available_capabilities: Object.entries(full.available).filter(([, v]) => v).map(([k]) => k),
        unavailable_capabilities: full.unavailable,
        next: 'Declare MCP/in-app providers you can see with `caps declare <provider> true|false`; `caps resolve <verb>` shows why a verb resolved as it did.',
      };
    },
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
    help: 'Start a session: session start --request "..." [--trigger ...] [--input goals.json]. '
      + 'See "session start --example" for a valid goals.json shape.',
    example: {
      request: 'Test the saved-card checkout change on branch feat/SHOP-412-saved-card',
      goals: [
        {
          goal: 'Confirm a saved card cannot be used to charge another user',
          success_criteria: [
            'API rejects a payment-method ID that does not belong to the session user',
            'No regression in the existing single-user checkout path',
          ],
        },
        'Baseline: the existing unit and integration suites still pass at head',
      ],
    },
    run: ({ flags }) => {
      const body = payload(flags);
      // Starting over an unfinished session is the costliest continuity mistake: after a
      // compaction an agent "starts testing" again, and every commitment, open run and owed
      // item of the real session drops out of view. Refuse it for a recent session with work
      // in progress; --new is the explicit, deliberate way to abandon it.
      const current = state.loadSession();
      if (current && !flags.new && Date.now() - new Date(current.updated_at).getTime() < 12 * 60 * 60 * 1000) {
        const open = (current.open_executions ?? []).length;
        const plan = state.loadPlan() ? processCompleteness.planProgress() : null;
        const owed = plan?.must_test_remaining ?? 0;
        if (open || owed) {
          throw new Error(`Session ${current.session_id} is unfinished (${open} open run(s), ${owed} committed scenario(s) not covered), `
            + `last updated ${current.updated_at}. To continue it: "session resume". To abandon it deliberately and start fresh: `
            + 'add --new (its open runs are finalised as INTERRUPTED and it is archived).');
        }
      }
      return state.startSession({
        request: flags.request ?? body.request,
        trigger: flags.trigger ?? body.trigger ?? 'user-request',
        // No "?? null" here: an explicit git object still wins, but the absent case must
        // stay `undefined` so startSession's own default (auto-detect from the working
        // directory) actually runs. Forcing null here was the reason auto-detection was
        // unreachable through the real CLI path even after it existed as a default.
        git: body.git,
        goals: body.goals ?? [],
      });
    },
  },
  'session show': { help: 'Print the current session state.', run: () => state.requireSession() },
  'session phase': {
    help: 'Move to a phase: session phase execute --note "..."',
    run: ({ positional, flags }) => {
      const out = state.setPhase(positional[2], flags.note);
      if (positional[2] !== 'discover' && !state.loadProfile()) {
        return { ...out, warning: 'No repository profile is stored. Every later decision (signals, applicability, environment classification) reads it; run `profile save` before relying on them.' };
      }
      return out;
    },
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
    help: 'Run the recovery protocol and print what is owed and what to do next. Open runs idle for 10+ minutes are '
      + 'finalised as INTERRUPTED; recent ones are left for a parallel explorer that may still own them. '
      + 'Add --interrupt-all when you know nothing else is running.',
    run: ({ flags }) => {
      const r = state.recover({ interruptAll: Boolean(flags['interrupt-all']) });
      if (!r.recoverable) return r;
      const queue = processCompleteness.outstanding();
      const plan = state.loadPlan() ? processCompleteness.planProgress() : null;
      return {
        ...r,
        recorded_next_action: r.next_action,
        next_action: queue.done
          ? (plan ? 'Nothing is owed. Run `validate --final`, then generate and verify the report.' : r.next_action)
          : `Continue the work queue (${queue.count} item(s) owed). Next: ${queue.items[0].what}${queue.items[0].next ? ` -> ${queue.items[0].next}` : ''}`,
        plan_progress: plan ? { plan_id: plan.plan_id, committed: plan.must_test, covered: plan.must_test_executed, remaining: plan.must_test_remaining } : null,
        owed: { count: queue.count, items: queue.items.slice(0, 10), more: Math.max(0, queue.count - 10) },
      };
    },
  },
  'session said': {
    help: 'Record the user\'s own words mid-session: session said --quote "you have 30 minutes". Needed only when the '
      + 'UserPromptSubmit hook is not installed (it records prompts itself). Stored as source "agent" and labelled so in the report. '
      + 'A user-owned hold counts only when its user_quote is found in the request or a recorded statement.',
    run: ({ flags }) => {
      const s = state.recordUserStatement(flags.quote, { source: 'agent' });
      return { recorded: s.user_statements.at(-1) };
    },
  },
  'session goal': {
    help: 'Record a goal outcome: session goal G-01 [--criterion 2] --status PASSED --evidence EV-2026-00004[,EV-...] [--exec EXEC-...] [--note "..."]. '
      + 'Goals start with placeholder statuses; the report shows unassessed ones as "not assessed". PASSED/FAILED/COMPLETED/PARTIAL go through the evidence gate like exec finish.',
    run: ({ positional, flags }) => {
      const goalId = positional[2];
      if (!goalId || !flags.status) throw new Error('Usage: session goal G-01 [--criterion N] --status <STATUS> [--evidence EV-...,EV-...]');
      const evidenceIds = flags.evidence ? String(flags.evidence).split(',').map((x) => x.trim()).filter(Boolean) : [];
      const gate = evidence.verifyClaim({ status: flags.status, evidenceIds, statement: flags.note ?? '' });
      const status = gate.permitted ? flags.status : gate.downgrade_to;
      const goal = state.assessGoal({
        goalId,
        criterion: flags.criterion ? Number(flags.criterion) : null,
        status,
        evidence: evidenceIds,
        executionId: flags.exec ?? null,
        note: flags.note ?? '',
      });
      return { goal, claimed: flags.status, recorded: status, downgraded: !gate.permitted, gate_reasons: gate.reasons };
    },
  },

  /* ---- repository profile ---- */
  'profile save': {
    help: 'Persist a repository profile: profile save --input profile.json. See "profile save --example" for a valid shape.',
    example: {
      profile_version: '1.1.0',
      generated_at: '2026-09-28T10:00:00.000Z',
      repository: { root: '.', name: 'shop', default_branch: 'main' },
      architecture: {
        frontend: { present: true, stack: ['React', 'Next.js'], paths: ['src/app'] },
        backend: { present: true, stack: ['Next.js route handlers'], paths: ['src/app/api'] },
      },
      technologies: [
        { name: 'Next.js', kind: 'framework', version: '16.2.6', evidence: ['package.json#dependencies.next'] },
        { name: 'node:test', kind: 'test-framework', evidence: ['package.json#scripts.test'] },
      ],
      apis: [{ kind: 'rest', route_count: 12, auth_required: true }],
      testing_frameworks: [{ name: 'node:test', levels: ['unit'], run_command: 'npm test', verified_runnable: false }],
      existing_coverage: { test_file_count: 16, measured: false },
      environments: [
        { name: 'production', url: 'https://shop.example.com', class: 'production', evidence: ['user: "shop.example.com is the live site"'] },
        { name: 'local', url: 'http://localhost:3000', class: 'non-production', evidence: ['package.json#scripts.dev'] },
      ],
      declared_signals: [{ signal: 'responsive', evidence: ['src/app/page.tsx uses md:/lg: breakpoint classes'] }],
      gaps: ['No coverage report; coverage is unmeasured'],
      provenance: { skill_version: '0.13.0', created_at: '2026-10-12T10:00:00.000Z', created_by: 'agent' },
    },
    run: ({ flags }) => {
      const profile = payload(flags, false);
      applicability.signalsFromProfile(profile);
      return state.saveProfile(profile);
    },
  },
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
    help: 'Score risk: risk score --input factors.json [--profile balanced]. '
      + 'See "risk score --example" for a valid factors.json shape, or `risk profiles` for the full factor catalog.',
    // Reused verbatim from skills/risk-analysis/SKILL.md's own worked example -- the exact
    // shape a field trial's agent found only after invoking this command blind, because
    // that skill had not been loaded. The contract belongs here, not only in a sibling
    // skill's prose.
    example: {
      profile: 'security-critical',
      factors: {
        business_criticality: { value: 1.0, basis: 'checkout is the only revenue path', epistemic_class: 'observed' },
        security_sensitivity: { value: 0.9, basis: 'diff modifies auth/session.ts middleware', epistemic_class: 'observed' },
        change_magnitude: { value: 0.6, basis: '312 changed lines across 7 files in a ~2k-line module', epistemic_class: 'observed' },
        coverage_deficit: { value: 0.8, basis: 'no test exercises the saved-card branch (grep across test/ found none)', epistemic_class: 'observed' },
        irreversibility: { value: 0.9, basis: 'captures a real payment; refunds are manual', epistemic_class: 'inferred' },
      },
    },
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
    help: 'Compute the test applicability matrix: applicability eval --input input.json. See "applicability eval --example"; signals come from `profile signals`.',
    example: {
      signals: ['ui', 'web-ui', 'http-api', 'auth', 'sessions', 'responsive'],
      coverage: { unit: 'partial', e2e: 'none' },
      unmetPrerequisites: ['no test credentials for the staging tenant'],
      budgetMinutes: 60,
    },
    run: ({ flags }) => {
      const body = payload(flags);
      const result = applicability.evaluate({ ...body, capabilities: withResolvedCapabilities(body.capabilities) });
      // Persist so the coverage floor in `validate --final` can check that every applicable
      // P0/P1 category was actually addressed. Opt out with --no-save for a dry run.
      if (!flags['no-save']) state.saveApplicability(result);
      return result;
    },
  },
  'applicability catalog': { help: 'Show the category catalog and known signals.', run: () => applicability.catalog() },

  /* ---- browser method ---- */
  'browser decide': {
    help: 'Choose a browser testing method: browser decide --input factors.json. '
      + 'See "browser decide --example" for a valid factors.json shape, or `browser matrix` for the full factor catalog.',
    // A flat body, not { factors: {...} } -- unlike risk score. See G-07's fix (the two
    // adjacent commands with opposite payload shapes and opposite failure modes): this
    // command discards anything outside a top-level "factors" key silently rather than
    // erroring, so this example exists precisely to show the shape it actually needs.
    // `environment` is in the example on purpose: when it was absent, an agent copying the
    // example against a production URL got exploration methods the production rule forbids.
    // "unknown" is what the engine assumes anyway (and treats as production).
    example: {
      factors: {
        ui_known: 0.2,
        exploratory_value: 0.8,
        repeatability: 0.85,
        business_criticality: 0.9,
        existing_automation: 0.3,
      },
      environment: 'unknown',
    },
    run: ({ flags }) => {
      const body = payload(flags);
      return browser.decide({ ...body, ...environmentFor(body), capabilities: withResolvedCapabilities(body.capabilities) });
    },
  },
  'browser should-automate': {
    help: 'Decide whether an explored scenario should become a committed test: browser should-automate --input factors.json. See "browser should-automate --example".',
    example: { factors: { repeatability: 0.9, business_criticality: 0.8, environment_stability: 0.8, expected_runtime_minutes: 2 } },
    run: ({ flags }) => browser.shouldAutomate(payload(flags)),
  },
  'browser matrix': { help: 'Print the browser decision matrix.', run: () => browser.matrix() },

  /* ---- decisions ---- */
  'decide': {
    help: 'Record a decision: decide --input decision.json. See "decide --example". Input names differ from the stored record (options -> candidate_options, selected -> selected_option).',
    example: {
      question: 'Which browser method for the checkout flow?',
      category: 'tool-selection',
      options: [
        { id: 'playwright-script', label: 'B: deterministic Playwright spec' },
        { id: 'hybrid', label: 'D: explore with the browser MCP, then script' },
      ],
      selected: 'hybrid',
      reason: ['browser decide selected hybrid: ui_known 0.2, repeatability 0.85', 'target is localhost, declared non-production in the profile'],
      confidence: 0.7,
      reversible: true,
    },
    run: ({ flags }) => decisions.record(payload(flags)),
  },
  'decision assess': {
    help: 'Record a decision outcome: decision assess DEC-00001 --verdict correct --note "..."',
    run: ({ positional, flags }) => decisions.assess(positional[2], { verdict: flags.verdict, note: flags.note ?? '' }),
  },
  'decision next': {
    help: 'Ask what to do after a result: decision next --input next.json. failureClass is the "class" that `failure classify` returned. See "decision next --example".',
    example: { status: 'FAILED', failureClass: 'data-failure', remainingWork: ['accessibility scan of /checkout', 'perf baseline of /api/orders'] },
    run: ({ flags }) => decisions.nextAction(payload(flags)),
  },
  'decision list': { help: 'List decision records.', run: () => state.list('decisions') },

  /* ---- plan ---- */
  'plan save': {
    help: 'Persist a plan: plan save --input plan.json. See "plan save --example". The plan is linked to the active session '
      + 'and its must-test scenarios become obligations that `validate --final` enforces.',
    example: {
      plan_id: 'PLAN-00001',
      created_at: '2026-10-08T10:00:00.000Z',
      objective: 'Comprehensive testing of the visitor management system',
      scope: { in_scope: ['visitor CRUD', 'guard approval flow', 'admin dashboard'], out_of_scope: ['billing integration'] },
      applicability: [
        { category: 'e2e', applicable: true, reason: 'multi-role system with handoff points', priority: 'P0' },
        { category: 'security', applicable: true, reason: 'auth + user-input signals present', priority: 'P1' },
      ],
      scenarios: [
        { id: 'S-01', title: 'Host creates a visit invite', category: 'e2e', obligation: 'must-test', method: 'api-client' },
        { id: 'S-02', title: 'Guard approves arriving visitor', category: 'e2e', obligation: 'must-test', method: 'playwright-script' },
        { id: 'S-03', title: 'XSS probe on visitor name field', category: 'security', obligation: 'must-test', method: 'api-client' },
        { id: 'S-04', title: 'Load test on check-in endpoint', category: 'load', obligation: 'should-test', method: 'load-tool' },
      ],
      exit_criteria: ['All must-test scenarios executed or blocked with reason', 'Coverage floors satisfied'],
      provenance: { skill_version: '0.13.0', created_at: '2026-10-08T10:00:00.000Z', created_by: 'agent' },
    },
    run: ({ flags }) => {
      const plan = payload(flags, false);
      if (!plan.plan_id) plan.plan_id = nextId('plan');
      const before = state.planCommitments();
      const saved = state.savePlan(plan);
      const warnings = [];
      for (const c of Object.values(before)) {
        const now = saved.scenarios.find((s) => s.id === c.id);
        if ((c.obligation === 'must-test' || c.obligation === 'blocked') && (!now || now.obligation !== c.obligation)) {
          warnings.push(`${c.id} was ${c.obligation} in ${c.plan_id} and is ${now ? now.obligation : 'missing'} here. Commitments do not shrink: it is still enforced. Discharge it with a run, a blocked not-run, or a NOT_APPLICABLE not-run backed by a decision.`);
        }
      }
      for (const s of saved.scenarios) {
        if (s.obligation === 'blocked' && !s.blocked_by) warnings.push(`${s.id} is planned as blocked but names no blocked_by uncertainty.`);
      }
      if (!saved.scenarios.some((s) => s.obligation === 'must-test')) warnings.push('No must-test scenario: this plan commits to nothing and validate --final will fail.');
      return warnings.length ? { ...saved, plan_warnings: warnings } : saved;
    },
  },
  'plan charters': {
    help: 'Generate exploratory charters (area x posture) as plan scenarios to paste into plan.json: '
      + 'plan charters --areas "checkout,signup" [--postures first-time-user,edge-input] [--start 20] [--obligation must-test]. '
      + 'Postures: first-time-user, numbers-and-copy, edge-input, state-after-reload, error-paths (default: all five). '
      + 'Each charter is one browser-explorer run, linked with plan_scenario_id, so the scenario floor enforces every one.',
    run: ({ flags }) => {
      const POSTURES = {
        'first-time-user': { persona: 'a first-time user with no context', mission: 'complete the main task the way a newcomer would; note anything confusing, misleading or broken' },
        'numbers-and-copy': { persona: 'a careful reader who checks every number and word', mission: 'verify totals, counts, dates, currency, pluralisation and copy against each other and against the inputs' },
        'edge-input': { persona: 'a fuzzer', mission: 'feed empty, boundary, oversized, unicode and malformed values into every input and watch for crashes and silent acceptance' },
        'state-after-reload': { persona: 'a user who reloads, goes back and opens a second tab', mission: 'change state, then reload, navigate back/forward and duplicate the tab; check nothing is lost, duplicated or stale' },
        'error-paths': { persona: 'a skeptic', mission: 'force failures: wrong credentials, expired session, offline, double submit, server errors; check every error is handled and explained' },
      };
      const areas = String(flags.areas ?? '').split(',').map((a) => a.trim()).filter(Boolean);
      if (!areas.length) throw new Error('--areas is required: the pages or flows to explore, comma-separated (e.g. "checkout,signup").');
      const postures = flags.postures ? String(flags.postures).split(',').map((p) => p.trim()) : Object.keys(POSTURES);
      const unknown = postures.filter((p) => !POSTURES[p]);
      if (unknown.length) throw new Error(`Unknown posture(s): ${unknown.join(', ')}. Known: ${Object.keys(POSTURES).join(', ')}.`);
      const obligation = flags.obligation ?? 'must-test';
      let n = Number(flags.start ?? 20);
      if (!Number.isInteger(n) || n < 1) throw new Error('--start must be a positive integer.');
      const scenarios = [];
      for (const area of areas) {
        for (const posture of postures) {
          scenarios.push({
            id: `S-${String(n).padStart(2, '0')}`,
            title: `Explore ${area} as ${POSTURES[posture].persona}`,
            category: 'exploratory',
            method: 'browser-explorer',
            obligation,
            area,
            posture,
            persona: POSTURES[posture].persona,
            steps: [POSTURES[posture].mission],
          });
          n += 1;
        }
      }
      return { scenarios, next: 'Add these to plan.json "scenarios" and run plan save. Dispatch one browser-explorer per charter (up to 4 in parallel); each records its run with plan_scenario_id and files candidate findings, which stay unverified until a repro check confirms them.' };
    },
  },
  'plan show': {
    help: 'Print the active plan, or a specific one: plan show [PLAN-00001]',
    run: ({ positional }) => {
      const plan = state.loadPlan(positional[2] ?? null);
      if (!plan) return { error: 'No plan stored. Write one during the planning phase and persist it with `plan save`.' };
      return plan;
    },
  },
  'plan progress': {
    help: 'Show must-test scenarios vs executions: which are done, which are not.',
    run: () => {
      if (!state.loadPlan()) return { error: 'No plan stored.' };
      return processCompleteness.planProgress();
    },
  },
  'todo': {
    help: 'The work queue: every item still owed before `validate --final` can pass (unrun committed scenarios, '
      + 'authored tests never executed, holds whose blocker was resolved, floor categories and features). '
      + 'Loop on it: run the next item, then ask again, until "done": true.',
    run: () => processCompleteness.outstanding(),
  },

  /* ---- evidence ---- */
  'evidence add': {
    help: 'Register a file another process already produced (a CI artifact, a runner\'s report): evidence add --input evidence.json. '
      + 'If you are about to run the command yourself, use `evidence capture` instead. See "evidence add --example".',
    example: { kind: 'test-report', summary: 'playwright: 11 passed, 1 failed', epistemicClass: 'observed', executionId: 'EXEC-2026-00003', artifactPath: 'test-results/results.json', mediaType: 'application/json' },
    run: ({ flags }) => evidence.add(payload(flags)),
  },
  'evidence capture': {
    help: 'Run a command and register its real output as evidence.\n'
      + '  evidence capture --exec EXEC-2026-00001 [--summary "..."] [--cwd dir] [--timeout ms] -- <command> [args...]\n'
      + '  evidence capture --exec EXEC-2026-00001 --script <file> [--summary "..."] [--cwd dir] [--timeout ms]\n'
      + 'The --script form runs the file directly (shell:false) — no quote mangling, safe on Windows/PowerShell.\n'
      + 'Supported: .js/.mjs (via node), .ps1 (via powershell), .sh (via bash), .py (via python).\n'
      + 'On timeout the whole process tree is killed. Output beyond 8M characters per stream keeps its first and last 4M.',
    run: async ({ flags, rest }) => {
      const hasScript = Boolean(flags.script);
      if (!hasScript && !rest.length) {
        throw new Error(
          'evidence capture requires a command after "--", or use --script <file>.\n'
          + 'Examples:\n'
          + '  ast evidence capture --exec EXEC-2026-00001 -- npm run lint\n'
          + '  ast evidence capture --exec EXEC-2026-00001 --script test-auth.js',
        );
      }
      if (!flags.exec) {
        throw new Error('evidence capture requires --exec <EXECUTION_ID> naming the execution this evidence supports.');
      }
      const target = state.get('executions', flags.exec);
      if (!target) {
        throw new Error(`No such execution: ${flags.exec}. Open one first with "exec start" -- never capture evidence for an execution that does not exist.`);
      }
      if (target.finished_at) {
        throw new Error(`${flags.exec} already finished as ${target.status}; evidence captured now would attach to nothing. `
          + 'Start a new execution for this run, capture into it, then finish it.');
      }

      const cwd = flags.cwd ?? process.cwd();
      const timeout = Number(flags.timeout ?? 600_000);
      const isWin = process.platform === 'win32';

      let spawnCommand, spawnArgs, argvString, useShell;

      if (hasScript) {
        // --script mode: run the file directly with shell:false.
        // No cmd.exe or PowerShell tokenization — the quoting problem disappears
        // structurally because there is no shell to re-split anything.
        const scriptPath = path.resolve(cwd, flags.script);
        if (!fs.existsSync(scriptPath)) {
          throw new Error(`Script file not found: ${scriptPath}`);
        }
        const ext = path.extname(scriptPath).toLowerCase();
        const runners = {
          '.js': [process.execPath, [scriptPath]],
          '.mjs': [process.execPath, [scriptPath]],
          '.ps1': ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]],
          '.sh': ['bash', [scriptPath]],
          '.py': [isWin ? 'python' : 'python3', [scriptPath]],
        };
        const runner = runners[ext];
        if (!runner) {
          throw new Error(
            `Unsupported script extension "${ext}". Supported: ${Object.keys(runners).join(', ')}`,
          );
        }
        [spawnCommand, spawnArgs] = runner;
        argvString = `[script] ${flags.script}`;
        useShell = false;
      } else {
        // -- <command> [args...] mode: original behaviour.
        argvString = rest.map((a) => (/\s/.test(a) && !/^".*"$/.test(a) ? `"${a}"` : a)).join(' ');
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
        spawnCommand = isWin ? winShellQuote(rest[0]) : rest[0];
        spawnArgs = isWin ? rest.slice(1).map(winShellQuote) : rest.slice(1);
        useShell = isWin;
      }

      const started = Date.now();
      const r = await runCaptured(spawnCommand, spawnArgs, { cwd, timeout, shell: useShell });
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
    help: 'Check whether a status claim is supported: evidence verify --input claim.json. See "evidence verify --example".',
    example: { status: 'PASSED', evidenceIds: ['EV-2026-00004'], executionId: 'EXEC-2026-00003', statement: 'vitest: 211/211 passed at abc1234' },
    run: ({ flags }) => evidence.verifyClaim(payload(flags)),
  },
  'evidence amend': {
    help: 'Correct a mis-typed evidence kind: evidence amend EV-2026-00001 --kind evidence-audit',
    run: ({ flags, positional }) => {
      const id = positional[2];
      if (!id) throw new Error('evidence amend requires an evidence ID, e.g.: ast evidence amend EV-2026-00001 --kind evidence-audit');
      return evidence.amend(id, { kind: flags.kind });
    },
  },
  'evidence list': { help: 'List evidence items.', run: () => state.list('evidence') },

  /* ---- execution ---- */
  'exec start': {
    help: 'Open an execution record: exec start --input exec.json. See "exec start --example". Add "target": {"url": "...", "deployed_commit": "..."} when testing a deployed system. '
      + 'Add "plan_scenario_id": "S-01" to link this execution to a plan scenario so the scenario coverage floor can verify it. '
      + 'Add "test_files": ["tests/x.spec.ts"] when it runs test files you wrote this session.',
    example: {
      goal: 'Read-only smoke of the staging deployment',
      method: 'playwright-script',
      testCategory: 'smoke',
      plan_scenario_id: 'S-01',
      test_files: ['e2e/smoke.spec.ts'],
      command: 'npx playwright test smoke --reporter=junit',
      environment: 'staging',
      target: { url: 'https://staging.example.com' },
    },
    run: ({ flags }) => {
      const body = payload(flags);
      const rec = execution.start(body);
      const sid = rec.plan_scenario_id;
      const known = state.planCommitments();
      if (sid && Object.keys(known).length && !known[sid]) {
        return { ...rec, warning: `plan_scenario_id "${sid}" is not a scenario in this session's plan (known: ${Object.keys(known).join(', ')}). This run will count toward no scenario. If that was a typo, finish this run and start a new one with the right id.` };
      }
      return rec;
    },
  },
  'exec finish': {
    help: 'Finalise an execution: exec finish EXEC-2026-00001 --input result.json. See "exec finish --example". '
      + '"junit": "<path>" turns a JUnit XML report into per-test results, so passing tests in a failed run still count as proven.',
    example: {
      status: 'FAILED',
      statusReason: '9 of 12 smoke checks passed; robots.txt and sitemap point at the wrong origin (2 tests), one unsettled.',
      evidence: ['EV-2026-00002', 'EV-2026-00004'],
      junit: 'test-results/junit.xml',
      signals: ['wrong-value-rendered'],
    },
    run: ({ positional, flags }) => execution.finish(positional[2], payload(flags)),
  },
  'exec not-run': {
    help: 'Document work that was NOT executed: exec not-run --input not-run.json. See "exec not-run --example". '
      + 'A hold counts toward the floors only while it links an OPEN uncertainty the agent cannot clear itself: status blocked, '
      + 'user-input-required, environment-unavailable or external-dependency, or a user-owned hold whose user_quote matches '
      + 'what the user said. NOT_APPLICABLE counts only with "decisionId" naming a recorded decision. SKIPPED records a visible '
      + 'disposition (enough for should-test scenarios and P2/P3 categories) but never covers a floor. Add "reproduces" to hold a defect repro.',
    example: {
      goal: 'Payment E2E against the real provider sandbox',
      status: 'BLOCKED',
      reason: 'STRIPE_SECRET_KEY is unset; the journey ran with the provider mocked, only the real-provider hop is untested.',
      testCategory: 'e2e',
      plan_scenario_id: 'S-04',
      uncertainties: ['U-00001'],
    },
    run: ({ flags }) => execution.recordNonExecution(payload(flags)),
  },
  'exec list': { help: 'List executions.', run: () => state.list('executions') },
  'exec summary': { help: 'Aggregate execution statuses.', run: () => execution.summarise() },

  /* ---- failure ---- */
  'failure classify': {
    help: 'Classify a failure: failure classify --input signals.json. Signals are real tokens from the output; `failure signals` lists them. See "failure classify --example".',
    example: { signals: ['assertion-mismatch', 'wrong-value-rendered'], evidenceIds: ['EV-2026-00007'] },
    run: ({ flags }) => {
      const body = payload(flags);
      const result = classify(body);
      const unknown = unknownSignals(body.signals ?? []);
      return unknown.length ? { ...result, unknown_signals: unknown } : result;
    },
  },
  'failure signals': {
    help: 'List the signal tokens the failure classifier understands, grouped by the class they point to.',
    run: () => failureSignalsByClass(),
  },

  /* ---- findings ---- */
  'finding add': {
    help: 'Record a finding: finding add --input finding.json. See "finding add --example".',
    example: {
      title: 'Sitemap URLs point at a login-protected preview deployment',
      kind: 'defect',
      severity: 'major',
      confidence: 0.9,
      component: 'src/lib/site.ts',
      summary: 'Every sitemap <loc> uses the per-deployment host instead of the production domain.',
      reproduction: {
        preconditions: ['anonymous visitor'],
        steps: ['GET /sitemap.xml', 'read the <loc> values'],
        expected: 'URLs on the production origin',
        actual: 'URLs on the per-deployment origin, which answers 302 to SSO',
        reproducible: 'always',
        attempts: 2,
      },
      impact: 'Search engines are sent to pages they cannot index.',
      evidence: [],
      recommendedAction: 'Set NEXT_PUBLIC_SITE_URL for the production environment and redeploy.',
    },
    run: ({ flags }) => defects.create(payload(flags)),
  },
  'finding promote': {
    help: 'Check whether a finding may be filed: finding promote FIND-00001 [--authorised] [--quote "..."] [--assignee name]',
    run: ({ positional, flags }) => defects.assessPromotion(positional[2], {
      system: flags.system ?? 'github',
      userAuthorised: Boolean(flags.authorised),
      authorisationQuote: flags.quote ?? '',
      assignee: flags.assignee ?? null,
      allowUnverified: Boolean(flags['allow-unverified']),
    }),
  },
  'finding verify': {
    help: 'Show each finding\'s verification as validate --final judges it: confirmed (a linked repro run failed on a '
      + 'product-defect assertion with real evidence), held, refuted, rejected, unverified or duplicate -- with the reason. '
      + 'Optional: finding verify FIND-00001.',
    run: ({ positional }) => {
      const all = defects.verifyAll();
      return positional[2] ? all.find((v) => v.finding_id === positional[2]) ?? { error: `No such finding: ${positional[2]}` } : all;
    },
  },
  'finding reject': {
    help: 'Triage a candidate out: finding reject FIND-00001 --class <explorer-artifact|environment|intended-design|fixture-gap|'
      + 'not-reproduced|out-of-scope> --reason "why it is not a defect" --cite "src/x.ts:42 | EXEC-... | URL". '
      + 'All three are required; the rejection is listed in the report with its citation.',
    run: ({ positional, flags }) => defects.reject(positional[2], { reasonClass: flags.class, reason: flags.reason, citation: flags.cite }),
  },
  'finding render': { help: 'Render the issue title/body/labels for a finding.', run: ({ positional }) => defects.renderIssue(positional[2]) },
  'finding list': { help: 'List findings, most severe first.', run: () => defects.bySeverity() },

  /* ---- uncertainty ---- */
  'uncertainty raise': {
    help: 'Raise an uncertainty: uncertainty raise --input u.json. See "uncertainty raise --example".',
    example: {
      question: 'May authenticated flows be tested, and with which test account?',
      status: 'user-input-required',
      impact: 'No coverage of any signed-in feature',
      affectedScope: ['dashboard'],
      blocksCategories: ['authn-authz', 'e2e'],
      nextAction: 'Provide a throwaway test account or a staging URL',
      owner: 'user',
    },
    run: ({ flags }) => uncertainty.raise(payload(flags)),
  },
  'uncertainty resolve': {
    help: 'Resolve one: uncertainty resolve U-00001 --answer "..."',
    run: ({ positional, flags }) => uncertainty.resolve(positional[2], { answer: flags.answer, resolvedBy: flags.by ?? 'user' }),
  },
  'uncertainty partition': {
    help: 'Split planned scenarios into runnable vs blocked: uncertainty partition --input scenarios.json. See "uncertainty partition --example".',
    example: { scenarios: [{ id: 'S-01', category: 'unit' }, { id: 'S-02', category: 'e2e' }, { id: 'S-03', category: 'authn-authz' }] },
    run: ({ flags }) => uncertainty.partitionWork(payload(flags).scenarios ?? payload(flags)),
  },
  'uncertainty list': { help: 'List open uncertainties.', run: () => uncertainty.open() },
  'uncertainty note': {
    help: 'Record work done despite a blocker: uncertainty note U-00001 --work "Ran the API suite against a mocked provider (12/12)". '
      + 'This is the evidence that the blocker stopped one branch, not the session.',
    run: ({ positional, flags }) => {
      if (!flags.work || !String(flags.work).trim()) throw new Error('--work is required: what you did anyway, with its result.');
      return uncertainty.noteIndependentWork(positional[2], String(flags.work).trim());
    },
  },

  /* ---- authorization + external writes ---- */
  'auth check': {
    help: 'Authorization gate: auth check --input auth.json. See "auth check --example".',
    example: { action: 'github.create_issue', target: 'acme/shop', userAuthorised: true, authorisationQuote: 'yes, open a GitHub issue for that' },
    run: ({ flags }) => {
      const body = payload(flags);
      if (!body.environmentClass && body.target) {
        const declared = auth.declaredClassFromProfile(body.target, state.loadProfile());
        if (declared) body.environmentClass = declared.class;
      }
      return auth.check(body);
    },
  },
  'auth policy': { help: 'Print the authorization policy.', run: () => auth.policy() },
  'auth classify-env': {
    help: 'Classify a host for the non-production-only gate: auth classify-env https://staging.example.com [--declared non-production]',
    run: ({ positional, flags }) => (flags.declared
      ? auth.classifyEnvironment(positional[2] ?? '', flags.declared)
      : auth.resolveEnvironment(positional[2] ?? '', state.loadProfile())),
  },
  'write check': {
    help: 'Duplicate-suppression check before an external write: write check --input write.json. See "write check --example".',
    example: { system: 'github', action: 'github.create_issue', idempotencyKey: 'sha256:<finding fingerprint>' },
    run: ({ flags }) => auth.alreadyWritten(payload(flags)),
  },
  'write record': {
    help: 'Record the confirmed/unconfirmed outcome of an external write.',
    run: ({ flags }) => auth.recordWrite(payload(flags)),
  },
  'write list': { help: 'List every external write attempted.', run: () => auth.listWrites() },

  /* ---- analysis ---- */
  'flaky analyse': { help: 'Analyse per-test pass/fail history.', run: () => flakiness.analyse() },
  'flaky quarantine': {
    help: 'File a test-quality-issue finding for every test proven flaky (>= 3 mixed runs at one commit). exec finish runs this automatically when it receives per-test results.',
    run: () => flakiness.quarantine(),
  },
  'trace query': {
    help: 'Traceability query: trace query what-remains-untested | what-validates REQ-1 | why-this-method EXEC-...',
    run: ({ positional }) => trace.query(positional[2], positional[3] ?? null),
  },
  'trace graph': { help: 'Dump the traceability graph.', run: () => trace.build() },
  'trace queries': { help: 'List available traceability queries.', run: () => trace.queries() },

  /* ---- reporting ---- */
  'report generate': {
    help: 'Generate the report: report generate [--input context.json] [--format md]. '
      + 'context.json is entirely optional -- see "report generate --example".',
    // `plan`, `riskAssessment` and `applicability` are normally the literal output of
    // `plan compute` / `risk score` / `applicability eval` piped straight through, not
    // hand-typed -- this example shows the one field worth hand-authoring directly:
    // recommendations, prose a human or agent adds on top of what state already proves.
    example: {
      recommendations: [
        'Prioritise adding an owner check on the payment-methods endpoint before the next release.',
        'Re-run the accessibility scan once the interrupted session resumes.',
      ],
    },
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

  'report diff': {
    help: 'Compare two reports and show what changed: report diff [NEW_ID [OLD_ID]]. '
      + 'With no args, compares the latest report against its predecessor. '
      + 'Shows added/removed/changed executions, findings, metrics, and blocked work.',
    run: ({ positional }) => {
      const newId = positional[2] || undefined;
      const oldId = positional[3] || undefined;
      return reporting.diff(newId, oldId);
    },
  },

  /* ---- metrics + evaluation ---- */
  'metrics': { help: 'Compute evaluation metrics for the current state.', run: ({ flags }) => computeMetrics(payload(flags)) },
  'eval run': {
    help: 'Run the benchmark and regression suites: eval run [--only case-03]. Exits 1 if any check fails.',
    run: ({ flags }) => {
      const result = evaluation.run({ only: flags.only ?? null });
      // CI gates on the exit code; a red suite that exits 0 gates nothing.
      if (result.failures.length) process.exitCode = 1;
      return result;
    },
  },
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
      authorisation: { userAuthorised: Boolean(flags.authorised), authorisationQuote: flags.quote ?? '', allowUnverified: Boolean(flags['allow-unverified']) },
    }),
  },
  'github comment': {
    help: 'Comment on an issue: github comment --repo owner/name --number 412 --input body.json [--authorised]',
    run: ({ flags }) => adapters.getAdapter('github').comment({
      repo: flags.repo, number: flags.number, body: payload(flags).body,
      idempotencyKey: flags.key, decisionId: flags.decision ?? null,
      dryRun: Boolean(flags['dry-run']),
      authorisation: { userAuthorised: Boolean(flags.authorised), authorisationQuote: flags.quote ?? '', allowUnverified: Boolean(flags['allow-unverified']) },
    }),
  },
  'github assign': {
    help: 'Assign an issue to a USER-NAMED account: github assign --repo owner/name --number 412 --assignee octocat --authorised',
    run: ({ flags }) => adapters.getAdapter('github').assign({
      repo: flags.repo, number: flags.number, assignee: flags.assignee ?? null,
      decisionId: flags.decision ?? null, dryRun: Boolean(flags['dry-run']),
      authorisation: { userAuthorised: Boolean(flags.authorised), authorisationQuote: flags.quote ?? '', allowUnverified: Boolean(flags['allow-unverified']) },
    }),
  },
  'jira preflight': {
    help: 'Check the Jira REST credentials (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN) before any write.',
    run: () => adapters.preflight('jira'),
  },
  'jira read': {
    help: 'Read from Jira: jira read ticket --key SHOP-412 | jira read search --jql "project = SHOP AND updated >= -7d" [--limit 20]. Descriptions come back as text, with acceptance criteria extracted when they are a heading.',
    run: ({ positional, flags }) => {
      const jira = adapters.getAdapter('jira');
      if (positional[2] === 'ticket') return jira.readTicket({ key: flags.key });
      if (positional[2] === 'search') return jira.search({ jql: flags.jql, limit: flags.limit ? Number(flags.limit) : 20 });
      throw new Error(`Unknown read "${positional[2]}". One of: ticket, search`);
    },
  },
  'jira file-issue': {
    help: 'File a finding as a Jira issue, through every gate: jira file-issue FIND-00001 --project SHOP [--type Bug] [--authorised --quote "..."] [--dry-run]',
    run: ({ positional, flags }) => adapters.getAdapter('jira').createIssueFromFinding({
      findingId: positional[2],
      project: flags.project,
      issueType: flags.type ?? 'Bug',
      decisionId: flags.decision ?? null,
      dryRun: Boolean(flags['dry-run']),
      authorisation: { userAuthorised: Boolean(flags.authorised), authorisationQuote: flags.quote ?? '', allowUnverified: Boolean(flags['allow-unverified']) },
    }),
  },
  'jira comment': {
    help: 'Comment on a Jira issue: jira comment --key SHOP-412 --input body.json [--authorised --quote "..."] [--dry-run]. The body is plain text; it is converted to ADF. See "jira comment --example".',
    example: { body: 'Test plan for SHOP-412: 12 scenarios, 9 ran, 1 confirmed defect (FIND-00001), 2 blocked on sandbox credentials.' },
    run: ({ flags }) => adapters.getAdapter('jira').comment({
      key: flags.key, body: payload(flags).body,
      idempotencyKey: flags.idempotency, decisionId: flags.decision ?? null,
      dryRun: Boolean(flags['dry-run']),
      authorisation: { userAuthorised: Boolean(flags.authorised), authorisationQuote: flags.quote ?? '', allowUnverified: Boolean(flags['allow-unverified']) },
    }),
  },
  'adapter complete': {
    help: 'Finish a delegated (MCP) write: adapter complete --ticket WT-... --input response.json, where response.json is the raw provider response, unedited. See "adapter complete --example" (a GitHub create-issue response).',
    example: { number: 418, html_url: 'https://github.com/acme/shop/issues/418', title: 'Saved card belonging to another user is selectable', state: 'open' },
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
    run: () => ({ implemented: adapters.SYSTEMS, contracts_only: ['google-docs', 'google-drive'] }),
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

function validateAll({ final = false } = {}) {
  // Structural problems (schema, dangling references, open runs) come from the same engine
  // module the work queue and the Stop gate use, so the three can never disagree.
  const { counts, problems: structural } = integrity.structuralCheck();
  const problems = structural.map((p) => p.message);
  const warnings = [];

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

  // A field trial's agent hit `session start --input goals.json` with no goals.json to
  // point at, read the session schema cold, then gave up and ran with just --request.
  // The four commands that need this most (session start, risk score, browser decide,
  // report generate) had no worked example anywhere the agent's own reading path reached
  // -- risk score's WAS documented, but only in a sibling skill the agent had not loaded.
  // Payload contracts belong to the CLI itself: `--example` prints one directly, on any
  // command that has declared one, so an agent never has to guess a shape or go find it.
  if (flags.example) {
    if (!COMMANDS[key].example) {
      fail(`no example payload is defined yet for "${key}"`, 'run with --input pointing at a real payload, or check the command\'s own --help text');
      return;
    }
    process.stdout.write(`${JSON.stringify(COMMANDS[key].example, null, 2)}\n`);
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
