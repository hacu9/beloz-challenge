# Decision log

Each entry keeps the original question number (Q1–Q32) for traceability.
Status `DECIDED` means Henry decided it. P1–P7 were AI proposals; Henry
accepted them on 2026-10-31.

| Q | Topic | Decision | Status |
|---|---|---|---|
| Q1 | Stack | TypeScript + Express. Beloz runs this stack. | DECIDED |
| Q2 | Extras | Document all extras in the backlog. Start them after the core is done. Freeze is first. | DECIDED |
| Q3 | Time plan | Not relevant. | DECIDED |
| Q4 | Prompt log | Export the Claude Code transcript into `PROMPTS.md`. | DECIDED |
| Q5 | Style | One app and one real Postgres. The code splits by area. The bank, the card network and the login are simulated, because Acme does not own them. | DECIDED |
| Q6 | Boundary | We own accounts, cards, collateral, the ledger, holds and payouts. The card network, the login and the bank are fakes. No KYC. | DECIDED |
| Q7 | Sync/async | Synchronous. The only async input is the bank webhooks. No outbox. | DECIDED |
| Q8 | API | REST. Customer endpoints, plus separate endpoints for the card network and the bank, each with its own auth. | DECIDED |
| Q9 | Ledger | Double entry, append only. We never edit an entry. A fix is a new entry. Holds stay out of the ledger. | DECIDED |
| Q10 | Money | Integer centavos. No floats. MXN is the single currency. `bigint` in Postgres, `number` in TypeScript (with a safe-integer guard, see architecture §4). | DECIDED |
| Q11 | Event sourcing | No. | DECIDED |
| Q12 | Storage | Real Postgres in Docker. Memory cannot prove that locks or constraints work. | DECIDED |
| Q13 | Concurrency | Lock the account row (`SELECT … FOR UPDATE`) inside the transaction, then check and save. CHECK constraints on holds. A test fires 20 parallel purchases and asserts that the total never goes over the limit. | DECIDED |
| Q14 | Idempotency | An `Idempotency-Key` header on every money call. Store the key and the hash of the body in the same transaction as the money movement. | DECIDED |
| Q15 | Spend lifecycle | Full: authorize (= hold), capture, reverse, hold expiry after N days, refund. A capture always posts, also when it is bigger than the hold or arrives after expiry. We can decline an authorization, never a capture. | DECIDED |
| Q16 | Limit | 1:1 with the confirmed collateral. | DECIDED |
| Q17 | Deposit | The deposit arrives as a signed bank webhook. The card activates when the deposit is confirmed. Dedupe on the bank transaction ID. | DECIDED |
| Q18 | Repayment | Only by bank webhook. An overpayment goes back to the customer as a payout. | DECIDED |
| Q19 | Closure | Closing blocks new purchases at once. We wait for late captures. The collateral pays the debt first, and the rest goes to the customer. | DECIDED |
| Q20 | Entities | One account, one card. States: `pending_collateral`, `active`, `frozen` (tentative), `closing`, `settling`, `closed`. | DECIDED |
| Q21 | Callers | Four callers: customer, ops, card network, bank. Customer and ops use test JWTs with a role. The card network has its own API key. The bank signs its webhooks. | DECIDED |
| Q22 | PCI | Store a token and the last 4 digits only. | DECIDED |
| Q23 | Audit | Append-only audit table: who, what, before, after, request ID. | DECIDED |
| Q24 | Invariants | The ledger always sums to zero. A new authorization never goes over the limit. | DECIDED |
| Q25 | Reconciliation | A small check we can run: the ledger sums to zero, the held counter matches the open holds, and the cached balances match the ledger. | DECIDED |
| Q26 | Observability | Structured logs with a request ID. | DECIDED |
| Q27 | Time | An injectable clock. All code reads the time from it. | DECIDED |
| Q28 | Local run | Docker Compose with Postgres, seed data, and a demo script that runs the main flow. | DECIDED |
| Q29 | Cloud | Terraform on AWS. We do not apply it. | DECIDED |
| Q30 | CI | GitHub Actions: lint, type check, tests against Postgres, `terraform validate`. | DECIDED |
| Q31 | Live demo | Only if we build a UI. | DECIDED |
| Q32 | Docs | SDD in `docs/`: requirements, architecture, tasks with milestones. Update them when the code changes. | DECIDED |

## AI proposals (accepted 2026-10-31)

| ID | Topic | Proposal | Reason |
|---|---|---|---|
| P1 | DB access | Raw SQL with `pg` (node-postgres). No ORM. | The locks, the isolation and the constraints must be visible in the code. An ORM hides them. |
| P2 | Migrations | Plain numbered SQL files and a small runner. | The schema is the safety net. The reviewer must read it as SQL. |
| P3 | Validation | `zod` at every HTTP boundary. | One schema gives the type and the runtime check. |
| P4 | Logs | `pino` with a request ID from `AsyncLocalStorage`. | JSON logs, low overhead. |
| P5 | Tests | `vitest` + `supertest` against the Compose Postgres. | Fast. Real DB. |
| P6 | Isolation level | `READ COMMITTED` plus `SELECT … FOR UPDATE` on the account row. | The row lock serialises all writes per account. `SERIALIZABLE` adds retries and gives nothing more here. |
| P7 | Hold TTL | 7 days, from config `HOLD_TTL_DAYS`. | A common issuer default for card-present and e-commerce authorizations. |

## Answers to the open questions (2026-10-31)

