#!/usr/bin/env node
/**
 * PreToolUse hook — a last-resort guard on shell commands.
 *
 * This is NOT the authorization system. `engine/authorization` is, and it works because
 * the agent consults it. This hook catches the case where that reasoning was skipped, for
 * a small set of commands whose blast radius is large and irreversible.
 *
 * Deliberately narrow. A guard that fires constantly gets disabled, and then it guards
 * nothing. It denies (exit via permissionDecision) rather than crashing, and fails open on
 * any internal error.
 */
import fs from 'node:fs';

/** Patterns that are refused outright. Each carries the reason shown to the agent. */
const DENY = [
  [/\bgit\s+push\b[^\n]*--force(?!-with-lease)/i, 'Force push discards history irreversibly. Use --force-with-lease, and only when the user asked for it.'],
  [/\bgit\s+push\b[^\n]*\s-f\b/i, 'Force push discards history irreversibly.'],
  [/\bDROP\s+(DATABASE|SCHEMA)\b/i, 'Dropping a database or schema is irreversible and is never part of testing.'],
  [/\bTRUNCATE\s+TABLE\b/i, 'TRUNCATE is irreversible. Use a disposable test database and recreate it instead.'],
  [/\bDELETE\s+FROM\s+\w+\s*(;|$)/i, 'An unqualified DELETE removes every row. Add a WHERE clause or use a disposable database.'],
  [/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+\/(?:\s|$)/i, 'Recursive force delete of the filesystem root.'],
  [/\bgh\s+pr\s+merge\b/i, 'Merging a pull request is prohibited by default for this agent. The user performs merges.'],
  [/\bgh\s+(issue|pr)\s+close\b/i, 'Closing issues or pull requests is prohibited by default for this agent.'],
  [/\bgh\s+repo\s+delete\b/i, 'Deleting a repository is prohibited.'],
  [/\bgh\s+(issue|pr)\s+edit\b[^\n]*--add-assignee/i, 'Assignment requires the user to name the account explicitly. The agent must never choose an assignee.'],
];

/** Patterns that are allowed but worth flagging in the transcript. */
const WARN = [
  [/\bnpm\s+audit\s+fix\b[^\n]*--force/i, 'This can install breaking major versions. Confirm the user wants it.'],
  [/\b(k6|artillery|ab|wrk|siege|locust)\b/i, 'Load-generating tool detected. Load traffic needs explicit authorisation and a non-production target.'],
  [/\b(nmap|nikto|sqlmap|zap-cli|wpscan)\b/i, 'Active security scanning needs authorisation from whoever owns the target host.'],
  [/\bgit\s+reset\s+--hard\b/i, 'This discards uncommitted work in the working tree.'],
];

function out(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

let input = '';
try {
  input = fs.readFileSync(0, 'utf8');
} catch {
  process.exit(0); // no stdin: nothing to inspect
}

try {
  const payload = JSON.parse(input);
  const command = String(payload?.tool_input?.command ?? '');
  if (!command) process.exit(0);

  for (const [pattern, reason] of DENY) {
    if (pattern.test(command)) {
      out({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `[autonomous-software-testing] ${reason} See skills/testing-orchestrator/policies/authorization-policy.md. If the user genuinely wants this, they should run it themselves or restate the request knowing the consequence.`,
        },
      });
      process.exit(0);
    }
  }

  const warnings = WARN.filter(([pattern]) => pattern.test(command)).map(([, reason]) => reason);
  if (warnings.length) {
    out({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: `[autonomous-software-testing] ${warnings.join(' ')}`,
      },
    });
  }
} catch {
  // Fail open.
}
process.exit(0);
