# Changelog

Semantic versioning. See [docs/versioning.md](docs/versioning.md) for what is versioned
independently — document schemas and policy files carry their own versions.

## [0.6.0] - 2026-09-16

The GitHub adapter contract becomes executable, so the external-write protocol is enforced
in code rather than remembered by the agent.

### Added

- `engine/adapters/base.mjs` - `performWrite`, the single path to a ledger entry. It runs
  capability -> authorisation -> duplicate ledger -> render -> perform -> parse -> record ->
  evidence, in that order, and a caller cannot use half of it. `performRead` for the read
  side, which always produces corroborating (never execution) evidence.
- `engine/adapters/github.mjs` - the GitHubAdapter: five reads, four writes, `preflight`
  that distinguishes authentication from scope, and parsers that derive confirmation from
  GitHub's own response.
- **Delegated-write tickets.** Node cannot call an MCP tool, so when a capability resolves
  to an MCP provider the adapter runs the gates, issues a single-use ticket with the
  rendered content, and `completeWrite` finishes the protocol. A ledger entry cannot be
  created without a ticket; a ticket cannot be issued without passing the gates. Tickets
  expire after an hour, because authorisation is per-session and does not keep.
- **Provider error classification** covering 401, 403, 404, 422, 429, network errors and
  timeouts. Each carries a status and a stated next action. Network errors and timeouts are
  explicitly **not** retry-safe: the write may have landed, and retrying blindly is how
  duplicate issues get created.
- The exact body sent to each external system is kept under
  `state/external-writes/bodies/`, so "what did the agent actually put in that issue?"
  stays answerable.
- CLI: `github preflight`, `github read`, `github file-issue`, `github comment`,
  `github assign`, `adapter complete`, `adapter pending`, `adapter systems`.
- 29 adapter tests. The central property: each gate is asserted to refuse **before** the
  provider is called, by checking the injected executor recorded zero calls.

### Changed

- `skills/defect-reporting` and the orchestrator's reporting workflow now route through
  `ast github file-issue` instead of instructing the agent to run `gh` itself. The
  behavioural guarantee is replaced by a structural one.
- `bin/ast.mjs` awaits command results. Adapter commands are async, and without this a
  promise serialised as `{}` - which looks exactly like a successful empty result. A
  refused or blocked adapter call now also exits non-zero.

### Fixed

- The URL parser dropped the `#issuecomment-N` anchor, so a confirmed comment could not be
  distinguished from its parent issue. A comment URL without its anchor is now reported
  unconfirmed rather than being keyed to the issue.
- A `*/` inside `integrations/*/adapter.md` in a block comment terminated the comment early
  and broke the module. Paths in comments now use `<system>`.

### Notes

- `confirmed: true` is still only ever set by parsing a real identifier out of the
  provider's response. Exit code 0 with no identifier is `INCONCLUSIVE`, and the report
  prints `NOT CONFIRMED`.
- The delegated path is weaker than the CLI path: the agent could perform a call and never
  return. It cannot fabricate a *confirmed* write, because confirmation is derived here.

## [0.5.0] - 2026-09-16

Initial implementation. Core engines are implemented and tested; integration adapters are
specified, and bound where a provider exists. See [PROGRESS.md](PROGRESS.md) for the honest
breakdown of what is implemented versus designed.

### Engines

- **State engine** with atomic writes and a recovery protocol that marks unfinished
  executions `INTERRUPTED` rather than inferring success.
- **Evidence engine** with the false-confidence gate: `PASSED` without execution evidence is
  downgraded to `INCONCLUSIVE` with the reason recorded.
- **Risk engine** — 14 factors, 4 weighting profiles, unevidenced factors excluded rather
  than guessed, confidence reported as the share of profile weight actually evidenced.
- **Applicability engine** — 47 test categories, 35 repository signals, priority-tiered
  budget selection so a budget never drops P0 work in favour of cheap P2 wins.
- **Browser decision engine** — 5 methods, 15 factors, 4 hard rules, ambiguity gate that
  escalates rather than guessing.
- **Decision engine** enforcing ≥2 options, ≥1 itemised reason, a confidence value and a
  reversibility flag; plus adaptive next-action derived from failure classification.
- **Execution engine** with open-before/close-after semantics.
- **Defect engine** with content fingerprints suppressing duplicate filings across sessions.
- **Uncertainty register** that partitions work so a blocker stops one branch, not the session.
- **Failure classifier** ranking non-product causes above `product-defect` on a tie.
- **Flakiness analysis** requiring ≥3 runs at the same commit.
- **Capability registry** — 37 verbs, 13 providers, three-state availability where
  undeclared means unavailable.
