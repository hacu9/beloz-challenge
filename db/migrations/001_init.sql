-- 001_init: first schema (architecture §3).
-- Timestamps have no DEFAULT now(): the app writes them from the injectable clock (OPS-01).

-- ---------------------------------------------------------------- accounts and cards

CREATE TABLE accounts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id          uuid NOT NULL,
  status               text NOT NULL CHECK (status IN
                         ('pending_collateral', 'active', 'frozen', 'closing', 'settling', 'closed')),
  -- Cached ledger balances (architecture §5). The reconciliation command recomputes them.
  credit_limit         bigint NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  posted_debt          bigint NOT NULL DEFAULT 0 CHECK (posted_debt >= 0),
  held_total           bigint NOT NULL DEFAULT 0 CHECK (held_total >= 0),
  credit_balance       bigint NOT NULL DEFAULT 0 CHECK (credit_balance >= 0),
  -- OQ-07: one SPEI-style reference for collateral, one for repayments.
  collateral_reference text NOT NULL UNIQUE,
  repayment_reference  text NOT NULL UNIQUE CHECK (repayment_reference <> collateral_reference),
  version              bigint NOT NULL DEFAULT 0,
  closing_started_at   timestamptz,
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL
);
CREATE INDEX accounts_customer_idx ON accounts (customer_id);

CREATE TABLE cards (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL UNIQUE REFERENCES accounts (id),
  token      text NOT NULL UNIQUE,                       -- SEC-05: never a PAN
  last4      char(4) NOT NULL CHECK (last4 ~ '^[0-9]{4}$'),
  status     text NOT NULL CHECK (status IN ('inactive', 'active', 'blocked')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

-- ---------------------------------------------------------------- ledger

CREATE TABLE ledger_accounts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL CHECK (code IN (
               'cash_collateral', 'cash_operating', 'network_payable', 'chargeoff_loss',
               'unapplied_funds', 'customer_collateral', 'customer_receivable', 'customer_credit')),
  account_id uuid REFERENCES accounts (id),               -- NULL for system accounts
  type       text NOT NULL CHECK (type IN ('asset', 'liability', 'expense')),
  CONSTRAINT ledger_accounts_owner_matches_code CHECK (
    (code LIKE 'customer\_%') = (account_id IS NOT NULL)),
  CONSTRAINT ledger_accounts_unique UNIQUE NULLS NOT DISTINCT (code, account_id)
);

CREATE TABLE journal_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind ~ '^[a-z_]{1,64}$'),
  account_id   uuid REFERENCES accounts (id),
  reverses_id  uuid REFERENCES journal_entries (id),     -- LEDGER-03: a fix references the original
  request_id   text,
  created_at   timestamptz NOT NULL,
  -- Lines may only be added in the transaction that created the entry.
  created_txid xid8 NOT NULL DEFAULT pg_current_xact_id()
);
CREATE INDEX journal_entries_account_idx ON journal_entries (account_id);

CREATE TABLE journal_lines (
  id                bigserial PRIMARY KEY,
  journal_id        uuid NOT NULL REFERENCES journal_entries (id),
  ledger_account_id uuid NOT NULL REFERENCES ledger_accounts (id),
  amount            bigint NOT NULL CHECK (amount <> 0)  -- debit > 0, credit < 0
);
CREATE INDEX journal_lines_journal_idx ON journal_lines (journal_id);
CREATE INDEX journal_lines_ledger_account_idx ON journal_lines (ledger_account_id);

INSERT INTO ledger_accounts (code, account_id, type) VALUES
  ('cash_collateral', NULL, 'asset'),
  ('cash_operating',  NULL, 'asset'),
  ('network_payable', NULL, 'liability'),
  ('chargeoff_loss',  NULL, 'expense'),
  ('unapplied_funds', NULL, 'liability');

-- ---------------------------------------------------------------- spending

CREATE TABLE holds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts (id),
  network_auth_id text NOT NULL UNIQUE,                  -- SPEND-11
  amount          bigint NOT NULL CHECK (amount > 0),
  status          text NOT NULL CHECK (status IN ('open', 'captured', 'reversed', 'expired')),
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL,
  closed_at       timestamptz,
  CHECK ((status = 'open') = (closed_at IS NULL))
);
CREATE INDEX holds_open_idx ON holds (account_id, expires_at) WHERE status = 'open';

CREATE TABLE captures (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network_capture_id text NOT NULL UNIQUE,               -- SPEND-11
  account_id         uuid NOT NULL REFERENCES accounts (id),
  hold_id            uuid UNIQUE REFERENCES holds (id),  -- NULL for a force post (OQ-08); one capture per hold (OQ-09)
  network_auth_id    text,
  amount             bigint NOT NULL CHECK (amount > 0),
  journal_id         uuid NOT NULL REFERENCES journal_entries (id),
  created_at         timestamptz NOT NULL
);

