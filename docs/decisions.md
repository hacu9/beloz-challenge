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

## M6 build decisions (2026-10-31)

| ID | Decision | Reason |
|---|---|---|
| D-M6-0 | Free credit nets against new debt at capture time, until a payout takes it (PAYOUT-10). | Henry 2026-10-31. |
| D-M6-1 | Credit from a deposit that landed in the collateral account never nets against open debt; it is returned from `cash_collateral` (PAYOUT-11). Henry confirmed 2026-10-31. Amended by D-R-5: it first recovers charged-off debt. | Netting it would move cash out of the segregated account without a real bank transfer: the ledger and the bank statement would disagree. |
| D-M6-2 | Payouts are created by a scheduled job, not at the moment credit appears. | Without a delay there is no "not sent yet" window, so D-M6-0 would never apply. |
| D-M6-3 | The customer gives a payout CLABE when opening the account. Henry confirmed 2026-10-31. | A payout needs a destination; the service had none. |
| D-M6-4 | Fifth payout state `cancelled`: ops gives up on a failed payout; the reservation ends. Henry confirmed 2026-10-31. | OQ-06 says a person resolves a failed payout; "retry" and "give up" are the two resolutions. |
| D-M6-5 | The test schema checks that take table-wide locks (`TRUNCATE … CASCADE`, unfiltered `UPDATE`/`DELETE` as owner) run in an isolated copy of the test database. | Once (1 of 9 runs) the owner-trigger test failed. The cascading TRUNCATE locks every table that references the ledger, so it can deadlock with, or kill, transactions in parallel test files. The log of the failing run was lost, so the deadlock is the likely cause, not a proven one. 5 of 5 runs green after the change. |

## M7 build decisions (2026-10-31)

| ID | Decision | Reason |
|---|---|---|
| D-M7-1 | A repayment after a charge-off is a recovery: it reduces `chargeoff_loss` before it can become credit (CLOSE-09). | Without it, a customer paying a charged-off debt would have the money paid back to them, because `posted_debt` is already 0. Found while designing M7. |
| D-M7-2 | Charged-off debt stays on the account as `charged_off_outstanding`, with an append-only `charge_offs` log (charge-off / recovery). | OQ-04 says "record the debt for collections". |
| D-M7-3 | A `pending_collateral` account with money (a credited deposit) closes through `closing` → `settling`, without the late-capture window. | Its deposit must go back first; it never had an active card, so no capture can arrive. |
| D-M7-4 | Collateral already in a payout is never pulled back. Debt that appears after that is charged off. Amended by D-R-4: a `failed` collateral payout is taken back; an `unknown` one that later fails recovers the charge-off. | The money has left or may have left (`unknown`). Pulling it back needs the bank. |
| D-M7-5 | Stuck payouts are flagged in two kinds: `not_submitted` and `no_bank_result` (PAYOUT-14). | Henry asked for a stuck flag; SPEI settles in seconds, so both are suspect after minutes. |

## M8 / M9 build decisions (2026-10-31)

| ID | Decision | Reason |
|---|---|---|
| D-M8-1 | The demo runs the jobs as one-off containers (`docker compose run --rm jobs <job>`), like production. | The demo then proves the job entry point and its exit codes, not a test-only shortcut. |
| D-M8-2 | The `jobs` Compose service sets `CLOSING_CAPTURE_WINDOW_DAYS=0`; the app keeps 30. | The demo must close an account in one run without a fake clock. Only the closure job reads the window. |
| D-M8-3 | The demo reads the card token from the database. | The token belongs to the card network (SEC-05: the API never returns it). In production the issuer processor hands it over. |
| D-M8-4 | `reconcile` also checks `charged_off_outstanding` against the `charge_offs` log and `credit_returnable <= credit_balance`. | These caches were added in M6/M7 after Q25 was written. |
| D-M9-1 | Terraform generates every secret, so they are in the state; the S3 backend must be encrypted and locked. | Simplest correct first environment. RDS-managed master passwords plus rotation is the next step. |
| D-M9-2 | ARM64 (Graviton) Fargate tasks, one NAT gateway, HTTPS-only ALB. | Cost for a first environment; production adds a NAT per AZ. |
| D-M9-3 | Jobs are scheduled one-off tasks with no scheduler retry. | Each job step is idempotent under the account lock; the next tick is the retry. A failure raises an alarm. |

## Blind review fixes (2026-10-31)

opencode2 (`gpt-6-luna`), two blind runs: closure + payouts, and refunds + repayments + clearing. Briefs held the files, 11 money rules and the five review questions only.

