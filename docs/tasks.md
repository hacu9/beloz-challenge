# Tasks and milestones

Rules: a task is done when its tests pass against Postgres and the spec matches
the code. Each test names the requirement ID it proves. Mark a done task `[x]`
and add the commit sha.

## M0 — Spec

- [x] Gather the architecture questions (Q1–Q32).
- [x] Write requirements, architecture, decisions and open questions.
- [x] Answer OQ-01 to OQ-11.

## M1 — Foundation

- [ ] TypeScript + Express scaffold, strict `tsconfig`, ESLint, Prettier.
- [ ] `docker-compose.yml`: Postgres 16 + app. `.env.example` with comments.
- [ ] Migration runner and the first schema (architecture §3), incl. `frozen` in the status CHECK (OQ-11).
- [ ] Ledger triggers: zero-sum at commit, no `UPDATE`/`DELETE` on ledger and audit tables. Least-privilege DB role. (LEDGER-02, LEDGER-04, AUDIT-03)
- [ ] Platform: config, clock (OPS-01), pino logger with request ID (OPS-02), `pg` bigint parser + money helpers (MONEY-01..05), transaction helper.
- [ ] Test harness: vitest against the Compose Postgres, one clean schema per test file.
- [ ] GitHub Actions: lint, type check, tests with a Postgres service container.

## M2 — Cross-cutting core

- [ ] Ledger module: chart of accounts, `post(tx, entry)`, balance queries. (LEDGER-01..06)
- [ ] Audit writer. (AUDIT-01, AUDIT-02)
- [ ] Auth middleware: JWT roles, network key, bank HMAC. `fake-login`. (SEC-01..04, SEC-06)
- [ ] Idempotency middleware + store. (IDEM-01..05)
- [ ] Error model: one JSON error shape, no stack traces in responses.

## M3 — Accounts and collateral

- [ ] Open account + card (token, last4). (COL-01, SEC-05)
- [ ] `fake-bank` that signs webhooks.
- [ ] Deposit webhook → journal, limit, activation in one transaction. (COL-02..09)
- [ ] Ownership checks on read endpoints. (SEC-02)

## M4 — Authorization

- [ ] Authorize: lock, lazy expiry, check, hold. (SPEND-01..05, SPEND-11)
- [ ] Concurrency test: 20 parallel authorizations, total never over the limit. (SPEND-03)
- [ ] Mutation check: remove `FOR UPDATE`, confirm the concurrency test goes red, restore.

## M5 — Capture, reversal, expiry, refund

- [ ] `fake-network` client.
- [ ] Capture (over the hold, after expiry). (SPEND-06, SPEND-07), incl. force post
- [ ] Reversal. (SPEND-08)
- [ ] Expiry job + lazy expiry. (SPEND-09)
- [ ] Refund, with excess to credit balance. (SPEND-10)

## M6 — Repayment

- [ ] Repayment webhook. (REPAY-01..03)
- [ ] Payout module: request with payout ID as bank idempotency key, four states, timeout → `unknown`, no auto-retry. (REPAY-04, PAYOUT-01..06)
- [ ] Ops endpoints: list and resolve `unknown`/`failed` payouts, list `unapplied_funds`. (PAYOUT-04, COL-08)
- [ ] Late payout webhook on an `unknown` payout. — blocked by OQ-12

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
