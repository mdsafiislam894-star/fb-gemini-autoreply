-- ZEVIAN v4.9 encrypted singleton state store.
-- The application writes AES-256-GCM ciphertext only; no message or profile plaintext is stored here.
CREATE TABLE IF NOT EXISTS zevian_state (
  state_key TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
