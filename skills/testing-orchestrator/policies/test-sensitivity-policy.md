# Test Sensitivity Policy — prove a test can fail

A test that cannot fail is not evidence. It still produces a green run with a zero exit code
and a hashed transcript, and the evidence gate will accept it, because the gate checks that
something ran, not that it could have noticed anything. This policy covers that gap.

**What this policy is:** a judgement rule the specialist skills follow. **What it is not:**
something `evidence verify` enforces. The gate does not know whether you planted a fault. Do
not describe a sensitivity check as gate-verified. It is verified by the two captured exit
codes below, which a reader can check.

## When it is required

Before a `PASSED` claim rests on any of these:

- a test you **wrote or changed** in this session, backing a `must-test` scenario;
- a **gate**: a coverage threshold, a performance budget, a k6 threshold, a scanner's
  fail level, a CI job that is supposed to block a merge;
- a **plan or query assertion** (an `EXPLAIN` check, an index check);
- a scanner or scan configuration you set up (axe tags, a dependency-scan severity level).

For an existing suite you only ran, sensitivity is not required. Say that the suite's power
to detect failure was not measured.

## The protocol

Run it under the same execution as the claim it supports.

1. **Plant the smallest fault the test exists to catch.** Invert one comparison, delete one
   `<label>`, drop the index, remove the authorisation check, raise the threshold above the
   current value. One fault only, so a failure can mean only one thing.
2. **Capture the run with the fault present. It must exit non-zero, for the right reason.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" evidence capture --exec EXEC-2026-00007 \
     --summary "sensitivity: planted fault (removed ownership check in orders/get.ts)" -- npm run test:api
   ```

   A non-zero exit from a *different* failure (a syntax error, a missing import, a
   connection refused) proves nothing. Read the output and confirm that the assertion you
   care about is the one that failed.
3. **Restore, and confirm the workspace matches what it was before the fault.**
   `git diff --stat` shows no change from the fault, or the database has its index back.
   Revert with version control, not by hand.
4. **Capture the run again. It must exit zero.**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/ast.mjs" evidence capture --exec EXEC-2026-00007 \
     --summary "sensitivity: fault restored" -- npm run test:api
   ```

5. Cite **both** evidence IDs in the claim. The pair is the proof. Either one alone is not.

If the planted-fault run exits zero, the test is vacuous. That is a finding about the test,
not the product. Fix the test (usually the wrong URL, the wrong DOM, a missing `await`, or
an assertion that is never reached), then run the protocol again. Never report the original
green as `PASSED`.

## Safety

- Plant faults **only in the local workspace or a disposable database you started**. Never
  in a shared environment, never in anything the profile does not declare non-production.
- Never commit a planted fault, and never leave one in place while you work on something
  else. The restore in step 3 comes before any other step.
- This does not conflict with "never adjust product code to make your test pass". Here the
  product code is changed on purpose, to make the test **fail**, and it is reverted.

## Reporting

Say which tests were sensitivity-checked and which were not:

> Checkout authz suite: 14 passed (`EV-2026-00052`). Sensitivity demonstrated for the
> object-level authz test: it fails with the ownership check removed (`EV-2026-00050`,
> exit 1) and passes with it restored (`EV-2026-00051`, exit 0). The remaining 13 tests
> were not sensitivity-checked.
