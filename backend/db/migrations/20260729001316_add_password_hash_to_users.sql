-- migrate:up
-- Nullable on purpose. NULL means "this account has no password and cannot log in
-- interactively" — a real state for an API-key-only account, and it lets existing
-- rows keep working without a backfill. src/lib/password.ts owns the encoding.
ALTER TABLE users ADD COLUMN "passwordHash" text;

-- migrate:down
ALTER TABLE users DROP COLUMN "passwordHash";
