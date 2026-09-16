# Google Docs / Drive integration

The external documentation layer: a durable, versioned testing record that outlives any
one agent session and can be read by people who were not in the conversation.

```
skill  →  docs.update_testing_log  →  capability-registry  →  mcp-google-drive  |  local-doc-mirror
```

## Honest degradation is the design

`local-doc-mirror` is **always available** and always the last resort. When no Google
provider resolves, the canonical testing record is versioned Markdown under
`state/reports/`, and the agent says plainly that the external log was not updated.

That is deliberate. A system that silently drops its documentation obligation when a
connector is missing is worse than one that has no connector at all, because nobody notices.

```bash
node bin/ast.mjs caps resolve docs.update_testing_log
```

## Enabling the Google provider

No Google Docs or Drive MCP server ships with this plugin — add one and declare it:

```bash
node bin/ast.mjs caps declare mcp-google-drive true --note "google drive connector authorised"
```

Verify the capability before writing. A connector that is present but unauthorised must be
treated as absent.

## Capability surface

| Verb | Write? | Authorisation |
| --- | --- | --- |
| `docs.read` | no | none |
| `drive.list` | no | none |
| `docs.create` | **yes** | explicit |
| `docs.update_testing_log` | **yes** | explicit, idempotent on execution ID |
| `drive.upload_evidence` | **yes** | explicit |

`drive.upload_evidence` deserves a second thought every time: screenshots taken during
testing routinely contain real data from whatever environment you were in. Confirm before
uploading, and never upload evidence captured against production without saying what is in
it.

## One canonical log, not a document per action

The failure mode here is document sprawl — forty near-identical documents nobody reads.
Maintain **one** testing record per project and append to it.

Suggested structure, when the connector supports it:

| Document | Contents | Cadence |
| --- | --- | --- |
| Testing Strategy | Approach, scope, standing decisions | Rarely |
| Testing Goals | What each cycle is trying to establish | Per cycle |
| Testing Baseline | Coverage and known issues at a point in time | Per release |
| **Execution Log** | Append-only record of every cycle | **Every cycle** |
| Findings / Defects | Findings and their external issue links | As found |
| Evidence Index | Evidence IDs, kinds, locations, hashes | Every cycle |
| Final Test Report | The current report | Per cycle, superseding |
| Decision History | Decision records | Every cycle |
| Uncertainty Register | Open questions and blockers | As raised |
| Future Testing Backlog | Deferred work and why | As deferred |

If that is too many, collapse to two: **Execution Log** and **Final Test Report**. Those
carry most of the value.

## What each cycle appends

Session ID · repository · commit / branch / PR · skill version · timestamp · goals ·
completed work · failed work · blocked work · deferred work · skipped work ·
not-applicable work · interruptions · uncertainties · decisions · tools used · evidence
references · findings · issues created · tests added or modified · coverage change ·
remaining work · next recommended action.

**The log must never imply completion of work that did not occur.** It is the same rule as
the report, applied to a document other people will read months later without the context
you had.

## Idempotency

Keyed on execution ID. If `EXEC-2026-00142` is already in the log, do not append it again.
Re-running the reporting step must be safe — otherwise a retried report doubles the record.

```bash
node bin/ast.mjs write check --json '{"system":"google-docs","action":"docs.update_testing_log","idempotencyKey":"EXEC-2026-00142"}'
```

## Versioning

Google Docs keeps native revision history. Use it — do not create "Test Report v2",
"v2 final", "v2 final FINAL". Name each revision with the report ID (`REPORT-2026-00142`)
so a document revision can be traced back to the state that produced it.

When using the local mirror, `state/reports/REPORT-YYYY-NNNNN.md` files are immutable and a
new report carries `supersedes`.

## Failure modes

| Condition | Handling |
| --- | --- |
| Connector not authorised | Fall back to the local mirror. **Say so in the report.** |
| Document not found | Do not create a replacement silently — the original may just be unshared. Ask. |
| Permission denied on write | `BLOCKED`. Record `confirmed: false`. |
| Partial write | Verify before retrying; a duplicated log section is confusing and hard to unpick. |
| Rate limited | Back off once, then `BLOCKED`. |

## Secrets

Everything written passes through redaction. Even so: never paste credentials, tokens or
customer personal data into a shared document. A testing log is usually more widely shared
than the environment it describes.

See [docs.md](docs.md) and [drive.md](drive.md).
