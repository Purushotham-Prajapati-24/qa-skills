# Versioning

Six things are versioned independently, because they change at different rates and for
different reasons.

## A. The skill system

Semantic versioning, in `package.json` and `.claude-plugin/plugin.json`. Currently
**0.5.0**.

| Bump | When |
| --- | --- |
| **major** | A schema changes incompatibly, a capability verb is removed or renamed, or a policy default reverses |
| **minor** | A new skill, a new test category, a new capability verb, a new risk profile |
| **patch** | Wording, docs, bug fixes, threshold tuning that the benchmark confirms is behaviour-preserving |

Every report and every persisted record stamps the version that produced it. That is what
lets you answer "did the agent get worse after 0.6.0?" — you can find every report produced
by each version.

## B. Document schemas

`engine/core/version.mjs` → `DOC_VERSIONS`. A schema bumps only when its **shape** changes,
independently of the system version, so old records stay readable and `ast validate` can
tell you which migration you owe.

```
repository-profile  1.0.0
testing-plan        1.0.0
session-state       1.0.0
report              1.0.0
```

## C. Policy files

Each carries its own `version`, and decisions reference it:

```jsonc
"policy_refs": ["browser-decision.matrix@1.0.0#hybrid_trigger"]
```

So when a decision looks wrong six months later, you can tell whether the *reasoning* was
wrong or the *policy* has since changed underneath it. Without this, every old decision is
unfalsifiable.

Versioned policies: `engine/risk-engine/weights.json`,
`engine/applicability-engine/catalog.json`, `engine/browser-decision/matrix.json`,
`engine/authorization/policy.json`, `engine/capability-registry/capabilities.json`.

## D. Record identifiers

Allocated by `engine/core/ids.mjs` from a single counters file, so two records can never
collide.

| Kind | Format | Scope |
| --- | --- | --- |
| Session | `SESSION-0031` | global |
| Decision | `DEC-00042` | global |
| Execution | `EXEC-2026-00142` | per year |
| Evidence | `EV-2026-00311` | per year |
| Finding | `FIND-00042` | global |
| Uncertainty | `U-00019` | global |
| Report | `REPORT-2026-00142` | per year |
| Test case | `TC-00123` | global |
| Plan | `PLAN-00007` | global |

Year-scoped counters restart each January, which keeps IDs short without ever repeating a
full identifier. Every ID is greppable: `grep -r "DEC-00042" state/` finds everything that
references it.

## E. Reports

A report is immutable. A new one **supersedes** rather than overwrites:

```jsonc
{ "report_id": "REPORT-2026-00143", "supersedes": "REPORT-2026-00142" }
```

Never "report v2 final FINAL". The chain of supersession is the history.

## F. Testing strategy documents

In the external documentation layer, use whole-number versions (`v2.0`) for the strategy —
it changes rarely and deliberately — and rely on the platform's native revision history for
the append-only log. Name each revision with the report ID so a document revision traces
back to the state that produced it.

## Changing a policy safely

```bash
# 1. Edit the JSON
# 2. Both must stay green
node bin/ast.mjs eval run
node --test "tests/*.test.mjs"
# 3. Bump the policy's own "version"
# 4. Record what changed in CHANGELOG.md, including which benchmark cases moved
```

The benchmark exists precisely to catch the case where tuning a risk weight silently
changed the browser-method decision in an unrelated case. If a benchmark case now fails,
decide honestly whether the **expectation** was wrong or the **policy** is — and write down
which, in the case's `reasoning_notes`.

## Migrating records

When a schema version bumps incompatibly:

1. Add the new fields as optional first; ship a minor version.
2. `ast validate` reports records that do not conform.
3. Write a one-off migration under `scripts/`, run it, re-validate.
4. Make the fields required; ship the major version.

Never silently reinterpret an old record under a new schema. A record means what it meant
when it was written.
