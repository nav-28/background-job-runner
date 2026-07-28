-- migrate:up
CREATE TABLE api_keys (
  id           uuid PRIMARY KEY,
  "userId"     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  "keyHash"    text NOT NULL UNIQUE,
  prefix       text NOT NULL,
  "lastUsedAt" timestamptz,
  "revokedAt"  timestamptz,
  "createdAt"  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_user_idx ON api_keys ("userId");

-- migrate:down
DROP TABLE api_keys;
