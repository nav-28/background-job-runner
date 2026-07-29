import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { SESSION_COOKIE } from '#src/plugins/auth.ts';
import { buildTestApp, closeDb, truncateAll, validUser } from '#tests/helpers.ts';
import { UUID_RE } from './utils.ts';

/**
 * The task API, driven through HTTP.
 *
 * The brief's nine success criteria are walked here as a reviewer would walk them — over the
 * REST surface, not the engine's TypeScript one. The engine's own suite (`tests/engine/`) proves
 * the same behaviours at the library level; this file proves the API in front of it does not
 * lose, rename or reshape any of it. We needs a real process kill and lives in
 * `tests/durability-restart.test.ts`; the event stream needs a real socket and lives in
 * `tests/events.test.ts`.
 *
 * Requires Postgres: `docker compose up -d postgres && pnpm db:migrate`.
 */
describe('task API', async () => {
  /**
   * Concurrency 2 is the number criterion 7 names. The rest are impatience: a 25ms poll and a
   * 25ms backoff turn a suite that would spend most of its time asleep into one that runs in
   * seconds, and neither changes a single code path.
   */
  const app = await buildTestApp({
    engine: {
      config: { concurrency: 2, pollIntervalMs: 25, maxAttempts: 2, backoffBaseMs: 25 },
    },
  });

  /** The full key set of a task on the wire. Sorted, so a stray field fails the assertion. */
  const TASK_KEYS = [
    'attempts',
    'collected',
    'created_at',
    'error',
    'handle',
    'id',
    'is_seed',
    'lane',
    'params',
    'result',
    'status',
    'updated_at',
  ];

  const signup = async (email = validUser.email) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      body: { ...validUser, email },
    });
    assert.equal(res.statusCode, 201, 'signup fixture must succeed');
    const { token, user } = res.json();
    return { token: token as string, userId: user.id as string };
  };

  /** An API key for a session, so the same routes can be exercised with a machine credential. */
  const mintKey = async (token: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/keys',
      headers: { authorization: `Bearer ${token}` },
      body: { name: 'test-runner' },
    });
    assert.equal(res.statusCode, 201, 'key fixture must succeed');
    return res.json().key as string;
  };

  const bearer = (credential: string) => ({ authorization: `Bearer ${credential}` });

  const submit = (credential: string, lane: string, params: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: bearer(credential),
      body: { lane, params },
    });

  /** Submits and asserts the 201, for the many places where the submit itself is not the point. */
  const submitOk = async (
    credential: string,
    lane: string,
    params: Record<string, unknown> = {},
  ) => {
    const res = await submit(credential, lane, params);
    assert.equal(res.statusCode, 201, `submit failed: ${res.payload}`);
    return res.json();
  };

  const getTask = (credential: string, handle: string) =>
    app.inject({ method: 'GET', url: `/api/v1/tasks/${handle}`, headers: bearer(credential) });

  const listTasks = (credential: string, query = '') =>
    app.inject({ method: 'GET', url: `/api/v1/tasks${query}`, headers: bearer(credential) });

  const history = (credential: string, handle: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${handle}/history`,
      headers: bearer(credential),
    });

  const collect = (credential: string, handle: string) =>
    app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${handle}/result`,
      headers: bearer(credential),
    });

  const cancel = (credential: string, handle: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${handle}/cancel`,
      headers: bearer(credential),
    });

  const retry = (credential: string, handle: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${handle}/retry`,
      headers: bearer(credential),
    });

  const stats = async (credential: string) => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tasks/stats',
      headers: bearer(credential),
    });
    assert.equal(res.statusCode, 200);
    return res.json() as Record<string, number>;
  };

  const eventTypes = async (credential: string, handle: string) => {
    const res = await history(credential, handle);
    assert.equal(res.statusCode, 200, res.payload);
    return (res.json() as { type: string }[]).map((event) => event.type);
  };

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Polls until `check` passes, so nothing here races the claim loop with a bare sleep. */
  const waitFor = async (label: string, check: () => Promise<boolean>, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) {
        return;
      }
      await sleep(20);
    }
    throw new Error(`timed out waiting for: ${label}`);
  };

  const waitForStatus = async (credential: string, handle: string, status: string) => {
    await waitFor(`${handle} to be ${status}`, async () => {
      const res = await getTask(credential, handle);
      return res.statusCode === 200 && res.json().status === status;
    });
  };

  before(truncateAll);

  /**
   * The engine is stopped around the truncate on purpose. A live claim loop mid-TRUNCATE would
   * be writing events for tasks the statement is deleting; stopping first makes every test start
   * from a genuinely empty queue.
   */
  beforeEach(async () => {
    await app.engine.stop();
    await truncateAll();
    await app.engine.start();
  });

  after(async () => {
    await app.close();
    await closeDb();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The brief's success criteria, walked over HTTP
  // ───────────────────────────────────────────────────────────────────────────

  describe('instant handle', () => {
    it('returns scrape-1 queued in well under a second for a 10s job', async () => {
      const { token } = await signup();

      const startedAt = Date.now();
      const res = await submit(token, 'scrape', { duration_ms: 10_000 });
      const elapsed = Date.now() - startedAt;

      assert.equal(res.statusCode, 201);
      const task = res.json();
      assert.equal(task.handle, 'scrape-1');
      assert.equal(task.status, 'queued');
      assert.ok(elapsed < 1000, `submit took ${elapsed}ms; it must not wait on the work`);

      // The acknowledgement is not the work: the job is still nowhere near done.
      assert.equal(task.result, null);
      assert.equal(task.attempts, 0);
    });
  });

  describe('lifecycle to ready, result collectable', () => {
    it('moves queued → running → ready and hands the result back through /result', async () => {
      const { token } = await signup();
      const submitted = await submitOk(token, 'scrape', { duration_ms: 1000 });
      assert.equal(submitted.status, 'queued');

      await waitForStatus(token, submitted.handle, 'running');
      await waitForStatus(token, submitted.handle, 'ready');

      const beforeCollect = (await getTask(token, submitted.handle)).json();
      assert.equal(beforeCollect.collected, false, 'ready must not imply collected');
      assert.equal(beforeCollect.error, null);

      const res = await collect(token, submitted.handle);
      assert.equal(res.statusCode, 200);
      const collected = res.json();
      assert.equal(collected.collected, true);
      assert.equal(collected.status, 'ready');
      assert.equal(collected.handle, submitted.handle);
      assert.equal(collected.id, submitted.id, 'collecting must not return a different task');
      assert.equal(collected.result.handle, submitted.handle);
      assert.equal(collected.result.lane, 'scrape');
      assert.equal(collected.result.durationMs, 1000);

      // The transition log a reviewer reads on the detail view.
      assert.deepEqual(await eventTypes(token, submitted.handle), [
        'accepted',
        'started',
        'ready',
        'collected',
      ]);
    });

    it('refuses to collect twice, and refuses to collect a task that is not ready', async () => {
      const { token } = await signup();
      const running = await submitOk(token, 'scrape', { duration_ms: 30_000 });
      await waitForStatus(token, running.handle, 'running');

      const tooEarly = await collect(token, running.handle);
      assert.equal(tooEarly.statusCode, 409);
      assert.match(tooEarly.json().message, /only a ready task can be collected/);

      const done = await submitOk(token, 'report', { duration_ms: 20 });
      await waitForStatus(token, done.handle, 'ready');
      assert.equal((await collect(token, done.handle)).statusCode, 200);

      const again = await collect(token, done.handle);
      assert.equal(again.statusCode, 409);
      assert.match(again.json().message, /already been collected/);
    });
  });

  describe('per-category numbering', () => {
    it('numbers each lane independently and gives the next scrape scrape-2', async () => {
      const { token } = await signup();

      const scrape1 = await submitOk(token, 'scrape', { duration_ms: 30_000 });
      const report1 = await submitOk(token, 'report', { duration_ms: 30_000 });
      const scrape2 = await submitOk(token, 'scrape', { duration_ms: 30_000 });

      assert.equal(scrape1.handle, 'scrape-1');
      assert.equal(report1.handle, 'report-1', 'a report must not be numbered behind a scrape');
      assert.equal(scrape2.handle, 'scrape-2', 'the first scrape is still active');
    });
  });

  describe('recycling without collision', () => {
    it('holds the number while a task is active and hands it back once collected', async () => {
      const { token } = await signup();

      const first = await submitOk(token, 'scrape', { duration_ms: 20 });
      assert.equal(first.handle, 'scrape-1');
      await waitForStatus(token, first.handle, 'ready');

      // Finished but uncollected is still active: the number must NOT be reused.
      const second = await submitOk(token, 'scrape', { duration_ms: 30_000 });
      assert.equal(second.handle, 'scrape-2');

      assert.equal((await collect(token, 'scrape-1')).statusCode, 200);

      // Collected releases 1, and the allocator fills the gap rather than counting upwards.
      const third = await submitOk(token, 'scrape', { duration_ms: 30_000 });
      assert.equal(third.handle, 'scrape-1');
      assert.notEqual(third.id, first.id, 'a recycled handle is a different task');

      // …and the retired one is still addressable by id, which is why id exists.
      const retired = await app.inject({
        method: 'GET',
        url: `/api/v1/tasks/id/${first.id}`,
        headers: bearer(token),
      });
      assert.equal(retired.statusCode, 200);
      assert.equal(retired.json().collected, true);
      assert.equal(retired.json().handle, 'scrape-1');

      // The handle now resolves to the live owner, not the retired one.
      assert.equal((await getTask(token, 'scrape-1')).json().id, third.id);
    });

    it('releases a cancelled task’s number too', async () => {
      const { token } = await signup();

      const first = await submitOk(token, 'scrape', { duration_ms: 30_000 });
      assert.equal((await cancel(token, first.handle)).statusCode, 200);

      const second = await submitOk(token, 'scrape', { duration_ms: 30_000 });
      assert.equal(second.handle, 'scrape-1');
      assert.notEqual(second.id, first.id);
    });
  });

  describe('failure surfaces, no auto-collect, operator can retry', () => {
    it('lands in failed with an honest reason and a retryable flag, and retries on request', async () => {
      const { token } = await signup();
      const doomed = await submitOk(token, 'report', { fail: true, duration_ms: 20 });

      await waitForStatus(token, doomed.handle, 'failed');
      const failed = (await getTask(token, doomed.handle)).json();

      assert.equal(failed.status, 'failed');
      assert.equal(failed.collected, false, 'a failure must never be silently collected');
      assert.equal(failed.result, null);
      assert.equal(typeof failed.error.reason, 'string');
      assert.ok(failed.error.reason.includes('simulated failure'), failed.error.reason);
      assert.equal(failed.error.retryable, true);
      assert.equal(failed.attempts, 2, 'the transient error was auto-retried up to its budget');

      // Auto-retry with backoff happened, and it is visible in the history.
      const types = await eventTypes(token, doomed.handle);
      assert.deepEqual(types, ['accepted', 'started', 'retry_scheduled', 'started', 'failed']);

      // The operator decides when to try again.
      const retried = await retry(token, doomed.handle);
      assert.equal(retried.statusCode, 200);
      assert.equal(retried.json().status, 'queued');
      assert.equal(retried.json().error, null, 'a requeued task is not a failed one');
      assert.equal(retried.json().attempts, 2, 'attempts is a lifetime counter, never reset');
    });

    it('refuses to retry anything that is not failed', async () => {
      const { token } = await signup();
      const running = await submitOk(token, 'scrape', { duration_ms: 30_000 });

      const res = await retry(token, running.handle);
      assert.equal(res.statusCode, 409);
      assert.match(res.json().message, /only a failed task can be retried/);
    });
  });

  describe('cancellation, running and queued', () => {
    it('stops a running job and never reports it ready', async () => {
      const { token } = await signup();
      const task = await submitOk(token, 'scrape', { duration_ms: 30_000 });
      await waitForStatus(token, task.handle, 'running');

      const res = await cancel(token, task.handle);
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().status, 'cancelled');

      // The worker stopped; give the pool room to have finished if it had not.
      await sleep(300);
      assert.equal((await getTask(token, task.handle)).json().status, 'cancelled');
      const types = await eventTypes(token, task.handle);
      assert.deepEqual(types, ['accepted', 'started', 'cancelled']);
    });

    it('cancels a job still queued behind the concurrency limit', async () => {
      const { token } = await signup();
      await submitOk(token, 'scrape', { duration_ms: 30_000 });
      await submitOk(token, 'scrape', { duration_ms: 30_000 });
      const queued = await submitOk(token, 'scrape', { duration_ms: 30_000 });

      // Concurrency is 2, so the third one never starts.
      await waitFor('two tasks running', async () => (await stats(token)).running === 2);
      assert.equal((await getTask(token, queued.handle)).json().status, 'queued');

      const res = await cancel(token, queued.handle);
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().status, 'cancelled');
      assert.deepEqual(await eventTypes(token, queued.handle), ['accepted', 'cancelled']);
    });

    it('refuses to cancel a task that already finished', async () => {
      const { token } = await signup();
      const task = await submitOk(token, 'scrape', { duration_ms: 20 });
      await waitForStatus(token, task.handle, 'ready');

      const res = await cancel(token, task.handle);
      assert.equal(res.statusCode, 409);
      assert.equal((await getTask(token, task.handle)).json().status, 'ready');
    });
  });

  describe('concurrency respected', () => {
    it('never has more than 2 running with 5 jobs submitted at once', async () => {
      const { token } = await signup();
      await Promise.all(
        Array.from({ length: 5 }, () => submitOk(token, 'scrape', { duration_ms: 400 })),
      );

      // Saturation is waited for, not sampled for. Folding "did we ever see 2 running?" into the
      // loop below would make it a question about how often this process got scheduled: on a busy
      // machine every sample can land between rounds and the check fails for no good reason.
      // Waiting has the same meaning and a real answer — either the pool fills both slots within
      // the timeout or it does not.
      await waitFor(
        'both slots in use with work still queued behind them',
        async () => {
          const counts = await stats(token);
          assert.ok(counts.running <= 2, `saw ${counts.running} running; the limit is 2`);
          return counts.running === 2 && counts.queued > 0;
        },
        30_000,
      );

      // …and the limit holds for the whole run, not just at that moment.
      await waitFor(
        'all five to finish',
        async () => {
          const counts = await stats(token);
          assert.ok(counts.running <= 2, `saw ${counts.running} running; the limit is 2`);
          return counts.ready === 5;
        },
        30_000,
      );
    });
  });

  describe('concurrent completions', () => {
    it('finishes three near-simultaneous jobs with exactly one ready event each', async () => {
      const { token } = await signup();
      const handles = await Promise.all(
        ['scrape', 'report', 'scrape'].map(
          async (lane) => (await submitOk(token, lane, { duration_ms: 150 })).handle,
        ),
      );

      await waitFor('all three ready', async () => (await stats(token)).ready === 3);

      const counts = await stats(token);
      assert.deepEqual(counts, { queued: 0, running: 0, ready: 3, failed: 0, cancelled: 0 });

      for (const handle of handles) {
        const types = await eventTypes(token, handle);
        assert.equal(
          types.filter((type) => type === 'ready').length,
          1,
          `${handle} must have exactly one ready event, got ${types.join(',')}`,
        );
        assert.deepEqual(types, ['accepted', 'started', 'ready']);
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The wire contract
  // ───────────────────────────────────────────────────────────────────────────

  describe('the task object', () => {
    it('carries exactly the brief’s fields plus id, attempts and is_seed', async () => {
      const { token } = await signup();
      const created = await submitOk(token, 'scrape', { duration_ms: 30_000 });

      assert.deepEqual(Object.keys(created).sort(), TASK_KEYS);
      assert.match(created.id, UUID_RE);
      assert.equal(created.lane, 'scrape');
      assert.equal(created.is_seed, false);
      assert.equal(created.collected, false);
      assert.equal(typeof created.attempts, 'number');
      // Timestamps are ISO strings, not the engine's Date objects.
      assert.equal(new Date(created.created_at).toISOString(), created.created_at);
      assert.equal(new Date(created.updated_at).toISOString(), created.updated_at);

      // Every route that returns a task returns the same shape.
      const fetched = (await getTask(token, created.handle)).json();
      assert.deepEqual(Object.keys(fetched).sort(), TASK_KEYS);
      const [listed] = (await listTasks(token)).json();
      assert.deepEqual(Object.keys(listed).sort(), TASK_KEYS);
      const cancelled = (await cancel(token, created.handle)).json();
      assert.deepEqual(Object.keys(cancelled).sort(), TASK_KEYS);
    });

    /**
     * The serialisation trap. fast-json-stringify emits only the properties a response schema
     * names, so a naively typed `params` turns `{"duration_ms":500}` into `{}` — which a
     * key-presence assertion would happily accept. Hence structural equality, on a payload deep
     * enough that a stripping serialiser cannot accidentally pass.
     */
    it('round-trips a deeply nested params object through jsonb without dropping a key', async () => {
      const { token } = await signup();
      const params = {
        duration_ms: 30_000,
        target: {
          url: 'https://example.com/a?b=c&d=e',
          headers: { accept: 'text/html', 'x-trace': ['one', 'two'] },
          retry: { limit: 3, on: [429, 503], jitter: true, backoff: null },
        },
        selectors: [
          { css: '.title', many: false },
          { css: '.row', many: true, fields: { price: '.p', name: '.n' } },
        ],
        empty_object: {},
        empty_array: [],
        unicode: 'héllo — ✅ 日本語',
      };
      // `fail` picks up its declared default; everything else must survive untouched.
      const expected = { ...params, fail: false };

      const created = await submitOk(token, 'scrape', params);
      assert.deepEqual(created.params, expected, 'the POST response dropped part of params');

      const fetched = (await getTask(token, created.handle)).json();
      assert.deepEqual(
        fetched.params,
        expected,
        'the round trip through jsonb lost part of params',
      );

      const [listed] = (await listTasks(token)).json();
      assert.deepEqual(listed.params, expected, 'the list response dropped part of params');
    });

    it('round-trips a nested result and a structured error', async () => {
      const { token } = await signup();

      const ok = await submitOk(token, 'scrape', { duration_ms: 20 });
      await waitForStatus(token, ok.handle, 'ready');
      const ready = (await getTask(token, ok.handle)).json();
      // The mock worker's result is an object; every field of it must survive.
      assert.deepEqual(Object.keys(ready.result).sort(), [
        'durationMs',
        'finishedAt',
        'handle',
        'lane',
      ]);
      assert.equal(ready.result.durationMs, 20);

      const bad = await submitOk(token, 'report', { fail: true, duration_ms: 20 });
      await waitForStatus(token, bad.handle, 'failed');
      const failed = (await getTask(token, bad.handle)).json();
      assert.deepEqual(Object.keys(failed.error).sort(), ['reason', 'retryable']);
    });

    it('populates result only when ready and error only when failed', async () => {
      const { token } = await signup();

      const queued = await submitOk(token, 'scrape', { duration_ms: 30_000 });
      assert.equal(queued.result, null);
      assert.equal(queued.error, null);

      const done = await submitOk(token, 'report', { duration_ms: 20 });
      await waitForStatus(token, done.handle, 'ready');
      const ready = (await getTask(token, done.handle)).json();
      assert.notEqual(ready.result, null);
      assert.equal(ready.error, null);

      const cancelled = (await cancel(token, queued.handle)).json();
      assert.equal(cancelled.result, null);
      assert.equal(cancelled.error, null);
    });
  });

  describe('GET /tasks', () => {
    it('returns a bare array rather than the house pagination envelope', async () => {
      const { token } = await signup();
      await submitOk(token, 'scrape', { duration_ms: 30_000 });

      const res = await listTasks(token);
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.ok(Array.isArray(body), 'the brief fixes this shape; res.json()[0] must work');
      assert.equal(body.length, 1);
      assert.equal(body[0].handle, 'scrape-1');
    });

    it('filters by status, lane and date range, and sorts and pages', async () => {
      const { token } = await signup();
      const first = await submitOk(token, 'scrape', { duration_ms: 30_000 });
      await submitOk(token, 'report', { duration_ms: 30_000 });
      const third = await submitOk(token, 'scrape', { duration_ms: 30_000 });
      await cancel(token, third.handle);

      const byLane = (await listTasks(token, '?lane=report')).json();
      assert.deepEqual(
        byLane.map((task: { handle: string }) => task.handle),
        ['report-1'],
      );

      const byStatus = (await listTasks(token, '?status=cancelled')).json();
      assert.deepEqual(
        byStatus.map((task: { id: string }) => task.id),
        [third.id],
      );

      // Newest first by default; `sort=asc` flips it.
      const desc = (await listTasks(token)).json();
      assert.equal(desc[0].id, third.id);
      const asc = (await listTasks(token, '?sort=asc')).json();
      assert.equal(asc[0].id, first.id);

      const paged = (await listTasks(token, '?sort=asc&limit=1&offset=1')).json();
      assert.equal(paged.length, 1);
      assert.equal(paged[0].handle, 'report-1');

      // A window that excludes everything, and one that includes it all.
      const future = new Date(Date.now() + 60_000).toISOString();
      assert.equal((await listTasks(token, `?from=${future}`)).json().length, 0);
      const past = new Date(Date.now() - 60_000).toISOString();
      assert.equal((await listTasks(token, `?from=${past}&to=${future}`)).json().length, 3);
    });

    it('rejects a malformed date filter with a 400', async () => {
      const { token } = await signup();
      const res = await listTasks(token, '?from=not-a-date');
      assert.equal(res.statusCode, 400);
    });

    it('rejects an unknown status filter with a 400', async () => {
      const { token } = await signup();
      assert.equal((await listTasks(token, '?status=exploded')).statusCode, 400);
    });
  });

  describe('GET /tasks/stats', () => {
    it('reports every status, including the ones with no rows', async () => {
      const { token } = await signup();
      const empty = await stats(token);
      assert.deepEqual(empty, { queued: 0, running: 0, ready: 0, failed: 0, cancelled: 0 });

      const task = await submitOk(token, 'scrape', { duration_ms: 30_000 });
      await cancel(token, task.handle);
      assert.deepEqual(await stats(token), {
        queued: 0,
        running: 0,
        ready: 0,
        failed: 0,
        cancelled: 1,
      });
    });
  });

  describe('GET /tasks/{handle}/history', () => {
    it('returns each transition with its timestamp and detail', async () => {
      const { token } = await signup();
      const task = await submitOk(token, 'scrape', { duration_ms: 20 });
      await waitForStatus(token, task.handle, 'ready');

      const res = await history(token, task.handle);
      assert.equal(res.statusCode, 200);
      const events = res.json();
      assert.deepEqual(Object.keys(events[0]).sort(), ['at', 'detail', 'id', 'type']);
      assert.equal(events[0].type, 'accepted');
      assert.equal(new Date(events[0].at).toISOString(), events[0].at);
      // Ids are the SSE cursor: monotonic, so history and the stream agree on ordering.
      assert.ok(events[1].id > events[0].id);
      assert.equal(typeof events[0].detail, 'object');
    });
  });

  describe('GET /lanes', () => {
    it('is public and describes every lane well enough to render a form', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/lanes' });
      assert.equal(res.statusCode, 200, 'no credential at all must still work');

      const lanes = res.json();
      assert.deepEqual(lanes.map((lane: { lane: string }) => lane.lane).sort(), [
        'report',
        'scrape',
      ]);

      const scrape = lanes.find((lane: { lane: string }) => lane.lane === 'scrape');
      assert.equal(scrape.kind, 'inline');
      assert.ok(scrape.description.length > 0);
      const duration = scrape.params.find(
        (param: { name: string }) => param.name === 'duration_ms',
      );
      assert.equal(duration.type, 'number');
      assert.equal(duration.required, false);
      assert.equal(duration.min, 0);
      assert.equal(duration.max, 300_000);
      const fail = scrape.params.find((param: { name: string }) => param.name === 'fail');
      assert.equal(fail.default, false, 'a declared default must survive serialisation');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Validation, auth and isolation
  // ───────────────────────────────────────────────────────────────────────────

  describe('POST /tasks validation', () => {
    it('rejects an unknown lane with a 400 that names the ones it knows', async () => {
      const { token } = await signup();
      const res = await submit(token, 'teleport', {});
      assert.equal(res.statusCode, 400);
      assert.match(res.json().message, /Unknown lane "teleport"/);
      assert.match(res.json().message, /report, scrape/);
    });

    it('rejects a parameter that violates its descriptor', async () => {
      const { token } = await signup();

      const tooLong = await submit(token, 'scrape', { duration_ms: 999_999_999 });
      assert.equal(tooLong.statusCode, 400);
      assert.match(tooLong.json().message, /must be <= 300000/);

      const negative = await submit(token, 'scrape', { duration_ms: -1 });
      assert.equal(negative.statusCode, 400);
      assert.match(negative.json().message, /must be >= 0/);

      const notANumber = await submit(token, 'scrape', { duration_ms: 'soon' });
      assert.equal(notANumber.statusCode, 400);

      const notABoolean = await submit(token, 'scrape', { fail: 'yes' });
      assert.equal(notABoolean.statusCode, 400);
      assert.match(notABoolean.json().message, /must be a boolean/);
    });

    it('rejects a body with no lane before it reaches the engine', async () => {
      const { token } = await signup();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/tasks',
        headers: bearer(token),
        body: { params: {} },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().message, 'Validation error');
    });

    it('rejects a malformed handle with a 400, not a 404', async () => {
      const { token } = await signup();
      assert.equal((await getTask(token, 'nonsense')).statusCode, 400);
    });
  });

  describe('authentication', () => {
    it('accepts an API key on every task route', async () => {
      const { token } = await signup();
      const key = await mintKey(token);

      const created = await submitOk(key, 'scrape', { duration_ms: 30_000 });
      assert.equal(created.handle, 'scrape-1');
      assert.equal((await getTask(key, 'scrape-1')).statusCode, 200);
      assert.equal((await listTasks(key)).statusCode, 200);
      assert.equal((await history(key, 'scrape-1')).statusCode, 200);
      assert.equal((await cancel(key, 'scrape-1')).statusCode, 200);

      // Same user, whichever credential was used.
      assert.equal((await listTasks(token)).json().length, 1);
    });

    it('accepts a session cookie, which is how the dashboard authenticates', async () => {
      const { token } = await signup();

      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/tasks',
        cookies: { [SESSION_COOKIE]: token },
        body: { lane: 'scrape', params: { duration_ms: 30_000 } },
      });
      assert.equal(created.statusCode, 201);

      const listed = await app.inject({
        method: 'GET',
        url: '/api/v1/tasks',
        cookies: { [SESSION_COOKIE]: token },
      });
      assert.equal(listed.statusCode, 200);
      assert.equal(listed.json().length, 1);
    });

    it('answers 401 on every task route with no credential', async () => {
      const routes: [string, string][] = [
        ['POST', '/api/v1/tasks'],
        ['GET', '/api/v1/tasks'],
        ['GET', '/api/v1/tasks/stats'],
        ['GET', '/api/v1/tasks/scrape-1'],
        ['GET', '/api/v1/tasks/scrape-1/result'],
        ['GET', '/api/v1/tasks/scrape-1/history'],
        ['POST', '/api/v1/tasks/scrape-1/cancel'],
        ['POST', '/api/v1/tasks/scrape-1/retry'],
        ['GET', `/api/v1/tasks/id/${crypto.randomUUID()}`],
        ['GET', '/api/v1/events'],
      ];

      for (const [method, url] of routes) {
        const res = await app.inject({ method: method as 'GET', url, body: {} });
        assert.equal(res.statusCode, 401, `${method} ${url} must require a credential`);
      }
    });
  });

  describe('cross-user isolation', () => {
    it('hides another user’s task from every route, by handle and by id', async () => {
      const owner = await signup('owner@example.com');
      const stranger = await signup('stranger@example.com');
      const strangerKey = await mintKey(stranger.token);

      const task = await submitOk(owner.token, 'scrape', { duration_ms: 30_000 });
      const failing = await submitOk(owner.token, 'report', { fail: true, duration_ms: 20 });
      await waitForStatus(owner.token, failing.handle, 'failed');

      // Their list is empty, and their own numbering starts at 1 regardless of ours.
      assert.deepEqual((await listTasks(stranger.token)).json(), []);
      assert.deepEqual(await stats(stranger.token), {
        queued: 0,
        running: 0,
        ready: 0,
        failed: 0,
        cancelled: 0,
      });

      for (const credential of [stranger.token, strangerKey]) {
        assert.equal((await getTask(credential, task.handle)).statusCode, 404);
        assert.equal((await history(credential, task.handle)).statusCode, 404);
        assert.equal((await collect(credential, task.handle)).statusCode, 404);
        assert.equal((await cancel(credential, task.handle)).statusCode, 404);
        assert.equal((await retry(credential, failing.handle)).statusCode, 404);

        const byId = await app.inject({
          method: 'GET',
          url: `/api/v1/tasks/id/${task.id}`,
          headers: bearer(credential),
        });
        assert.equal(byId.statusCode, 404, 'a task id must not be a window into another user');
      }

      // Nothing the stranger tried changed anything.
      assert.equal((await getTask(owner.token, task.handle)).json().status, 'running');
      assert.equal((await getTask(owner.token, failing.handle)).json().status, 'failed');

      // Handle numbers are per user: the stranger's first scrape is also scrape-1.
      const theirs = await submitOk(stranger.token, 'scrape', { duration_ms: 30_000 });
      assert.equal(theirs.handle, 'scrape-1');
      assert.notEqual(theirs.id, task.id);
    });
  });
});
