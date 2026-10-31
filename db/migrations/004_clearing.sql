-- 004: captures and refunds carry what the network sent, so a retried
-- delivery can be compared with the first one (SPEND-11).

ALTER TABLE captures ADD COLUMN card_token text NOT NULL;
ALTER TABLE refunds ADD COLUMN card_token text NOT NULL;
ALTER TABLE refunds ADD COLUMN network_capture_id text;
-- A refund splits into the part that reduced debt and the part credited (SPEND-10).
ALTER TABLE refunds ADD COLUMN debt_reduced bigint NOT NULL CHECK (debt_reduced >= 0);
ALTER TABLE refunds ADD COLUMN credited bigint NOT NULL CHECK (credited >= 0);
ALTER TABLE refunds ADD CONSTRAINT refunds_split_check CHECK (debt_reduced + credited = amount);
