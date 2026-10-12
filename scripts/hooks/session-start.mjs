#!/usr/bin/env node
/**
 * SessionStart hook.
 *
 * If a testing session is already in progress on disk, tell the agent before it does
 * anything else. Without this, a resumed session cheerfully starts over and loses the
 * previous run's blockers and evidence.
 *
 * Read-only. Fails open: any error exits 0 with no output, because a broken hook must
 * never break the session.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

function emit(additionalContext) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
    })}\n`,
  );
}

try {
  // Same resolution as the CLI (flag/env, in-project runtime, or <project>/.testing-state), so
  // the hook never looks at a different state directory than the agent's commands write to.
  const { pathToFileURL: toUrl } = await import('node:url');
  const { stateRoot } = await import(toUrl(path.join(ROOT, 'engine', 'core', 'paths.mjs')).href);
  const stateDir = stateRoot();
  const sessionFile = path.join(stateDir, 'testing-state.json');

  if (!fs.existsSync(sessionFile)) process.exit(0);

  const s = JSON.parse(fs.readFileSync(sessionFile, 'utf8').replace(/^﻿/, ''));

  const openCount = (s.open_executions ?? []).length;
  const blockers = (s.blockers ?? []).length;
  const lines = [
    `An autonomous-software-testing session is already on disk: ${s.session_id}, phase "${s.phase}", last updated ${s.updated_at}.`,
    `Recorded next action: ${s.next_action}`,
  ];
  if (openCount) {
    lines.push(
      `${openCount} execution(s) were started and never finalised. They must be treated as INTERRUPTED, not as passed.`,
    );
  }
  if (blockers) lines.push(`${blockers} blocker(s) are still open.`);
  try {
    const { pathToFileURL } = await import('node:url');
    const { setStateRoot } = await import(pathToFileURL(path.join(ROOT, 'engine', 'core', 'paths.mjs')).href);
    setStateRoot(stateDir);
    const { outstanding } = await import(pathToFileURL(path.join(ROOT, 'engine', 'evaluation-engine', 'process-completeness.mjs')).href);
    const q = outstanding();
    if (!q.done) lines.push(`${q.count} item(s) are still owed before validate --final can pass (committed scenarios, unrun tests, unproven defects and the like).`);
  } catch {
    // The count is a courtesy; the instruction below stands without it.
  }
  const cli = `node "${path.join(ROOT, 'bin', 'ast.mjs').replace(/\\/g, '/')}"`;
  lines.push(
    `Do NOT start a new session. Continue this one: run \`${cli} session resume\` (it lists what is owed and the next action), then loop on \`${cli} todo\`. Follow skills/testing-orchestrator/workflows/recovery.md.`,
  );

  emit(lines.join('\n'));
} catch {
  // Fail open. A hook is not worth a broken session.
}
process.exit(0);
