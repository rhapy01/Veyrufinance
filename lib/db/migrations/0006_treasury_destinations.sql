ALTER TABLE trezu_allocation_settings
  ADD COLUMN IF NOT EXISTS treasury_destinations jsonb NOT NULL
  DEFAULT '{"tax":"","savings":"","spending":""}'::jsonb;
