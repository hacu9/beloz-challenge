-- 006: closure, charge-offs and recoveries (M7).

-- CLOSE-03: an account that never activated has no late captures to wait for.
ALTER TABLE accounts ADD COLUMN activated_at timestamptz;
UPDATE accounts SET activated_at = created_at WHERE status <> 'pending_collateral';

-- CLOSE-07, CLOSE-09: debt the collateral did not cover, still owed by the
-- customer (collections). A later repayment recovers it before anything else.
ALTER TABLE accounts ADD COLUMN charged_off_outstanding bigint NOT NULL DEFAULT 0
  CHECK (charged_off_outstanding >= 0);

-- Append-only record of each charge-off and recovery, for collections.
CREATE TABLE charge_offs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id),
  kind       text NOT NULL CHECK (kind IN ('charge_off', 'recovery')),
  amount     bigint NOT NULL CHECK (amount > 0),
  journal_id uuid NOT NULL REFERENCES journal_entries (id),
  created_at timestamptz NOT NULL
);
CREATE INDEX charge_offs_account_idx ON charge_offs (account_id);
GRANT SELECT, INSERT ON charge_offs TO acme_app;
