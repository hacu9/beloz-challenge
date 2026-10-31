# Requirements

Format: each requirement has an ID, one rule, and the source decision (`Q` =
[decisions.md](decisions.md), `OQ` = [open-questions.md](open-questions.md)).
"Shall" means the rule is mandatory. A test must name the ID it proves.

## 1. Money (MONEY)

| ID | Requirement | Source |
|---|---|---|
| MONEY-01 | The service shall represent every amount as an integer number of MXN centavos. | Q10 |
| MONEY-02 | The service shall reject an amount that is not a positive safe integer, with HTTP 422. | Q10 |
| MONEY-03 | The service shall not use floating-point arithmetic on an amount. | Q10 |
| MONEY-04 | The service shall store every amount as `bigint` in Postgres. | Q10 |
| MONEY-05 | The service shall reject an amount above `MAX_AMOUNT_CENTAVOS` with HTTP 422. | Q10 |

## 2. Ledger (LEDGER)

| ID | Requirement | Source |
|---|---|---|
| LEDGER-01 | Every money movement shall write one journal entry with two or more lines. | Q9 |
| LEDGER-02 | The lines of each journal entry shall sum to zero (debit positive, credit negative). | Q9, Q24 |
| LEDGER-03 | The service shall never update or delete a journal entry or a line. A correction is a new entry that references the original. | Q9 |
| LEDGER-04 | The database shall reject an `UPDATE` or a `DELETE` on the ledger tables. | Q9 |
| LEDGER-05 | A hold shall not write to the ledger. | Q9 |
| LEDGER-06 | The service shall write the journal entry and the cached balance change in the same DB transaction. | Q9, Q25 |

## 3. Collateral and activation (COL)

| ID | Requirement | Source |
|---|---|---|
| COL-01 | When a customer opens an account, the service shall create the account in state `pending_collateral` and an inactive card. | Q20 |
| COL-02 | The service shall accept a collateral deposit only from a bank webhook with a valid signature. | Q17, Q21 |
| COL-03 | The service shall process each bank transaction ID only once. A duplicate shall return the first result. | Q17 |
| COL-04 | When the service confirms a deposit, it shall post the journal entry, set the credit limit equal to the confirmed collateral, move the account to `active` and activate the card, in one transaction. | Q16, Q17 |
| COL-05 | A card shall not authorize a purchase before its account is `active`. | Q17 |
| COL-06 | The service shall never reject a confirmed deposit webhook because of the account state. Money that landed is always recorded. | OQ-02 |
| COL-07 | A deposit for a known account that is not `pending_collateral` shall go to the customer credit balance and be paid back. | OQ-02 |
| COL-08 | A deposit with an unknown reference shall go to `unapplied_funds` and be flagged for ops. | OQ-02 |
| COL-09 | A deposit below `MIN_DEPOSIT_CENTAVOS` on a `pending_collateral` account shall go to the customer credit balance and be paid back. The account shall stay `pending_collateral`. | OQ-10 |

## 4. Spending (SPEND)

| ID | Requirement | Source |
|---|---|---|
| SPEND-01 | The service shall accept an authorization only from the card network, with a valid network API key. | Q8, Q21 |
| SPEND-02 | The service shall approve an authorization only if `amount <= credit_limit - posted_debt - held_total`. | Q13, Q24 |
| SPEND-03 | Under any number of parallel authorizations on one account, `posted_debt + held_total` shall not exceed `credit_limit` because of an authorization. | Q13, Q24 |
| SPEND-04 | An approved authorization shall create a hold and add its amount to `held_total`. | Q15 |
| SPEND-05 | The service shall decline an authorization when the account is not `active`. | Q15, Q19, Q20 |
| SPEND-06 | A capture shall always post, also when its amount is larger than the hold, and also after the hold expired. | Q15 |
| SPEND-07 | A capture shall close its hold, remove the hold amount from `held_total`, and post the capture amount to the ledger. | Q15 |
| SPEND-08 | A reversal shall release an open hold and remove its amount from `held_total`. It shall not write to the ledger. | Q15 |
| SPEND-09 | A hold shall expire `HOLD_TTL_DAYS` after its creation. An expired hold shall not count in `held_total`. | Q15, P7 |
| SPEND-10 | A refund shall post a credit to the customer. A refund larger than the debt shall put the excess in the customer credit balance. | Q15, Q18 |
| SPEND-11 | Each network authorization ID, capture ID and refund ID shall be processed only once. | Q14 |

## 5. Repayment (REPAY)

| ID | Requirement | Source |
|---|---|---|
| REPAY-01 | The service shall accept a repayment only from a signed bank webhook. | Q18 |
| REPAY-02 | A confirmed repayment shall reduce `posted_debt` and so restore available credit. | Q18 |
| REPAY-03 | The part of a repayment above `posted_debt` shall go to the customer credit balance. | Q18 |
| REPAY-04 | The service shall return a positive credit balance to the customer as a payout. | Q18 |

## 5a. Payouts (PAYOUT)

