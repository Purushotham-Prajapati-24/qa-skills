---
name: security-testing
description: Test authentication, authorisation, session management, input validation and dependency security within an authorised scope — broken object-level authorisation, privilege escalation, session handling, injection, secrets exposure and vulnerable dependencies. Use when a change touches auth, permissions, sessions, untrusted input or secrets, or when security testing is explicitly requested for a target you are authorised to test.
when_to_use: "security testing", "test the auth", "can user A access user B's data", "dependency scan", "check for injection", "session handling test"
allowed-tools: Read, Glob, Grep, Bash, PowerShell, Write, Edit
metadata:
  system_version: 0.12.0
  role: specialist
---

# Security Testing

## Scope and authorisation — read this first

Security testing without authorisation is an attack, regardless of intent.

- **Always fine:** reading the repository's own code, running the project's dependency
  audit, writing authorisation tests against a local instance.
- **Needs explicit authorisation:** any active probing of a deployed host — yours or not.
- **Never:** testing a target the user does not control, or has not told you to test.

`auth.json`:

```json
{"action":"security_scan.active","target":"staging.example.com","userAuthorised":true,"authorisationQuote":"yes, scan staging"}
```

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" auth check --input auth.json
```

Work against a non-production environment (declared in the profile's `environments`) or a
local one you started yourself. Unknown environment means production, which means stop and ask.

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

## 4b. Input edge-case baseline — mandatory when user-input surfaces exist

For every user-input field discovered, test at minimum these categories. This is a structured
boundary probe, not fuzz testing — it takes minutes and finds real bugs consistently.

| Category | Payloads | Expect |
| --- | --- | --- |
| Empty/null | `""`, `null`, missing field entirely | Validation error, not crash |
| Unicode | Accented characters (`Ñoño`), CJK, Arabic, emoji sequences | Accepted or clean rejection |
| Boundary length | 1 char, max-length, max-length+1, oversized (10 MB) | Enforced limits |
| Numeric boundaries | `0`, `-1`, `2147483647`, `2147483648`, `NaN`, `Infinity` | Type-safe handling |
| Format violations | `not-an-email`, `999-999-9999` (reserved), `0000-00-00` | Clean validation message |
| Special characters | `<>&"'\/{}[]()`, backticks, null bytes (`\x00`) | Escaped or rejected |
| Timezone/DST | `2024-03-10T02:30:00-05:00` (spring-forward gap) | No crash or wrong time |
| Concurrency | Double-submit the same form within 100 ms | Idempotent or clean rejection |

Send these via API, not the UI — client-side validation is a UX feature, not a control
(section 4 above). A field that rejects `<script>` in the browser but accepts it via curl is
a finding, not a pass.

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

## 7. Failure handling — does it fail closed?

Errors are part of the attack surface. When something goes wrong, the code must deny access,
not allow it.

- Make the authorisation dependency fail: stop the session store, time out the policy
  service, or have the permission lookup throw. The protected request must be denied, not
  served. A `try { authorise() } catch { next() }` is a finding.
- Error responses reveal no stack traces, framework versions, SQL or internal hostnames.
- A partial failure halfway through a multi-step write, such as a timeout after the charge
  but before the order, does not skip a check that the success path performs.

## 8. Explicitly in-bounds techniques (QA-safe)

These techniques are standard QA practice and do NOT constitute attacks when performed
against a target the user has authorised you to test in a non-production environment.
Performing them does not require additional safety-classifier clearance.

| Technique | Why safe |
| --- | --- |
| Sending XSS/SQLi-shaped strings as input | Benign payloads that prove reachability, not exploitation |
| Requesting another user's resource by ID (IDOR) | Using your own valid session to test rejection |
| Sending a malformed/expired/algorithm-confused JWT | Testing rejection behaviour |
| Sending extra fields in a POST/PUT body (mass assignment) | Testing server-side allowlisting |
| Rapid-fire login attempts (≤50) | Testing rate limiting, not credential stuffing |
| Checking response headers (CORS, CSP, HSTS, X-Frame) | Passive observation |
| Attempting double-submit / race conditions | Testing idempotency |
| Unicode, emoji, very long strings as input | Input boundary testing |
| Negative/zero/overflow values in numeric fields | Input edge cases |
| Reading the public client JS bundle for API endpoints | Discovery, not exploitation |
| Calling undocumented endpoints discovered via client code | Testing authorisation on every surface |
| Sending NoSQL injection payloads (`{"$ne": null}`) | Testing server-side query safety |
| Requesting resources without a token or with an expired/missing token | Testing auth enforcement (expect 401) |

