import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { getDb } from '#src/db.ts';
import { SESSION_COOKIE } from '#src/plugins/auth.ts';
import { buildTestApp, closeDb, truncateAll, validUser } from '#tests/helpers.ts';
import { UUID_RE } from './utils.ts';

const SESSION_TTL_SECONDS = 14_400;

/**
 * Every error body carries a fresh correlation id, so "identical response" means
 * identical once that one field is masked. Comparing the raw payload string rather
 * than the parsed object also catches differences in key order and whitespace.
 */
const maskCorrelationId = (payload: string) =>
  payload.replace(/"correlationId":"[^"]*"/, '"correlationId":"<masked>"');

/** Requires Postgres: `docker compose up -d postgres && pnpm db:migrate`. */
describe('auth API', async () => {
  const app = await buildTestApp();

  const signup = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/auth/signup', body });

  const login = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/v1/auth/login', body });

  const me = (headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/api/v1/auth/me', headers });

  type InjectResponse = Awaited<ReturnType<typeof signup>>;
  const sessionCookie = (res: InjectResponse) =>
    res.cookies.find((cookie) => cookie.name === SESSION_COOKIE);

  before(truncateAll);
  beforeEach(truncateAll);
  after(async () => {
    await app.close();
    await closeDb();
  });

  describe('POST /api/v1/auth/signup', () => {
    it('creates the account and returns the user with a token', async () => {
      const res = await signup(validUser);
      const body = res.json();

      assert.equal(res.statusCode, 201);
      assert.match(body.user.id, UUID_RE);
      assert.equal(body.user.email, validUser.email);
      assert.equal(body.user.name, validUser.name);
      assert.equal(typeof body.token, 'string');
      assert.ok(body.token.length > 0);
      assert.equal(body.expiresIn, SESSION_TTL_SECONDS);
    });

    it('never leaks the password or its hash', async () => {
      const res = await signup(validUser);

      assert.ok(!res.payload.includes(validUser.password));
      assert.ok(!res.payload.includes('passwordHash'));
      assert.ok(!res.payload.includes('scrypt'));
    });

    it('sets an HttpOnly, host-only, lax session cookie scoped to the whole API', async () => {
      const res = await signup(validUser);
      const cookie = sessionCookie(res);

      assert.ok(cookie, 'signup must set the session cookie');
      assert.equal(cookie.httpOnly, true, 'JavaScript must not be able to read the session');
      assert.equal(cookie.path, '/');
      assert.equal(cookie.sameSite?.toLowerCase(), 'lax');
      assert.equal(cookie.maxAge, SESSION_TTL_SECONDS);
      // No Domain attribute: a host-only cookie is not sent to sibling subdomains.
      assert.equal(cookie.domain, undefined);
      assert.ok(cookie.value.length > 0);
    });

    it('returns a token that actually authenticates', async () => {
      const { token } = (await signup(validUser)).json();

      const res = await me({ authorization: `Bearer ${token}` });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().user.email, validUser.email);
    });

    it('rejects a duplicate email with 409', async () => {
      await signup(validUser);
      const res = await signup(validUser);

      assert.equal(res.statusCode, 409);
      assert.equal(res.json().error, 'Conflict');
      assert.ok(res.json().correlationId);
    });

    it('treats email case-insensitively, so a second signup is still a duplicate', async () => {
      await signup(validUser);
      const res = await signup({ ...validUser, email: validUser.email.toUpperCase() });

      assert.equal(res.statusCode, 409);
    });

    describe('validation', () => {
      const invalid = [
        ['a password under 8 characters', { ...validUser, password: 'short7!' }],
        ['an empty password', { ...validUser, password: '' }],
        ['a malformed email', { ...validUser, email: 'not-an-email' }],
        ['a missing password', { email: validUser.email, name: validUser.name }],
        ['a missing email', { name: validUser.name, password: validUser.password }],
        ['a missing name', { email: validUser.email, password: validUser.password }],
      ] as const;

      for (const [description, body] of invalid) {
        it(`rejects ${description} with 400`, async () => {
          const res = await signup(body as Record<string, unknown>);

          assert.equal(res.statusCode, 400);
          assert.equal(res.json().error, 'Bad Request');
          assert.ok(res.json().correlationId);
        });
      }
    });
  });

  describe('POST /api/v1/auth/login', () => {
    it('returns a session for correct credentials', async () => {
      await signup(validUser);

      const res = await login({ email: validUser.email, password: validUser.password });
      const body = res.json();

      assert.equal(res.statusCode, 200);
      assert.equal(body.user.email, validUser.email);
      assert.equal(typeof body.token, 'string');
      assert.equal(sessionCookie(res)?.httpOnly, true);
    });

    it('accepts a differently-cased email', async () => {
      await signup(validUser);

      const res = await login({
        email: validUser.email.toUpperCase(),
        password: validUser.password,
      });

      assert.equal(res.statusCode, 200);
    });

    /**
     * The anti-enumeration property. If these two responses differed in any way, the
     * login endpoint would tell an attacker which email addresses have accounts here.
     */
    it('returns byte-identical 401s for a wrong password and an unknown email', async () => {
      await signup(validUser);

      const wrongPassword = await login({ email: validUser.email, password: 'not-the-password' });
      const unknownEmail = await login({
        email: 'nobody@gmail.com',
        password: validUser.password,
      });

      assert.equal(wrongPassword.statusCode, 401);
      assert.equal(unknownEmail.statusCode, 401);
      assert.equal(
        maskCorrelationId(wrongPassword.payload),
        maskCorrelationId(unknownEmail.payload),
        'a wrong password and an unknown email must be indistinguishable',
      );
    });

    it('gives an account with no password the same 401, not a different error', async () => {
      await signup(validUser);
      const wrongPassword = await login({ email: validUser.email, password: 'not-the-password' });

      // An API-only account: the row exists, passwordHash is NULL.
      await getDb()`
        INSERT INTO users (id, email, name, "passwordHash")
        VALUES (${randomUUID()}, 'apionly@gmail.com', 'API Only', NULL)`;

      const res = await login({ email: 'apionly@gmail.com', password: validUser.password });

      assert.equal(res.statusCode, 401);
      assert.equal(maskCorrelationId(res.payload), maskCorrelationId(wrongPassword.payload));
    });

    it('does not accept an empty password against a null hash', async () => {
      await getDb()`
        INSERT INTO users (id, email, name, "passwordHash")
        VALUES (${randomUUID()}, 'apionly@gmail.com', 'API Only', NULL)`;

      const res = await login({ email: 'apionly@gmail.com', password: '' });

      assert.equal(res.statusCode, 400, 'an empty password fails schema validation first');
    });
  });

  describe('POST /api/v1/auth/logout', () => {
    it('clears the session cookie', async () => {
      const signedUp = await signup(validUser);
      const token = sessionCookie(signedUp)?.value;
      assert.ok(token);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        cookies: { [SESSION_COOKIE]: token },
      });

      assert.equal(res.statusCode, 204);
      const cleared = sessionCookie(res);
      assert.ok(cleared, 'logout must send a Set-Cookie that overwrites the session');
      assert.equal(cleared.value, '');
      assert.equal(cleared.path, '/');
      // An expiry in the past is what actually makes the browser drop it.
      assert.ok(cleared.expires && cleared.expires.getTime() <= Date.now());
    });

    it('works without a session, so a stale client can still clear itself', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/logout' });

      assert.equal(res.statusCode, 204);
    });
  });

  describe('GET /api/v1/auth/me', () => {
    it('authenticates a bearer JWT and reports kind "session"', async () => {
      const { token } = (await signup(validUser)).json();

      const res = await me({ authorization: `Bearer ${token}` });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().kind, 'session');
      assert.equal(res.json().user.email, validUser.email);
    });

    it('authenticates the session cookie and reports kind "session"', async () => {
      const signedUp = await signup(validUser);
      const token = sessionCookie(signedUp)?.value;
      assert.ok(token);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/me',
        cookies: { [SESSION_COOKIE]: token },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().kind, 'session');
      assert.equal(res.json().user.email, validUser.email);
    });

    it('never returns the password hash', async () => {
      const { token } = (await signup(validUser)).json();

      const res = await me({ authorization: `Bearer ${token}` });

      assert.ok(!res.payload.includes('passwordHash'));
      assert.ok(!res.payload.includes('scrypt'));
    });

    it('rejects a request with no credential', async () => {
      const res = await me();

      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error, 'Unauthorized');
      assert.ok(res.json().correlationId);
    });

    it('rejects a garbage bearer token', async () => {
      const res = await me({ authorization: 'Bearer not-a-jwt' });

      assert.equal(res.statusCode, 401);
    });

    it('rejects a token signed with the wrong secret', async () => {
      // Header/payload are well-formed; only the signature is wrong.
      const forged =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEifQ.YQ';
      const res = await me({ authorization: `Bearer ${forged}` });

      assert.equal(res.statusCode, 401);
    });

    it('rejects an expired token', async () => {
      const { user } = (await signup(validUser)).json();
      // Signed with a past exp rather than waiting four hours for a real one.
      const expired = app.jwt.sign({ sub: user.id }, { expiresIn: -3600 });

      const res = await me({ authorization: `Bearer ${expired}` });

      assert.equal(res.statusCode, 401);
    });

    it('rejects a valid token for a user that no longer exists', async () => {
      const { token, user } = (await signup(validUser)).json();
      await getDb()`DELETE FROM users WHERE id = ${user.id}`;

      const res = await me({ authorization: `Bearer ${token}` });

      assert.equal(res.statusCode, 401);
    });

    it('rejects an Authorization header that is not a bearer token', async () => {
      const { token } = (await signup(validUser)).json();

      const res = await me({ authorization: `Basic ${token}` });

      assert.equal(res.statusCode, 401);
    });
  });

  describe('public routes', () => {
    it('still serves the health probe with no credential', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { status: 'ok' });
    });
  });
});
