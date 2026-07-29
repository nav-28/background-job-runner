-- migrate:up
--
-- Demo fixtures for the operations dashboard: two users, two API keys, and a task history rich
-- enough that filtering, sorting and the detail view all show something.
--
-- Every task row here is `isSeed = true`, and every statement in the engine that could execute a
-- task carries `AND NOT "isSeed"` — the claim query, the boot sweep (`reclaimOrphans`) and the
-- lease reaper (`reclaimExpiredLeases`). So the seeded `running` and `queued` rows below look
-- exactly like live work on the dashboard and will never actually run, which is what makes them
-- safe to leave in place during a recorded demo.
--
-- ┌─ CREDENTIALS ─────────────────────────────────────────────────────────────────────────────┐
-- │ Only the SHA-256 of each key is stored, exactly as for a key minted through POST /keys.    │
-- │ The plaintext is written here because these are throwaway demo credentials for a local     │
-- │ database — NEVER seed a real key this way, and never run this against a reachable host.    │
-- │                                                                                           │
-- │   demo@example.com      password123   jrk_demo_key_do_not_use_in_production_0001          │
-- │   reviewer@example.com  password123   jrk_reviewer_key_do_not_use_in_prod_0001            │
-- └───────────────────────────────────────────────────────────────────────────────────────────┘
--
--   demo     — populated, so the dashboard has something to filter, sort and drill into.
--   reviewer — deliberately EMPTY, so a reviewer gets a clean slate to walk the success criteria
--              against without demo rows in the way.
--
-- The scrypt hash is the same one the dev user carries: a real hash of `password123` produced by
-- hashPassword() in src/lib/password.ts, so both accounts can actually log in.

INSERT INTO users (id, email, name, "passwordHash")
VALUES
  (
    '00000000-0000-4000-8000-0000000000d0',
    'demo@example.com',
    'Demo User',
    'scrypt$16384$8$1$im1x2UZITZmxFyqDOhgmUQ==$Rsq0nPxweWDyzy2cx7PaYf+XhSsx4xZvGU9Ld+mUM5PUuhrTMut1ZwGzHu1Aybh1ErbQes5bQ4b1ojalGcAFNg=='
  ),
  (
    '00000000-0000-4000-8000-0000000000e0',
    'reviewer@example.com',
    'Reviewer',
    'scrypt$16384$8$1$im1x2UZITZmxFyqDOhgmUQ==$Rsq0nPxweWDyzy2cx7PaYf+XhSsx4xZvGU9Ld+mUM5PUuhrTMut1ZwGzHu1Aybh1ErbQes5bQ4b1ojalGcAFNg=='
  )
ON CONFLICT (id) DO UPDATE
  SET email = EXCLUDED.email, name = EXCLUDED.name, "passwordHash" = EXCLUDED."passwordHash";

INSERT INTO api_keys (id, "userId", name, "keyHash", prefix, "createdAt")
VALUES
  (
    '00000000-0000-4000-8000-00000000ad00',
    '00000000-0000-4000-8000-0000000000d0',
    'demo-cli',
    '2b2a561a18dbc2f40f41b08a150c782c4a39fcb654727cbd9f07b2a239da8cea',
    'jrk_demo_key',
    now() - interval '7 days'
  ),
  (
    '00000000-0000-4000-8000-00000000ae00',
    '00000000-0000-4000-8000-0000000000e0',
    'reviewer-cli',
    '20e5cfd7ac0e915760dd720cc20b6cad33c8f94cbfac04f40fbe4140f493bdcb',
    'jrk_reviewer',
    now() - interval '7 days'
  )
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Demo tasks.
--
-- Handle numbers respect `tasks_active_handle_uniq`, the invariant the whole handle scheme rests
-- on: at most one ACTIVE task per (user, lane, handleNum), where active is
-- queued | running | failed | (ready AND NOT collected). The retired rows below deliberately
-- REUSE scrape-1, scrape-2 and report-1, because a collected or cancelled task releases its
-- number — which is exactly the behaviour the dashboard should be demonstrating.
--
--   active:  scrape-1 running · scrape-2 queued · scrape-3 failed · scrape-4 ready (uncollected)
--            report-1 ready (uncollected) · report-2 failed
--   retired: scrape-1 ready+collected · scrape-2 cancelled · report-1 ready+collected
--            report-3 cancelled
--
-- `createdAt` is spread over a week so the date-range filter has something to bite on.
-- ─────────────────────────────────────────────────────────────────────────────────────────────

