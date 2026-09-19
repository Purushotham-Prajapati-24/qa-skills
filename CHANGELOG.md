# Changelog

Semantic versioning. See [docs/versioning.md](docs/versioning.md) for what is versioned
independently — document schemas and policy files carry their own versions.

## [0.10.0] - 2026-09-19

### Fixed

- **`ast adapter complete`'s own `--help` text was the one place in the CLI still leading
  with `--json '<provider response>'`** instead of `--input`, the shell-agnostic path every
  other command's help text already uses (G-08's fix #2: "keep `--json` in the CLI but
  remove it from the documented path"). The flag itself still works unchanged
  (`flags.json ? JSON.parse(flags.json) : payload(flags)`) -- only the shown example
  changed, to `--input response.json`. `bin/ast.mjs`.

### Added

- **`ast <command> --example` (G-12, remediation item 15).** A field trial's agent hit
  `session start --input goals.json` with no goals.json to point at and no example
  anywhere in its reading path -- it read the session schema cold, then gave up and ran
  with just `--request`. `risk score`'s payload WAS documented with a worked example, but
  only in a sibling skill (`risk-analysis/SKILL.md`) the agent had not loaded at the moment
  it needed it: correct and unreachable. "Payload contracts belong to the CLI, not to
  prose in a sibling skill." `--example` prints a valid, realistic payload directly from
  the command that needs it, for any command that declares one, without executing it --
  the four commands the field trial named as needing this most now have one:
  `session start` (a `goals.json` shape), `risk score` (the exact worked example already
  in `risk-analysis/SKILL.md`, now reachable from the CLI itself), `browser decide` (a
  `factors.json` shape), and `report generate` (a minimal `context.json`). Each is verified
  by a test that round-trips the printed example straight back through the real command,
  not merely that the flag prints something. Left for later, not silently dropped: the
  other ~20 `--input`-taking commands have no declared example yet -- the flag mechanism
  supports adding one to any of them at any time, it is just unpopulated. `bin/ast.mjs`,
  `skills/testing-orchestrator/SKILL.md`, `skills/risk-analysis/SKILL.md`.

