ALTER TABLE trezu_users
  ADD COLUMN IF NOT EXISTS privy_user_id text;

CREATE UNIQUE INDEX IF NOT EXISTS trezu_users_privy_user_id_unique
  ON trezu_users (privy_user_id);
