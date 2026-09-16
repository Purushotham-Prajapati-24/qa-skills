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
  const stateDir = process.env.AST_STATE_DIR
    ? path.resolve(process.env.AST_STATE_DIR)
    : path.join(ROOT, 'state');
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
  lines.push(
    'Before starting anything new, run `node bin/ast.mjs session resume` from the plugin root and follow skills/testing-orchestrator/workflows/recovery.md.',
  );

  emit(lines.join('\n'));
} catch {
  // Fail open. A hook is not worth a broken session.
}
process.exit(0);
