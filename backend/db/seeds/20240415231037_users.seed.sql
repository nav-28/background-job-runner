-- migrate:up
-- Fixed uuid: engine tests reference this dev user directly.
--
-- The hash below was produced by hashPassword() in src/lib/password.ts — it is a real
-- scrypt hash, not a placeholder, so `dev@example.com` can actually log in locally.
-- Plaintext (development only, never use this anywhere reachable): password123
INSERT INTO users (id, email, name, "passwordHash")
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'dev@example.com',
  'Dev User',
  'scrypt$16384$8$1$im1x2UZITZmxFyqDOhgmUQ==$Rsq0nPxweWDyzy2cx7PaYf+XhSsx4xZvGU9Ld+mUM5PUuhrTMut1ZwGzHu1Aybh1ErbQes5bQ4b1ojalGcAFNg=='
)
ON CONFLICT (id) DO UPDATE SET "passwordHash" = EXCLUDED."passwordHash";

-- migrate:down
DELETE FROM users WHERE id = '00000000-0000-4000-8000-000000000001';
