import { buildApp } from '#src/app.ts';
import { getDb } from '#src/db.ts';

/** A ready Fastify instance that never binds a port — drive it with app.inject(). */
export async function buildTestApp() {
  const app = await buildApp({ logger: { level: 'silent' } });
  await app.ready();
  return app;
}

export async function truncateUsers() {
  await getDb()`TRUNCATE TABLE users`;
}

export const validUser = {
  email: 'john.doe@gmail.com',
  country: 'England',
  street: 'Road Avenue',
  postalCode: '29145',
};

export { closeDb } from '#src/db.ts';
