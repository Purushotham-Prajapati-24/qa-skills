import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { useTempState } from './helpers.mjs';
import * as state from '../engine/state-engine/index.mjs';
import { outstanding } from '../engine/evaluation-engine/process-completeness.mjs';

/**
 * The end-to-end continuity guarantee: an agent that remembers NOTHING -- only what the hook
 * says after a compaction and what `ast todo` lists -- can take a half-finished session to a
 * passing `validate --final` and a verified report. If the queue ever has a dead end, an item
 * with no actionable next step, or an order that makes work happen twice, this fails.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AST = path.join(ROOT, 'bin', 'ast.mjs');
const created = [];
test.after(() => created.forEach((c) => c()));

test('a memoryless agent driven only by the work queue finishes a session across a compaction', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-qdrive-'));
  created.push(() => fs.rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.mkdirSync(path.join(repo, 'tests'));
  const env = { ...process.env, AST_STATE_DIR: path.join(repo, '.testing-state'), AST_STOP_GATE: '' };
  const run = (args, ok = true) => {
    try { const o = execFileSync(process.execPath, [AST, ...args], { cwd: repo, encoding: 'utf8', stdio: 'pipe', env, timeout: 30_000 }); return o.trim() ? JSON.parse(o) : null; }
    catch (e) { if (ok) throw new Error(`${args.join(' ')}\n${e.stdout}${e.stderr}`); return { error: `${e.stdout}${e.stderr}` }; }
  };
  const inp = (args, body, ok) => { const f = path.join(repo, `in-${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify(body)); return run([...args, '--input', f], ok); };

  // Before the compaction: a plan, one run in flight, one test written and never run.
  run(['session', 'start', '--request', 'Test the cart service. You have 60 minutes.']);
  const m = inp(['applicability', 'eval'], { signals: ['http-api', 'user-input'] });
  const floor = m.matrix.filter((r) => r.applicable && (['P0', 'P1'].includes(r.priority) || ['security', 'input-validation', 'accessibility', 'perf-baseline'].includes(r.category)));
  const charters = run(['plan', 'charters', '--areas', 'cart', '--postures', 'edge-input,error-paths']).scenarios;
  const scenarios = [...charters, ...floor.map((r, i) => ({ id: `S-${40 + i}`, title: `${r.category} baseline for the cart`, category: r.category, method: 'api-client', obligation: 'must-test' }))];
  inp(['plan', 'save'], { plan_id: 'PLAN-00001', created_at: new Date().toISOString(), objective: 'Cart service, queue-driven', scope: { in_scope: ['cart'], out_of_scope: [] }, applicability: [{ category: 'exploratory', applicable: true, reason: 'cart never mapped' }], scenarios, exit_criteria: ['queue empty'], provenance: { skill_version: '0.12.0', created_at: new Date().toISOString(), created_by: 'agent' } });
  inp(['exec', 'start'], { goal: 'first charter, cut off by compaction', method: 'playwright-mcp', plan_scenario_id: scenarios[0].id });
  fs.writeFileSync(path.join(repo, 'tests', 'cart-qty.spec.mjs'), "import test from 'node:test'; import assert from 'node:assert'; test('qty', () => assert.equal(3 * 10, 30));\n");

  // The compaction: memory gone. What remains is the hook and the CLI.
  const ctx = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'hooks', 'session-start.mjs')], { input: '{"source":"compact"}', encoding: 'utf8', env, cwd: repo })).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Do NOT start a new session/);
  assert.match(run(['session', 'start', '--request', 'continue testing the cart'], false).error, /unfinished/);
  const resumed = run(['session', 'resume', '--interrupt-all']);
  assert.equal(resumed.orphaned_executions.length, 1);
  assert.match(resumed.next_action, /Continue the work queue/);

  // Follow ONLY the queue, top item each time, using its ref.
  const seen = new Map();
  let rounds = 0;
  for (;;) {
    const q = run(['todo']);
    if (q.done) break;
    assert.ok(++rounds <= 60, 'the queue never emptied');
    const item = q.items[0];
    const key = `${item.check}:${item.ref}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    assert.ok(seen.get(key) <= 1, `taking "${key}" did not discharge it -- a dead end: ${item.what}`);
    assert.ok(item.next || item.check === 'no-decisions', `queue item has no next step: ${JSON.stringify(item)}`);
    if (item.check === 'no-decisions') {
      inp(['decide'], { question: 'How deep should the cart be tested?', options: ['standard', 'deep'], selected: 'deep', reason: 'user asked to test the cart service', confidence: 0.8, reversible: true });
    } else if (item.check === 'scenario-coverage-floor') {
      const ex = inp(['exec', 'start'], { goal: `Run scenario ${item.ref}`, method: 'api-client', plan_scenario_id: item.ref });
      const ev = run(['evidence', 'capture', '--exec', ex.execution_id, '--summary', `ran ${item.ref}`, '--', process.execPath, '-e', "require('node:assert').ok([1, 2, 3].length === 3)"]);
      inp(['exec', 'finish', ex.execution_id], { status: 'PASSED', statusReason: `${item.ref} assertions held`, evidence: [ev.evidence_id] });
    } else if (item.check === 'authored-test-not-run') {
      const ex = inp(['exec', 'start'], { goal: `Run authored ${item.ref}`, method: 'existing-suite', plan_scenario_id: scenarios[0].id, test_files: [item.ref], command: `node --test ${item.ref}` });
      const ev = run(['evidence', 'capture', '--exec', ex.execution_id, '--summary', `ran ${item.ref}`, '--', process.execPath, '--test', item.ref]);
      inp(['exec', 'finish', ex.execution_id], { status: 'PASSED', statusReason: 'authored test passed', evidence: [ev.evidence_id] });
    } else if (item.check === 'category-disposition') {
      inp(['exec', 'not-run'], { goal: `${item.ref} testing`, status: 'SKIPPED', reason: `${item.ref} is low priority and outside the user's 60 minutes`, testCategory: item.ref });
    } else {
      assert.fail(`the queue asked for something a scenario run could not discharge: ${JSON.stringify(item)}`);
    }
  }

  assert.equal(run(['validate', '--final']).valid, true);
  const rep = run(['report', 'generate']);
  assert.ok(!run(['report', 'verify', rep.markdown_path], false).error);
  const md = fs.readFileSync(rep.markdown_path, 'utf8');
  assert.match(md, /## Plan vs executed/);
  assert.match(md, /tests\/cart-qty\.spec\.mjs \| ran/);
  assert.match(md, /INTERRUPTED/, 'the cut-off run is reported, not hidden');
});

test('the queue folds a floor gap into the owed scenario that discharges it, and puts set-up first', () => {
  const t = useTempState('qfold');
  created.push(() => t.cleanup());
  state.startSession({ request: 'fold', git: null });
  state.saveApplicability({ matrix: [
    { category: 'security', applicable: true, priority: 'P1', reason: 'auth present' },
    { category: 'compatibility', applicable: true, priority: 'P3', reason: 'two browsers in the support matrix' },
  ] });
  state.savePlan({
    plan_id: 'PLAN-00001', created_at: new Date().toISOString(), objective: 'Fold test plan',
    scope: { in_scope: ['x'], out_of_scope: [] }, applicability: [{ category: 'security', applicable: true, reason: 'auth present' }],
    scenarios: [{ id: 'S-01', title: 'security sweep', category: 'security', method: 'api-client', obligation: 'must-test' }],
    exit_criteria: ['run'], provenance: { skill_version: '0.12.0', created_at: new Date().toISOString(), created_by: 'agent' },
  });
  const q = outstanding();
  assert.ok(!q.items.some((i) => i.check === 'coverage-floor'), 'the category gap is not separate work');
  const s = q.items.find((i) => i.check === 'scenario-coverage-floor');
  assert.deepEqual(s.also_covers, ['coverage-floor:security']);
  const at = (check) => q.items.findIndex((i) => i.check === check);
  assert.ok(at('scenario-coverage-floor') < at('category-disposition'), 'committed work comes before tidying up skips');
});
