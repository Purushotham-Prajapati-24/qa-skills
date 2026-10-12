import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The skills are executable instructions. An agent copies a documented command and payload and
 * runs it; if the docs name a command that does not exist, or show a payload the CLI rejects, a
 * correct plan fails to execute. This walks every skill, agent, doc and walkthrough and runs
 * what they document against the real CLI.
 *
 * "Dependency" failures (a payload citing EXEC-2026-00003 in an empty state) are expected and
 * not counted; shape errors, missing fields and crashes are.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AST = path.join(ROOT, 'bin', 'ast.mjs');
const help = execFileSync(process.execPath, [AST, 'help'], { encoding: 'utf8' });
const COMMANDS = new Set(help.split(/\r?\n/).map((l) => /^ {2}([a-z][a-z-]*(?: [a-z][a-z-]*)?) {2,}/.exec(l)?.[1]).filter(Boolean));

function markdownFiles() {
  const out = [path.join(ROOT, 'README.md')];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(p);
    }
  };
  for (const d of ['skills', 'agents', 'docs', 'examples/walkthroughs', 'integrations', 'templates']) {
    if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
  }
  return out;
}

function documented() {
  const commands = [];
  const payloads = [];
  for (const file of markdownFiles()) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    // One pass: an --input file refers to the nearest block with that label ABOVE it.
    const blocks = new Map();
    let fence = null;
    let buf = [];
    let label = null;
    let pending = null;
    lines.forEach((line, i) => {
      const f = /^\s*```(\w*)/.exec(line);
      if (f && !fence) { fence = f[1] || 'text'; buf = []; pending = label; return; }
      if (f && fence) { if ((fence === 'json' || fence === 'jsonc') && pending) blocks.set(pending, buf.join('\n')); fence = null; return; }
      if (fence) { buf.push(line); }
      const lab = !fence && /^\s*`([\w.-]+\.json)`:\s*$/.exec(line);
      if (lab) label = lab[1];
      const m = /ast\.mjs"?\s+(?:--state \S+\s+)?([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/.exec(line);
      if (!m) return;
      const two = m[2] ? `${m[1]} ${m[2]}` : null;
      const cmd = two && COMMANDS.has(two) ? two : COMMANDS.has(m[1]) ? m[1] : null;
      commands.push({ where: `${rel}:${i + 1}`, cmd, text: line.trim() });
      const input = /--input\s+(\S+\.json)/.exec(line)?.[1];
      if (cmd && input && blocks.has(path.basename(input))) payloads.push({ where: `${rel}:${i + 1}`, cmd, body: blocks.get(path.basename(input)) });
    });
  }
  return { commands, payloads };
}

const { commands, payloads } = documented();

test('every documented ast command exists', () => {
  assert.ok(commands.length > 100, `found only ${commands.length} documented invocations -- the scan is broken`);
  const unknown = commands.filter((c) => !c.cmd).map((c) => `${c.where}: ${c.text}`);
  assert.deepEqual(unknown, []);
});

test('every command a skill tells you to feed a payload can print a valid example of it', () => {
  const needing = [...new Set(commands.filter((c) => c.cmd && /--input/.test(c.text)).map((c) => c.cmd))];
  const missing = needing.filter((cmd) => {
    try { execFileSync(process.execPath, [AST, ...cmd.split(' '), '--example'], { stdio: 'pipe' }); return false; } catch { return true; }
  });
  assert.deepEqual(missing, []);
});

const RUNNABLE = /^(decide|exec (start|finish|not-run)|finding add|uncertainty (raise|partition)|plan save|applicability eval|risk score|browser decide|failure classify|decision next|session start|profile save|report generate|evidence add)$/;
const DEPENDENCY = /No such (execution|finding|evidence|uncertainty|decision)|does not exist|not a recorded finding|references missing|ENOENT/i;

test('every documented --input payload is accepted by the real CLI', () => {
  const runnable = payloads.filter((p) => RUNNABLE.test(p.cmd));
  assert.ok(runnable.length > 30, `found only ${runnable.length} runnable documented payloads -- the scan is broken`);
  const broken = [];
  for (const p of runnable) {
    let body;
    try { body = JSON.parse(p.body.replace(/^\s*\/\/.*$/gm, '')); } catch (e) { broken.push(`${p.where}: not valid JSON (${e.message})`); continue; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ast-docs-'));
    try {
      const run = (args) => execFileSync(process.execPath, [AST, '--state', dir, ...args], { encoding: 'utf8', stdio: 'pipe', timeout: 15_000 });
      if (p.cmd !== 'session start') run(['session', 'start', '--request', 'documented payload check']);
      const extra = [];
      if (p.cmd === 'exec finish') {
        fs.writeFileSync(path.join(dir, 'start.json'), JSON.stringify({ goal: 'documented payload run', method: 'api-client' }));
        extra.push(JSON.parse(run(['exec', 'start', '--input', path.join(dir, 'start.json')])).execution_id);
      }
      const f = path.join(dir, 'payload.json');
      fs.writeFileSync(f, JSON.stringify(body));
      try {
        run([...p.cmd.split(' '), ...extra, '--input', f]);
      } catch (e) {
        const msg = `${e.stderr ?? ''}${e.stdout ?? ''}${e.code ? ` [code ${e.code}]` : ''}${e.signal ? ` [signal ${e.signal}]` : ''}`.replace(/\s+/g, ' ').slice(0, 200);
        if (!DEPENDENCY.test(msg)) broken.push(`${p.where} [${p.cmd}]: ${msg}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  assert.deepEqual(broken, []);
});
