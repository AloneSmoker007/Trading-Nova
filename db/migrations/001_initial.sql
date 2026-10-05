CREATE TABLE IF NOT EXISTS trading_state (
  namespace text NOT NULL,
  state_id text NOT NULL,
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(namespace,state_id)
);
CREATE TABLE IF NOT EXISTS trading_idempotency (
  idempotency_key text PRIMARY KEY,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS trading_audit (
  sequence bigserial PRIMARY KEY,
  entry jsonb NOT NULL,
  previous_hash text,
  hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS trading_risk_configs (
  config_hash text PRIMARY KEY,
  version text NOT NULL,
  config jsonb NOT NULL,
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL,
  previous_hash text
);
CREATE TABLE IF NOT EXISTS trading_checkpoints (
  checkpoint_id text PRIMARY KEY,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trading_audit_created_idx ON trading_audit(created_at);