INSERT INTO tasks (
  id, "userId", lane, "handleNum", params, status, result, error,
  attempts, "maxAttempts", collected, "collectedAt", "isSeed", "createdAt", "updatedAt"
) VALUES
  -- ── active ────────────────────────────────────────────────────────────────────────────────
  (
    '00000000-0000-4000-8000-000000005001', '00000000-0000-4000-8000-0000000000d0',
    'scrape', 1,
    '{"duration_ms": 240000, "url": "https://news.example.com/latest", "depth": 2}'::jsonb,
    'running', NULL, NULL,
    1, 3, false, NULL, true, now() - interval '35 minutes', now() - interval '34 minutes'
  ),
  (
    '00000000-0000-4000-8000-000000005002', '00000000-0000-4000-8000-0000000000d0',
    'scrape', 2,
    '{"duration_ms": 12000, "url": "https://shop.example.com/catalog?page=3"}'::jsonb,
    'queued', NULL, NULL,
    0, 3, false, NULL, true, now() - interval '20 minutes', now() - interval '20 minutes'
  ),
  (
    '00000000-0000-4000-8000-000000005003', '00000000-0000-4000-8000-0000000000d0',
    'scrape', 3,
    '{"duration_ms": 8000, "url": "https://intranet.example.com/private", "fail": true}'::jsonb,
    'failed', NULL,
    '{"reason": "worker failed after 3 attempts: 403 Forbidden from https://intranet.example.com/private", "retryable": true}'::jsonb,
    3, 3, false, NULL, true,
    now() - interval '2 days', now() - interval '2 days' + interval '27 seconds'
  ),
  (
    '00000000-0000-4000-8000-000000005004', '00000000-0000-4000-8000-0000000000d0',
    'scrape', 4,
    '{"duration_ms": 6000, "url": "https://blog.example.com/archive", "selectors": {"title": "h1", "body": ".post"}}'::jsonb,
    'ready',
    '{"lane": "scrape", "handle": "scrape-4", "pages": 18, "items": 431, "bytes": 2841920, "durationMs": 6014}'::jsonb,
    NULL,
    1, 3, false, NULL, true,
    now() - interval '3 hours', now() - interval '3 hours' + interval '6 seconds'
  ),
  (
    '00000000-0000-4000-8000-000000005005', '00000000-0000-4000-8000-0000000000d0',
    'report', 1,
    '{"duration_ms": 9000, "period": "2026-07", "format": "pdf", "recipients": ["ops@example.com"]}'::jsonb,
    'ready',
    '{"lane": "report", "handle": "report-1", "rows": 12480, "format": "pdf", "url": "s3://reports/2026-07.pdf", "durationMs": 9002}'::jsonb,
    NULL,
    1, 3, false, NULL, true,
    now() - interval '6 hours', now() - interval '6 hours' + interval '9 seconds'
  ),
  (
    '00000000-0000-4000-8000-000000005006', '00000000-0000-4000-8000-0000000000d0',
    'report', 2,
    '{"duration_ms": 3000, "period": "2026-13", "format": "csv"}'::jsonb,
    'failed', NULL,
    '{"reason": "period \"2026-13\" is not a valid month", "retryable": false}'::jsonb,
    1, 3, false, NULL, true,
    now() - interval '3 days', now() - interval '3 days' + interval '3 seconds'
  ),
  -- ── retired: these released their handle numbers, which is why the numbers repeat ─────────
  (
    '00000000-0000-4000-8000-000000005007', '00000000-0000-4000-8000-0000000000d0',
    'scrape', 1,
    '{"duration_ms": 4000, "url": "https://news.example.com/2026-07-24"}'::jsonb,
    'ready',
    '{"lane": "scrape", "handle": "scrape-1", "pages": 4, "items": 96, "durationMs": 4003}'::jsonb,
    NULL,
    1, 3, true, now() - interval '5 days' + interval '2 minutes', true,
    now() - interval '5 days', now() - interval '5 days' + interval '2 minutes'
  ),
  (
    '00000000-0000-4000-8000-000000005008', '00000000-0000-4000-8000-0000000000d0',
    'scrape', 2,
    '{"duration_ms": 300000, "url": "https://huge.example.com/everything"}'::jsonb,
    'cancelled', NULL, NULL,
    1, 3, false, NULL, true,
    now() - interval '4 days', now() - interval '4 days' + interval '40 seconds'
  ),
  (
    '00000000-0000-4000-8000-000000005009', '00000000-0000-4000-8000-0000000000d0',
    'report', 1,
    '{"duration_ms": 7000, "period": "2026-06", "format": "csv"}'::jsonb,
    'ready',
    '{"lane": "report", "handle": "report-1", "rows": 11902, "format": "csv", "url": "s3://reports/2026-06.csv", "durationMs": 7001}'::jsonb,
    NULL,
    1, 3, true, now() - interval '6 days' + interval '1 minute', true,
    now() - interval '6 days', now() - interval '6 days' + interval '1 minute'
  ),
  (
    '00000000-0000-4000-8000-00000000500a', '00000000-0000-4000-8000-0000000000d0',
    'report', 3,
    '{"duration_ms": 60000, "period": "2026-05", "format": "pdf"}'::jsonb,
    'cancelled', NULL, NULL,
    0, 3, false, NULL, true,
    now() - interval '1 day', now() - interval '1 day' + interval '15 seconds'
  )
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Matching transition logs, so the detail view's history is never empty. Each `at` is derived
-- from its own task's `createdAt` plus an offset, so every timeline reads honestly.
-- ─────────────────────────────────────────────────────────────────────────────────────────────

INSERT INTO task_events ("taskId", "userId", type, detail, at)
SELECT t.id, t."userId", e.type, e.detail::jsonb,
       t."createdAt" + e.offset_ms * interval '1 millisecond'