| OQ | Topic | Decision |
|---|---|---|
| OQ-01 | Over-limit guard | The authorization guard lives in the locked transaction plus the concurrency test. The DB cannot enforce `posted_debt + held_total <= credit_limit`, because a capture may post over the limit (Q15). We document this as a deliberate trade-off. |
| OQ-02 | Deposit for an account that is not `pending_collateral` | We cannot reject money that already landed: a rejected webhook does not send the money back. Known account: record the deposit as customer credit and pay it back to the customer. Unknown reference: record it in a suspense account (`unapplied_funds`) and flag it for ops. Collateral top-up stays in the backlog. |
| OQ-03 | Late-capture window | `CLOSING_CAPTURE_WINDOW_DAYS = 30` from config. |
| OQ-04 | Debt larger than collateral | Apply all collateral, post the rest to `chargeoff_loss`, record the debt for collections, close the account. |
| OQ-05 | Money events in `settling` / `closed` | Post them. A capture becomes new debt (collections or charge-off). A refund or repayment becomes a credit and triggers a new payout. |
| OQ-06 | Payout result | Four states: `requested`, `completed`, `failed`, `unknown`. A timeout or an unclear bank answer is `unknown`, never `failed`. The service never retries a payout on its own. A person resolves `unknown` and `failed` payouts. The money stays reserved until then. |
| OQ-07 | Deposit vs repayment | Two references per account (collateral and repayment), like two SPEI CLABEs. |
| OQ-08 | Capture without a known authorization | Accept and post it (force post). It must name a known card token. |
| OQ-09 | Captures per hold | One capture closes the hold. Multi-capture goes in the backlog. |
| OQ-10 | Minimum deposit | `MIN_DEPOSIT_CENTAVOS` from config (default 50000 = 500 MXN). |
| OQ-11 | `frozen` in the first migration | Yes. The endpoints stay in the backlog. |
| OQ-12 | Late bank webhook for a payout | The webhook resolves the payout only while it is still `unknown`. If a person already resolved it, the webhook changes nothing; when its result differs from the person's, the service flags the mismatch for ops. |
| COL-09 | Deposit below the minimum | Accepted as proposed: credit balance + payback, the account stays `pending_collateral`. |

## M3 build decisions (2026-10-31)

| ID | Decision | Reason |
|---|---|---|
| D-M3-1 | One bank event, `transfer.received`, for all incoming money. The reference decides deposit vs repayment. | A SPEI transfer has no purpose field; the CLABE it went to is the only signal (OQ-07). |
| D-M3-2 | Until M6, a transfer to a repayment reference returns 501 and records nothing. | The rollback stores nothing, so the bank retries and no money is lost or half-applied. |
| D-M3-3 | Until M6, a credited deposit (COL-07, COL-09) raises `credit_balance`; the payout itself ships with the payout module. | The ledger and the cached balance are correct now; only the outgoing transfer waits. |
| D-M3-4 | One non-closed account per customer, enforced by a partial unique index (COL-10). | Q20 says one account, one card. The index also wins the race between parallel opens. |
| D-M3-5 | A transfer amount has no maximum. | The money already landed (COL-06). `MAX_AMOUNT_CENTAVOS` applies to requests, not to money received. |
| D-M3-6 | Card token `tok_<32 hex>` and a random last4, from a simulated issuer. | SEC-05: the service never sees a PAN. |

## M4 build decisions (2026-10-31)

| ID | Decision | Reason |
|---|---|---|
| D-M4-1 | A credited deposit to a collateral reference debits `cash_collateral`, not `cash_operating`. | The money physically landed in the segregated collateral bank account. Henry agreed 2026-10-31. |
| D-M4-2 | A credit balance never counts as available credit (SPEND-12). | Henry 2026-10-31. A credit balance is money we owe back, not collateral. |
| D-M4-3 | Every authorization decision is stored in `authorizations`, declines included. | A decline creates no hold, but a retry must still get the same answer (SPEND-11). |
| D-M4-4 | An amount over `MAX_AMOUNT_CENTAVOS` is a decline, not a 422. | The card network expects a decision for a well-formed request. |
| D-M4-5 | Holds expire lazily under the account lock before each decision; the sweep job (M5) is a convenience, not a guard. | Correctness must not depend on a job running on time. |

## M5 build decisions (2026-10-31)

| ID | Decision | Reason |
|---|---|---|
| D-M5-1 | A payout of a credit balance leaves from the bank account where the money landed. The source comes from the ledger: a `customer_credit` line from a `deposit` entry came through `cash_collateral` (pay back as a return of that transfer); one from a `refund` or `repayment` came through operating cash. | Henry agreed 2026-10-31. No new table: the journal already records it. Implemented in M6. |
| D-M5-2 | The account view clamps `availableCredit` at 0 and shows `overLimit`; decisions use the real value. | Henry agreed 2026-10-31. A negative "available" confuses a customer; hiding the excess hides debt. |
| D-M5-3 | A capture releases the whole open hold, whatever its amount, and links to it; a capture on a hold that is not open links to nothing. | One capture per hold (OQ-09); `captures.hold_id` is unique, and a capture must never fail. |
| D-M5-4 | A capture or refund does not net against an existing credit balance. | The credit balance is paid back (REPAY-04), and its source decides which bank account pays (D-M5-1). Netting would mix the two. |

## Dependency audit (2026-10-31)

| Package | Severity | Scope | Action |
|---|---|---|---|
| `zod` < 4.6.6 (GHSA-mrhx-c7xc-m3w5, memory exhaustion) | high | runtime | Upgraded to `zod@4.6.7`. |
| `tinypool` via `vitest` (GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr) | critical | dev | Upgraded to `vitest@5.0.5`. |
| `minimatch` < 11.0.1 via `eslint` / `typescript-eslint` | moderate | dev | Accepted. npm's only "fix" downgrades to `eslint@4`. The ReDoS needs an attacker-controlled glob; ESLint only reads our own config. Revisit when ESLint ships a fixed chain. |

`npm audit --omit=dev` reports 0 vulnerabilities. CI should run it as a gate (M9).
