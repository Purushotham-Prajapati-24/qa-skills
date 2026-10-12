import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redactText } from '../engine/core/redact.mjs';

/**
 * Round two of the continuity audit (2026-10-12): install scopes, queue/gate agreement, the
 * capture mechanism under real-world output, and the subagent that drives the browser.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AST = path.join(ROOT, 'bin', 'ast.mjs');
const created = [];
test.after(() => created.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const tmp = (label) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `ast-r2-${label}-`)); created.push(d); return d; };
const envNoState = () => { const e = { ...process.env, AST_STOP_GATE: '' }; delete e.AST_STATE_DIR; return e; };

function cli(cliPath, cwd, { state = null, env = envNoState() } = {}) {
  const run = (args, ok = true) => {
    try {
      const o = execFileSync(process.execPath, [cliPath, ...(state ? ['--state', state] : []), ...args], { cwd, env, encoding: 'utf8', stdio: 'pipe', timeout: 60_000 });
      return o.trim() ? JSON.parse(o) : null;
    } catch (e) { if (ok) throw new Error(`${args.join(' ')}\n${e.stdout}${e.stderr}`); return { error: `${e.stdout}${e.stderr}` }; }
  };
  const input = (args, body, ok) => { const f = path.join(os.tmpdir(), `ast-r2-in-${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify(body)); try { return run([...args, '--input', f], ok); } finally { fs.rmSync(f, { force: true }); } };
  return { run, input };
}
const plan = (ids) => ({ plan_id: 'PLAN-00001', created_at: new Date().toISOString(), objective: 'Round two plan', scope: { in_scope: ['x'], out_of_scope: [] }, applicability: [{ category: 'e2e', applicable: true, reason: 'multi-step user paths present' }], scenarios: ids.map((id) => ({ id, title: `scenario ${id}`, category: 'e2e', method: 'api-client', obligation: 'must-test' })), exit_criteria: ['run'], provenance: { skill_version: '0.12.0', created_at: new Date().toISOString(), created_by: 'agent' } });

/* ------------------------------------------------ one runtime, many projects */

test('a runtime shared across projects (user scope, plugin) keeps each project\'s state in that project', () => {
  const home = tmp('home');
  execFileSync(process.execPath, [path.join(ROOT, 'bin', 'install.mjs'), '--target', home], { cwd: home, stdio: 'ignore' });
  const shared = path.join(home, '.claude', 'ast', 'bin', 'ast.mjs');
  const one = tmp('one'); const two = tmp('two');
  for (const p of [one, two]) execFileSync('git', ['init', '-q'], { cwd: p });
  const a = cli(shared, one); const b = cli(shared, two);
  a.run(['session', 'start', '--request', 'project ONE']);
  a.input(['plan', 'save'], plan(['S-01']));
  b.run(['session', 'start', '--request', 'project TWO']);
  assert.equal(a.run(['session', 'show']).user_request, 'project ONE', 'project ONE\'s live session is untouched');
  assert.equal(b.run(['session', 'show']).user_request, 'project TWO');
  assert.ok(fs.existsSync(path.join(one, '.testing-state', 'testing-state.json')));
  assert.ok(fs.existsSync(path.join(two, '.testing-state', 'testing-state.json')));
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'ast', 'state', 'testing-state.json')), 'nothing lands in the shared runtime');
  assert.match(fs.readFileSync(path.join(one, '.testing-state', '.gitignore'), 'utf8'), /^\*$/m, 'implicit state does not show up as untracked files');

  // The hooks resolve the same directory the CLI writes to.
  const hook = path.join(home, '.claude', 'ast', 'scripts', 'hooks', 'session-start.mjs');
  const ctx = JSON.parse(execFileSync(process.execPath, [hook], { cwd: one, input: '{"source":"compact"}', encoding: 'utf8', env: envNoState() })).hookSpecificOutput.additionalContext;
  assert.match(ctx, /SESSION-0001/);
});

