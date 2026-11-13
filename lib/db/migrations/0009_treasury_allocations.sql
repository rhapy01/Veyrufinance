CREATE TABLE IF NOT EXISTS trezu_treasury_allocation_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL UNIQUE REFERENCES trezu_workspaces(id) ON DELETE CASCADE,
  rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trezu_treasury_income_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES trezu_workspaces(id) ON DELETE CASCADE,
  payment_id uuid NOT NULL REFERENCES trezu_near_intent_quotes(id) ON DELETE RESTRICT,
  created_by text NOT NULL,
  source_amount numeric(78, 36) NOT NULL,
  currency text NOT NULL,
  network text NOT NULL,
  rule_snapshot jsonb NOT NULL,
  outputs jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL CHECK (status IN ('in_progress', 'completed', 'partial', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, payment_id)
);

CREATE INDEX IF NOT EXISTS trezu_treasury_income_runs_workspace_created_idx
  ON trezu_treasury_income_runs(workspace_id, created_at DESC);
