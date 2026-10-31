-- 003: every authorization decision, approved or declined (SPEND-11).
-- A decline creates no hold, but a retry of the same network_auth_id must
-- still get the same answer, so the decision itself is stored.

CREATE TABLE authorizations (
  network_auth_id text PRIMARY KEY,
  card_token      text NOT NULL,
  account_id      uuid REFERENCES accounts (id),      -- NULL when the card is unknown
  amount          bigint NOT NULL CHECK (amount > 0),
  approved        boolean NOT NULL,
  decline_reason  text CHECK (decline_reason IN (
                    'card_not_found', 'card_not_active', 'account_not_active',
                    'insufficient_credit', 'amount_over_maximum')),
  hold_id         uuid UNIQUE REFERENCES holds (id),
  merchant        jsonb,
  decided_at      timestamptz NOT NULL,
  CHECK (approved = (hold_id IS NOT NULL)),
  CHECK (approved = (decline_reason IS NULL))
);
CREATE INDEX authorizations_account_idx ON authorizations (account_id);

GRANT SELECT, INSERT ON authorizations TO acme_app;
