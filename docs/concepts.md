# Concepts, for someone new to agent skills

Everything you need to understand before configuring anything. No prior knowledge assumed.

## What is an agent skill?

A folder with a `SKILL.md` file in it. That is genuinely all.

```
skills/api-testing/
└── SKILL.md
```

`SKILL.md` is Markdown with a YAML header:

```yaml
---
name: api-testing
description: Test HTTP, GraphQL and gRPC APIs. Use when a change affects an API…
---

# API Testing

Instructions Claude follows when this skill is active…
```

A skill is **instructions Claude reads when it decides they are relevant.** It is not code.
It does not execute. Think of it as a colleague's notes on how to do a particular job well —
notes good enough that someone competent could follow them.

## How does Claude decide to use one?

It reads the `description` of every available skill. When your request matches one, it loads
that skill's content into the conversation and follows it.

This is why the `description` matters more than anything else in the file. A vague one
("helps with testing") never gets picked. A specific one that names the triggering
situations does.

You can also invoke one deliberately by typing `/api-testing`.

**Progressive disclosure:** only the descriptions are loaded up front. The body loads when
the skill is chosen. That is why `SKILL.md` stays under 500 lines and detail lives in
supporting files — like `skills/browser-testing/playwright-mcp.md` — which load only when
the skill points at them.

## What are tools?

The things Claude can actually *do*: read a file, run a command, edit a file, search the
web. Skills are instructions; tools are actions. A skill can restrict which tools apply
while it is active, via `allowed-tools`.

## What is MCP?

**Model Context Protocol** — a standard for giving Claude extra tools from an external
program. An MCP server is a program that exposes tools; Claude connects and can call them.

Examples: a Playwright MCP server exposing `browser_navigate` and `browser_click`; a GitHub
MCP server exposing issue creation.

MCP servers are configured in `.mcp.json`. **They are optional here.** This system is built
so that a missing MCP server degrades honestly rather than breaking — see *capabilities*
below.

## What is a connector?

A hosted integration you authorise once (usually through a browser OAuth flow), after which
Claude can use it. Mechanically similar to MCP; the difference is who runs the server and
how you authenticate. Jira and Google Drive typically arrive as connectors.

A connector that is configured but **not authorised** is unavailable. This system treats
that as "unavailable", never as "probably fine".

## What are hooks?

Programs Claude Code runs automatically at defined moments — before a tool call, when a
session starts. They are **deterministic shell processes, not the agent**: they cannot
reason, they just run and return a decision.

This system uses two:

- `SessionStart` → tells the agent if a testing session is already in progress on disk.
- `PreToolUse` → refuses a small set of catastrophic shell commands (force push, `DROP
  DATABASE`, merging a PR).

The hook is a backstop, not the authorisation system. The real gate is
`engine/authorization`, which works because the agent consults it.

## What are subagents?

A separate Claude instance with its own fresh context, its own instructions and a restricted
tool set. You delegate a chunk of work; it returns a summary.

Useful when the work would flood your context with output you do not need — surveying a
large repository, driving a long browser session. **Not** useful for small tasks: spawning
four subagents for a three-file change is theatre.

This system defines four: `repository-analyst`, `evidence-auditor`, `browser-explorer`,
`test-author`.

## What is state?

Files on disk that survive when the conversation does not.

The conversation is not durable. It gets compacted, interrupted, restarted. So everything
that matters is written to `state/`: the session, decisions, executions, evidence, findings,
uncertainties, reports.

That is what makes "continue from the previous testing session" mean something real rather
than "re-read the chat and hope".

## What is orchestration?

One skill that decides which other skills to use, in what order, based on what it finds.

`testing-orchestrator` does not contain the testing knowledge. It contains the **decision
process**: discover → profile → classify → assess risk → select → plan → execute → validate
→ document → decide next. It delegates the actual testing to specialists.

This is why the system is 21 skills rather than one enormous file: each is separately
readable, testable and replaceable.

## What are capabilities?

The key idea for integrations.

A skill never says "call `mcp__github__create_issue`". It says "I need
`github.create_issue`". Something else — the **capability registry** — works out which
provider can actually do that right now:

```
github.create_issue  →  GitHub MCP server?   not authorised
                     →  gh CLI?              yes, authenticated
                     →  resolved
```

If nothing can, the capability is **unavailable**, and the affected testing is reported
`BLOCKED`. Never simulated, never assumed.

Why bother? Because MCP tool names are the least stable thing in this stack. With this
indirection, a server changing its tool names is a one-line change in one JSON file instead
of an edit across 21 skills. `scripts/validate-repo.mjs` fails the build if any skill
hard-codes an MCP tool name.

## What is the decision engine?

Not a black box. It is three things:

1. **Configuration** — `weights.json` (risk), `catalog.json` (what testing applies),
   `matrix.json` (browser method), `policy.json` (what is allowed).
2. **Small deterministic functions** that combine configuration with evidence and produce a
   score plus an itemised explanation.
3. **A record** of each choice: the options considered, the one selected, the reasons,
   the confidence, and whether it can be undone.

You can disagree with any decision and change exactly one number to fix it.

## What is evidence, and why the fuss?

The system's central belief:

> **"I did not observe a failure" is not "it works."**

So a claim that something passed requires an artefact proving it ran: command output, a test
report, a trace, a coverage report. A screenshot shows what a page looked like; it does not
show that an assertion held.

If you claim `PASSED` with no evidence, the engine downgrades it to `INCONCLUSIVE` and
records why. You cannot route around this by asserting more confidently.

Every report states its own **false-confidence rate**. The target is zero.

## Which pieces are code, and which are judgement?

The dividing line that shapes the whole design:

| Code (`bin/ast.mjs`, `engine/`) | Judgement (`skills/`) |
| --- | --- |
| Allocating IDs | Deciding what is worth testing |
| Validating record shapes | Interpreting a diff |
| Refusing unevidenced claims | Judging whether something is a defect |
| Suppressing duplicate issues | Writing a useful reproduction |
| Computing metrics | Choosing how deep to go |

Bookkeeping is code because bookkeeping done by judgement drifts. Judgement is prose because
judgement encoded as code becomes a checklist bot.

## Next

- Install it: [installation.md](installation.md)
- Use it: [../README.md](../README.md)
- Watch it work: [../examples/](../examples/)
- Extend it: [extending.md](extending.md)
- When it misbehaves: [debugging.md](debugging.md)