test('a runtime installed inside the project keeps its state beside itself, as before', () => {
  const proj = tmp('inproj');
  execFileSync('git', ['init', '-q'], { cwd: proj });
  execFileSync(process.execPath, [path.join(ROOT, 'bin', 'install.mjs'), '--target', proj], { cwd: proj, stdio: 'ignore' });
  const c = cli(path.join(proj, '.claude', 'ast', 'bin', 'ast.mjs'), proj);
  c.run(['session', 'start', '--request', 'in-project install']);
  assert.ok(fs.existsSync(path.join(proj, '.claude', 'ast', 'state', 'testing-state.json')));
  assert.ok(!fs.existsSync(path.join(proj, '.testing-state')));
});

/* ------------------------------------------------ the queue agrees with the gate */

test('an open run keeps the queue (and the Stop gate) from saying done while validate --final would fail', () => {
  const s = tmp('gate');
  const c = cli(AST, s, { state: s });
  c.run(['session', 'start', '--request', 'queue vs gate']);
  c.input(['decide'], { question: 'How deep should testing go?', options: ['standard', 'deep'], selected: 'standard', reason: 'fixture', confidence: 0.8, reversible: true });
  c.input(['plan', 'save'], plan(['S-01']));
  const ex = c.input(['exec', 'start'], { goal: 'covering run', method: 'api-client', plan_scenario_id: 'S-01', git: null });
  const ev = c.run(['evidence', 'capture', '--exec', ex.execution_id, '--summary', 'covering run', '--', process.execPath, '-e', "require('node:assert').ok(1)"]);
  c.input(['exec', 'finish', ex.execution_id], { status: 'PASSED', statusReason: 'assertion held', evidence: [ev.evidence_id] });
  const m = c.input(['applicability', 'eval'], { signals: [] });
  for (const r of m.matrix.filter((x) => x.applicable)) c.input(['exec', 'not-run'], { goal: `${r.category} testing`, status: 'SKIPPED', reason: `${r.priority}, out of scope here`, testCategory: r.category });
  assert.equal(c.run(['todo']).done, true, 'fixture: everything owed is done');
  const open = c.input(['exec', 'start'], { goal: 'probe left open', method: 'api-client', git: null });
  const todo = c.run(['todo']);
  assert.equal(todo.done, false);
  assert.ok(todo.items.some((i) => i.check === 'integrity:open-execution' && i.ref === open.execution_id));
  assert.match(c.run(['validate', '--final'], false).error, /still open/);
  const gate = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'hooks', 'stop-gate.mjs')], { input: '{}', encoding: 'utf8', env: { ...envNoState(), AST_STATE_DIR: s } });
  assert.equal(JSON.parse(gate).decision, 'block');
});

test('with no session at all, the queue says so instead of reporting done', () => {
  const s = tmp('nosession');
  const todo = cli(AST, s, { state: s }).run(['todo']);
  assert.equal(todo.done, false);
  assert.equal(todo.items[0].check, 'no-session');
});

/* ------------------------------------------- the capture mechanism under load */

test('a command killed by its timeout: tree killed, and its evidence cannot back PASSED or count', () => {
  const s = tmp('timeout');
  const c = cli(AST, s, { state: s });
  c.run(['session', 'start', '--request', 'timeouts']);
  c.input(['plan', 'save'], plan(['S-01']));
  const ex = c.input(['exec', 'start'], { goal: 'hung run', method: 'api-client', plan_scenario_id: 'S-01', git: null });
  const beat = path.join(s, 'beat.txt');
  const started = Date.now();
  const ev = c.run(['evidence', 'capture', '--exec', ex.execution_id, '--summary', 'hung command', '--timeout', '1500', '--',
    process.execPath, '-e', `setInterval(() => require('fs').appendFileSync(${JSON.stringify(beat)}, '.'), 200)`], false);
  assert.ok(Date.now() - started < 20_000, 'the capture returns promptly after its timeout');
  const size = fs.existsSync(beat) ? fs.statSync(beat).size : 0;
  execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 1200)']);
  assert.equal(fs.existsSync(beat) ? fs.statSync(beat).size : 0, size, 'the killed process (and its children) stopped');
  const evId = /EV-\d{4}-\d+/.exec(JSON.stringify(ev))?.[0];
  assert.ok(evId, 'the cut-off run is still recorded as evidence');
  const fin = c.input(['exec', 'finish', ex.execution_id], { status: 'PASSED', statusReason: 'it did not crash', evidence: [evId] });
  assert.equal(fin.record.status, 'INCONCLUSIVE');
  assert.match(fin.record.status_reason, /did not complete/);
  assert.equal(c.run(['plan', 'progress']).must_test_executed, 0);
});

