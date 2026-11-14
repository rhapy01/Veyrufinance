CREATE TABLE IF NOT EXISTS trezu_user_preferences (
  user_id uuid PRIMARY KEY REFERENCES trezu_users(id) ON DELETE CASCADE,
  default_receive_addresses jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