FROM tasks t
JOIN (VALUES
  -- scrape-1 (running)
  ('00000000-0000-4000-8000-000000005001', 'accepted', '{"summary": "scrape-1 accepted"}', 0),
  ('00000000-0000-4000-8000-000000005001', 'started', '{"attempt": 1}', 900),
  -- scrape-2 (queued behind the concurrency limit)
  ('00000000-0000-4000-8000-000000005002', 'accepted', '{"summary": "scrape-2 accepted"}', 0),
  -- scrape-3 (a transient failure that exhausted its budget: two backoffs, then failed)
  ('00000000-0000-4000-8000-000000005003', 'accepted', '{"summary": "scrape-3 accepted"}', 0),
  ('00000000-0000-4000-8000-000000005003', 'started', '{"attempt": 1}', 500),
  ('00000000-0000-4000-8000-000000005003', 'retry_scheduled', '{"attempt": 1, "maxAttempts": 3, "reason": "403 Forbidden from https://intranet.example.com/private", "retryable": true, "backoffMs": 550}', 8500),
  ('00000000-0000-4000-8000-000000005003', 'started', '{"attempt": 2}', 9100),
  ('00000000-0000-4000-8000-000000005003', 'retry_scheduled', '{"attempt": 2, "maxAttempts": 3, "reason": "403 Forbidden from https://intranet.example.com/private", "retryable": true, "backoffMs": 1100}', 17500),
  ('00000000-0000-4000-8000-000000005003', 'started', '{"attempt": 3}', 18700),
  ('00000000-0000-4000-8000-000000005003', 'failed', '{"reason": "worker failed after 3 attempts: 403 Forbidden from https://intranet.example.com/private", "retryable": true, "attempts": 3}', 27000),
  -- scrape-4 (ready, waiting to be collected)
  ('00000000-0000-4000-8000-000000005004', 'accepted', '{"summary": "scrape-4 accepted"}', 0),
  ('00000000-0000-4000-8000-000000005004', 'started', '{"attempt": 1}', 300),
  ('00000000-0000-4000-8000-000000005004', 'ready', '{"summary": "scrape-4 ready"}', 6314),
  -- report-1 (ready, waiting to be collected)
  ('00000000-0000-4000-8000-000000005005', 'accepted', '{"summary": "report-1 accepted"}', 0),
  ('00000000-0000-4000-8000-000000005005', 'started', '{"attempt": 1}', 200),
  ('00000000-0000-4000-8000-000000005005', 'ready', '{"summary": "report-1 ready"}', 9202),
  -- report-2 (a permanent failure — never auto-retried)
  ('00000000-0000-4000-8000-000000005006', 'accepted', '{"summary": "report-2 accepted"}', 0),
  ('00000000-0000-4000-8000-000000005006', 'started', '{"attempt": 1}', 250),
  ('00000000-0000-4000-8000-000000005006', 'failed', '{"reason": "period \"2026-13\" is not a valid month", "retryable": false, "attempts": 1}', 3250),
  -- retired scrape-1 (collected, which released the number)
  ('00000000-0000-4000-8000-000000005007', 'accepted', '{"summary": "scrape-1 accepted"}', 0),
  ('00000000-0000-4000-8000-000000005007', 'started', '{"attempt": 1}', 400),
  ('00000000-0000-4000-8000-000000005007', 'ready', '{"summary": "scrape-1 ready"}', 4403),
  ('00000000-0000-4000-8000-000000005007', 'collected', '{}', 120000),
  -- retired scrape-2 (cancelled mid-run — the worker was actually stopped)
  ('00000000-0000-4000-8000-000000005008', 'accepted', '{"summary": "scrape-2 accepted"}', 0),
  ('00000000-0000-4000-8000-000000005008', 'started', '{"attempt": 1}', 350),
  ('00000000-0000-4000-8000-000000005008', 'cancelled', '{"from": "running"}', 40000),
  -- retired report-1 (collected)
  ('00000000-0000-4000-8000-000000005009', 'accepted', '{"summary": "report-1 accepted"}', 0),
  ('00000000-0000-4000-8000-000000005009', 'started', '{"attempt": 1}', 300),
  ('00000000-0000-4000-8000-000000005009', 'ready', '{"summary": "report-1 ready"}', 7301),
  ('00000000-0000-4000-8000-000000005009', 'collected', '{}', 60000),
  -- retired report-3 (cancelled while still queued — no worker ever started)
  ('00000000-0000-4000-8000-00000000500a', 'accepted', '{"summary": "report-3 accepted"}', 0),
  ('00000000-0000-4000-8000-00000000500a', 'cancelled', '{"from": "queued"}', 15000)
) AS e(task_id, type, detail, offset_ms) ON e.task_id::uuid = t.id
WHERE NOT EXISTS (SELECT 1 FROM task_events x WHERE x."taskId" = t.id);

-- migrate:down
-- ON DELETE CASCADE on tasks."userId" and task_events."taskId" takes the rest with it.
DELETE FROM users WHERE id IN (
  '00000000-0000-4000-8000-0000000000d0',
  '00000000-0000-4000-8000-0000000000e0'
);
