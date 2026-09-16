# MCP and connector configuration

**Nothing here is required.** Every capability resolves through the registry and degrades
honestly when a provider is absent. A missing MCP server makes some testing `BLOCKED`; it
never makes the system lie.

## The indirection, and why

```
skill asks for:        github.create_issue
registry resolves:     mcp-github (not authorised) → gh-cli (authenticated) ✓
skill never knows:     which one answered
```

MCP tool names are the least stable thing in this stack. With this indirection, a server
renaming its tools is a one-line change in one JSON file instead of an edit across 21
skills. `scripts/validate-repo.mjs` fails the build if any skill hard-codes an `mcp__*`
name.

## Check what you have

```bash
node bin/ast.mjs caps probe        # runs the probes it can
node bin/ast.mjs caps list         # every verb and how it resolved
node bin/ast.mjs caps resolve browser.explore
```

Three states, and the third matters:

| `available` | Meaning |
| --- | --- |
| `true` | Probed or declared present |
| `false` | Probed or declared absent |
| `null` | **Nobody declared it.** Treated as unavailable. |

`null` is deliberate. A capability wrongly assumed present produces a plan whose steps
silently never run.

## Declaring what the CLI cannot see

The probe can run `gh auth status` and check environment variables. It cannot see your MCP
tool list — only you can:

```bash
node bin/ast.mjs caps declare mcp-playwright true  --note "browser_navigate, browser_snapshot present"
node bin/ast.mjs caps declare builtin-browser true --note "in-app browser pane available"
node bin/ast.mjs caps declare mcp-atlassian false  --note "connector requires OAuth; not authorised here"
```

Declare from what is **actually in your tool list right now**, not from what is configured.
A configured-but-unauthorised connector is unavailable.

## Playwright MCP

Shipped in `.mcp.json`, started on demand via `npx`:

```json
{ "mcpServers": { "playwright": { "command": "npx",
  "args": ["@playwright/mcp@latest", "--isolated", "--headless",
           "--output-dir", "${CLAUDE_PLUGIN_DATA}/browser-artifacts"] } } }
```

- `--isolated` — profile in memory, so a test session never inherits or pollutes real
  browser state.
- `--output-dir` — where screenshots and traces land, so they can be registered as evidence.
- `--caps=devtools,pdf,testing` — opt into tracing, network mocking and
  `browser_generate_locator`.
- `--allowed-origins` — restrict what it can reach. Worth setting when testing anything
  that talks to the internet.

Tool names verified against
[microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp). They appear in
documentation only, never in skill logic.

For running **committed** Playwright specs you also need the browser binaries:

```bash
npx playwright install chromium
```

That is `browser.run_deterministic_test`, a different capability from `browser.explore`.
One can be available while the other is not.

## GitHub

The `gh` CLI is the provider that works most often, because developers already have it:

```bash
gh auth status
```

**Read the scopes, not just the success line.** `repo` covers issues and PRs. Without it,
reads succeed while writes fail — and a failed write is recorded `confirmed: false`, never
retried until something sticks.

The official GitHub MCP server is richer but usually needs an OAuth flow that cannot run in
a non-interactive session.

## Jira

Either authorise the Atlassian connector interactively, or use the REST fallback:

```bash
export JIRA_BASE_URL=https://your-org.atlassian.net
export JIRA_EMAIL=you@example.com
export JIRA_API_TOKEN=...
node bin/ast.mjs caps probe
```

The `jira-rest` provider probes for all three variables. Descriptions and comments are ADF,
not Markdown — see [../integrations/jira/adapter.md](../integrations/jira/adapter.md).

## Google Docs / Drive

No server ships here. Add one, then declare it. Without one, `docs.*` resolves to
`local-doc-mirror`: versioned Markdown under `state/reports/`, and the report says plainly
that the external log was not updated.

That fallback is the design, not a gap. A system that silently drops its documentation
obligation when a connector is missing is worse than one with no connector, because nobody
notices.

## Adding a server

1. Add it to `.mcp.json` (or your own MCP config).
2. Declare the provider in `engine/capability-registry/capabilities.json`.
3. Bind it to capability verbs, in preference order.
4. Add any write actions to `engine/authorization/policy.json` — unlisted actions are denied.
5. Write the adapter contract in `integrations/<system>/adapter.md`.
6. `node bin/ast.mjs caps declare <provider> true` and verify with `caps resolve`.

Full walkthrough in [extending.md](extending.md).

## Authorisation in a non-interactive session

Connectors needing OAuth cannot be authorised from a non-interactive session. If one is
required:

- Tell the user which server needs authorising, and where (claude.ai connector settings, or
  `claude mcp` / `/mcp` in an interactive session).
- Mark the affected capability unavailable.
- Report the affected test categories as `BLOCKED`.
- **Never ask the user for a token, an authorisation code or a callback URL.**

## Security

- A server you add can read what you point it at. Add deliberately.
- Restrict browser origins when testing anything internet-facing.
- Never put a credential in `.mcp.json` if that file is committed. Use environment
  variables or the plugin's `userConfig` with `"sensitive": true`.
- Everything persisted passes through redaction, but redaction is defence in depth — do not
  deliberately capture secret material as evidence.
