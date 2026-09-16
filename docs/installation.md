# Installation and setup

## Requirements

- **Node.js ≥ 20.6** — the only hard requirement. No `npm install`; there are no
  dependencies.
- Claude Code 2.1+ for the skills and hooks.
- Everything else is optional and degrades honestly.

```bash
node --version
node bin/ast.mjs version
```

## Two ways to install

### A. As a Claude Code plugin (recommended)

Skills arrive namespaced (`/autonomous-software-testing:testing-orchestrator`), and you get
the subagents, hooks and MCP config with them.

```bash
# In an interactive claude session:
/plugin marketplace add /absolute/path/to/autonomous-software-testing
/plugin install autonomous-software-testing
```

Or point the marketplace at a git URL once you have pushed it.

### B. As project skills

Copy the skills into a repository's `.claude/skills/`, or your personal `~/.claude/skills/`:

```bash
node scripts/install-skills.mjs --target /path/to/your/repo/.claude/skills
node scripts/install-skills.mjs --target ~/.claude/skills --link   # symlink instead of copy
```

Symlinks mean edits here take effect immediately, which is what you want while developing.
Copies are what you want when shipping to a team that will not have this checkout.

This path gives you skills only — no subagents, no hooks. Add those by hand if you want
them.

## Initialise state

```bash
node bin/ast.mjs init
node bin/ast.mjs caps probe
```

`caps probe` reports what this environment can actually do. Read it before trusting any
plan.

By default, state lives in `<plugin>/state`. To put it elsewhere — for example inside the
repository under test, so testing history travels with the code:

```bash
export AST_STATE_DIR=/path/to/your/repo/.testing-state     # bash
$env:AST_STATE_DIR = "D:\repo\.testing-state"              # PowerShell
node bin/ast.mjs --state /path/to/dir session show         # per-command
```

## Declaring what only you can see

The probe checks commands and environment variables. It cannot see your MCP tool list — so
you tell it:

```bash
node bin/ast.mjs caps declare mcp-playwright true  --note "browser_* tools present"
node bin/ast.mjs caps declare builtin-browser true --note "in-app browser pane available"
node bin/ast.mjs caps declare mcp-github false     --note "connector not authorised in this session"
```

Undeclared means **unknown**, which is treated as unavailable. That is deliberate: a
capability wrongly assumed present produces a plan that silently never runs.

## Optional integrations

### Playwright MCP

Already in `.mcp.json`. It runs via `npx` on first use:

```bash
npx playwright install chromium     # browser binaries, if you also want to run committed specs
```

### GitHub

The `gh` CLI is the provider that works most often:

```bash
gh auth status     # check it is authenticated AND check the token scopes
```

`repo` scope covers issues and PRs. Without it, reads can succeed while writes fail — and a
failed write is recorded as unconfirmed, not retried.

### Jira

Either authorise the Atlassian connector in an interactive session, or use the REST
fallback:

```bash
export JIRA_BASE_URL=https://your-org.atlassian.net
export JIRA_EMAIL=you@example.com
export JIRA_API_TOKEN=...          # id.atlassian.com/manage-profile/security/api-tokens
node bin/ast.mjs caps resolve jira.read_ticket
```

### Google Docs / Drive

No server ships here. Add one and declare it. Without it, the testing log falls back to
versioned Markdown under `state/reports/`, and the agent says so in the report rather than
quietly dropping the obligation.

## Verify the installation

```bash
node --test "tests/*.test.mjs"     # 90 tests
node bin/ast.mjs eval run          # 15 benchmark cases, 41 checks
node scripts/validate-repo.mjs     # links, schemas, cross-references
```

All three should be green. If `eval run` fails after you have edited a policy file, that is
the suite doing its job — see [../evaluation/README.md](../evaluation/README.md).

## First run

```
Test this repository.
```

The orchestrator will check for existing state, probe capabilities, profile the repository,
and come back with what it found and what it proposes — before running anything expensive.

## Uninstalling

```bash
/plugin uninstall autonomous-software-testing
```

State under `state/` is yours and is not removed. Delete it deliberately if you want to.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `Cannot find module '…/tests'` | Use `node --test "tests/*.test.mjs"` — the bare directory form does not work on this Node version |
| `Corrupt JSON … Unexpected token '\ufeff'` | A UTF-8 BOM. `readJson` strips it; if you see it elsewhere, write the file without a BOM |
| `Unknown repository signal` | The signal is not declared in `engine/applicability-engine/catalog.json` — add it rather than removing the check |
| `Risk factor "x" has a value but no basis` | Working as designed. An unexplained number is not a risk assessment |
| `A decision needs at least two candidate options` | Working as designed. If there was only one path, it is an assumption, not a decision |
| Capability shows `available: null` | Nobody declared it. `ast caps declare <provider> true\|false` |
