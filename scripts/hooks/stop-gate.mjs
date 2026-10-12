#!/usr/bin/env node
/**
 * Stop hook: the testing session is not over while `ast todo` still lists owed work.
 *
 * Everything else in this system makes stopping early *visible* (`validate --final` fails,
 * `todo` lists the gap). This makes it *structural*: when the agent tries to end its turn with
 * committed scenarios unrun, written tests never executed, or held work whose blocker has been
 * resolved, Claude Code is told to keep going and given the queue.
 *
 * It can never trap a session:
 *  - each block must be followed by progress (the queue shrinking); after
 *    AST_STOP_GATE_MAX (default 3) consecutive blocks without progress it releases, because
 *    at that point the agent needs a human, not another push;
 *  - a session untouched for 12 hours is not gated (old state, unrelated work);
 *  - AST_STOP_GATE=off disables it;
 *  - any internal error fails open (exit 0, no output).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const STALE_MS = 12 * 60 * 60 * 1000;
const MAX = Math.max(1, Number(process.env.AST_STOP_GATE_MAX ?? 3) || 3);
const SHOWN = 8;

const mod = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

async function main() {
  if (String(process.env.AST_STOP_GATE ?? '').toLowerCase() === 'off') return;
  try { fs.readFileSync(0, 'utf8'); } catch { /* stdin is informational only */ }

  const { setStateRoot, stateRoot } = await mod('engine/core/paths.mjs');
  const stateDir = stateRoot();
  const sessionFile = path.join(stateDir, 'testing-state.json');
  if (!fs.existsSync(sessionFile)) return;
  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8').replace(/^﻿/, ''));
  if (Date.now() - new Date(session.updated_at).getTime() > STALE_MS) return;
  setStateRoot(stateDir);
  const { outstanding } = await mod('engine/evaluation-engine/process-completeness.mjs');
  const todo = outstanding();

  const gateFile = path.join(stateDir, 'stop-gate.json');
  let gate = {};
  try { gate = JSON.parse(fs.readFileSync(gateFile, 'utf8')); } catch { /* first run */ }
  if (gate.session_id !== session.session_id) gate = {};

  const keys = todo.items.map((i) => `${i.check}:${i.ref ?? String(i.what).slice(0, 80)}`);
  const executions = (session.completed_executions ?? []).length;
  if (todo.done) {
    fs.writeFileSync(gateFile, JSON.stringify({ session_id: session.session_id, keys: [], executions, strikes: 0 }));
    return;
  }

  // Progress is "something owed was discharged, or new work was recorded" -- not "the queue got
  // shorter": the first real run legitimately surfaces new gaps, and that agent is working.
  const now = new Set(keys);
  const progressed = !Array.isArray(gate.keys)
    || gate.keys.some((k) => !now.has(k))
    || executions > (gate.executions ?? 0);
  const strikes = progressed ? 1 : (gate.strikes ?? 0) + 1;
  fs.writeFileSync(gateFile, JSON.stringify({ session_id: session.session_id, keys, executions, strikes }));

  const cli = `node "${path.join(ROOT, 'bin', 'ast.mjs').replace(/\\/g, '/')}"`;
  const lines = todo.items.slice(0, SHOWN).map((i) => `- [${i.check}] ${i.what}${i.next ? `\n    next: ${i.next}` : ''}`);
  if (todo.items.length > SHOWN) lines.push(`- ... and ${todo.items.length - SHOWN} more (\`${cli} todo\`)`);

  if (strikes > MAX) {
    process.stdout.write(`${JSON.stringify({
      systemMessage: `Testing stop gate released after ${MAX} attempts without progress. ${todo.count} item(s) are still owed `
        + `and validate --final will fail until they are run or held with a real blocker. Run \`${cli} todo\` to see them.`,
    })}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify({
    decision: 'block',
    reason: [
      `Testing is not finished: ${todo.count} item(s) are still owed before \`validate --final\` can pass.`,
      ...lines,
      '',
      'Keep going: take the next item and run it now. Do not stop to ask between items.',
      'If an item genuinely cannot run (after trying locally, with a stand-in, by another route, and in reduced form), record it '
        + 'with `exec not-run` linked to an uncertainty whose status says what is outside your control -- that removes it from the queue.',
      'If you need the user to decide something, record it NEEDS_USER_INPUT linked to a user-input-required uncertainty, then ask once, batched.',
      `(Gate ${strikes}/${MAX}: it releases if the queue stops shrinking. AST_STOP_GATE=off disables it.)`,
    ].join('\n'),
  })}\n`);
}

try {
  await main();
} catch {
  // Fail open. A hook is not worth a broken session.
}
process.exit(0);
