import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { buildTestApp, closeDb, truncateAll } from '#tests/helpers.ts';
import { UUID_RE } from '#tests/utils.ts';

/**
 * Every failure leaves through the same door, in the same shape.
 *
 * The handler used to enumerate two `FST_…` codes by name and let everything else fall through to
 * a 500 — so `curl -X POST -H 'Content-Type: application/json'` with no body answered "Internal
 * Server Error" for what is plainly a bad request. These tests pin the general rule that replaced
 * the enumeration: an error that already knows it is a 4xx is reported as one.
 *
 * Requires Postgres: `docker compose up -d postgres && pnpm db:migrate`.
 */
describe('error handling', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;

  before(async () => {
    await truncateAll();
    app = await buildTestApp();
  });
  after(async () => {
    await app.close();
    await closeDb();
  });

  const signup = (opts: { payload?: string; contentType?: string }) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      headers: { 'content-type': opts.contentType ?? 'application/json' },
      payload: opts.payload,
    });

  it('answers 400, not 500, when a JSON content-type arrives with no body', async () => {
    const res = await signup({});
    const body = res.json();

    assert.equal(res.statusCode, 400);
    assert.equal(body.statusCode, 400);
    assert.equal(body.error, 'Bad Request');
    // Fastify's own wording is written for the caller, so it is passed through rather than
    // flattened to "Bad Request".
    assert.match(body.message, /body cannot be empty/i);
  });

  it('answers 400 for a malformed JSON body', async () => {
    const res = await signup({ payload: '{"email": ' });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'Bad Request');
  });

  it('answers 415 for a content type it cannot parse', async () => {
    // Not `text/plain` — Fastify ships a parser for that, so it would parse and then fail
    // validation as a 400. This needs a media type with no registered parser at all.
    const res = await signup({ payload: '<user/>', contentType: 'application/xml' });
    const body = res.json();

    assert.equal(res.statusCode, 415);
    assert.equal(body.statusCode, 415);
    assert.equal(body.error, 'Unsupported Media Type');
  });

  it('reports schema validation with per-field detail', async () => {
    const res = await signup({ payload: JSON.stringify({ email: 'nope', password: 'x' }) });
    const body = res.json();

    assert.equal(res.statusCode, 400);
    assert.equal(body.message, 'Validation error');
    assert.ok(body.subErrors, 'validation failures name the fields that failed');
  });

  it('gives an unmatched route the same body shape as every other error', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    const body = res.json();

    assert.equal(res.statusCode, 404);
    assert.equal(body.statusCode, 404);
    assert.equal(body.error, 'Not Found');
    assert.match(body.message, /not found/i);
  });

  it('keeps an AppError’s own message rather than the generic reason phrase', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    const body = res.json();

    assert.equal(res.statusCode, 401);
    assert.equal(body.statusCode, 401);
    // UnauthorizedError, not a framework 401 — its wording must survive the handler.
    assert.notEqual(body.message, 'Unauthorized');
  });

  it('attaches a correlation id to every failure', async () => {
    const responses = await Promise.all([
      signup({}),
      signup({ payload: '{' }),
      signup({ payload: JSON.stringify({}) }),
      app.inject({ method: 'GET', url: '/api/v1/nope' }),
      app.inject({ method: 'GET', url: '/api/v1/auth/me' }),
    ]);

    for (const res of responses) {
      assert.match(res.json().correlationId, UUID_RE, `${res.statusCode} carries a correlation id`);
    }
  });
});
