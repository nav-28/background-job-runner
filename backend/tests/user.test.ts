import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { buildTestApp, closeDb, truncateUsers, validUser } from '#tests/helpers.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Requires Postgres: `docker compose up -d postgres && pnpm db:migrate`. */
describe('users API', async () => {
  const app = await buildTestApp();

  const createUser = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/users', body });

  const findUsers = (query = '') => app.inject({ method: 'GET', url: `/api/v1/users${query}` });

  before(truncateUsers);
  beforeEach(truncateUsers);
  after(async () => {
    await app.close();
    await closeDb();
  });

  describe('POST /api/v1/users', () => {
    it('creates a user and returns its id', async () => {
      const res = await createUser(validUser);

      assert.equal(res.statusCode, 201);
      assert.match(res.json().id, UUID_RE);
    });

    it('rejects a duplicate email with 409', async () => {
      await createUser(validUser);
      const res = await createUser(validUser);

      assert.equal(res.statusCode, 409);
      assert.equal(res.json().error, 'Conflict');
      assert.ok(res.json().correlationId);
    });
  });

  describe('POST /api/v1/users validation', () => {
    const invalid = [
      ['malformed email', { ...validUser, email: 'not-an-email' }],
      ['missing email', { country: 'England', street: 'Road Avenue', postalCode: '29145' }],
      ['country too short', { ...validUser, country: 'a' }],
      ['postal code too long', { ...validUser, postalCode: '1'.repeat(11) }],
    ] as const;

    for (const [name, body] of invalid) {
      it(`rejects ${name} with 400`, async () => {
        const res = await createUser(body as Record<string, unknown>);

        assert.equal(res.statusCode, 400);
        assert.equal(res.json().error, 'Bad Request');
        assert.ok(res.json().correlationId, 'error body carries a correlation id');
      });
    }
  });

  describe('GET /api/v1/users', () => {
    it('returns an empty page when there are no users', async () => {
      const res = await findUsers();

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { count: 0, limit: 20, page: 0, data: [] });
    });

    it('returns the created user with ISO date strings', async () => {
      await createUser(validUser);
      const res = await findUsers();
      const body = res.json();

      assert.equal(res.statusCode, 200);
      assert.equal(body.count, 1);
      assert.equal(body.data.length, 1);
      assert.equal(body.data[0].email, validUser.email);
      assert.equal(body.data[0].role, 'guest');
      // Dates must cross the wire as ISO strings, not Date objects.
      assert.equal(typeof body.data[0].createdAt, 'string');
      assert.equal(new Date(body.data[0].createdAt).toISOString(), body.data[0].createdAt);
    });

    it('filters by country', async () => {
      await createUser(validUser);
      await createUser({ ...validUser, email: 'jane@gmail.com', country: 'France' });

      const res = await findUsers('?country=France');
      const body = res.json();

      assert.equal(body.count, 1);
      assert.equal(body.data[0].country, 'France');
    });

    it('paginates, reporting the unfiltered total', async () => {
      for (let i = 0; i < 3; i++) {
        await createUser({ ...validUser, email: `user${i}@gmail.com` });
      }

      const page0 = (await findUsers('?limit=2&page=0')).json();
      const page1 = (await findUsers('?limit=2&page=1')).json();

      assert.equal(page0.count, 3);
      assert.equal(page0.data.length, 2);
      assert.equal(page1.data.length, 1);

      // Pages must not overlap — this is what the ORDER BY in the repository guarantees.
      const ids = [...page0.data, ...page1.data].map((u: { id: string }) => u.id);
      assert.equal(new Set(ids).size, 3);
    });

    it('rejects an out-of-range limit with 400', async () => {
      const res = await findUsers('?limit=0');

      assert.equal(res.statusCode, 400);
    });
  });

  describe('DELETE /api/v1/users/:id', () => {
    it('deletes a user', async () => {
      const { id } = (await createUser(validUser)).json();

      const res = await app.inject({ method: 'DELETE', url: `/api/v1/users/${id}` });
      assert.equal(res.statusCode, 204);

      assert.equal((await findUsers()).json().count, 0);
    });

    it('returns 404 for a user that does not exist', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/users/2cdc8ab1-6d50-49cc-ba14-54e4ac7ec231',
      });

      assert.equal(res.statusCode, 404);
    });
  });

  describe('health', () => {
    it('reports ok', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { status: 'ok' });
    });
  });
});