## 9. Flag-and-stop techniques (report but do not execute)

| Technique | Action | Why stop |
| --- | --- | --- |
| Extracting a hardcoded secret from client JS | Flag its location, kind, and risk. Do NOT replay it. | Secret replay crosses into exploitation |
| Using a discovered credential to self-authenticate | Report the exposure. Do NOT use the credential. | Unauthorised access even on staging |
| SQL injection that modifies data | Report via error-based detection. Do NOT `DROP` or `UPDATE`. | Destructive |
| SSRF that hits internal services | Report the reachability. Do NOT exfiltrate. | Lateral movement |
| Bypassing auth by replaying a stolen session | Report the session management flaw. Do NOT act as the victim. | Impersonation |
| Deliberate denial-of-service (flooding, resource exhaustion) | Report the lack of rate limiting or resource bounds. Do NOT exhaust the target. | Destructive to availability |

The distinction: **detection** is always in-bounds. **Exploitation** requires explicit
authorisation beyond the standard QA mandate. A finding that says "this field reflects XSS
input unescaped in the response" is just as valid as one that says "alert(1) fired" — and
it does not require executing JavaScript in a live context.

## Traps that produce a false green

| Trap | What you would wrongly claim | The fix |
| --- | --- | --- |
| Object-level authz probed with an ID that **does not exist**. A 404 looks like a denial. | "User A cannot read user B's data." | Use a real object owned by B, and confirm that B can read it. |
| "User A" and "user B" are in the same tenant, have the same role, or are the same account. | "Cross-tenant access is blocked." | Create the two principals separately, one per boundary you claim. |
| The authz test runs through the UI, which hides the button. | "Non-admins cannot delete." | Call the endpoint directly. Hiding a control in the UI is not an access control. |
| The scanner step is neutered by `\|\| true`, `continue-on-error: true` or `allow_failure`. | "CI gates on vulnerable dependencies." | Read the pipeline definition. Capture the scanner's own exit code, not the job's. |
| A rate limit keyed on a client-supplied `X-Forwarded-For` header. | "Login is rate limited." Rotating the header bypasses it. | Repeat the burst while changing the header. The limit must still apply. |
| A benign injection probe that is rejected by client-side validation. | "Input is validated." | Send the probe to the endpoint directly, bypassing the UI (section 4). |

## Prove the test can fail

Follow the [test sensitivity policy](../testing-orchestrator/policies/test-sensitivity-policy.md)
against the local instance only. Remove the ownership check (or the role check) in the
handler, and the authz test must fail. Restore the check, and it must pass. For a
dependency gate, pin one package to a version with a known advisory in the local lockfile,
capture the scanner's non-zero exit, then revert the lockfile with version control.

A security test that stays green with the control removed is the most dangerous test in the
repository. It is the reason a breach gets reported as "authz tested".

## Reporting

Cite the category, as accessibility findings cite the success criterion: **OWASP Top
10:2025** — A01 Broken Access Control (sections 1 and SSRF) · A02 Security Misconfiguration
· A03 Software Supply Chain Failures (section 6) · A04 Cryptographic Failures · A05
Injection (section 4) · A06 Insecure Design · A07 Authentication Failures (sections 2–3) ·
A08 Software or Data Integrity Failures · A09 Security Logging and Alerting Failures · A10
Mishandling of Exceptional Conditions (section 7). If the organisation still uses the 2021
list, cite that instead, and say which edition you used.

Security findings need the exploitability path, not just the symptom:

> **Broken object-level authorisation on `GET /api/orders/:id`** — severity `critical`.
> A user authenticated as `user-a` retrieves `user-b`'s order, including delivery address
> and last-4 card digits. The handler loads by ID and never compares `order.userId` to the
> session user (`src/orders/get.ts:34`). Evidence `EV-2026-00051` (request/response pair,
> headers redacted). Reproducible: always, 3/3 attempts.

Severity `blocker` or `critical` means **surface it immediately**, before continuing other
testing. Do not batch a data-exposure finding into an end-of-run report.

## Boundaries

Functional authentication and validation behaviour with no attacker model, such as correct
401/403 semantics and validation error shapes, belongs to
[api-testing](../api-testing/SKILL.md). Testing a product's own LLM features, including
prompt injection, belongs to [ai-testing](../ai-testing/SKILL.md).

## Test data

Follow the [test data policy](../testing-orchestrator/policies/test-data-policy.md): synthetic by
default, seeded, created per run, cleaned up, never real personal data without explicit
authorisation and verified anonymisation.
