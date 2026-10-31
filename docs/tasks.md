# Tasks and milestones

Rules: a task is done when its tests pass against Postgres and the spec matches
the code. Each test names the requirement ID it proves. Mark a done task `[x]`
and add the commit sha.

## M0 — Spec

- [x] Gather the architecture questions (Q1–Q32).
- [x] Write requirements, architecture, decisions and open questions.
- [x] Answer OQ-01 to OQ-11.

## M1 — Foundation (done 2026-10-31)

- [x] TypeScript + Express scaffold, strict `tsconfig`, ESLint, Prettier.
- [x] `docker-compose.yml`: Postgres 16 + app. `.env.example` with comments.
- [x] Migration runner and the first schema (architecture §3), incl. `frozen` in the status CHECK (OQ-11).
- [x] Ledger triggers: zero-sum at commit, no `UPDATE`/`DELETE` on ledger and audit tables. Least-privilege DB role. (LEDGER-02, LEDGER-04, AUDIT-03)
- [x] Platform: config, clock (OPS-01), pino logger with request ID (OPS-02), `pg` bigint parser + money helpers (MONEY-01..05), transaction helper.
- [x] Test harness: vitest against the Compose Postgres, one clean schema per test file.
- [x] GitHub Actions: lint, type check, tests with a Postgres service container.

## M2 — Cross-cutting core (done 2026-10-31)

- [x] Ledger module: chart of accounts, `post(tx, entry)`, balance queries. (LEDGER-01..06)
- [x] Audit writer. (AUDIT-01, AUDIT-02)
- [x] Auth middleware: JWT roles, network key, bank HMAC. `fake-login`. (SEC-01..04, SEC-06)
- [x] Idempotency middleware + store. (IDEM-01..05)
- [x] Error model: one JSON error shape, no stack traces in responses.

**Mutation checks (M1/M2).** Each guard was broken on purpose; the named test went red, then the code was restored.

| Mutation | Test that goes red |
|---|---|
| Skip the body-hash compare | IDEM-04 |
| Check-then-insert the idempotency key (race) | IDEM-05 |
| Remove the zero-sum constraint triggers | LEDGER-02 (both DB tests) |
| Grant UPDATE/DELETE on ledger and audit to `acme_app` | LEDGER-04 / AUDIT-03 (app role) |

Two test defects found this way and fixed: IDEM-05 did not force overlap (now the
probe holds the transaction with `pg_sleep`), and the audit trigger test passed
only when other files had written audit rows first (now it seeds its own row).


## M3 — Accounts and collateral (done 2026-10-31)

- [x] Open account + card (token, last4), one open account per customer. (COL-01, COL-10, SEC-05)
- [x] `fake-bank` that signs and sends `transfer.received` webhooks.
- [x] Deposit webhook → journal, limit, activation in one transaction. (COL-02..04, COL-06..09)
- [x] Ownership checks on read endpoints. (SEC-02)
- Deferred: COL-05 is proved in M4 (authorization). The payback payout of COL-07/COL-09 ships in M6 (D-M3-3).

**Mutation checks (M3).**

| Mutation | Test that goes red |
|---|---|
| No advisory lock on the bank transaction ID | COL-03 (10 overlapping deliveries) |
| No `FOR UPDATE` on the reference lookup | COL-06 (two transfers racing) |
| No `FOR UPDATE` and no version check | COL-06 |
| Minimum compare `>` instead of `>=` | COL-09 |
| Drop the customer filter on reads | SEC-02 |
| Drop the one-open-account index | COL-10 (both tests) |
| Skip the card activation | COL-04 |

## M4 — Authorization (done 2026-10-31)

- [x] Authorize: lock, lazy expiry, check, hold; every decision stored. (SPEND-01..05, SPEND-09, SPEND-11..13, COL-05, LEDGER-05)
- [x] Concurrency test: 20 parallel authorizations, total never over the limit. (SPEND-03)
- [x] Mutation check: remove `FOR UPDATE`, confirm the concurrency test goes red, restore.
- [x] Credited deposits debit `cash_collateral` (D-M4-1).

**Mutation checks (M4).**

| Mutation | Test that goes red |
|---|---|
| No `FOR UPDATE` on the account lock | SPEND-03 (version check makes losers fail) |
| No `FOR UPDATE` and no version check | SPEND-03: **20 of 20 approved** against a limit that fits 14 |
| `credit_balance` counted as available | SPEND-12 |
| `>=` instead of `>` on the credit check | SPEND-02, SPEND-12, SPEND-09 |
| No advisory lock on the network ID | SPEND-11 (10 overlapping deliveries) |
| No lazy expiry | SPEND-09 |
| Expiry `<` instead of `<=` | SPEND-09 (boundary) |
| No account status check | COL-05 / SPEND-05 |