CREATE TABLE refunds (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network_refund_id text NOT NULL UNIQUE,                -- SPEND-11
  account_id        uuid NOT NULL REFERENCES accounts (id),
  amount            bigint NOT NULL CHECK (amount > 0),
  journal_id        uuid NOT NULL REFERENCES journal_entries (id),
  created_at        timestamptz NOT NULL
);

-- ---------------------------------------------------------------- bank

CREATE TABLE bank_transactions (
  bank_txn_id text PRIMARY KEY,                          -- COL-03: dedupe key
  kind        text NOT NULL CHECK (kind IN ('deposit', 'payout_result')),
  reference   text,
  account_id  uuid REFERENCES accounts (id),
  amount      bigint CHECK (amount > 0),
  outcome     text NOT NULL,
  journal_id  uuid REFERENCES journal_entries (id),
  received_at timestamptz NOT NULL
);

CREATE TABLE payouts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts (id),
  kind            text NOT NULL CHECK (kind IN ('collateral', 'credit')),
  amount          bigint NOT NULL CHECK (amount > 0),
  status          text NOT NULL CHECK (status IN ('requested', 'completed', 'failed', 'unknown')),
  bank_txn_id     text UNIQUE,
  journal_id      uuid REFERENCES journal_entries (id),
  resolved_by     text,
  resolution_note text,
  mismatch        boolean NOT NULL DEFAULT false,        -- PAYOUT-09
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  CHECK ((status = 'completed') = (journal_id IS NOT NULL))   -- PAYOUT-05
);
CREATE INDEX payouts_attention_idx ON payouts (status) WHERE status IN ('unknown', 'failed');

-- ---------------------------------------------------------------- idempotency and audit

CREATE TABLE idempotency_keys (
  caller          text NOT NULL,
  key             text NOT NULL CHECK (length(key) BETWEEN 1 AND 255),
  request_hash    text NOT NULL,
  response_status int,
  response_body   jsonb,
  created_at      timestamptz NOT NULL,
  completed_at    timestamptz,
  PRIMARY KEY (caller, key)
);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  actor_type  text NOT NULL CHECK (actor_type IN ('customer', 'ops', 'network', 'bank', 'system')),
  actor_id    text,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text NOT NULL,
  before      jsonb,
  after       jsonb,
  request_id  text,
  at          timestamptz NOT NULL
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);

-- ---------------------------------------------------------------- append-only guards

-- LEDGER-04, AUDIT-03: no UPDATE, DELETE or TRUNCATE, for any role, including the owner.
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % is forbidden', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_entries_no_truncate BEFORE TRUNCATE ON journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_lines_append_only BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journal_lines_no_truncate BEFORE TRUNCATE ON journal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- A line can join only an entry created in the same transaction, so a committed entry never changes.
CREATE FUNCTION journal_line_same_tx() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM journal_entries
                 WHERE id = NEW.journal_id AND created_txid = pg_current_xact_id()) THEN
    RAISE EXCEPTION 'journal %: lines can only be added in the transaction that created it', NEW.journal_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_lines_same_tx BEFORE INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION journal_line_same_tx();

-- LEDGER-02: at commit, every entry has at least two lines and its lines sum to zero.
CREATE FUNCTION assert_journal_balanced(p_journal_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  line_count int;
  line_sum   numeric;
BEGIN
  SELECT count(*), coalesce(sum(amount), 0) INTO line_count, line_sum
    FROM journal_lines WHERE journal_id = p_journal_id;
  IF line_count < 2 OR line_sum <> 0 THEN
    RAISE EXCEPTION 'journal % is not balanced (lines=%, sum=%)', p_journal_id, line_count, line_sum
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

CREATE FUNCTION journal_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM assert_journal_balanced(NEW.id); RETURN NULL; END $$;
CREATE FUNCTION journal_line_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM assert_journal_balanced(NEW.journal_id); RETURN NULL; END $$;

CREATE CONSTRAINT TRIGGER journal_entries_balanced AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_entry_balanced();
CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_line_balanced();

-- ---------------------------------------------------------------- least privilege

-- The app role (created by the bootstrap step) cannot UPDATE, DELETE or TRUNCATE
-- the ledger and audit tables. This is a second barrier next to the triggers.
GRANT USAGE ON SCHEMA public TO acme_app;
GRANT SELECT, INSERT, UPDATE ON accounts, cards, holds, payouts, idempotency_keys TO acme_app;
GRANT SELECT, INSERT ON captures, refunds, bank_transactions, ledger_accounts,
  journal_entries, journal_lines, audit_log TO acme_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO acme_app;
