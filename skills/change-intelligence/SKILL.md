---
name: change-intelligence
description: Work out exactly what changed in a pull request, commit range, branch or described feature, which modules and user-facing behaviours it affects, which existing tests cover it, and where the coverage gaps are. Use when testing a PR or commit, deciding which tests to re-run, scoping regression testing, or answering what a change actually affects.
when_to_use: "test this PR", "what changed", "what should I re-run", "scope the regression for this commit", "what does this change break"
allowed-tools: Read, Glob, Grep, Bash, PowerShell
metadata:
  system_version: 0.7.0
  role: specialist
---

# Change Intelligence

Change-aware testing beats running everything. The output of this skill is a gap: what the
change affects, minus what existing tests already cover. That gap is the plan.

## 1. Establish the diff precisely

```bash
git merge-base HEAD origin/main
git diff --stat <base>...<head>
git diff --name-status <base>...<head>
git log --oneline <base>..<head>
```

For a PR, when `gh` is authenticated:

```bash
gh pr view <n> --json title,body,files,additions,deletions,baseRefName,headRefName,commits
gh pr diff <n>
```

If neither is available, say so and work from what the user described — clearly labelled
`reported-by-user`, not `observed`.

Record the base and head commits. Every later result is only valid for that head.

## 2. Read the diff, not just the file list

A 500-line diff that renames a variable and a 5-line diff that changes an authorisation
check carry opposite risk. Categorise each hunk:

| Kind | Testing implication |
| --- | --- |
| Behaviour change | Needs functional testing of the new behaviour **and** regression on the old |
| New behaviour | Needs new tests; nothing existing covers it |
| Refactor, no behaviour change | Existing tests should pass unchanged — that is the test |
| Dependency bump | Integration and regression; check the changelog for breaking changes |
| Config change | Often untested and high-impact. Verify the effective config, not the file |
| Schema / migration | Migration testing, data integrity, and rollback |
| Auth / permission change | Security testing across the role matrix, always |
| Deletion | What called this? Do those paths still work? |

## 3. Map impact outward

```bash
# Who imports the changed module?
grep -rn "from '.*<module>'" src/ --include=*.ts --include=*.tsx
grep -rn "require(.*<module>" src/
```

Walk the dependency graph until you reach a user-facing boundary: a route, a page, a CLI
command, a job. That boundary is what you actually test — users do not call functions.

## 4. Map to existing tests

```bash
grep -rln "<changed symbol>" test/ tests/ spec/ e2e/ __tests__/
```

For each impacted module, one of three answers:

- **Covered** — a test exercises this behaviour → re-run it.
- **Partially covered** — a test touches the module but not the changed branch → extend it.
- **Uncovered** — nothing → this is the gap.

Do not assume a test covering a file covers the changed lines. Check.

## 5. Produce the change summary

```jsonc
"change_summary": {
  "files_changed": 7, "insertions": 312, "deletions": 44,
  "impacted_modules": ["checkout/payment", "orders/create", "auth/session"],
  "user_facing_behaviour": [
    "Guest checkout now allows a saved card",
    "Order confirmation shows an estimated delivery date"
  ],
  "mapped_existing_tests": ["e2e/checkout.spec.ts", "src/orders/create.test.ts"],
  "coverage_gaps": [
    "No test covers the saved-card branch in checkout/payment",
    "auth/session change has no test at all"
  ]
}
```

## 6. Feed the risk engine

The change gives you evidence for several risk factors directly — use it rather than
guessing:

- `change_magnitude` — diff size relative to module size
- `change_frequency` — `git log --format=%H -- <path> | wc -l` over a window
- `dependency_complexity` — how many modules import the changed one
- `coverage_deficit` — from step 4
- `irreversibility` — does the change move money, send messages, or alter schema?

## 7. Recommend the scope

Deliver four lists:

1. **Re-run** — existing tests covering impacted paths.
2. **Write** — new tests for uncovered changed behaviour.
3. **Explore** — behaviour too new or unclear to assert yet.
4. **Skip** — and why. Usually "unrelated to anything in this diff", which is a good and
   sufficient reason.

## When there is no diff

The user describes a feature instead. Then: locate the implementation, treat it as
"changed", and say plainly that scope came from the description rather than from version
control. That distinction matters — a description can omit the change that breaks things.
