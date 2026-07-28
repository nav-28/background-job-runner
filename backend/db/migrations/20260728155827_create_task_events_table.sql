-- migrate:up
CREATE TABLE task_events (
  id       bigserial PRIMARY KEY,
  "taskId" uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  "userId" uuid NOT NULL,
  type     text NOT NULL,
  detail   jsonb NOT NULL DEFAULT '{}'::jsonb,
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_events_task_idx ON task_events ("taskId", id);
CREATE INDEX task_events_user_idx ON task_events ("userId", id);

-- migrate:down
DROP TABLE task_events;
