-- 007: fixes from the blind review of 2026-10-31 (A1, A2, B1, B2, B3, OQ-13).

-- OQ-13: a cancelled payout parks its money until ops releases it. Only a
-- cancelled payout can be released.
ALTER TABLE payouts ADD COLUMN released_at timestamptz;
ALTER TABLE payouts ADD CONSTRAINT payouts_release_only_cancelled
  CHECK (released_at IS NULL OR status = 'cancelled');

-- One live return per deposit. A released (cancelled) return no longer
-- counts, so ops can have the deposit returned again.
ALTER TABLE payouts DROP CONSTRAINT payouts_return_of_key;
CREATE UNIQUE INDEX payouts_one_live_return ON payouts (return_of)
  WHERE return_of IS NOT NULL AND released_at IS NULL;

-- B2: a refund splits three ways: open debt, charged-off debt, credit.
ALTER TABLE refunds ADD COLUMN recovered bigint NOT NULL DEFAULT 0 CHECK (recovered >= 0);
ALTER TABLE refunds DROP CONSTRAINT refunds_split_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_split_check
  CHECK (debt_reduced + recovered + credited = amount);