- **An "Unblock these" report section (G-16, remediation item 11).** A field trial's admin
  had to interrogate the agent turn by turn ("why didnt you do it? do you have any
  boundation from the .claude skills?") to learn that three untested features were blocked
  by legitimate, well-reasoned policy, not laziness or a bug. Even on the compliant path --
  a report that already states "BLOCKED: no explicit authorisation for load traffic" -- the
  reader was never told THEY were the one who could clear it: the system knew what
  authorisation or capability would unblock the item and never offered. This section lists
  every open, currently-blocking uncertainty (status `blocked`, `user-input-required`,
  `environment-unavailable` or `external-dependency` -- see
  `uncertainty-register`'s exported `BLOCKING_STATUSES`) whose `owner` is `user` or
  `external`, phrased as a direct offer: "**{what's blocked}** — blocked: {impact}.
  {next action}." Deliberately excludes `owner: 'agent'` uncertainties -- those are the
  agent's own job to resolve, and mixing them in would bury the ones that are actually
  waiting on the reader -- and non-blocking statuses like `future-case`, which do not stall
  anything right now. Reuses fields the uncertainty register already required
  (`next_action`, `impact`, `owner`, `raised_by_execution`); no new capability-registry
  threading needed. `engine/reporting-engine/index.mjs`, `engine/uncertainty-register/index.mjs`
  (`BLOCKING_STATUSES` now exported), `schemas/report.schema.json`
  (`uncertainty_details[].impact`/`.blocking`/`.raised_by_execution`, all optional; report
  schema stays at 1.2.0 -- see `engine/core/version.mjs`'s comment), `examples/artifacts/*`
  (regenerated).

- **`wall_clock_ms` and `command_duration_ms` on executions (remediation item 7).**
  `duration_ms` has always measured the gap between two CLI calls (`exec start` ..
  `exec finish`) -- the agent's own reasoning, tool calls and everything else in between,
  never the runtime of whatever was actually tested. A field trial's report recorded a
  Playwright suite at 100,488ms against a transcript stating the real run took 17.1s, a 6x
  overstatement, rendered under a plain "Duration" header inviting exactly that reading.
  `wall_clock_ms` gives the existing number its honest name; `duration_ms` stays, unchanged,
  as a deprecated alias so nothing reading the old field name breaks (renaming outright would
  be an incompatible schema change under this project's own versioning policy -- see
  `docs/versioning.md` -- disproportionate to what this fix needs). `command_duration_ms` is
  new: the real, captured runtime of what was tested, summed from linked evidence's
  `command.duration_ms` (populated by `evidence capture`, item 1 on this branch) -- absent,
  not zero, when nothing was captured that way. The rendered Executions table now has two
  honestly-labelled columns, "Wall clock" and "Command time", replacing the single ambiguous
  "Duration" — "—" for Command time when nothing was captured, never a wall-clock number
  standing in for it. `runtime_efficiency_ms_per_case` (one of the three metrics this field
  trial named as defective by construction) now sums `command_duration_ms` exclusively,
  excluding — not zeroing — any execution with none; a session with nothing captured this
  way now reports the metric as `null` rather than a wall-clock-derived figure that cannot
  be right. Deliberately NOT touched: `execution_summary.total_duration_ms` (the
  session-wide aggregate in the report's top summary, schema-locked and not the field
  G-06's reproduction case was about) and `evidence.command.duration_ms` (already correctly
  named — it always measured a real captured command). `engine/execution-engine/index.mjs`,
  `engine/reporting-engine/index.mjs`, `engine/evaluation-engine/metrics.mjs`,
  `schemas/execution.schema.json` (`wall_clock_ms`, `command_duration_ms`, both optional),
  `examples/artifacts/*` (regenerated).

### Changed

- **The Evaluation metrics table now renders only metrics with a real denominator; the
  rest collapse into one named line instead of sitting inline as `_n/a (zero
  denominator)_`.** A field trial's own report had three defective-by-construction metrics
  (G-04, G-06, G-10) rendered in the same table as its honest ones, with nothing about the
  table's presentation marking a difference in kind — a reader had to check each row by
  hand to tell a real measurement from a zero-denominator artifact. The table's own
  reviewer recommendation: "render only metrics with a real, non-defective denominator;
  move the rest to a collapsed 'not measured this session' list. A short honest table beats
  a long one with three broken rows." Found and fixed along the way: `false_confidence_rate`
  itself returned a real-looking `0`, not `null`, whenever there were zero PASSED/COMPLETED
  claims to audit — the one metric in this file that did not follow its own "null means
  zero denominator" convention, so it would have sat in the "real" table with `n: 0` under
  this exact change had it gone untouched. `report.integrity.false_confidence_rate`
  (schema-locked to `type: number`) is deliberately left returning `0` in that unrelated
  location — fixing it there would require a schema version bump disproportionate to this
  change, and it was not what the field trial's own recommendation was about.
  `engine/reporting-engine/index.mjs`, `engine/evaluation-engine/metrics.mjs`,
  `examples/artifacts/*` (regenerated).

### Added

- **A version-skew warning when persisted records were stamped under a different skill
  version than the one running right now.** A field trial's rendered report cited
  "AST v0.8.0" in one place while the skills it had just run under declared `system_version:
  0.9.0` in another — nothing had ever checked that the package was not upgraded
  mid-session. `provenance.skill_version` is already stamped from `SYSTEM_VERSION` at the
  moment each record is created, so a new `process-completeness` check compares every
  stamped value across the session, its decisions, executions, evidence and findings
  against the current `SYSTEM_VERSION`; any mismatch — whether upgraded partway through a
  session or only after it finished, before the report was generated — is now a named,
  advisory (never blocking, even under `--final`; an upgrade mid-session is not a defect in
  the work) finding, and flows automatically into the rendered report's integrity
  violations alongside every other process-completeness gap.
  `engine/evaluation-engine/process-completeness.mjs`.
- **`ast evidence amend <id> --kind <kind>`, the missing recovery path for a mis-typed
  evidence kind.** `evidence_auditor_run` is true only when some evidence record has `kind:
  'evidence-audit'`; a field trial's agent recorded the audit as `kind: 'other'`, generated
  the report, saw the metric read `false`, and had no way to correct the existing record —
  only to add a second, correctly-typed one and ship both. The final report rendered the
  same audit twice. `amend` corrects the stored record's `kind` in place (schema-validated,
  same as any other write; every other field, including the `evidence_id` and `timestamp`,
  is left untouched), and the orchestrator's own reporting workflow now names it directly
  as the fix for this situation instead of leaving an agent to improvise a second record
  the way the field trial's did. `engine/evidence-engine/index.mjs`, `bin/ast.mjs`,
  `skills/testing-orchestrator/workflows/reporting.md`.

### Fixed

- **`readJson` threw "Corrupt JSON" on a UTF-16 file instead of decoding it.** It already
  stripped a UTF-8 BOM (`Out-File -Encoding utf8` writes one) but had no equivalent for
  UTF-16, and UTF-16LE-with-BOM is exactly what PowerShell 5.1's `>` redirect writes —
  `npx playwright test > results.json` on Windows produces one, and a field trial hit
  precisely this, reading a real, uncorrupted file as unparseable with no clue why. Detects
  a UTF-16LE or UTF-16BE BOM and decodes it (Node has no native UTF-16BE decoder, so BE goes
  through `Buffer.swap16()` into LE first) rather than merely improving the error message —
  the same judgment already made for the UTF-8 BOM case: the file is not lying about its
  encoding, and rejecting a standard one is this tool's problem to route around, not the
  caller's to work around. `engine/core/fsjson.mjs`.
- **The failure classifier's no-signal fallback was named and scored like a verdict on
  the finding, not on the classifier's own inputs.** `classify()` returned
  `{class: 'insufficient-evidence', confidence: 0.9}` whenever `signals` was empty — the
  single highest confidence the function could ever return, on its weakest possible input.
  Worse, the entire signal vocabulary (`econnrefused`, `http-500`, `timeout`, ...) is
  runtime-shaped: a static review or a dependency scan has no such signal to supply and was
  routed to this fallback by construction, however solid the underlying finding was. In one
  field trial, a confirmed critical CVE and a hardcoded JWT secret both rendered as
  `insufficient-evidence (0.9)`, reading as "the findings are unsupported" when the opposite
  was true. Renamed to `unclassified-no-signals` at confidence `0.2` (consistent with this
  file's other low-certainty cases), and the report renderer now suppresses the Failure
  class cell entirely for it — `—`, the same as no classification at all — rather than
  printing a confident-looking label for an absence. Four static-analysis-shaped signals
  (`advisory-in-range`, `missing-auth-check`, `hardcoded-secret`, `policy-violation`) join
  the existing `product-defect` rule, so a static finding can be classified at all instead
  of defaulting to the fallback. `engine/failure-classifier/index.mjs`,
  `engine/reporting-engine/index.mjs`, `schemas/execution.schema.json`,
  `skills/testing-orchestrator/workflows/execution.md`.
  (Not touched: `insufficient-evidence` as an *uncertainty* status in
  `schemas/uncertainty.schema.json` — an unrelated enum with a name collision, not the
  same field.)
- Regenerated `examples/artifacts/*` via `node scripts/demo-session.mjs`, per
  `CONTRIBUTING.md`'s own instruction to run it after touching the pipeline — found stale
  (`report_version: 1.1.0`, missing this session's `digest`/`grade` fields) from several
  commits earlier in this same effort that should have triggered a regeneration and did
  not. Caught the schema/rename mismatch above in the same run, before it shipped.

### Added

- **Every evidence item is now graded `anchored` or `asserted`, computed by the engine and
  never agent-supplied.** `evidence add` has always treated `artifactPath` as optional, and
  the false-confidence gate checks the *kind* of evidence, not whether anything was
  actually captured — so a hand-typed sentence with no artifact has always passed as
  execution-grade evidence exactly like a hashed command output. One field trial shipped a
  report where 4 of 5 evidence records had no artifact at all, with `evidence_completeness:
  1` giving no hint of it. `grade` does not change what the gate accepts (that stays a
  separate, deliberate design question, recorded as open in the implementation plan) — it
  makes the previously invisible split visible: `anchored` means a real artifact, a real
  URI, or an excerpt paired with a real command exit code exists; `asserted` means the
  record is the agent's own account with nothing behind it. Surfaced in a new
  `evidence_anchored_rate` metric (distinct from `evidence_completeness`, which only asks
  whether *something* was attached) and an `Anchored?` column in the report's Evidence
  table. Evidence written before this field existed has no `grade` and is correctly
  excluded from the numerator rather than coerced into either bucket.
  `engine/evidence-engine/index.mjs`, `engine/evaluation-engine/metrics.mjs`,
  `engine/reporting-engine/index.mjs`, `schemas/evidence.schema.json` (`grade`, optional),
  `schemas/report.schema.json` (`evidence_index[].grade`, optional; report schema stays at
  1.2.0 — see `engine/core/version.mjs`'s comment on why this didn't need a further bump),
  `skills/testing-orchestrator/policies/evidence-policy.md`.

### Fixed

- **`actionable_finding_rate` was mathematically pinned at 0 for every possible session.**
  Its numerator counted findings with `triage.state` in `{confirmed, reported, resolved}`;
  the only code path anywhere in the codebase that ever writes a non-`'new'` triage state
  is the duplicate-detection branch, which sets `duplicate_of` at the same time — exactly
  what the denominator (`nonDuplicate`) filters out. The numerator was therefore always
  drawn from a set the denominator had already excluded. Now a freshly-filed (`triage.state:
  'new'`) finding also counts as actionable when it carries a `recommended_action` backed
  by real evidence — measurable the moment a finding is filed, rather than depending on a
  triage workflow nothing in this codebase currently advances. The duplicate-confirmed path
  still counts too, unchanged, so a future triage-advancing command would be picked up for
  free. `engine/evaluation-engine/metrics.mjs`.
- **`finding add --executionId` never back-linked the finding into the execution's own
  `findings[]`**, only onto the finding record itself and the session's list — so
  `unnecessary_test_rate`'s "barren" check (zero findings, zero decision, zero
  test_results) counted an execution that had produced a real, filed, evidenced finding as
  an unnecessary test. `defects.create()` now appends to `execution.findings[]` when
  `executionId` is supplied, mirroring what it already did for `session.findings` three
  lines away — no change to calling order or any skill's documented workflow (finish, then
  analyse, then file — findings are identified after an execution finishes, and this
  requires no change to that). Also added: an execution carrying real, hashed evidence
  (from `evidence capture`) and a terminal status is no longer "barren" whatever else it
  produced or didn't — a clean, evidenced typecheck or build is the useful outcome those
  cheap early checks exist to produce, not a wasted test. A Madhubala-shaped session
  (typecheck + build, both evidenced, neither turning up a defect) now scores
  `unnecessary_test_rate: 0`, not `0.4`. `engine/defect-engine/index.mjs`,
  `engine/evaluation-engine/metrics.mjs`.

### Added

- **Git provenance is now captured automatically instead of being purely agent-suppliable
  input nothing ever supplied.** `session start` detects the repository under test's
  commit, branch, dirty-tree state and (best-effort) `owner/repo` name via a new
  `engine/core/git.mjs`, failing closed to `null` — never throwing — when the target isn't
  a git repository at all. `exec start`, `evidence add` and `finding add` each inherit the
  session's captured value unless a caller explicitly supplies its own, including an
  explicit `git: null` to say "no git context for this specific record" — which now stays
  distinguishable from simply omitting the field (the three call sites destructure `git`
  with no default of their own, specifically so `undefined` and an explicit `null` are not
  conflated before `inheritedGit()` ever sees them). The `session start` CLI wrapper
  previously forced `git: body.git ?? null` regardless of whether the agent supplied one,
  which made auto-detection unreachable through the real CLI path even after it existed as
  the engine's own default — fixed alongside it.
  `engine/core/git.mjs` (new), `bin/ast.mjs`, `engine/state-engine/index.mjs`,
  `engine/execution-engine/index.mjs`, `engine/evidence-engine/index.mjs`,
  `engine/defect-engine/index.mjs`, `skills/testing-orchestrator/policies/evidence-policy.md`.

### Fixed

- **The report footer no longer asserts traceability to a commit it cannot name.**
  Previously unconditional ("every row above executed against the commit named at the
  top"), even when no commit was ever recorded. Now states one of three honest facts:
  the commit, the same sentence qualified with "uncommitted changes in the working tree"
  when the session's git info says the tree was dirty at capture time, or a plain
  statement that no commit was recorded at all. `engine/reporting-engine/index.mjs`.
- **The `reproducibility` metric was structurally 0 in every session, regardless of what
  was actually reproducible**, because its formula (`git.commit && environment &&
  command`) could never be satisfied while nothing captured `git`. Fixed as a direct
  consequence of git auto-capture above — no change to the metric's own formula was
  needed once the data existed to satisfy it.

Two field trials of the pack against real repositories surfaced defects in the CLI's own
input handling and in one decision engine's output shape — not in the judgement content,
which both trials independently praised, but in the bookkeeping layer that is supposed to
make that judgement trustworthy. This entry closes the first of those (payload shapes);
more follow under the same heading.

### Fixed

- **`risk score` no longer accepts a flat body, and no longer aliases factor names.**
  Previously, a body with no top-level `"factors"` key fell back to treating the whole body
  as the factors map (`factors: body.factors ?? body`); combined with the CLI's automatic
  camelCase aliasing of top-level snake_case keys, this made every factor name in a flat
  body acquire an unrecognised alias, producing an "Unknown risk factor(s)" error naming
  identifiers the caller never wrote. The flat fallback is removed, aliasing is disabled for
  this command's data payload (matching `profile save`), and the rejection now states the
  required shape and points at a worked example instead of failing bare.
  `bin/ast.mjs`, `engine/risk-engine/index.mjs`.
- **`browser decide` no longer returns a usable-looking `selected` value while also setting
  `escalate: true`.** The ambiguity gate already existed and already fired correctly when
  the top two candidates tied — including on a fully empty or malformed factors payload,
  where every candidate now legitimately ties at a score of 0 — but the `selected` field
  stayed populated with the tied candidate regardless, and a field literally named
  `selected` is exactly what an agent under time pressure will read instead of the
  `escalate` boolean next to it. `selected` is now `null` whenever `escalate` is true; the
  candidate that would have been picked is exposed as `top_candidate`, a name chosen to not
  imply safety. `engine/browser-decision/index.mjs`.
- **Three "unknown name" errors (risk factor, browser-decision factor, applicability
  signal) no longer instruct the caller to edit the engine's own configuration file.**
  `weights.json` / `matrix.json` / `catalog.json` are the model's source of truth; an
  unrecognised name reaching one of these checks is a caller typo or shape error, never a
  legitimately new factor or signal, and telling an autonomous agent to "fix" it by editing
  that file invites exactly the kind of config drift the file exists to prevent. All three
  now point at the corresponding discovery command (`ast risk profiles`,
  `ast browser matrix`, `ast applicability catalog`) instead.
  `engine/risk-engine/index.mjs`, `engine/browser-decision/index.mjs`,
  `engine/applicability-engine/index.mjs`.
- **The benchmark can now express "this case is expected to be ambiguous."** Two existing
  cases (case-01, case-11) already tied between `existing-tests` and `existing-other-
  tooling` — case-11's own reasoning notes already said so — and depended on the engine
  silently resolving that tie by array order. The new `escalates_to` expectation checks that
  the engine escalated *and* that the tied candidate it surfaced is one of the accepted
  ones, replacing a `one_of` (case-11) or a bare string (case-01) that would otherwise fail
  every time the ambiguity gate correctly refuses to guess. `engine/evaluation-engine/
  index.mjs`, `evaluation/benchmark-cases/case-01.json`, `evaluation/benchmark-cases/
  case-11.json`.

### Added

- **`ast evidence capture` — run a command and register its real output as evidence, so
  the false-confidence gate has something honest to check.** `evidence add` accepts a
  hand-typed summary with no artifact behind it: nothing stops a `PASSED` claim from being
  built on a sentence the agent wrote rather than proof it has. `evidence capture` spawns
  the given command, hashes its real stdout/stderr to a redacted blob, and records its
  real exit code and wall-clock duration — closing exactly that gap, using the existing,
  unchanged evidence gate (`a non-zero exit code contradicts a PASSED claim` was already
  correct; it simply had nothing real to check before). A command's own non-zero exit is
  treated as a normal, correctly-captured result (e.g. `npm audit` finding vulnerabilities)
  and never sets the CLI's own exit code — only a genuine capture-mechanism failure
  (command not found, or a timeout that killed the process before it produced an exit
  code) does that, alongside the evidence record it still honestly stores.
  `bin/ast.mjs`, `skills/testing-orchestrator/workflows/execution.md`,
  `skills/testing-orchestrator/policies/evidence-policy.md`,
  `skills/security-testing/SKILL.md`, `skills/api-testing/SKILL.md`.
- **`bin/ast.mjs` now supports a `--` argument terminator.** Everything after a literal
  `--` is handed to a spawned subcommand verbatim, including tokens shaped like the CLI's
  own flags (`--input`, `--state`) — required for `evidence capture` to pass an arbitrary
  command through untouched. Inert for every command that predates it.

### Fixed

- **On Windows, spawning a command whose own path contains a space (`shell: true`
  requires this) previously mis-parsed the path at the first space and reported a
  real-looking exit code that never came from the intended program.** Affects any
  absolute path with a space — most commonly `process.execPath` itself, wherever Node is
  installed under `Program Files`. Every argv element containing whitespace is now quoted
  before being handed to a Windows shell spawn. `bin/ast.mjs` (`evidence capture`).
- **`redact()` was silently corrupting `metrics.denominators.authorization_compliance`
  into `"[REDACTED]"` on every write, in every report, since `denominators` shipped in
  0.9.0.** `KEY_HINTS` matches `authorization` as an unanchored substring — the same class
  of bug the file's own comment says `token` was deliberately anchored to avoid, just never
  applied to this term. Nothing caught it because nothing compared a stored, reloaded
  record against a fresh render until `report verify` (below) did, on its first real run.
  `authorization_compliance` added to `SAFE_KEYS`; confirmed the only field name in the
  entire schema + metric vocabulary that collided. `engine/core/redact.mjs`.

### Added

- **`ast validate [--final]` now checks whether the orchestrator's own process actually
  happened, not just whether the records left behind are well-formed.** `validate` already
  checked schemas and referential integrity; it said nothing about a session that ran real
  executions, recorded zero decisions, and left blocked work never raised as an
  uncertainty — exactly what a field trial did, with its own report's integrity block
  still saying "No integrity violations detected." Two new checks (`no-decisions`,
  `blocked-without-uncertainty`) surface as warnings by default — correct at any point
  mid-session — and are promoted to failures only under `--final`, the orchestrator's own
  "before you tell the user you are done" gate; promoting them unconditionally would fail
  the exact, correct, mid-session moment the orchestrator's own workflow calls `validate`.
  A third check (`no-git-provenance`) stays advisory even under `--final`: nothing in this
  system yet captures git provenance automatically, so failing every session on a gap it
  cannot close itself would be a bug, not a gate. All three also appear in every report's
  `integrity.violations`, where the mid-session/advisory distinction no longer applies —
  by report time the session is over. `engine/evaluation-engine/process-completeness.mjs`
  (new), `bin/ast.mjs`, `engine/reporting-engine/index.mjs`.
- **`ast report verify` proves a rendered report was actually produced by this system.**
  The orchestrator's rule that the report handed to the user is the one the CLI rendered
  was stated twice in its skills and enforced nowhere; one field trial hand-wrote a report,
  back-filled state afterwards, and `ast validate` returned `valid: true` over it. Every
  report now carries a `digest` (SHA-256 over its own content, excluding itself) printed in
  the rendered footer; `report verify <path.md | REPORT-ID>` recomputes it, re-renders the
  stored record, and compares the result byte for byte (CRLF-normalised, so an incidental
  line-ending conversion is not mistaken for a content edit). Distinguishes three failure
  reasons: no title line at all (not this system's output), a report_id with no stored
  record or a digest that does not match its own content (altered on disk), or a
  byte-for-byte mismatch with a named first differing line (hand-written or edited after
  rendering). Verified against real field-trial artifacts: the renderer-produced report
  verifies clean; the hand-written one is correctly rejected (no matching title line at
  all). Added as **Rule 4** to the orchestrator's three overriding rules — the only one an
  agent could otherwise route around by paraphrasing instead of pasting.
  `engine/reporting-engine/index.mjs`, `schemas/report.schema.json` (`digest`, optional;
  report schema 1.1.0 → 1.2.0), `bin/ast.mjs`, `skills/testing-orchestrator/SKILL.md`,
  `skills/testing-orchestrator/workflows/reporting.md`, `skills/test-reporting/SKILL.md`,
  `docs/debugging.md`, `docs/versioning.md`.
- **`ast validate` also derives `integrity.checks_run`'s counts from what actually ran**,
  instead of printing the same four lines regardless of whether there was anything to
  check — e.g. "external writes checked for provider confirmation (0 write(s) — nothing to
  check)" rather than a bare claim indistinguishable from an audited zero.
  `engine/reporting-engine/index.mjs`.

## [0.9.0] - 2026-09-18

A round of fixes against a set of gaps this project had already named about itself in
PROGRESS.md and the "Known gaps" entries below — not new discoveries, but several of them
had sat as prose without a structural backstop. Additive and backward-compatible throughout:
no capability removed, no field made required, no document schema version bumped.

### Fixed

- **The risk confidence band now actually affects category selection.** Previously
  advisory-only: a `critical` backed by one evidenced factor out of fourteen (confidence
  0.10) drove `applicability-engine` category priority exactly as one backed by thirteen
  (confidence 0.95) would. Both the per-category risk alignment and the global P0 override
  now temper toward a neutral midpoint — not toward zero — as confidence drops, so thin
  evidence reads as "we don't know" rather than "it's safe". Every row's `reason` states the
  qualification when it applies. `engine/applicability-engine/index.mjs`,
  `skills/risk-analysis/SKILL.md`.
- **A fabricated GitHub comment identifier against a real issue no longer confirms.** The
  read-back for a delegated write previously verified only that the parent issue existed;
  `verifyCommentWrite` now reads the comment itself back via
  `gh api repos/.../issues/comments/<id>` and, when the hash of what was sent is available,
  checks the comment's actual body. `verifyGitHubWrite` dispatches to it automatically by the
  shape of the result ID. `engine/adapters/github.mjs`, `engine/adapters/base.mjs`.
- **The `evidence-auditor` subagent's omission is now visible, not silent.** Nothing can
  force a subagent launch from code, so this does not make the audit mandatory in the sense
  of blocking anything — but a report generated without an `evidence-audit` record now
  states `integrity.evidence_auditor_run: false`, a matching `audit_coverage: 0` metric, and
  a stated violation, instead of looking identical to a session where the audit ran and found
  nothing. `skills/testing-orchestrator/workflows/reporting.md` makes running it before
  `report generate` an explicit, required step. `engine/reporting-engine/index.mjs`,
  `engine/evaluation-engine/metrics.mjs`, `schemas/evidence.schema.json`,
  `schemas/report.schema.json`.
- **A Jira (or Google Docs/Drive) capability resolving `available: true` no longer looks like
  one with code behind it.** `manual_only_systems` in `capabilities.json` names every system
  with no executable adapter; `resolve()` now attaches `executable: false` and an explicit
  "perform this by hand" reason to every such verb, so an agent cannot mistake a present
  credential for a working adapter. `scripts/validate-repo.mjs` cross-checks the list against
  `engine/adapters/index.mjs` so it cannot drift in either direction.
- **The `PreToolUse` hook guard has test coverage for the first time** (`tests/hooks.test.mjs`),
  driven as a subprocess against the real JSON-in/JSON-out contract. Writing the corpus found
  two real gaps in the pattern set — `DROP TABLE` and `git clean -fd` were not denied — which
  are now added. The corpus also records, honestly, that obfuscated commands (base64,
  variable substitution) remain an accepted blind spot rather than pretending otherwise.
- **Evaluation metrics now expose their own denominators and a noise floor.** A metric like
  `decision_assessment_rate: 0.5` no longer has to be cross-referenced against a separate
  `sample_sizes` object to know whether the denominator was 2 or 200; `denominators` pairs
  every metric with its actual count, and `noisy_metrics` flags any non-null metric below a
  denominator of 5, distinct from a null (zero-denominator) metric. Surfaced in the rendered
  report table with a ⚠️. `engine/evaluation-engine/metrics.mjs`,
  `engine/reporting-engine/index.mjs`.
- **`scripts/validate-repo.mjs` now warns when a skill's `description` names no triggering
  situation** ("Use when...", "when the user...", etc.) — the property `docs/concepts.md`
  says matters more than anything else in the file for whether a skill gets picked at all.
  Warn-only: it does not judge phrasing quality, only that a trigger is named at all.
- Stale counts (test count, a schema-mismatch the demo caught that no unit test did) fixed
  across `README.md`, `PROGRESS.md`, `CONTRIBUTING.md`, `docs/installation.md`, and the
  regenerated `examples/artifacts/` (which also picked up a `github.merge_pr` refused-by-default
  demonstration `demo-session.mjs` did not previously exercise, and fixed stale
  `skill_version`/`engine_version` stamps left over from an earlier regeneration).

## [0.8.0] - 2026-09-18

Four guarantees this system documents as structural were, until now, enforced by the agent
remembering to follow them. Three of the four are now enforced by code. That is a change in
what a report *means*, not a bug-fix release: `PASSED` and `confirmed: true` are harder to
obtain than they were in 0.7.0, and a report from either version uses the same vocabulary
for different strengths of claim. Compare across the boundary with care.

### Changed

- **`PASSED` now requires evidence that does not contradict it.** `verifyClaim` reads the
  evidence, not just its kind: a `command-output` recording a non-zero exit code, a
  `test-report` with zero total cases, and execution evidence belonging to a different
  execution are each refused for a success claim, and downgraded to `INCONCLUSIVE` with the
  reason recorded. Evidence links via `execution_id` or by listing the execution in
  `supports`. A `FAILED` or `PARTIAL` claim backed by a failing command is unaffected --
  that pairing is correct, and refusing it would make failures unreportable.
- **`confirmed: true` on a delegated write now requires an independent read-back.** A write
  performed through the agent's own MCP tools is a self-attestation; `completeWrite` treats
  the response as an unverified claim and re-reads the object with `gh` -- run by this
  process, deliberately not routed through `caps.resolve()`, because capability resolution
  would prefer the agent's own provider and hand verification back to the party being
  verified. A fabricated identifier no longer produces a confirmed ledger entry.
- **An undeclared capability is unavailable again, everywhere.** `browser-decision` and
  `applicability-engine` tested `!== false`, so an unsupplied capability counted as present
  -- the opposite of the three-state contract, and a plan whose steps silently never run.
  Both now require `=== true`, and `bin/ast.mjs` injects the environment's resolved
  capabilities into `browser decide` and `applicability eval` so the check cannot be
  defeated by omitting the input. An explicit value still wins, for a skill deliberately
  testing a blocked path.
- **Every persistence path redacts.** `save()` and `saveProfile()` wrote through to disk
  untouched, so a token pasted into a request landed verbatim in `testing-state.json` and
  was then archived to `history/`. Redaction now runs on the session and the repository
  profile as well as on collections and telemetry.
- **A risk level carries its confidence.** `risk_level_qualified`, `confidence_band` and
  `confidence_warning` accompany `risk_level`, so `critical` backed by one evidenced factor
  out of fourteen no longer reads identically to `critical` backed by thirteen. The band is
  advisory: it is stated for the reader and the agent, and does not yet gate category
  selection.

### Fixed

- **Concurrent ID allocation lost IDs or crashed** (`FIND-00001`, found by this system
  against itself). `nextId` did an unsynchronised read-modify-write on `counters.json`; four
  processes sharing a state directory allocated 25 of 100 requested IDs, three of them dying
  on the atomic rename with `EPERM`. Allocation now runs under a cross-process lock whose
  owner is identified by a `<pid>:<uuid>` token, and that token governs both breaking and
  releasing. Every traceability guarantee rests on IDs being unique, and the suite only
  exercised sequential allocation, which is why this survived.
- **A lock whose owner had crashed could not be broken at all.** Breaking required the lock
  to be older than `staleMs` *and* its owner to be gone, but `staleMs` defaulted to 15000
  while the retry budget was about six seconds -- so the deadline was unreachable inside a
  single call, and the one case this recovery exists for, a process that died mid-update,
  was the one case it could not handle. The caller burned its budget and told the user to
  delete a file by hand. A confirmed-dead owner is now broken immediately: the PID check is
  the real signal and age is only a proxy for it. Age still gates the unreadable-lock case,
  where death cannot be established either.
- **The lock's staleness deadline now falls inside its retry budget.** `staleMs` drops to
  5000 and `retries` rises to 250, so the 5500ms of configured waiting exceeds the deadline
  on the delays alone rather than relying on incidental syscall cost, and
  `tests/concurrency.test.mjs` asserts that ordering. A deadline longer than the budget is
  not a conservative setting, it is a disabled one. `LOCK_DEFAULTS` is exported so the
  invariant can be tested rather than commented.
- **The write read-back conflated "the object is not there" with "I could not look."** Both
  returned a bare `exists: false`, which loses the only fact a caller needs. A refuted write
  did not happen, so retrying is safe; an unverifiable one may well have landed, so retrying
  files a duplicate -- the exact failure the write ledger exists to prevent. The read-back
  now classifies the provider failure through `classifyProviderError` and reports
  `verification: 'refuted' | 'unavailable' | 'confirmed'` with an explicit `retry_safe`,
  which `completeWrite` passes to the caller along with the matching next action. Only a
  genuine 404 licenses a retry.
- **The lock could be held by two processes at once**, in three ways: a losing `wx` open
  surfaced as `EPERM`/`EACCES` rather than `EEXIST` on Windows when the winner's file was
  pending-delete and escaped the retry loop; a lock older than `staleMs` was broken on age
  alone, so a slow owner had its lock taken and then wrote its stale value over the thief's
  update; and release unlinked whatever lock was present, including a successor's.
  Reproduced at 2 failures in 50 runs before the fix.
- **`caps declare` reported success and changed nothing.** The declaration was written to
  `declared` while resolution read only `providers`, which is populated by `probe()` alone
  -- so the documented order (`probe`, then `declare`) left every agent-declared provider
  unavailable, and browser testing was blocked on a fresh install. Declaring now updates
  resolution directly.
- **`probe()` held the registry lock across five 15-second command probes**, longer than any
  sane staleness deadline. The shell-outs now run before the lock and only the merge is
  serialised, with agent-declared entries re-read inside the lock so a `caps declare`
  landing mid-probe survives.
- **Three verbs failed their own read-back after succeeding.** `comment`, `updateIssue` and
  `assign` store their target as `owner/repo#42`, and that whole string was forwarded to
  `gh --repo`, which takes `[HOST/]OWNER/REPO` and nothing else. Every delegated write of
  those verbs was therefore recorded `INCONCLUSIVE` after working. Added
  `repoSlugFromTarget`, which previously had no tests -- which is why this shipped.
- **A non-product signal outranked `product-defect` unconditionally.** The comparator sorted
  by class before score, so one incidental `timeout` displaced three strong product signals
  and a real defect was classified as a slow environment. The non-product preference now
  applies within a margin, keeping the conservative bias for a genuine tie while letting
  weight of evidence decide otherwise.
- **Flakiness was asserted from absent data.** `commits.size <= 1` treated *no* recorded
  commit as "the same commit", so three mixed runs with no git metadata -- the default, since
  `git` is optional on `exec start` -- were labelled `flaky` at 0.7 confidence. Mislabelling
  a real defect as flaky teaches people to ignore a true signal, so this now returns
  `unstable-cause-unknown` and says that whether the code changed is unknown.
- **Record ordering broke past the ID pad width.** `readCollection` relied on filename order
  matching ID order, which holds only while every counter fits its padding: `DEC-100000`
  sorts before `DEC-99999` lexically. Digit runs now compare numerically.
- **`classifyEnvironment` was unreachable**, and returned a `'likely-non-production'` value
  that could never satisfy the `non-production-only` gate it existed to serve. Wired into
  `check()` and exposed on the CLI.
- **The load-tool guard matched a bare `ab`**, firing on any command containing that token.
  A guard that fires constantly gets disabled, and then it guards nothing.

### Added

- **Skills resolve the CLI through `${CLAUDE_PLUGIN_ROOT}`.** Every skill invoked
  `node bin/ast.mjs`, a relative path that resolves only inside this checkout -- so under a
  plugin install, where the working directory is the repository under test, every command in
  every skill failed. 32 files updated, and the installer rewrites the path again for a
  project- or user-scoped install.
- **43 tests**, and coverage for the two engines that had none. `capability-registry` was
  one of them, and it held the `caps declare` defect above -- a declare-then-resolve
  assertion would have caught it. New suites: `concurrency`, `evidence-engine`,
  `capability-registry`, `capabilities`.
- `scripts/validate-repo.mjs` now asserts the test count quoted in the documentation against
  the number the suite actually defines, and reports the version. Version and count drift had
  accumulated across five files; this turns a recurring correction into an invariant.

### Removed

- The answer key from the benchmark application. All eight seeded defects were commented in
  place (`// INJECTED LOGICAL ERROR #1`), so `grep -rn INJECTED` found every one of them
  without testing anything, and 8-of-8 detection was not evidence of testing capability. The
  markers are gone. The application itself is still held out of the repository, which
  `PROGRESS.md` records as an open gap: a calibration harness nobody else can run is not yet
  a calibration harness.

### Known gaps

- A fabricated **comment** identifier against a real issue still confirms. The read-back
  verifies that the issue exists and its number matches, and a comment's `result_id` embeds
  the issue number as its leading segment, so `github.comment` remains self-attestable where
  `github.create_issue` no longer is. Closing it needs
  `gh api repos/.../issues/comments/<id>`.
- The risk **confidence band is advisory**. Nothing consumes it, so a `critical` at 0.10
  confidence still drives category selection exactly as one at 0.95 would.

## [0.7.0] - 2026-09-16

Installable into any repository on any machine with one command, and a report format
rebuilt around what a reader actually needs.

### Added

- **`npx --yes github:Purushotham-Prajapati-24/qa-skills`** installs 21 skills, 4 subagents
  and the runtime into `./.claude/`. No clone, no `npm install` -- there are still zero
  dependencies. `--user` installs for every project, `--only` for a subset, `--hooks` to
  wire the hooks into settings.json, `--dry-run` to see the plan.
- The installer rewrites what only makes sense inside this repository: skills call the CLI
  at `bin/ast.mjs`, which does not exist anywhere else, so it becomes
  `.claude/ast/bin/ast.mjs` (relative for a project install, absolute for a user install),
  and links that walk up into `templates/`, `docs/` or `integrations/` are redirected
  through `ast/`. It then runs the installed CLI to prove the rewrite worked and warns
  about any skill it missed.
- 7 installer tests that install into a throwaway repository and assert the CLI runs there,
  the benchmark passes from the installed copy, every link resolves, no skill still points
  at the source layout, a user-scope install uses an absolute path, and a second install
  refuses rather than silently overwriting.
- `files` and a `bin` map in package.json so `npx`, a release tarball and (should you want
  it) `npm publish` all work.

### Changed

- **The report is an inverted pyramid.** Verdict, then what needs action, then what was
  proven, then the gaps, then detail, then reference. Measured against a real session: 3
  stub sections became 0, 31 lines of repeated "no matching repository signal" in the
  summary became 1 grouped line, and the findings section went from 8 bare identifiers to
  125 lines of content you can act on without opening anything else.
- An empty section is no longer rendered at all. A heading over nothing trains the reader
  to skim past headings, which then hides the sections that do have content.
- Findings, open questions and decisions carry their content rather than their identifiers.
- README and docs/installation.md lead with the npx command.

### Removed

- `scripts/install-skills.mjs`. It copied skills without the runtime, so everything it
  installed referenced a CLI that was not there. Superseded by `bin/install.mjs`.

### Schema

- `report.schema.json` gains `finding_details`, `uncertainty_details`,
  `decision_summaries` and `executive_summary.not_applicable_summary`, so a stored report
  stays readable long after the state directory has moved on. Report document version
  1.0.0 -> 1.1.0; additive, so older reports still validate.

### Verification

100 tests, 41 benchmark checks, clean repository self-check, and the installer exercised
end to end into a clean repository.

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

[0.8.0]: https://github.com/Purushotham-Prajapati-24/qa-skills/releases/tag/v0.8.0
[0.7.0]: https://github.com/Purushotham-Prajapati-24/qa-skills/releases/tag/v0.7.0
[0.6.0]: https://github.com/Purushotham-Prajapati-24/qa-skills/releases/tag/v0.6.0
[0.5.0]: https://github.com/Purushotham-Prajapati-24/qa-skills/releases/tag/v0.5.0
