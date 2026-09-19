# Contributing

## Before anything

```bash
node --test "tests/*.test.mjs"     # 294 tests
node bin/ast.mjs eval run          # 15 benchmark cases, 41 checks
node scripts/validate-repo.mjs     # links, schemas, cross-references
```

All three green before you start and after you finish. `npm run check` runs the last two.

There are **no dependencies and no build step**. That is a constraint worth protecting: the
system must run offline with nothing but a Node runtime. If you need a library, first check
whether the 200 lines it would replace are actually the problem.

## The rule that decides most design questions

> If a change requires editing `engine/*/index.mjs`, first ask whether the **configuration**
> is missing an expressive dimension.

Engine changes need new tests and can break behaviour elsewhere. Configuration changes need a
benchmark case. The second is cheaper and safer, and the design intends it to be sufficient
almost always.

| Change | Where |
| --- | --- |
| Risk weighting or thresholds | `engine/risk-engine/weights.json` |
| Which testing applies | `engine/applicability-engine/catalog.json` |
| Browser method selection | `engine/browser-decision/matrix.json` |
| What needs authorisation | `engine/authorization/policy.json` |
| Tool bindings | `engine/capability-registry/capabilities.json` |

Full guide: [docs/extending.md](docs/extending.md).

## Writing a skill

- Directory name **must** match the frontmatter `name`. `validate-repo.mjs` checks this.
- Frontmatter opens on line 1, or Claude Code treats the whole file as content.
- `description` + `when_to_use` ≤ 1,536 characters combined — that is the listing cap, and
  the description is how Claude decides to invoke the skill at all.
- Keep `SKILL.md` under 500 lines. Detail goes in supporting files the skill links to.
- **Never name an MCP tool.** Ask for a capability verb. The validator fails the build on
  `mcp__*` in any skill or agent file.
- Say what the skill is *for* and what it is *not* for. A skill that claims everything gets
  invoked for everything.

Write like a senior engineer explaining their judgement to a capable colleague — the
trade-off and the reason, not a checklist. The specialist skills each contain a "common
mistakes" section for exactly this reason: knowing what not to do is most of the expertise.

## Changing a policy

1. Edit the JSON.
2. `node bin/ast.mjs eval run` — if a benchmark case moves, that is the suite working.
3. Decide honestly whether the **expectation** was wrong or the **policy** is. Four of the
   original cases had wrong expectations; each correction is recorded in the case's
   `reasoning_notes`. Changing an expectation to make a test pass is legitimate **only** when
   the expectation was wrong, and you must say why.
4. Bump the policy file's own `version`.
5. Note in `CHANGELOG.md` which cases moved.

## Changing a schema

Schemas are versioned separately from the system (`engine/core/version.mjs`, `DOC_VERSIONS`)
so old records stay readable.

Additive change → minor bump. Breaking change → add fields as optional first, ship, migrate,
then make them required.

**Never silently reinterpret an old record under a new schema.** A record means what it meant
when it was written.

Only the draft-07 subset in `engine/schema/validate.mjs` is supported — anything else throws
at schema-load time rather than being silently ignored. If you need another keyword, add it
to the validator **and** the `KNOWN` set, with a test.

## Tests

`tests/core.test.mjs` (IDs, redaction, schemas), `tests/decision-engines.test.mjs` (risk,
applicability, browser, classification), `tests/lifecycle.test.mjs` (the full session).

Use `useTempState()` from `tests/helpers.mjs` — never write into the repository's own `state/`.

Test the **guarantee**, not the implementation. `a PASSED claim without evidence is
downgraded, not accepted` survives a refactor; `verifyClaim returns an object with a
permitted key` does not.

The lifecycle tests are deliberately adversarial: they check that unevidenced claims get
downgraded, that duplicates are suppressed, that recovery refuses to infer success, that
assignment without a named account is refused. Those are the behaviours worth protecting.

## Adding a benchmark case

`evaluation/benchmark-cases/case-NN.json`. Include:

- `reasoning_notes` — what it is really checking. Without this it becomes uninterpretable
  within a month.
- `not_covered` — what it cannot check. Honesty about a test's limits is part of the test.

Prefer `one_of` and `at_least` where the meaningful assertion is a direction. Pinning an exact
score turns the case into a test of `weights.json` rather than of the reasoning, and then
every legitimate tuning change looks like a regression.

## Style

- British spelling in prose; American in code identifiers where the ecosystem uses it.
- Comments explain **why**, not what. A comment restating the code is noise; one explaining
  the constraint that forced an odd choice is the most valuable line in the file.
- Error messages tell the reader what to do. `A decision needs at least two candidate
  options. If there was only one path, record it as an assumption in the plan.` is worth five
  times `Invalid input`.
- No emoji in code or documentation.

## Documentation

Every behavioural change updates its documentation in the **same commit**. A docs page that
is quietly wrong is worse than no page, because it is trusted.

[docs/assumptions.md](docs/assumptions.md) records what was verified, when, and against what.
If you find an assumption has expired, fix it there in the same commit as the code change.

## Pull requests

State what changed, why, which benchmark cases moved and why that is correct, and what you
did **not** do. The last one matters most — an honest gap is more useful than an implied
completeness.

Run the demo if you touched anything in the pipeline:

```bash
node scripts/demo-session.mjs
```

It exercises every subsystem together and will tell you if a guarantee stopped holding.

## What not to contribute

- A dependency, unless it removes substantially more complexity than it adds.
- A skill that duplicates an existing one. Extend the existing one instead.
- A metric without a stated blind spot. Misused metrics drive worse behaviour than none.
- Anything that makes the agent more confident. The bias is the other way, deliberately.
