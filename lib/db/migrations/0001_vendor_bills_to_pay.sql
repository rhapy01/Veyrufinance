DO $$ BEGIN
  CREATE TYPE trezu_payable_bill_status AS ENUM ('draft', 'submitted', 'ready', 'processing', 'pending_settlement', 'paid', 'failed', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS trezu_payable_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES trezu_workspaces(id) ON DELETE CASCADE,
  bill_number text NOT NULL,
  vendor_name text NOT NULL,
  vendor_email text,
  description text NOT NULL,
  amount numeric(24, 6) NOT NULL,
  currency text NOT NULL,
  due_date date,
  payout_asset_id text NOT NULL,
  payout_asset_symbol text NOT NULL,
  payout_network text NOT NULL,
  recipient_address text NOT NULL,
  status trezu_payable_bill_status NOT NULL DEFAULT 'draft',
  payout_amount numeric(36, 18),
  payment_quote_id uuid,
  deposit_tx_hash text,
  provider_reference text,
  failure_reason text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trezu_payable_bill_workspace_number_unique UNIQUE (workspace_id, bill_number)
);
CREATE INDEX IF NOT EXISTS trezu_payable_bill_workspace_status_idx ON trezu_payable_bills (workspace_id, status);
ALTER TABLE trezu_near_intent_quotes ADD COLUMN IF NOT EXISTS payable_bill_id uuid REFERENCES trezu_payable_bills(id) ON DELETE RESTRICT;
ALTER TABLE trezu_payable_bills ADD COLUMN IF NOT EXISTS deposit_tx_hash text;
ALTER TABLE trezu_payable_bills ADD COLUMN IF NOT EXISTS public_status_token text;
ALTER TABLE trezu_payable_bills ADD COLUMN IF NOT EXISTS submitted_at timestamptz;
ALTER TABLE trezu_payable_bills ALTER COLUMN payout_asset_id DROP NOT NULL;
ALTER TABLE trezu_payable_bills ALTER COLUMN payout_asset_symbol DROP NOT NULL;
ALTER TABLE trezu_payable_bills ALTER COLUMN payout_network DROP NOT NULL;
ALTER TABLE trezu_payable_bills ALTER COLUMN recipient_address DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS trezu_payable_bill_public_status_token_unique ON trezu_payable_bills (public_status_token) WHERE public_status_token IS NOT NULL;
ALTER TYPE trezu_payable_bill_status ADD VALUE IF NOT EXISTS 'submitted';
ALTER TYPE trezu_payable_bill_status ADD VALUE IF NOT EXISTS 'rejected';

CREATE TABLE IF NOT EXISTS trezu_payable_intake_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL UNIQUE REFERENCES trezu_workspaces(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trezu_payable_intake_link_active_idx ON trezu_payable_intake_links (workspace_id, active);
