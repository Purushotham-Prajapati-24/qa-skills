# GoogleDriveAdapter — contract

Drive is for **evidence artefacts** that are too large or too binary for a document:
screenshots, videos, traces, HAR files, coverage reports.

## Shape

```
GoogleDriveAdapter
  capabilities:  drive.list, drive.upload_evidence
  read(verb, args)  -> { ok, data, evidence }
  write(verb, args) -> { ok, fileId, url, confirmed, error, evidence }
  authorization: explicit for uploads
  idempotency:   evidence ID + content SHA-256
```

## Think before uploading

`drive.upload_evidence` moves data out of the testing environment into shared storage.

Screenshots and HAR files routinely contain: real user data from whatever environment you
tested, session cookies and bearer tokens in request headers, internal hostnames and
infrastructure detail, and email addresses and names in test fixtures that turned out not
to be synthetic.

Before uploading, ask: **do I know what is in this artefact?** If the answer is no, do not
upload it. A local path in the evidence index serves the same purpose without the exposure.

Never upload evidence captured against production without stating what it contains.

## Operations

| Verb | Behaviour | Authorisation |
| --- | --- | --- |
| `drive.list` | List files in a folder. Used to detect an existing upload. | none |
| `drive.upload_evidence` | Upload one artefact and return its ID and URL. | **explicit** |

## Layout

Predictable, so evidence is findable months later:

```
Testing Evidence/
  <repository>/
    SESSION-0031/
      EV-2026-00021-trace.zip
      EV-2026-00022-screenshot.png
      EV-2026-00031-coverage.json
```

The filename leads with the evidence ID, so a report reference resolves to a file without
a lookup.

## Idempotency

Keyed on `evidence_id + sha256`. The same artefact uploaded twice is the same file; if the
hash differs, the artefact changed and that is worth noticing rather than silently
overwriting.

```bash
node bin/ast.mjs write check --json '{"system":"google-docs","action":"drive.upload_evidence","idempotencyKey":"EV-2026-00021:sha256:…"}'
```

## Failure modes

| Condition | Handling |
| --- | --- |
| Not authorised | Keep evidence local. Record the local path. **Say the upload did not happen.** |
| Quota exceeded | `BLOCKED`. Do not delete anything to make room. |
| File too large | Keep it local; reference the path and the hash. |
| Partial upload | Verify by hash before retrying; a truncated trace is worse than no trace. |
| Permission denied on the folder | `BLOCKED`. Do not create a parallel folder elsewhere. |

## Evidence of the upload

Uploading produces its own evidence record, linked to the original:

```jsonc
{ "kind": "other", "summary": "Uploaded EV-2026-00021 (playwright trace) to Drive",
  "epistemic_class": "observed", "supports": ["EV-2026-00021"],
  "artifact": { "uri": "https://drive.google.com/file/d/…", "sha256": "sha256:…" } }
```

The hash is what makes the copy verifiable against the original. Record it on both sides.

## Retention

Traces and videos are large and accumulate fast. Agree a retention policy with the team and
write it into the testing strategy document. The agent does not delete evidence on its own
initiative — deletion is `prohibited-by-default`, and evidence for a finding that is still
open must not disappear because storage got tight.
