import { type AppOptions, buildApp } from '#src/app.ts';
import { getDb } from '#src/db.ts';

/**
 * A ready Fastify instance that never binds a port — drive it with app.inject().
 *
 * The engine is built but NOT started. A live claim loop would race `truncateAll()`: it claims
 * rows an unrelated suite has just truncated and writes events for tasks that no longer exist.
 * A test that needs work to actually execute says so out loud:
 *
 *     const app = await buildTestApp({ engine: { config: { concurrency: 2 } } });
 *     await app.engine.start();
 */
export async function buildTestApp(options: AppOptions = {}) {
  const app = await buildApp(
    {
      logger: { level: 'silent' },
      // A test app must never be able to hang on close. Fastify's default waits for non-idle
      // connections, and an open SSE stream is never idle — `tests/events.test.ts` binds a real
      // port and `app.close()` would block on it forever if a client failed to disconnect.
      forceCloseConnections: true,
    },
    { ...options, engine: { autostart: false, ...options.engine } },
  );
  await app.ready();
  return app;
}

export async function truncateAll() {
  await getDb()`TRUNCATE TABLE task_events, tasks, api_keys, users`;
}

export const validUser = {
  email: 'john.doe@gmail.com',
  name: 'John Doe',
  password: 'password123',
};

export const DEV_USER_ID = '00000000-0000-4000-8000-000000000001';

export async function ensureDevUser() {
  await getDb()`
    INSERT INTO users (id, email, name)
    VALUES (${DEV_USER_ID}, 'dev@example.com', 'Dev User')
    ON CONFLICT (id) DO NOTHING`;
}

export { closeDb } from '#src/db.ts';
