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

## Install

### The one command

```bash
npx --yes github:Purushotham-Prajapati-24/qa-skills
```

Run it from the root of the repository you want to test. No clone, no `npm install` —
there are no dependencies to fetch.

It writes only inside `.claude/`:

```
.claude/
  skills/     21 skills        where Claude Code looks for them
  agents/     4 subagents
  ast/        the runtime      CLI, engines, schemas, docs, templates
```

**Why a runtime directory?** The skills call the `ast` CLI for everything that must be
deterministic. In this source repository that CLI is at `bin/ast.mjs`; in your repository it
is not. So the installer copies the runtime to `.claude/ast/` and rewrites the command in
every installed skill to match. It then runs the installed CLI to prove the rewrite worked,
and warns if any skill still points at the old path.

### Options

| Flag | Effect |
| --- | --- |
| *(none)* | Install into `./.claude` — this repository only |
| `--user`, `--global` | Install into `~/.claude` — every project on this machine |
| `--target <dir>` | Install into a specific directory's `.claude` |
| `--only a,b,c` | Install only these skills |
| `--hooks` | Also wire SessionStart and PreToolUse into `.claude/settings.json` |
| `--force` | Overwrite an existing install (it refuses by default) |
| `--dry-run` | Print the plan and change nothing |
| `--help` | |

### Pin a version

Tracking the default branch means you get changes as they land. To pin:

```bash
npx --yes github:Purushotham-Prajapati-24/qa-skills#v0.9.0
```

Or install from a release tarball, which needs no git:

```bash
npx --yes https://github.com/Purushotham-Prajapati-24/qa-skills/releases/download/v0.9.0/autonomous-software-testing-0.9.0.tgz
```

### If npx picks the wrong command

The package declares two binaries (`autonomous-software-testing` for the installer, `ast`
for the CLI). If npx cannot work out which you meant, say so:

```bash
npx --yes -p github:Purushotham-Prajapati-24/qa-skills autonomous-software-testing
```

### As a Claude Code plugin

Namespaced skills plus the subagents, hooks and MCP config in one go:

```bash
/plugin marketplace add https://github.com/Purushotham-Prajapati-24/qa-skills
/plugin install autonomous-software-testing
```

Nothing is copied into your repository and nothing is rewritten. The skills live in Claude
Code's plugin cache and your working directory stays the repository under test, so the
skills address the CLI through `${CLAUDE_PLUGIN_ROOT}` — a placeholder Claude Code replaces
with the plugin's absolute path before the agent reads the skill. You never type it
yourself; the agent proves it resolves with `ast version` as its first command of every
session.

This is why the skills do **not** say `node bin/ast.mjs`: that path only exists inside this
source repository, and under a plugin install it would resolve against your repository and
fail.

### From a clone

```bash
git clone https://github.com/Purushotham-Prajapati-24/qa-skills.git
cd qa-skills
node bin/install.mjs --target /path/to/your/repo
```

## Initialise state

```bash
node .claude/ast/bin/ast.mjs init
node .claude/ast/bin/ast.mjs caps probe
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
node --test "tests/*.test.mjs"     # 221 tests
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
# npx install
rm -rf .claude/ast .claude/agents
node -e "require('fs').readdirSync('.claude/skills').forEach(s=>require('fs').rmSync('.claude/skills/'+s,{recursive:true,force:true}))"

# plugin install
/plugin uninstall autonomous-software-testing
```

Nothing is written outside `.claude/`. Your testing history under `.claude/ast/state/` is
yours and is not removed — delete it deliberately if you want to.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `Cannot find module '…/tests'` | Use `node --test "tests/*.test.mjs"` — the bare directory form does not work on this Node version |
| `Corrupt JSON … Unexpected token '\ufeff'` | A UTF-8 BOM. `readJson` strips it; if you see it elsewhere, write the file without a BOM |
| `Unknown repository signal` | The signal is not declared in `engine/applicability-engine/catalog.json` — add it rather than removing the check |
| `Risk factor "x" has a value but no basis` | Working as designed. An unexplained number is not a risk assessment |
| `A decision needs at least two candidate options` | Working as designed. If there was only one path, it is an assumption, not a decision |
| Capability shows `available: null` | Nobody declared it. `ast caps declare <provider> true\|false` |
