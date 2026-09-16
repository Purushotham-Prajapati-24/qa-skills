# Technology assumptions

Everything here was verified at the date shown, against the source shown. All of it moves.
When something in this system stops working, check this page first — an assumption has
probably expired.

**Verified: 2026-09-16.**

## Claude Code

| Assumption | Source | If it changes |
| --- | --- | --- |
| Skills live at `.claude/skills/<name>/SKILL.md`, or `skills/<name>/SKILL.md` in a plugin | [code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills) | Move the `skills/` tree; nothing else changes |
| Frontmatter must open on **line 1** or the whole file is treated as content | same | `scripts/validate-repo.mjs` checks this |
| `description` + `when_to_use` are truncated at **1,536 characters** in listings | same | Update the cap in `validate-repo.mjs` |
| SKILL.md should stay under **500 lines**; detail goes in supporting files | same | Warning threshold in `validate-repo.mjs` |
| `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}` substitutions | same | Used in `hooks/hooks.json` and `.mcp.json` |
| Plugin layout: `.claude-plugin/plugin.json`, with `skills/ agents/ commands/ hooks/ .mcp.json` at the **plugin root**, not inside `.claude-plugin/` | [plugins-reference](https://code.claude.com/docs/en/plugins-reference) | Restructure; the docs are explicit that this is a hard rule |
| Only `name` is required in `plugin.json` | same | — |
| Hooks support `SessionStart` and `PreToolUse` with exec-form `command` + `args`, JSON on stdout, `permissionDecision` deny | [hooks](https://code.claude.com/docs/en/hooks) | Rewrite `hooks/hooks.json` |
| Hook exit code 2 blocks on `PreToolUse`; other codes are non-blocking | same | Our hooks use `permissionDecision`, not exit codes |
| Subagents live in `agents/*.md` with `name`, `description`, `tools`, `model` frontmatter | [sub-agents](https://code.claude.com/docs/en/sub-agents) | Update `agents/` |

Note: `docs.claude.com/en/docs/claude-code/*` now **301-redirects** to
`code.claude.com/docs/en/*`. Links in this repository use the new host.

## Node.js

| Assumption | Detail |
| --- | --- |
| Node ≥ 20.6 | ESM, `node:test`, `node --test` with a glob |
| **Zero runtime dependencies** | Deliberate: the system must run offline with no `npm install`. The cost is a hand-written JSON Schema subset validator. |
| `node --test "tests/*.test.mjs"` | The bare directory form (`node --test tests/`) fails on this Node version; the glob is required |

### The JSON Schema subset

`engine/schema/validate.mjs` implements a **subset** of draft-07: `$ref` (local and
cross-file), `type`, `enum`, `const`, `required`, `properties`, `patternProperties`,
`additionalProperties`, `items` (schema and tuple), `minItems`, `maxItems`, `uniqueItems`,
numeric bounds, `multipleOf`, string length, `pattern`, `format` (`date-time`, `date`,
`uri`, `email`), `allOf`, `anyOf`, `oneOf`, `not`, `dependentRequired`, `nullable`.

Anything else **throws at schema-load time** rather than being silently ignored. A
silently-ignored keyword makes a schema look stricter than it is, which is worse than a
crash.

`undefined` property values are treated as absent, because JSON serialisation drops them —
validating them as present would let a record pass now and fail on reload.

## Playwright MCP

Tool names verified against [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp):
`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`,
`browser_fill_form`, `browser_select_option`, `browser_press_key`, `browser_hover`,
`browser_find`, `browser_take_screenshot`, `browser_console_messages`,
`browser_network_requests`, `browser_resize`, `browser_evaluate`, `browser_wait_for`,
`browser_tabs`, `browser_close`. Network mocking, tracing and `browser_generate_locator`
sit behind `--caps`.

**These names appear only in documentation**, never in skill logic. Skills ask for
`browser.explore`. `scripts/validate-repo.mjs` fails the build if a skill hard-codes an
`mcp__*` tool name.

## GitHub

| Assumption | Detail |
| --- | --- |
| `gh` CLI provides issues, PRs and runs with `--json` | Probed via `gh auth status` |
| Token **scopes** matter, not just successful auth | `repo` covers issues and PRs; reads can work while writes fail |
| REST rate limits: 5,000/hour authenticated, 30/minute for search | Treat 429 as authoritative |
| The official GitHub MCP server usually needs OAuth | Cannot be authorised in a non-interactive session |

## Jira

| Assumption | Detail |
| --- | --- |
| Cloud REST v3 at `/rest/api/3/` | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` |
| Descriptions and comments are **ADF**, not Markdown | Must be parsed and produced as a node tree |
| Custom field IDs differ per instance | Never assume `customfield_10001` means the same thing anywhere else |
| Rate limits are dynamic, not a published number | Honour `Retry-After` |

## Google

No Google Docs or Drive MCP server ships with this plugin, and none was present in the
environment where it was built. The adapter contracts are specified; the always-available
fallback is `local-doc-mirror`, which writes versioned Markdown under `state/reports/`.

## Environment where this was built

Windows 11, PowerShell 5.1 and Git Bash, Node 22.17.1, Python 3.12.10, `gh` authenticated,
Docker present, no `uv`. Two consequences baked into the code:

- `readJson` strips a UTF-8 **BOM**, because Windows PowerShell's `Out-File -Encoding utf8`
  writes one by default and hand-authored fixtures routinely carry it.
- Hook scripts are written in **Node**, not shell, so they behave identically on Windows
  and POSIX.

## How to re-verify

```bash
node --version && node bin/ast.mjs version
node bin/ast.mjs caps probe
node bin/ast.mjs eval run
node --test "tests/*.test.mjs"
node scripts/validate-repo.mjs
```

If the docs links above have moved again, update this file in the same commit as the fix.
An assumptions page that is quietly wrong is worse than no assumptions page.
