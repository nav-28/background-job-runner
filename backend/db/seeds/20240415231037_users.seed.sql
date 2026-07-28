-- migrate:up
-- Fixed uuid: engine tests reference this dev user directly.
INSERT INTO users (id, email, name)
VALUES ('00000000-0000-4000-8000-000000000001', 'dev@example.com', 'Dev User')
ON CONFLICT (id) DO NOTHING;

-- migrate:down
DELETE FROM users WHERE id = '00000000-0000-4000-8000-000000000001';