## M5 — Capture, reversal, expiry, refund (done 2026-10-31)

- [x] Network endpoints for capture, reversal and refund (the `fake-network` client is the test helper for now; the demo script in M8 drives them).
- [x] Capture (over the hold, after expiry, force post, second capture). (SPEND-06, SPEND-07, SPEND-11, SPEND-14)
- [x] Reversal. (SPEND-08, SPEND-15)
- [x] Expiry job + lazy expiry. (SPEND-09)
- [x] Refund, with excess to credit balance. (SPEND-10, SPEND-12)
- [x] View clamp: `availableCredit >= 0`, `overLimit`. (SPEND-16)
- [x] CI: Prettier check and `npm audit --omit=dev`.

**Mutation checks (M5).**

| Mutation | Test that goes red |
|---|---|
| Capture does not release the hold amount | SPEND-07 and 6 more |
| Capture refuses an amount above the hold | SPEND-06 |
| No advisory lock on the capture ID | SPEND-11 (10 overlapping deliveries) |
| Refund puts the whole amount on the debt | SPEND-10 / SPEND-12, SPEND-11 |
| Reversal ignores a captured hold | SPEND-15 |
| Reversal without account lock or version check | the reversal-vs-authorizations race (3 of 3 runs) |
| Sweep job does nothing | SPEND-09 sweep |
| No clamp in the view | SPEND-16 |

The reversal-lock mutation first stayed green: the capture-vs-reversal race is
already serialised by the hold row lock. The account lock protects a different
race (reversal vs new authorizations on the same account), so that test was added.

## M6 — Repayment and payouts (done 2026-10-31)

- [x] Repayment webhook: debt first, excess to credit. (REPAY-01..03)
- [x] Credit netting at capture time; returnable credit never nets. (PAYOUT-10, PAYOUT-11)
- [x] Payout module: five states, payout ID as bank idempotency key, timeout → `unknown`, no auto-retry; `send-payouts` job. (REPAY-04, PAYOUT-01..06, PAYOUT-12, PAYOUT-13)
- [x] Ops endpoints: list and resolve payouts (completed / failed / retry / cancel), list `unapplied_funds`. (PAYOUT-04, COL-08)
- [x] Late payout webhook: resolve only `requested`/`unknown`, flag a mismatch after a manual resolution. (PAYOUT-08, PAYOUT-09)
- [x] Test isolation fix for table-wide lock checks (D-M6-5).

**Mutation checks (M6).**

| Mutation | Test that goes red |
|---|---|
| Netting ignores credit reserved by a payout | sent-payout credit does not net; parallel job; timeout reservation |
| Netting uses returnable credit | D-M6-1 return test |
| No netting | PAYOUT-10; retry/cancel frees credit |
| Timeout recorded as `failed` | PAYOUT-02 and three ops / late-webhook tests |
| Bank result overrides a person's resolution | both PAYOUT-09 tests |
| No advisory lock on the payout result bank ID | 10 overlapping result deliveries |
| Repayment puts the whole amount on the debt | 16 tests (CHECK `posted_debt >= 0` fires) |

## M7 — Closure

- [ ] Close request → `closing`. (CLOSE-01, CLOSE-02)
- [ ] `progress-closures` job: `closing` → `settling` → `closed`. (CLOSE-03..08, PAYOUT-07)

## M8 — Operability and demo

- [ ] Reconciliation command. (OPS-03)
- [ ] Seed data + `docker compose up` works from a clean clone. (OPS-04)
- [ ] Demo script for the main flow. (OPS-05)
- [ ] README: how to run, how to test, links to `docs/`.

## M9 — Cloud and CI

- [ ] Terraform for AWS (architecture §12). (Q29)
- [ ] CI runs `terraform fmt -check` and `terraform validate`. (OPS-06)

## M10 — Delivery

- [ ] Export the Claude Code transcripts into `PROMPTS.md`, in order. (Q4)
- [ ] Thinking-process doc: choices, trade-offs, what we left out and why.
- [ ] Final pass: spec matches code, every requirement has a test.

## Backlog (after the core, in this order)

1. Freeze / unfreeze. (FREEZE-01, FREEZE-02)
2. Collateral top-up / limit increase. (OQ-02)
3. Statements.
4. Interest (needs a rounding rule first).
5. Late fees.
6. Multi-capture per hold. (OQ-09)
7. UI + live demo. (Q31)