- **Authorization engine** with a 6-level policy, a prohibited-by-default list, and an
  external-write ledger.
- **Traceability graph** answering "what remains untested", with an explicit caveat about
  requirements nobody declared.
- **Reporting engine** rendering Markdown from the JSON record, with an integrity self-audit.
- **Evaluation engine** — benchmark runner plus 14 metrics, each with a stated blind spot.

### Skills

`testing-orchestrator` with 5 workflows and 5 policies, plus 20 specialists. Four subagents:
`repository-analyst`, `evidence-auditor`, `browser-explorer`, `test-author`.

### Infrastructure

- `bin/ast.mjs` — 50+ subcommands, zero dependencies.
- 11 JSON schemas with a hand-written draft-07 subset validator that **throws on unsupported
  keywords** rather than ignoring them.
- 15 benchmark cases (41 checks), 61 unit and lifecycle tests, a repository self-check.
- Two Claude Code hooks: `SessionStart` (surface in-progress state) and `PreToolUse` (refuse
  catastrophic shell commands).
- `scripts/demo-session.mjs`, which generates the example artefacts rather than shipping
  hand-written ones.

### Calibration notes

Four benchmark cases were written with expectations the engines did not meet. Each was
examined rather than loosened:

- **case-01** — the engine was right (`negligible` at 0.14, not `low`). Expectation corrected.
- **case-02 / case-05** — the band was over-specified; the real assertion is "at least high",
  now expressed with `one_of`. Case 05 surfaced a genuine signal: the `balanced` profile
  weights irreversibility at 0.8, landing a lossy migration at 0.81, just under `critical`.
  Teams shipping lossy migrations should use `security-critical`.
- **case-11** — the factor set contains nothing naming *which* browser framework a repository
  uses, so the matrix cannot distinguish C from E. That comes from the repository profile.

Each is recorded in the relevant case's `reasoning_notes`.

### Bugs found and fixed during implementation

Recorded because they are the kind that would otherwise recur:

- The redactor masked `session_id` and `authorised_by` because they *look* like secrets,
  corrupting the records it was meant to protect. Fixed with a `SAFE_KEYS` allowlist, covered
  by a test.
- `undefined` property values validated as present, so a record could pass validation and
  fail on reload. The validator now treats `undefined` as absent, matching JSON semantics.
- Budget-limited category selection was greedy by score, which could drop a P0 category in
  favour of several cheap P2 ones. Now walks priority tiers.
- `captureOutput` redacted before handing text to `add`, so the `redacted` flag was always
  false — the record claimed it was clean when it had been cleaned. Now passes raw text and
  lets `add` redact and flag honestly.
- The report headline counted only `kind === "defect"`, under-reporting a session whose only
  finding was a `security-issue`.
- The redactor's key pattern was `pass(word|phrase)?`, making the suffix optional, so it
  matched `passed` and masked test pass counts as `[REDACTED]` — corrupting every execution
  record that carried totals. Also tightened `token` to match as a whole segment so
  `tokens_used` is not treated as a secret.
- The redactor used a visited-set for cycle detection, so the *second* reference to a shared
  array (an execution's `evidence` and its `failure_classification.evidence_refs` are usually
  one array) became `"[circular]"` and failed its own schema. Now tracks the DFS path, so
  only a genuine ancestor counts as a cycle.
- `ast validate` extracted a record's ID through a fallback chain, so executions were keyed
  by `decision_id` and evidence by `execution_id` — making every real reference look
  dangling. The ID field is now pinned per collection.

  All three were found by running `ast validate` against the demo session's state, which is
  the argument for having the demo at all: the unit tests passed throughout.

### Known limitations

- The benchmark exercises decision machinery against fixed inputs. It cannot verify that the
  agent gathers correct inputs from a real repository.
- Google Docs/Drive adapters are specified but unbound — no server was available. The
  always-available fallback is versioned Markdown under `state/reports/`.
- Decision accuracy is self-assessed unless a human sets the verdict.
- Redaction cannot recognise a secret that looks like ordinary text.

[0.6.0]: https://github.com/your-org/autonomous-software-testing/releases/tag/v0.6.0
[0.5.0]: https://github.com/your-org/autonomous-software-testing/releases/tag/v0.5.0