test('a huge command output is captured quickly, with its head and tail kept', () => {
  const s = tmp('huge');
  const c = cli(AST, s, { state: s });
  c.run(['session', 'start', '--request', 'huge output']);
  const ex = c.input(['exec', 'start'], { goal: 'verbose run', method: 'api-client', git: null });
  const started = Date.now();
  const ev = c.run(['evidence', 'capture', '--exec', ex.execution_id, '--summary', 'verbose output', '--',
    process.execPath, '-e', "process.stdout.write('BEGIN-MARK ' + 'y'.repeat(30 * 1024 * 1024) + ' END-MARK')"]);
  assert.ok(Date.now() - started < 30_000, `took ${Date.now() - started}ms`);
  assert.equal(ev.command.exit_code, 0);
  const blob = fs.readFileSync(path.isAbsolute(ev.artifact.path) ? ev.artifact.path : path.join(s, ev.artifact.path), 'utf8');
  assert.match(blob, /BEGIN-MARK/);
  assert.match(blob, /END-MARK/);
  assert.match(blob, /bytes of output truncated by ast evidence capture/);
});

test('redaction is linear: long runs of word characters no longer hang it, and secrets are still masked', () => {
  const t = Date.now();
  redactText('x'.repeat(8 * 1024 * 1024));
  redactText(Buffer.alloc(4 * 1024 * 1024, 'QUJD').toString());
  assert.ok(Date.now() - t < 5_000, `took ${Date.now() - t}ms (it took minutes for 256 KB before)`);
  assert.match(redactText('DB_PASSWORD=hunter2hunter'), /\[REDACTED\]/);
  assert.match(redactText('"client_secret": "s3cr3t-value"'), /\[REDACTED\]/);
  assert.match(redactText('X_SERVICE_ACCESS_KEY=AAAAbbbbCCCC'), /\[REDACTED\]/);
  assert.doesNotMatch(redactText('tests passed: 87/87'), /\[REDACTED\]/);
});

/* --------------------------------------------- instructions that can execute */

test('the browser explorer is not restricted away from the browser it is told to drive', () => {
  const fm = fs.readFileSync(path.join(ROOT, 'agents', 'browser-explorer.md'), 'utf8').split('---')[1];
  assert.doesNotMatch(fm, /^tools:/m, 'a tools allowlist here cannot include MCP browser tools, so the agent could not browse');
});

test('every specialist exec example links the run to a plan scenario', () => {
  const missing = [];
  for (const skill of fs.readdirSync(path.join(ROOT, 'skills'))) {
    for (const f of fs.readdirSync(path.join(ROOT, 'skills', skill)).filter((x) => x.endsWith('.md'))) {
      const text = fs.readFileSync(path.join(ROOT, 'skills', skill, f), 'utf8');
      for (const m of text.matchAll(/```json\s*\n([\s\S]*?)```/g)) {
        const b = m[1];
        const isExecStart = /"goal"/.test(b) && /"method"/.test(b) && !/"status"/.test(b);
        if (isExecStart && !/plan_?[sS]cenario_?[iI]d|"reproduces"/.test(b)) missing.push(`${skill}/${f}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});
