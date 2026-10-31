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
| COL-10 | A customer shall have at most one account that is not `closed`. A second open request shall return HTTP 409. | Q20 |
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
| SPEND-11 | Each network authorization ID, capture ID and refund ID shall be processed only once. A retried authorization shall get the first decision, approved or declined. | Q14 |
| SPEND-17 | Under 50 concurrent mixed requests on one account (purchases, captures, duplicate captures, reversals, refunds, repayments), every request shall succeed, no recorded account state shall exceed the limit, and the final balances shall be the same for every order the database chooses. | Henry 2026-10-31 |
| SPEND-12 | A credit balance (overpayment, credited deposit) shall never raise available credit. Available credit is `credit_limit - posted_debt - held_total` and never includes `credit_balance`. | Henry 2026-10-31 |
| SPEND-14 | A capture or refund that names an unknown card token shall return HTTP 422 `card_not_found`. A capture without a known authorization shall still post (force post). | OQ-08 |
| SPEND-15 | A reversal of a captured authorization shall return HTTP 409. A reversal of an expired, reversed or declined authorization shall change nothing. An unknown authorization ID shall return 404. | Q15 |
| SPEND-16 | The account view shall show `availableCredit` as at least 0, and the amount over the limit as `overLimit`. Decisions use the real, possibly negative, value. | D-M5-2 |
| SPEND-13 | An authorization shall be declined, not rejected, when the card is unknown or not active, the account is not `active`, the amount is over `MAX_AMOUNT_CENTAVOS`, or credit is insufficient. A malformed request returns 422. | Q15 |

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
| PAYOUT-01 | A payout shall have one of five states: `requested`, `completed`, `failed`, `unknown`, `cancelled` (ops gave up on a failed payout). | OQ-06, D-M6-4 |
| PAYOUT-02 | When the bank call times out or gives an unclear answer, the payout shall become `unknown`, never `failed`. | OQ-06 |
| PAYOUT-03 | The service shall never retry a payout on its own. | OQ-06 |
| PAYOUT-04 | Only ops shall resolve an `unknown` or `failed` payout. Each resolution shall write an audit row. | OQ-06, Q23 |
| PAYOUT-05 | The money of a payout that is not `completed` shall stay reserved. The ledger shall post the payout only when it is `completed`. | OQ-06 |
| PAYOUT-06 | Each payout request to the bank shall carry the payout ID as the bank idempotency key. | OQ-06 |
| PAYOUT-07 | The service shall not move an account to `closed` while a payout of that account is not `completed`. | OQ-06, Q19 |
| PAYOUT-08 | A signed bank result webhook shall resolve a payout only while it is `unknown` or `requested`. | OQ-12 |
| PAYOUT-10 | Free credit (credit balance that is not returnable and not in an open payout) shall pay new debt when a capture posts. Credit in a `requested`, `unknown` or `failed` payout shall not net. | Henry 2026-10-31 |
| PAYOUT-11 | A deposit credited to the customer (COL-07, COL-09) shall go back as a `return` payout from `cash_collateral` and shall never net against debt. | D-M6-1 |
| PAYOUT-12 | Payouts shall go to the payout CLABE the customer gave when opening the account. Opening an account without an 18-digit payout CLABE shall return 422. | D-M6-3 |
| PAYOUT-13 | A scheduled job shall create the due payouts and send each one after its commit, with no lock held during the bank call. | REPAY-04 |
| PAYOUT-15 | A cancelled payout shall keep its money held (it does not net, is not paid out again, and keeps the account from closing) until ops releases it. Release may set a new payout CLABE; released credit first pays debt. A payout can be released once. | OQ-13 |
| PAYOUT-16 | When an account owes open or charged-off debt, settlement shall take back the collateral of a `failed` collateral payout and use it for that debt. A `requested` or `unknown` collateral payout is not touched; if it later turns `failed`, its collateral recovers the charge-off. | review A1 |
| PAYOUT-17 | A payout shall be claimed atomically before the bank call, so concurrent senders make at most one bank request per payout. | review B1 |
| PAYOUT-14 | The ops payout list shall flag a `requested` payout as stuck when, `PAYOUT_STUCK_MINUTES` after creation, it was never claimed for sending (`not_submitted`), or, that long after the claim, the bank sent no result (`no_bank_result`, which includes a crash between the claim and the bank call). | Henry 2026-10-31 |
| PAYOUT-09 | When a bank result webhook arrives for a payout that a person already resolved, the service shall not change the payout. If the results differ, it shall flag a mismatch for ops and write an audit row. | OQ-12 |

## 6. Closure and collateral release (CLOSE)

