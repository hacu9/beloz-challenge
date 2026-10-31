-- 009: freeze (FREEZE-01/02). A purchase on a frozen account is declined
-- with its own reason, so the customer can tell "frozen" from "closed".
ALTER TABLE authorizations DROP CONSTRAINT authorizations_decline_reason_check;
ALTER TABLE authorizations ADD CONSTRAINT authorizations_decline_reason_check CHECK (decline_reason IN (
  'card_not_found', 'card_not_active', 'account_not_active', 'account_frozen',
  'insufficient_credit', 'amount_over_maximum'));
