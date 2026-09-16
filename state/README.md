# state/

The agent's durable working memory. Everything here is generated at runtime, and it is
gitignored by default.

The conversation is not durable — it gets compacted, interrupted, restarted. So anything the
agent would be upset to lose is written here after every phase transition. That is what makes
"continue from the previous testing session" mean something real rather than "re-read the
chat and hope".

## Layout

```
state/
├── counters.json               ID allocation — one file, so IDs can never collide
├── testing-state.json          the current session
├── repository-profile.json     what it believes about the repository
├── capabilities-probe.json     what it believes it can do, and when it last checked
├── decisions/DEC-*.json
├── executions/EXEC-*.json
├── evidence/EV-*.json          + blobs/ for captured command output
├── findings/FIND-*.json
├── uncertainties/U-*.json
├── reports/REPORT-*.json|.md
├── external-writes/*.json      the idempotency ledger
│   ├── bodies/                 the exact content sent to each external system
│   └── pending/                delegated-write tickets, authorised but not yet completed
├── history/SESSION-*.json      archived previous sessions
└── telemetry/*.jsonl           append-only, redacted event stream
```

## Properties worth knowing

**Atomic writes.** Every file is written to a temp path and renamed, so an interrupted run
never leaves unparseable state. The recovery protocol depends on it.

**Redacted.** Everything persisted passes through `engine/core/redact.mjs`. Defence in depth,
not a guarantee — it cannot recognise a secret that looks like ordinary text.

**Greppable.** `grep -r "DEC-00042" state/` finds every reference to that decision.

**Sessions are archived, not overwritten.** Starting a new session moves the previous one to
`history/`. History is evidence.

## Somewhere else

```bash
export AST_STATE_DIR=/path/to/repo/.testing-state     # bash
$env:AST_STATE_DIR = "D:\repo\.testing-state"         # PowerShell
node bin/ast.mjs --state /path/to/dir session show    # per-command
```

Putting it inside the repository under test makes testing history travel with the code, which
is often what you want.

## Should you commit it?

**Read it first.** Evidence excerpts can contain data from whatever you tested — API
responses, database rows, screenshots. It is redacted for credentials, not for your
customers' names.

If you do commit it, you get a durable record of what was tested, when, at which commit, with
what evidence. That is genuinely valuable. Just decide deliberately rather than by default.

## Inspecting it

```bash
node bin/ast.mjs session show
node bin/ast.mjs exec list
node bin/ast.mjs finding list
node bin/ast.mjs uncertainty list
node bin/ast.mjs validate          # schemas + referential integrity
node bin/ast.mjs metrics
```

## Deleting it

Safe. The next session starts clean. You lose the history and the ability to resume — nothing
else.
