# Acme Credit: secured credit card service

A service that owns the lending flow of a secured credit card: collateral
deposit, card activation, purchase authorization with holds, capture and
refund, repayment, payouts, and account closure with collateral release or
application. TypeScript, Express 5, Postgres 16.

To see the money move, start with [`docs/money-flow.md`](docs/money-flow.md):
one account from deposit to close, every ledger entry, checked by a test.

The design and every decision behind it are in [`docs/`](docs/README.md),
written spec-first: requirements with IDs, the architecture, a decision log,
and milestones. Every test names the requirement it proves.

## Run it

Requirements: Docker with Compose, Node 22.

```bash
npm ci
docker compose up -d --build --wait app   # Postgres, migrations, seed, API on :3080
npm run demo                               # the whole flow, checked step by step
```

Where Docker has no buildx plugin, prefix the build: `DOCKER_BUILDKIT=0 docker compose up -d --build --wait app`.

`npm run demo` opens an account, deposits collateral, authorizes and captures
purchases, fires 20 parallel purchases at one card, repays with an
overpayment, closes the account, pays the collateral back, and ends with the
reconciliation job. It exits non-zero on the first unexpected number.

Scheduled jobs run on demand the way production runs them, one container per run:

```bash
docker compose run --rm jobs reconcile          # ledger sums to zero, caches match (exit 1 on drift)
docker compose run --rm jobs expire-holds
docker compose run --rm jobs send-payouts
docker compose run --rm jobs progress-closures
```

## Test it

```bash
docker compose up -d --wait db   # the tests use this Postgres on :5442
npm test                         # every test runs against real Postgres
npm run lint && npm run typecheck
```

Each run drops and re-creates the `acme_test` database and migrates it like
production. The suite includes parallel-request tests (20 purchases against
one card, 10 duplicate webhooks, racing captures and reversals). Every guard was
also checked by breaking it on purpose and watching its test fail; the tables
are in [`docs/tasks.md`](docs/tasks.md).

## What protects the money

| Concern | Mechanism | Where |
|---|---|---|
| Two purchases at once | `SELECT … FOR UPDATE` on the account row; every writer takes it | [architecture §7](docs/architecture.md) |
| Never over the limit | available = limit − debt − holds, checked under the lock; a credit balance never counts | SPEND-02/03/12 |
| Exactly once | `Idempotency-Key` stored in the same transaction; network and bank IDs deduped under an advisory lock | [architecture §8](docs/architecture.md) |
| Books that balance | double-entry ledger, append-only, zero-sum checked by a deferred DB trigger | LEDGER-01..04 |
| Money amounts | integer centavos, `bigint` in Postgres, a parser that throws past 2^53 | MONEY-01..05 |
| Least privilege | the app's DB role cannot UPDATE or DELETE ledger or audit rows | LEDGER-04, AUDIT-03 |
| Payouts in doubt | a timeout is `unknown`, never retried by the code; a person resolves it; a cancelled payout stays parked until a person releases it | PAYOUT-01..17 |
| Drift | `reconcile` recomputes every cached balance from the ledger | OPS-03 |
| Audit | append-only audit row in the same transaction as every change | AUDIT-01..03 |

## Callers

| Caller | Auth | Endpoints |
|---|---|---|
| Customer | JWT (`role=customer`) | `POST /v1/accounts`, `GET /v1/accounts[/:id]`, `POST /v1/accounts/:id/close` |
| Ops | JWT (`role=ops`) | `GET /v1/accounts/:id`, `/v1/ops/payouts`, `/v1/ops/payouts/:id/resolve`, `/v1/ops/payouts/:id/release`, `/v1/ops/unapplied-funds` |
| Card network | `X-Network-Key` | `/v1/network/authorizations`, `…/:id/reversal`, `/v1/network/captures`, `/v1/network/refunds` |
| Bank | HMAC signature over the raw body | `/v1/bank/webhooks` (`transfer.received`, `payout.completed`, `payout.failed`) |

The bank, the card network and the login provider are simulated (`src/fakes/`).

## Deploy

Terraform for AWS (ECS Fargate, RDS, Secrets Manager, EventBridge Scheduler)
is in `infra/terraform/`; see [`docs/deployment.md`](docs/deployment.md). CI
validates it; nothing here applies it.
