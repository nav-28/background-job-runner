import { buildApp } from '#src/app.ts';
import { getDb } from '#src/db.ts';

/** A ready Fastify instance that never binds a port — drive it with app.inject(). */
export async function buildTestApp() {
  const app = await buildApp({ logger: { level: 'silent' } });
  await app.ready();
  return app;
}

/**
 * Tables are listed together rather than with CASCADE: users is referenced by
 * api_keys and tasks, so Postgres refuses to truncate it alone.
 */
export async function truncateAll() {
  await getDb()`TRUNCATE TABLE task_events, tasks, api_keys, users`;
}

/** A signup body that passes validation. */
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
