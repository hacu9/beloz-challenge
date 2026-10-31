-- 010: who froze the account (OQ-14). A customer may lift only their own
-- freeze; ops may lift any. The CHECK ties the column to the frozen state,
-- so no path can leave `frozen` and forget to clear it.
ALTER TABLE accounts ADD COLUMN frozen_by text CHECK (frozen_by IN ('customer', 'ops'));
-- An account frozen before this column existed: treat it as an ops freeze,
-- the safe side (a customer cannot lift it).
UPDATE accounts SET frozen_by = 'ops' WHERE status = 'frozen';
ALTER TABLE accounts ADD CONSTRAINT accounts_frozen_by_matches_status
  CHECK ((status = 'frozen') = (frozen_by IS NOT NULL));
