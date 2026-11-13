ALTER TABLE trezu_treasury_allocation_events
  ADD COLUMN IF NOT EXISTS transfer_network text,
  ADD COLUMN IF NOT EXISTS transfer_tx_hashes jsonb;

-- The former background option created ledger classifications only; wallet movement
-- now requires an explicit user review and signature for each split.
UPDATE trezu_allocation_settings
  SET internal_income_automation_enabled = false
  WHERE internal_income_automation_enabled = true;