| ID | Finding | Verdict | Decision |
|---|---|---|---|
| D-R-1 | A2: credit freed after debt appeared was paid out instead of netting (repro: 10,000 paid, 4,000 expected) | CONFIRMED | Release nets first; `createDue` nets first as a second barrier. |
| D-R-2 | B2: a refund after a charge-off became customer credit (repro) | CONFIRMED | Refunds split debt → charged-off → credit, like repayments (CLOSE-09). |
| D-R-3 | B1: concurrent `submit` could call the bank twice for one payout | CONFIRMED (robustness: no caller does it today; the bank dedupes on payout ID) | Atomic claim before the bank call (PAYOUT-17). |
| D-R-4 | A1: collateral leaves while late debt is charged off | ESCALATED → Henry 2026-10-31 | Take back a `failed` collateral payout when money is owed; keep the charge-off for `requested`/`unknown`, and recover it from the collateral if that payout later fails (PAYOUT-16). |
| D-R-5 | B3: a collateral-reference deposit is returned while the customer owes charged-off debt | ESCALATED → Henry 2026-10-31 | Recover charged-off debt first; open debt still never nets (CLOSE-09). |
| D-R-6 | B4: `accounts.update` can set `closed` with debt | REJECTED | Only closure and the empty-pending close set `closed`, both after checking balances; a DB rule is impossible because closed accounts take late debt (CLOSE-08). |
| D-R-7 | B5: a cancelled return strands credit and blocks closure | CONFIRMED, merged into OQ-13 | Answered by OQ-13 below. |
| D-R-8 | B6, B7 | REJECTED | Informational / caller outside the file set (`closure.ts`). |

## Second blind review, the rest of the code (2026-10-31)

Four opencode2 runs: C (HTTP, auth, idempotency, routes), D (ledger, audit, money, DB layer), E (payouts, closure and charge-offs after the fixes, reconcile, migrations 002/003/007), F (Terraform, Dockerfile, CI).

| ID | Finding | Verdict | Action |
|---|---|---|---|
| C1 | Bank signature verified against an empty body when no JSON body was parsed | CONFIRMED, security, latent (probe: signed-over-nothing passed auth, stopped only by validation) | Fail closed without a raw body (SEC-04). |
| C2 | Ops retry: a failed send after commit is not resent on replay | REJECTED | No money moves; the stuck flag shows it; ops can mark it failed and retry. |
| D1 | Comment says the owner cannot bypass the append-only triggers | CONFIRMED (comment) | Corrected in migration 008 and architecture §3; 001 cannot change (checksum guard). |
| D2 | `Ledger.post` writes no audit row | REJECTED | Callers write the audit row with the state change; the journal is the money record. |
| D3 | Job audit rows have no request ID | CONFIRMED, robustness | Run ID per job run (AUDIT-01). |
| D4 | A migration added before an applied one runs out of order | CONFIRMED, robustness | Refused (OPS-07). |
| E1 | Ops marks an in-flight payout failed and retries: two bank calls | REJECTED as money-loss | Same payout ID; the bank dedupes (PAYOUT-06). |
| E2 | Collateral-reference deposit returned while open debt exists | REJECTED | D-M6-1 (Henry). The brief's rule was too broad. |
| E3 | Account closes with charged-off debt owed | REJECTED | OQ-04 (Henry). The brief's rule was too broad. |
| F1 | A secret could be put in plain-text `app_config` | CONFIRMED | Terraform validation, proven by `terraform test`. |
| F2 | Base image is a mutable tag | CONFIRMED | Pinned by digest. |
| F3 | CI never builds the image | CONFIRMED | `docker build` step. |
| F4 | Terraform does not run migrations | REJECTED | Release step 3 in deployment.md. |
| F5 | Job-failure alarm notifies nobody | CONFIRMED | SNS topic as alarm and OK action, proven by `terraform test`. |

Lesson for the next brief: state each rule *with* its deliberate exceptions (E2 and E3 came from rules written without D-M6-1 and OQ-04).

## OQ-13 answer (2026-10-31)

| OQ | Decision |
|---|---|
| OQ-13 | `cancel` parks the money until ops acts. Ops releases a parked payout (optionally with a new payout CLABE); without a release the account never closes (PAYOUT-15). |

## Dependency audit (2026-10-31)

| Package | Severity | Scope | Action |
|---|---|---|---|
| `zod` < 4.6.6 (GHSA-mrhx-c7xc-m3w5, memory exhaustion) | high | runtime | Upgraded to `zod@4.6.7`. |
| `tinypool` via `vitest` (GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr) | critical | dev | Upgraded to `vitest@5.0.5`. |
| `minimatch` < 11.0.1 via `eslint` / `typescript-eslint` | moderate | dev | Accepted. npm's only "fix" downgrades to `eslint@4`. The ReDoS needs an attacker-controlled glob; ESLint only reads our own config. Revisit when ESLint ships a fixed chain. |

`npm audit --omit=dev` reports 0 vulnerabilities. CI should run it as a gate (M9).