| ID | Requirement | Source |
|---|---|---|
| PAYOUT-01 | A payout shall have one of four states: `requested`, `completed`, `failed`, `unknown`. | OQ-06 |
| PAYOUT-02 | When the bank call times out or gives an unclear answer, the payout shall become `unknown`, never `failed`. | OQ-06 |
| PAYOUT-03 | The service shall never retry a payout on its own. | OQ-06 |
| PAYOUT-04 | Only ops shall resolve an `unknown` or `failed` payout. Each resolution shall write an audit row. | OQ-06, Q23 |
| PAYOUT-05 | The money of a payout that is not `completed` shall stay reserved. The ledger shall post the payout only when it is `completed`. | OQ-06 |
| PAYOUT-06 | Each payout request to the bank shall carry the payout ID as the bank idempotency key. | OQ-06 |
| PAYOUT-07 | The service shall not move an account to `closed` while a payout of that account is not `completed`. | OQ-06, Q19 |
| PAYOUT-08 | A signed bank result webhook shall resolve a payout only while it is `unknown` or `requested`. | OQ-12 |
| PAYOUT-09 | When a bank result webhook arrives for a payout that a person already resolved, the service shall not change the payout. If the results differ, it shall flag a mismatch for ops and write an audit row. | OQ-12 |

## 6. Closure and collateral release (CLOSE)

| ID | Requirement | Source |
|---|---|---|
| CLOSE-01 | When a customer or ops requests closure, the service shall move the account to `closing` at once. From then on it shall decline all new authorizations. | Q19 |
| CLOSE-02 | In `closing`, the service shall still post captures, reversals, refunds and repayments. | Q15, Q19 |
| CLOSE-03 | The service shall move the account from `closing` to `settling` when no open hold remains and `CLOSING_CAPTURE_WINDOW_DAYS` have passed since the close request. | Q19, OQ-03 |
| CLOSE-04 | In `settling`, the service shall apply the collateral to the debt first, then pay out the remaining collateral and the credit balance to the customer. | Q19 |
| CLOSE-05 | The service shall move the account to `closed` when the bank confirms all payouts. | Q19, OQ-06 |
| CLOSE-07 | When the debt is larger than the collateral, the service shall apply all collateral and post the rest to `chargeoff_loss`. | OQ-04 |
| CLOSE-08 | A capture, refund or repayment in `settling` or `closed` shall post. A credit that results shall trigger a new payout. | OQ-05 |
| CLOSE-06 | The service shall never release collateral while the account has debt. | Q19, Q24 |

## 7. Freeze (FREEZE) — backlog, first extra

| ID | Requirement | Source |
|---|---|---|
| FREEZE-01 | A customer or ops shall be able to freeze an `active` account and unfreeze a `frozen` account. | Q2, Q20 |
| FREEZE-02 | A `frozen` account shall decline all new authorizations and still post captures, reversals, refunds and repayments. | Q2, Q15 |

## 8. Security (SEC)

| ID | Requirement | Source |
|---|---|---|
| SEC-01 | Customer and ops endpoints shall require a JWT with a role (`customer` or `ops`). | Q21 |
| SEC-02 | A customer shall read and change only their own account. A request for another account shall return HTTP 404. | Q21 |
| SEC-03 | Card network endpoints shall require the network API key. | Q21 |
| SEC-04 | Bank webhooks shall require a valid HMAC-SHA256 signature over the timestamp and the raw body. The service shall reject a timestamp older than 5 minutes. | Q21 |
| SEC-05 | The service shall store only a card token and the last 4 digits. It shall never store or log a full card number. | Q22 |
| SEC-06 | Logs shall not contain secrets, tokens or signatures. | Q22, Q26 |

## 9. Idempotency (IDEM)

| ID | Requirement | Source |
|---|---|---|
| IDEM-01 | Every customer and ops call that moves money or changes state shall require an `Idempotency-Key` header. | Q14 |
| IDEM-02 | The service shall store the key, the SHA-256 hash of the body and the response in the same transaction as the change. | Q14 |
| IDEM-03 | A repeat with the same key and the same body shall return the stored response and change nothing. | Q14 |
| IDEM-04 | A repeat with the same key and a different body shall return HTTP 422 and change nothing. | Q14 |
| IDEM-05 | Two parallel requests with the same key shall produce one change. | Q14 |

## 10. Audit (AUDIT)

| ID | Requirement | Source |
|---|---|---|
| AUDIT-01 | Every state change shall write an audit row: actor, action, entity, state before, state after, request ID, time. | Q23 |
| AUDIT-02 | The service shall write the audit row in the same transaction as the change. | Q23 |
| AUDIT-03 | The database shall reject an `UPDATE` or a `DELETE` on the audit table. | Q23 |

## 11. Operations (OPS)

| ID | Requirement | Source |
|---|---|---|
| OPS-01 | All code shall read the time from an injectable clock. | Q27 |
| OPS-02 | Every log line shall be JSON and carry the request ID. | Q26 |
| OPS-03 | A reconciliation command shall check that (a) the ledger sums to zero, (b) each `held_total` equals the sum of open holds, (c) each cached balance equals its ledger sum. It shall exit non-zero on a mismatch. | Q25 |
| OPS-04 | `docker compose up` shall start Postgres and the app with seed data. | Q28 |
| OPS-05 | A demo script shall run the main flow end to end: open, deposit, activate, authorize, capture, repay, close, payout. | Q28 |
| OPS-06 | CI shall run lint, type check, the tests against Postgres, and `terraform validate`. | Q30 |
