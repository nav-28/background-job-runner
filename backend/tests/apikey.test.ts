import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { getDb } from '#src/db.ts';
import { buildTestApp, closeDb, truncateAll, validUser } from '#tests/helpers.ts';
import { UUID_RE } from './utils.ts';

/** Requires Postgres: `docker compose up -d postgres && pnpm db:migrate`. */
describe('api keys API', async () => {
  const app = await buildTestApp();

  /** Signs up a user and returns the session token that identifies them. */
  const newSession = async (email = validUser.email) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      body: { ...validUser, email },
    });
    assert.equal(res.statusCode, 201, 'signup fixture must succeed');
    const { token, user } = res.json();
    return { token, userId: user.id as string };
  };

  const createKey = (token: string, name = 'ci-pipeline') =>
    app.inject({
      method: 'POST',
      url: '/api/v1/keys',
      headers: { authorization: `Bearer ${token}` },
      body: { name },
    });

  const listKeys = (token: string) =>
    app.inject({
      method: 'GET',
      url: '/api/v1/keys',
      headers: { authorization: `Bearer ${token}` },
    });

  const me = (credential: string) =>
    app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${credential}` },
    });

  /** A session plus a freshly minted key for the same user. */
  const sessionWithKey = async (email = validUser.email) => {
    const { token, userId } = await newSession(email);
    const created = (await createKey(token)).json();
    return { token, userId, key: created.key as string, keyId: created.id as string };
  };

  before(truncateAll);
  beforeEach(truncateAll);
  after(async () => {
    await app.close();
    await closeDb();
  });

  describe('POST /api/v1/keys', () => {
    it('creates a key from a session and returns the secret exactly once', async () => {
      const { token } = await newSession();

      const res = await createKey(token);
      const body = res.json();

      assert.equal(res.statusCode, 201);
      assert.match(body.id, UUID_RE);
      assert.equal(body.name, 'ci-pipeline');
      assert.ok(body.key.startsWith('jrk_'), 'keys carry the scannable prefix');
      assert.ok(body.key.length > 40);
      assert.equal(body.lastUsedAt, null);
      assert.ok(body.prefix.startsWith('jrk_'));
      assert.ok(body.key.startsWith(body.prefix), 'the display prefix is the head of the key');

      // The secret occurs once in the response and nowhere else in it.
      assert.equal(res.payload.split(body.key).length - 1, 1);
    });

    it('stores only a hash, never the plaintext', async () => {
      const { token } = await newSession();
      const { key, id } = (await createKey(token)).json();

      const [row] = await getDb()<{ keyHash: string; prefix: string }[]>`
        SELECT "keyHash", prefix FROM api_keys WHERE id = ${id}`;

      assert.ok(row);
      assert.notEqual(row.keyHash, key);
      assert.ok(!row.keyHash.includes(key));
      assert.equal(row.keyHash.length, 64, 'sha-256, hex encoded');
    });

    it('refuses an API key as the credential, with 403', async () => {
      const { key } = await sessionWithKey();

      const res = await createKey(key, 'minted-by-a-key');

      assert.equal(res.statusCode, 403);
      assert.equal(res.json().error, 'Forbidden');
      assert.ok(res.json().correlationId);
    });

    it('rejects an unauthenticated request with 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/keys',
        body: { name: 'anonymous' },
      });

      assert.equal(res.statusCode, 401);
    });

    it('rejects a missing name with 400', async () => {
      const { token } = await newSession();

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/keys',
        headers: { authorization: `Bearer ${token}` },
        body: {},
      });

      assert.equal(res.statusCode, 400);
    });
  });

  describe('GET /api/v1/keys', () => {
    it('lists keys without ever returning the secret or its hash', async () => {
      const { token, key } = await sessionWithKey();

      const res = await listKeys(token);
      const body = res.json();

      assert.equal(res.statusCode, 200);
      assert.equal(body.count, 1);
      assert.equal(body.data[0].name, 'ci-pipeline');
      assert.ok(body.data[0].prefix.startsWith('jrk_'));
      assert.ok(!res.payload.includes(key), 'the one-time secret must never reappear');
      assert.ok(!res.payload.includes('keyHash'));
    });

    it('shows only the caller’s own keys', async () => {
      const { token: aliceToken } = await sessionWithKey('alice@gmail.com');
      const { token: bobToken } = await sessionWithKey('bob@gmail.com');

      assert.equal((await listKeys(aliceToken)).json().count, 1);
      assert.equal((await listKeys(bobToken)).json().count, 1);
      assert.notEqual(
        (await listKeys(aliceToken)).json().data[0].id,
        (await listKeys(bobToken)).json().data[0].id,
      );
    });

    it('refuses an API key as the credential, with 403', async () => {
      const { key } = await sessionWithKey();

      const res = await listKeys(key);

      assert.equal(res.statusCode, 403);
    });
  });

  describe('DELETE /api/v1/keys/:id', () => {
    it('revokes the key and drops it from the list without deleting the row', async () => {
      const { token, keyId } = await sessionWithKey();

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/keys/${keyId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      assert.equal(res.statusCode, 204);
      assert.equal((await listKeys(token)).json().count, 0);

      const [row] = await getDb()<{ revokedAt: Date | null }[]>`
        SELECT "revokedAt" FROM api_keys WHERE id = ${keyId}`;
      assert.ok(row, 'the row is kept for audit');
      assert.ok(row.revokedAt instanceof Date);
    });

    it('returns 404 for a key that does not exist', async () => {
      const { token } = await newSession();

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/keys/2cdc8ab1-6d50-49cc-ba14-54e4ac7ec231',
        headers: { authorization: `Bearer ${token}` },
      });

      assert.equal(res.statusCode, 404);
    });

    it('will not let one user revoke another user’s key', async () => {
      const { keyId: aliceKeyId } = await sessionWithKey('alice@gmail.com');
      const { token: bobToken } = await newSession('bob@gmail.com');

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/keys/${aliceKeyId}`,
        headers: { authorization: `Bearer ${bobToken}` },
      });

      // 404 rather than 403: Bob learns nothing about whether that id exists.
      assert.equal(res.statusCode, 404);

      const [row] = await getDb()<{ revokedAt: Date | null }[]>`
        SELECT "revokedAt" FROM api_keys WHERE id = ${aliceKeyId}`;
      assert.equal(row?.revokedAt, null, "Alice's key must still work");
    });

    it('refuses an API key as the credential, with 403', async () => {
      const { key, keyId } = await sessionWithKey();

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/keys/${keyId}`,
        headers: { authorization: `Bearer ${key}` },
      });

      assert.equal(res.statusCode, 403);
    });
  });

  describe('authenticating with an API key', () => {
    it('identifies the owner and reports kind "key"', async () => {
      const { key, userId } = await sessionWithKey();

      const res = await me(key);

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().kind, 'key');
      assert.equal(res.json().user.id, userId);
    });

    it('records lastUsedAt on first use', async () => {
      const { key, keyId } = await sessionWithKey();

      const before = await getDb()<{ lastUsedAt: Date | null }[]>`
        SELECT "lastUsedAt" FROM api_keys WHERE id = ${keyId}`;
      assert.equal(before[0]?.lastUsedAt, null, 'a brand new key has never been used');

      assert.equal((await me(key)).statusCode, 200);

      const [row] = await getDb()<{ lastUsedAt: Date | null }[]>`
        SELECT "lastUsedAt" FROM api_keys WHERE id = ${keyId}`;
      assert.ok(row?.lastUsedAt instanceof Date, 'first use must be recorded');
    });

    it('does not rewrite lastUsedAt on every request', async () => {
      const { key, keyId } = await sessionWithKey();
      await me(key);

      const [first] = await getDb()<{ lastUsedAt: Date }[]>`
        SELECT "lastUsedAt" FROM api_keys WHERE id = ${keyId}`;
      await me(key);
      const [second] = await getDb()<{ lastUsedAt: Date }[]>`
        SELECT "lastUsedAt" FROM api_keys WHERE id = ${keyId}`;

      assert.ok(first && second);
      // The 60-second gate lives in the UPDATE's WHERE clause, so the second request
      // touches no row at all.
      assert.equal(second.lastUsedAt.getTime(), first.lastUsedAt.getTime());
    });

    it('rejects a revoked key with 401', async () => {
      const { token, key, keyId } = await sessionWithKey();
      assert.equal((await me(key)).statusCode, 200, 'the key works before revocation');

      await app.inject({
        method: 'DELETE',
        url: `/api/v1/keys/${keyId}`,
        headers: { authorization: `Bearer ${token}` },
      });

      const res = await me(key);

      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error, 'Unauthorized');
    });

    it('rejects an unknown key with 401', async () => {
      const res = await me('jrk_thiskeywasnevermintedbyanyoneatall00000000');

      assert.equal(res.statusCode, 401);
    });

    it('keeps two users’ keys from resolving to each other', async () => {
      const alice = await sessionWithKey('alice@gmail.com');
      const bob = await sessionWithKey('bob@gmail.com');

      assert.notEqual(alice.key, bob.key);
      assert.equal((await me(alice.key)).json().user.id, alice.userId);
      assert.equal((await me(bob.key)).json().user.id, bob.userId);
      assert.equal((await me(alice.key)).json().user.email, 'alice@gmail.com');
      assert.equal((await me(bob.key)).json().user.email, 'bob@gmail.com');
    });

    it('does not fall back to JWT verification for a prefixed token', async () => {
      const { token } = await newSession();

      // A session JWT wearing the key prefix must fail as a key, not be re-tried as a JWT.
      const res = await me(`jrk_${token}`);

      assert.equal(res.statusCode, 401);
    });
  });
});
