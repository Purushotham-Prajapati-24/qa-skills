# Workflow: Recovery

Goal: pick up exactly where the last session stopped, without inheriting any of its
optimism.

Triggered by: "continue testing", a new session on a repository with existing state,
context compaction, agent restart, or a tool failure mid-run.

## The one rule

**Nothing is assumed to have completed unless a record on disk says so.** An execution
that was started and never finalised is `INTERRUPTED`. It is not `PASSED`. It is not
"probably fine". The absence of a failure record is not a success record.

## Protocol

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" session resume
```

This reads state, finalises orphaned executions as `INTERRUPTED`, appends an interruption
entry, and returns:

```jsonc
{
  "recoverable": true,
  "session_id": "SESSION-0031",
  "phase": "execute",
  "git": { "commit": "abc1234", "branch": "feat/checkout" },
  "orphaned_executions": [{ "execution_id": "EXEC-2026-00007", "issue": "marked INTERRUPTED on recovery" }],
  "unresolved_uncertainties": [ /* ... */ ],
  "remaining_work": [ /* ... */ ],
  "next_action": "..."
}
```

Then, in order:

**1. Has the code moved?**

```bash
git status --short
git rev-parse HEAD
```

Compare against the commit in the recovered state. If it changed, prior results describe
different code. Say so explicitly and decide which of them still stand — do not silently
carry forward a `PASSED` from a commit that no longer exists.

**2. Re-check the environment.** Capabilities are not durable across sessions.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" caps probe
```

Re-`declare` MCP and browser providers from your current tool list. A capability that
worked yesterday may be unauthorised today.

**3. Check integrity.**

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" validate
```

Dangling references or unfinished executions are repaired now, not reported later.

**4. Review open uncertainties.** Anything `user-input-required` is probably why the last
session stopped. Ask it again, plainly, and offer what you can do without it.

**5. Re-derive the next action.** Trust `next_action`, but sanity-check it against the
remaining work and the current commit. If they disagree, the code moved — re-plan.

## Re-running versus trusting

| Situation | Do |
| --- | --- |
| Same commit, evidence on disk, deterministic method | Trust it. Cite the original evidence ID and note the timestamp. |
| Same commit, method was exploratory (agent-driven browser) | Do **not** trust it as a gate. Exploration is not reproducible; it informs, it does not certify. |
| Commit changed, tests touch changed modules | Re-run. |
| Commit changed, tests are unrelated | Trust, but state the commit the evidence came from. |
| `INTERRUPTED` | Re-run from the start. A half-run tells you nothing. |
| Environment changed | Re-run anything environment-sensitive. |

## After a compaction

Context compaction loses conversation, not state. Everything that matters is on disk:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" session show
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" exec list
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" uncertainty list
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" finding list
```

Rebuild your understanding from those, not from memory. If something important was only
ever in the conversation, that is a bug in how the session was run — write it into state
now, before continuing.

## Telling the user

Be specific about what survived:

> Resuming `SESSION-0031`. The previous run reached the execute phase at commit `abc1234`;
> the working tree is now at `def5678`, so the 4 passing unit results still stand (they
> do not touch the changed files) but the E2E result does not — I will re-run it.
> `EXEC-2026-00007` was interrupted mid-run and tells us nothing, so it starts over. One
> blocker is still open: `U-00019`, payment credentials, waiting on you.
