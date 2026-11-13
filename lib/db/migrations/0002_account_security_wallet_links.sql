ALTER TABLE trezu_users
  ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

-- Existing local accounts predate verification, so preserve their ability to sign in.
UPDATE trezu_users
SET email_verified_at = COALESCE(email_verified_at, created_at, now())
WHERE email_verified_at IS NULL;

CREATE TABLE IF NOT EXISTS trezu_auth_action_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES trezu_users(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trezu_auth_action_tokens_user_purpose_idx
  ON trezu_auth_action_tokens(user_id, purpose);

CREATE TABLE IF NOT EXISTS trezu_linked_wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES trezu_users(id) ON DELETE CASCADE,
  network text NOT NULL,
  address text NOT NULL,
  public_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS trezu_linked_wallets_network_address_unique
  ON trezu_linked_wallets(network, address);

CREATE UNIQUE INDEX IF NOT EXISTS trezu_linked_wallets_user_network_address_unique
  ON trezu_linked_wallets(user_id, network, address);