| ID | Requirement | Source |
|---|---|---|
| CLOSE-01 | When a customer or ops requests closure, the service shall move the account to `closing` at once and block the card. From then on it shall decline all new authorizations. A `pending_collateral` account with no money closes at once. A second close request returns 409. | Q19 |
| CLOSE-02 | In `closing`, the service shall still post captures, reversals, refunds and repayments. | Q15, Q19 |
| CLOSE-03 | The service shall move the account from `closing` to `settling` when no open hold remains and `CLOSING_CAPTURE_WINDOW_DAYS` have passed since the close request. An account that never activated skips the window. | Q19, OQ-03 |
| CLOSE-04 | In `settling`, the service shall apply the collateral to the debt first, then pay out the remaining collateral and the credit balance to the customer. | Q19 |
| CLOSE-05 | The service shall move the account to `closed` when the bank confirms all payouts. | Q19, OQ-06 |
| CLOSE-07 | When the debt is larger than the collateral, the service shall apply all collateral and post the rest to `chargeoff_loss`. | OQ-04 |
| CLOSE-09 | A repayment or a refund shall pay open debt first, then charged-off debt (a recovery that reduces `chargeoff_loss`), and only then become credit. A deposit to the collateral reference shall recover charged-off debt first; it never pays open debt (D-M6-1). | D-M7-1, review B2/B3 |
| CLOSE-08 | A capture, refund or repayment in `settling` or `closed` shall post. A credit that results shall trigger a new payout. | OQ-05 |
| CLOSE-06 | The service shall never release collateral while the account has debt. | Q19, Q24 |

## 7. Freeze (FREEZE)

| ID | Requirement | Source |
|---|---|---|
| FREEZE-01 | A customer (own account only, else 404) or ops shall be able to freeze an `active` account and unfreeze a `frozen` account. Any other state returns 409. Both calls need an `Idempotency-Key` and write an audit row. | Q2, Q20, Henry 2026-10-31 |
| FREEZE-02 | A `frozen` account shall decline all new authorizations with reason `account_frozen`, and still post captures, reversals, refunds and repayments, because that money already moved. The card stays `active`. | Q2, Q15, Henry 2026-10-31 |
| FREEZE-03 | A `frozen` account can be closed; closing blocks the card and ends the freeze. | Henry 2026-10-31 |

## 8. Security (SEC)

| ID | Requirement | Source |
|---|---|---|
| SEC-01 | Customer and ops endpoints shall require a JWT with a role (`customer` or `ops`). | Q21 |
| SEC-02 | A customer shall read and change only their own account. A request for another account shall return HTTP 404. | Q21 |
| SEC-03 | Card network endpoints shall require the network API key. | Q21 |
| SEC-04 | Bank webhooks shall require a valid HMAC-SHA256 signature over the timestamp and the raw JSON body. The service shall reject a timestamp older than 5 minutes, and shall reject a request with no raw JSON body (fail closed). | Q21, review C1 |
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
| AUDIT-01 | Every state change shall write an audit row: actor, action, entity, state before, state after, request ID, time. A scheduled job run uses a run ID (`job:<name>:<uuid>`) as its request ID. | Q23, review D3 |
| AUDIT-02 | The service shall write the audit row in the same transaction as the change. | Q23 |
| AUDIT-03 | The database shall reject an `UPDATE` or a `DELETE` on the audit table. | Q23 |

## 11. Operations (OPS)

| ID | Requirement | Source |
|---|---|---|
| OPS-01 | All code shall read the time from an injectable clock. | Q27 |
| OPS-02 | Every log line shall be JSON and carry the request ID. | Q26 |
| OPS-03 | A reconciliation command shall check that (a) the ledger sums to zero, (b) each `held_total` equals the sum of open holds, (c) each cached balance equals its ledger sum, (d) each `charged_off_outstanding` equals its `charge_offs` log. It shall exit non-zero on a mismatch. | Q25 |
| OPS-04 | `docker compose up` shall start Postgres, run the migrations and the seed, and start the app. | Q28 |
| OPS-05 | A demo script (`npm run demo`) shall run the main flow end to end against the Compose stack: open, deposit, activate, authorize, capture, repay, close, payout, reconcile. It shall exit non-zero on any unexpected value. | Q28 |
| OPS-07 | The migration runner shall refuse a migration that sorts before one already applied, and an applied migration whose file changed. | review D4 |
| OPS-06 | CI shall run lint, Prettier, `npm audit --omit=dev`, type check, build, the tests against Postgres, a Docker image build, and `terraform fmt -check` + `validate` + `test`. | Q30, review F3 |
