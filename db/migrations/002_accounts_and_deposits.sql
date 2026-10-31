-- 002: one open account per customer, and the closed list of deposit outcomes.

-- Q20: one account, one card. A customer can open a new account only after
-- the previous one is closed. The index also wins the race between two
-- parallel "open account" calls.
CREATE UNIQUE INDEX accounts_one_open_per_customer
  ON accounts (customer_id) WHERE status <> 'closed';

-- COL-03 / COL-06..09: what the service did with each incoming bank transfer.
ALTER TABLE bank_transactions
  ADD CONSTRAINT bank_transactions_outcome_check CHECK (outcome IN (
    'collateral_confirmed',     -- COL-04: activated the account
    'credited_below_minimum',   -- COL-09: under MIN_DEPOSIT_CENTAVOS, paid back
    'credited_for_payback',     -- COL-07: account not pending_collateral, paid back
    'unapplied'                 -- COL-08: unknown reference, flagged for ops
  ));
