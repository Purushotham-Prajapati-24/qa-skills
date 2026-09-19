---
name: security-testing
description: Test authentication, authorisation, session management, input validation and dependency security within an authorised scope — broken object-level authorisation, privilege escalation, session handling, injection, secrets exposure and vulnerable dependencies. Use when a change touches auth, permissions, sessions, untrusted input or secrets, or when security testing is explicitly requested for a target you are authorised to test.
when_to_use: "security testing", "test the auth", "can user A access user B's data", "dependency scan", "check for injection", "session handling test"
allowed-tools: Read, Glob, Grep, Bash, PowerShell, Write, Edit
metadata:
  system_version: 0.10.0
  role: specialist
---

# Security Testing

## Scope and authorisation — read this first

Security testing without authorisation is an attack, regardless of intent.

- **Always fine:** reading the repository's own code, running the project's dependency
  audit, writing authorisation tests against a local instance.
- **Needs explicit authorisation:** any active probing of a deployed host — yours or not.
- **Never:** testing a target the user does not control, or has not told you to test.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" auth check --json '{"action":"security_scan.active","target":"staging.example.com","userAuthorised":true,"authorisationQuote":"yes, scan staging"}'
```

Work against a local or explicitly authorised non-production instance. Unknown environment
means production, which means stop and ask.

## 1. Authorisation — the highest-yield tests

Broken object-level authorisation is the most common serious web vulnerability, it is
trivial to test, and the failure mode is a data breach. Test it on every endpoint taking
an identifier.

```
As user A, obtain a valid session.
Request user B's resource by ID.
Expect 403 or 404. Anything that returns B's data is a critical finding.
```

Build the matrix and run it. It is tedious, mechanical, and it finds things:

| | Own resource | Other user's | Other tenant's | No auth |
| --- | --- | --- | --- | --- |
| Read | 200 | 403/404 | 403/404 | 401 |
| Update | 200 | 403 | 403 | 401 |
| Delete | 200 | 403 | 403 | 401 |
| Admin action | 403 | 403 | 403 | 401 |

Also test: privilege escalation via a role field in a request body; mass assignment
(`{"role":"admin"}` on a profile update); IDs guessable by increment; authorisation checked
on the read path but forgotten on the write path.

## 2. Authentication

- Wrong password, wrong username, locked account → same generic message and similar timing
  (otherwise you have user enumeration).
- Password reset tokens: single-use, short-lived, unguessable, invalidated on use.
- Rate limiting on login and reset.
- MFA cannot be skipped by calling the post-MFA endpoint directly.
- Credentials never travel in a URL or appear in logs.

## 3. Sessions

- Session ID **rotates on login** — otherwise session fixation is possible.
- Logout invalidates server-side, not just client-side.
- Cookies: `HttpOnly`, `Secure`, `SameSite`.
- Expiry and idle timeout behave as configured.
- Tokens are not accepted after a password change.

## 4. Input validation

Validate on the **server**. Client-side validation is a UX feature, not a control — test
by bypassing the UI entirely.

| Class | Probe (non-destructive) | Expect |
| --- | --- | --- |
| SQLi | `' OR '1'='1`, `1; SELECT pg_sleep(2)--` | Parameterised handling; no timing difference |
| NoSQLi | `{"$ne": null}` | Rejected |
| XSS | `<img src=x onerror=alert(1)>` stored then rendered | Escaped on output |
| Path traversal | `../../etc/passwd` | Rejected |
| Command injection | `; echo test` | Rejected |
| XXE | External entity in XML | Entities disabled |
| SSRF | Internal URL in a webhook/fetch field | Blocked |
| Deserialisation | Crafted payload | Rejected |
| Oversized input | 10MB field | Bounded, no crash |

Use benign payloads that prove reachability without causing damage. Never run a destructive
payload to "prove" the point.

## 5. Secrets

```bash
git grep -nE "(api[_-]?key|secret|password|token)\s*[:=]\s*['\"][^'\"]{8,}" -- ':!*.test.*'
git log -p --all -S "BEGIN PRIVATE KEY" | head -20
```

Check: secrets in source, in git history, in client bundles, in logs, in error responses.
A secret in git history is still exposed after the file is deleted — say so, and say that
rotation is the fix, not deletion.

**Never paste a discovered secret into a finding, an issue or a report.** Reference its
location and say what kind it is.

## 6. Dependencies

Run the scanner through the CLI so its real output — not your summary of it — becomes the
evidence, and its real exit code is what the gate checks:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" evidence capture --exec EXEC-2026-00003 \
  --summary "dependency scan" -- npm audit --json    # or pip-audit, cargo audit, govulncheck
```

A scanner finding vulnerabilities exits non-zero. That is a normal, correctly-captured
result, not a capture failure — `evidence capture` never treats the target command's own
exit code as its problem to interpret. Whether that exit code means the execution's goal
("no critical/high vulns") FAILED is your judgement to make and record via `exec finish`,
using the failure it surfaces as evidence, not a reason to avoid capturing it.

Triage before reporting. A critical CVE in a dev-only dependency on a code path you never
call is not a critical finding. State exploitability, not just severity.

## Reporting

Security findings need the exploitability path, not just the symptom:

> **Broken object-level authorisation on `GET /api/orders/:id`** — severity `critical`.
> A user authenticated as `user-a` retrieves `user-b`'s order, including delivery address
> and last-4 card digits. The handler loads by ID and never compares `order.userId` to the
> session user (`src/orders/get.ts:34`). Evidence `EV-2026-00051` (request/response pair,
> headers redacted). Reproducible: always, 3/3 attempts.

Severity `blocker` or `critical` means **surface it immediately**, before continuing other
testing. Do not batch a data-exposure finding into an end-of-run report.
