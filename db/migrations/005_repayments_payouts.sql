-- 005: repayments, credit netting and payouts (M6).

-- D-M6-3: where the customer receives payouts. Required by the API from M6 on.
ALTER TABLE accounts ADD COLUMN payout_clabe text CHECK (payout_clabe ~ '^[0-9]{18}$');

-- D-M6-1: the part of credit_balance whose cash sits in the segregated
-- collateral bank account. It is returned to the sender, never netted.
ALTER TABLE accounts ADD COLUMN credit_returnable bigint NOT NULL DEFAULT 0
  CHECK (credit_returnable >= 0);
ALTER TABLE accounts ADD CONSTRAINT accounts_returnable_within_credit
  CHECK (credit_returnable <= credit_balance);

-- Payouts: three kinds, five states, the cash account that pays, and the
-- deposit a return gives back.
ALTER TABLE payouts DROP CONSTRAINT payouts_kind_check;
ALTER TABLE payouts ADD CONSTRAINT payouts_kind_check
  CHECK (kind IN ('collateral', 'credit', 'return'));
ALTER TABLE payouts DROP CONSTRAINT payouts_status_check;
ALTER TABLE payouts ADD CONSTRAINT payouts_status_check
  CHECK (status IN ('requested', 'completed', 'failed', 'unknown', 'cancelled'));
ALTER TABLE payouts ADD COLUMN source_cash text NOT NULL
  CHECK (source_cash IN ('cash_collateral', 'cash_operating'));
ALTER TABLE payouts ADD COLUMN destination_clabe text NOT NULL;
ALTER TABLE payouts ADD COLUMN return_of text UNIQUE REFERENCES bank_transactions (bank_txn_id);
ALTER TABLE payouts ADD COLUMN submitted_at timestamptz;
ALTER TABLE payouts ADD CONSTRAINT payouts_return_has_origin
  CHECK ((kind = 'return') = (return_of IS NOT NULL));
CREATE INDEX payouts_account_open_idx ON payouts (account_id)
  WHERE status IN ('requested', 'unknown', 'failed');
DROP INDEX payouts_attention_idx;
CREATE INDEX payouts_attention_idx ON payouts (status)
  WHERE status IN ('requested', 'unknown', 'failed') OR mismatch;

-- Bank events now include repayments and payout results.
ALTER TABLE bank_transactions DROP CONSTRAINT bank_transactions_outcome_check;
ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_outcome_check CHECK (outcome IN (
  'collateral_confirmed', 'credited_below_minimum', 'credited_for_payback', 'unapplied',
  'repayment_applied',          -- REPAY-02/03
  'payout_result_applied',      -- PAYOUT-08
  'payout_result_ignored',      -- PAYOUT-09: same result a person already recorded
  'payout_result_mismatch'      -- PAYOUT-09: differs from the recorded result, flagged
));
