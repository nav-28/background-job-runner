-- migrate:up
CREATE TABLE tasks (
  id            uuid PRIMARY KEY,
  "userId"      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lane          text NOT NULL,
  "handleNum"   integer NOT NULL CHECK ("handleNum" >= 1),
  params        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL CHECK (status IN ('queued','running','ready','failed','cancelled')),
  result        jsonb,
  error         jsonb,
  attempts      integer NOT NULL DEFAULT 0,
  "maxAttempts" integer NOT NULL DEFAULT 3,
  "runAfter"    timestamptz NOT NULL DEFAULT now(),
  "leaseUntil"  timestamptz,
  "runnerId"    uuid,
  collected     boolean NOT NULL DEFAULT false,
  "collectedAt" timestamptz,
  "isSeed"      boolean NOT NULL DEFAULT false,
  "createdAt"   timestamptz NOT NULL DEFAULT now(),
  "updatedAt"   timestamptz NOT NULL DEFAULT now()
);

-- The core invariant: a handle number is unique per (user, lane) among ACTIVE tasks only.
-- Active = queued | running | failed | (ready AND NOT collected).
-- Retired tasks (collected, or cancelled) release their number for reuse.
CREATE UNIQUE INDEX tasks_active_handle_uniq
  ON tasks ("userId", lane, "handleNum")
  WHERE status IN ('queued','running','failed')
     OR (status = 'ready' AND NOT collected);

CREATE INDEX tasks_claim_idx  ON tasks ("runAfter", "createdAt")
  WHERE status = 'queued' AND NOT "isSeed";
CREATE INDEX tasks_lease_idx  ON tasks ("leaseUntil") WHERE status = 'running';
CREATE INDEX tasks_list_idx   ON tasks ("userId", "createdAt" DESC);
CREATE INDEX tasks_handle_idx ON tasks ("userId", lane, "handleNum", "createdAt" DESC);

-- migrate:down
DROP TABLE tasks;
