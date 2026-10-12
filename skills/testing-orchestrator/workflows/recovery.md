# Workflow: Recovery

Goal: pick up exactly where the last session stopped, without inheriting any of its
optimism.

Triggered by: "continue testing", a new session on a repository with existing state,
context compaction, agent restart, or a tool failure mid-run.

## The one rule

**Nothing is assumed to have completed unless a record on disk says so.** An execution
that was started and never finalised is `INTERRUPTED`. It is not `PASSED`. It is not
"probably fine". The absence of a failure record is not a success record.

## Resume — never restart

**Continue the existing session; do not start a new one.** `session start` refuses while a
recent session has open runs or uncovered commitments, because starting over drops every
commitment, open run and owed item out of view. Use `session start --new` only when the user
asks for a genuinely fresh pass (a new PR, a new day's build). That archives the old session
and finalises its open runs as `INTERRUPTED`. A new session never inherits the old one's
runs, decisions, findings or applicability matrix: they describe other code.

## Protocol

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" session resume
```

This reads state, finalises abandoned runs as `INTERRUPTED`, and tells you what is owed:

```jsonc
{
  "recoverable": true,
  "session_id": "SESSION-0031",
  "phase": "execute",
  "git": { "commit": "abc1234", "branch": "feat/checkout" },
  "orphaned_executions": [{ "execution_id": "EXEC-2026-00007", "issue": "marked INTERRUPTED on recovery" }],
  "in_flight_executions": [],          // recent runs left open: a parallel explorer may own them
  "plan_progress": { "plan_id": "PLAN-00001", "committed": 12, "covered": 7, "remaining": 5 },
  "owed": { "count": 6, "items": [ /* the first ten items of `ast todo`, each with its next command */ ] },
  "next_action": "Continue the work queue (6 item(s) owed). Next: ...",
  "recorded_next_action": "..."         // what the session last stored, for comparison
}
```

A run is finalised as `INTERRUPTED` when nothing happened on it for 10 minutes, or nothing
since a recorded `session interrupt`. A run with recent activity is left open and listed in
`in_flight_executions`: you may have dispatched explorers that are still working. If you know
nothing else is running, `session resume --interrupt-all`. A finished run is final. A
re-run is a **new** execution with the same `plan_scenario_id`, and both stay on record.

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

**5. Work the queue.** `next_action` is derived from `ast todo`, not from memory. Take the
next owed item, run it, and loop on `todo` until it returns `"done": true`. If the commit
moved, re-plan first (save the new plan; commitments only ratchet up), then work the queue.

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

Context compaction loses conversation, not state. With hooks installed, the SessionStart
hook fires after a compaction and tells you the session is in progress and how much is owed.
Everything that matters is on disk:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" session resume     # what is owed, next action
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" plan progress      # every committed scenario and every attempt
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" todo               # the full work queue
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" finding verify     # which defects are proven
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
