CREATE TABLE IF NOT EXISTS trezu_treasury_strategy_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL UNIQUE REFERENCES trezu_workspaces(id) ON DELETE CASCADE,
  aave_base_sepolia_usdc_percent integer NOT NULL DEFAULT 0 CHECK (aave_base_sepolia_usdc_percent BETWEEN 0 AND 100),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trezu_treasury_strategy_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES trezu_workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  strategy_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('supply', 'withdraw')),
  asset_symbol text NOT NULL,
  amount numeric(78, 36) NOT NULL CHECK (amount > 0),
  wallet_address text NOT NULL,
  transaction_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('confirmed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trezu_treasury_strategy_activity_workspace_created_idx
  ON trezu_treasury_strategy_activity(workspace_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS trezu_treasury_strategy_activity_workspace_tx_unique
  ON trezu_treasury_strategy_activity(workspace_id, transaction_hash);
