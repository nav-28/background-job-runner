import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { EngineEvent } from '#src/engine/types.ts';
import { BadRequestError, ConflictError, NotFoundError } from '#src/lib/errors.ts';
import { mockWorkers } from '#src/workers/mock-worker.ts';
import {
  createGate,
  engineHarness,
  ensureUser,
  SECOND_USER_ID,
  waitFor,
} from '#tests/engine/gate-worker.ts';
import { closeDb, DEV_USER_ID, ensureDevUser, truncateAll } from '#tests/helpers.ts';

/**
 * The task lifecycle: accepted → started → ready | failed, the retry schedule in between, and the
 * events each transition emits.
 *
 * Requires Postgres: `docker compose up -d postgres && pnpm db:migrate`.
 */
describe('engine — task lifecycle', () => {
  const harness = engineHarness();
  let gate = createGate();

  const statusOf = async (
    engine: { get: (u: string, h: string) => Promise<{ status: string }> },
    handle: string,
  ) => (await engine.get(DEV_USER_ID, handle)).status;

  before(truncateAll);
  beforeEach(async () => {
    await truncateAll();
    await ensureDevUser();
    gate = createGate();
  });
  afterEach(() => harness.stopAll());
  after(closeDb);

  it('accepts a long job and returns immediately', async () => {
    // The mock worker, asked to work for ten seconds. `submit` must not wait for it —
    // this is the whole point of a job runner.
    const engine = await harness.start({
      workers: mockWorkers,
      pollIntervalMs: 20,
      concurrency: 1,
    });

    const before = Date.now();
    const task = await engine.submit(DEV_USER_ID, 'scrape', { duration_ms: 10_000 });
    const elapsed = Date.now() - before;

    assert.equal(task.status, 'queued');
    assert.equal(task.handle, 'scrape-1');
    assert.ok(elapsed < 1000, `submit returned in ${elapsed}ms, expected well under 1000ms`);
  });

  it('moves queued → running → ready and hands back the result', async () => {
    const engine = await harness.start({ workers: gate.descriptors('scrape'), pollIntervalMs: 20 });

    const submitted = await engine.submit(DEV_USER_ID, 'scrape');
    assert.equal(submitted.status, 'queued');

    await waitFor(async () => (await statusOf(engine, 'scrape-1')) === 'running', 'running');
    await gate.release('scrape-1', { status: 'ready', result: { rows: 42 } });
    await waitFor(async () => (await statusOf(engine, 'scrape-1')) === 'ready', 'ready');

    const ready = await engine.get(DEV_USER_ID, 'scrape-1');
    assert.deepEqual(ready.result, { rows: 42 });
    assert.equal(ready.error, null);
    assert.equal(ready.collected, false);
    assert.equal(ready.collectedAt, null);
    assert.equal(ready.attempts, 1);

    const collected = await engine.collect(DEV_USER_ID, 'scrape-1');
    assert.equal(collected.collected, true);
    assert.ok(collected.collectedAt instanceof Date);
    // Collecting is a delivery receipt, not a state change — the task is still `ready`.
    assert.equal(collected.status, 'ready');
  });

  it('records a worker failure with its reason and retryability', async () => {
    const engine = await harness.start({
      workers: mockWorkers,
      pollIntervalMs: 20,
      maxAttempts: 1,
    });

    await engine.submit(DEV_USER_ID, 'scrape', { duration_ms: 20, fail: true });
    await waitFor(async () => (await statusOf(engine, 'scrape-1')) === 'failed', 'failed');

    const failed = await engine.get(DEV_USER_ID, 'scrape-1');
    assert.equal(failed.attempts, 1);
    assert.ok(failed.error);
    assert.match(failed.error.reason, /simulated failure/);
    // The budget ran out, and the reason says so — but `retryable` still describes the error,
    // not our policy, so a human can tell this is worth retrying by hand.
    assert.match(failed.error.reason, /after 1 attempts/);
    assert.equal(failed.error.retryable, true);
  });

  it('retries a retryable failure until the attempt budget runs out', async () => {
    const engine = await harness.start({
      workers: mockWorkers,
      pollIntervalMs: 20,
      maxAttempts: 3,
      backoffBaseMs: 10,
      backoffMaxMs: 40,
    });

    await engine.submit(DEV_USER_ID, 'scrape', { duration_ms: 10, fail: true });
    await waitFor(async () => (await statusOf(engine, 'scrape-1')) === 'failed', 'final failure');

    const failed = await engine.get(DEV_USER_ID, 'scrape-1');
    assert.equal(failed.attempts, 3, 'attempts is a lifetime counter, one per execution');

    const types = (await engine.history(DEV_USER_ID, 'scrape-1')).map((event) => event.type);
    assert.equal(types.filter((t) => t === 'started').length, 3);
    assert.equal(types.filter((t) => t === 'retry_scheduled').length, 2);
    assert.equal(types.filter((t) => t === 'failed').length, 1);
    assert.equal(types.at(-1), 'failed');
  });

  it('publishes accepted then ready in the exact wire shape', async () => {
    const engine = await harness.start({ workers: gate.descriptors('scrape'), pollIntervalMs: 20 });

    const seen: EngineEvent[] = [];
    const unsubscribe = engine.subscribe(DEV_USER_ID, (event) => seen.push(event));

    const task = await engine.submit(DEV_USER_ID, 'scrape');
    await waitFor(() => gate.started.includes('scrape-1'), 'scrape-1 to start');
    await gate.release('scrape-1');
    await waitFor(() => seen.some((e) => e.type === 'ready'), 'a ready event');
    unsubscribe();

    const accepted = seen.find((e) => e.type === 'accepted');
    const ready = seen.find((e) => e.type === 'ready');
    assert.ok(accepted && ready);

    // These four shapes are an external contract. Assert the key set, not just the values, so a
    // stray extra field is a test failure rather than a silent API change.
    const shape = ['handle', 'id', 'lane', 'summary', 'task_id', 'type', 'user_id'];
    assert.deepEqual(Object.keys(accepted).sort(), shape);
    assert.deepEqual(Object.keys(ready).sort(), shape);

    for (const event of [accepted, ready]) {
      assert.equal(event.task_id, task.id);
      assert.equal(event.user_id, DEV_USER_ID);
      assert.equal(event.handle, 'scrape-1');
      assert.equal(event.lane, 'scrape');
      assert.equal(typeof event.id, 'number');
    }
    assert.equal(accepted.type, 'accepted');
    assert.equal(ready.type, 'ready');
    assert.ok(seen.indexOf(accepted) < seen.indexOf(ready), 'accepted arrives before ready');

    // The same events must be reconstructible from the database for a client replaying a cursor.
    const replayed = await engine.eventsSince(DEV_USER_ID, 0);
    assert.deepEqual(
      replayed.find((e) => e.type === 'accepted'),
      accepted,
    );
    assert.deepEqual(
      replayed.find((e) => e.type === 'ready'),
      ready,
    );
  });

  it('returns the transition history in order, with timestamps', async () => {
    const engine = await harness.start({ workers: gate.descriptors('scrape'), pollIntervalMs: 20 });

    await engine.submit(DEV_USER_ID, 'scrape');
    await waitFor(() => gate.started.includes('scrape-1'), 'scrape-1 to start');
    await gate.release('scrape-1');
    await waitFor(async () => (await statusOf(engine, 'scrape-1')) === 'ready', 'ready');
    await engine.collect(DEV_USER_ID, 'scrape-1');

    const history = await engine.history(DEV_USER_ID, 'scrape-1');
    assert.deepEqual(
      history.map((event) => event.type),
      ['accepted', 'started', 'ready', 'collected'],
    );

    let previousId = 0;
    let previousAt = 0;
    for (const event of history) {
      assert.ok(event.at instanceof Date, 'every event carries a timestamp');
      assert.ok(event.id > previousId, 'ordered by a strictly increasing cursor');
      assert.ok(event.at.getTime() >= previousAt, 'timestamps are non-decreasing');
      previousId = event.id;
      previousAt = event.at.getTime();
    }
  });

  it('round-trips non-trivial params and results through jsonb', async () => {
    const engine = await harness.start({ workers: gate.descriptors('scrape'), pollIntervalMs: 20 });

    const params = {
      target: { url: 'https://example.com/a?b=c', headers: { 'x-trace': 'abc-123' } },
      selectors: ['h1', '.price', null],
      retries: { max: 3, factors: [1, 1.5, 2.25] },
      flags: { deep: true, dryRun: false },
      unicode: 'naïve — ✅',
    };
    const result = {
      items: [
        { id: 1, tags: ['a', 'b'] },
        { id: 2, tags: [] },
      ],
      meta: { pages: 3, cursor: null, nested: { deeply: { ok: true } } },
    };

    const submitted = await engine.submit(DEV_USER_ID, 'scrape', params);
    assert.deepEqual(submitted.params, params, 'params survive the write');

    await waitFor(() => gate.started.includes('scrape-1'), 'scrape-1 to start');
    await gate.release('scrape-1', { status: 'ready', result });
    await waitFor(async () => (await statusOf(engine, 'scrape-1')) === 'ready', 'ready');

    const done = await engine.get(DEV_USER_ID, 'scrape-1');
    assert.deepEqual(done.params, params);
    assert.deepEqual(done.result, result);
  });

  it('gives a manually retried task a fresh budget without rewriting its history', async () => {
    const engine = await harness.start({
      workers: gate.descriptors('scrape'),
      pollIntervalMs: 20,
      maxAttempts: 1,
    });

    await engine.submit(DEV_USER_ID, 'scrape');
    await waitFor(() => gate.started.includes('scrape-1'), 'scrape-1 to start');
    await gate.release('scrape-1', {
      status: 'failed',
      error: { reason: 'transient', retryable: true },
    });
    await waitFor(async () => (await statusOf(engine, 'scrape-1')) === 'failed', 'failed');

    const failed = await engine.get(DEV_USER_ID, 'scrape-1');
    assert.equal(failed.attempts, 1);
    assert.equal(failed.maxAttempts, 1);

    const requeued = await engine.retry(DEV_USER_ID, 'scrape-1');
    assert.equal(requeued.status, 'queued');
    assert.equal(requeued.error, null);
    assert.equal(requeued.attempts, 1, 'attempts is a lifetime counter and is not reset');
    assert.equal(requeued.maxAttempts, 2, 'the budget is extended instead of the count rewound');

    await waitFor(
      () => gate.started.filter((handle) => handle === 'scrape-1').length === 2,
      'a second execution',
    );
    await gate.release('scrape-1');
    await waitFor(async () => (await statusOf(engine, 'scrape-1')) === 'ready', 'ready');
    assert.equal((await engine.get(DEV_USER_ID, 'scrape-1')).attempts, 2);

    // Only a failed task can be retried; a ready one is a conflict, not a silent no-op.
    await assert.rejects(() => engine.retry(DEV_USER_ID, 'scrape-1'), ConflictError);
  });

  it('scopes every read to its user, and filters and sorts the list', async () => {
    await ensureUser(SECOND_USER_ID, 'second@example.com');
    const engine = harness.create({ workers: gate.descriptors('scrape', 'report') });

    const scrape = await engine.submit(DEV_USER_ID, 'scrape');
    const report = await engine.submit(DEV_USER_ID, 'report');
    const theirs = await engine.submit(SECOND_USER_ID, 'scrape');

    assert.deepEqual(
      (await engine.list(DEV_USER_ID, { lane: 'scrape' })).map((task) => task.handle),
      ['scrape-1'],
    );
    assert.equal((await engine.list(DEV_USER_ID, { status: 'queued' })).length, 2);
    assert.equal((await engine.list(DEV_USER_ID, { status: 'ready' })).length, 0);
    assert.equal((await engine.list(DEV_USER_ID, { createdAfter: new Date() })).length, 0);

    const ascending = (await engine.list(DEV_USER_ID, { sort: 'asc' })).map((task) => task.id);
    const descending = (await engine.list(DEV_USER_ID, { sort: 'desc' })).map((task) => task.id);
    assert.deepEqual(ascending, [scrape.id, report.id]);
    assert.deepEqual(descending, [...ascending].reverse());

    assert.equal((await engine.getById(DEV_USER_ID, scrape.id)).handle, 'scrape-1');
    // Another user's task id is a 404 here, not a window into their data.
    await assert.rejects(() => engine.getById(DEV_USER_ID, theirs.id), NotFoundError);
    await assert.rejects(() => engine.get(DEV_USER_ID, 'report-9'), NotFoundError);
    await assert.rejects(() => engine.get(DEV_USER_ID, 'nonsense'), BadRequestError);
  });

  it('describes its lanes and validates the parameters they declare', async () => {
    // The mock workers, registered by the caller — the engine itself knows no lanes.
    const engine = harness.create({ workers: mockWorkers });

    const lanes = engine.lanes();
    assert.deepEqual(lanes.map((lane) => lane.lane).sort(), ['report', 'scrape']);
    assert.ok(lanes.every((lane) => lane.kind === 'inline'));
    assert.ok(!('handler' in lanes[0]), 'the handler is not part of the public description');
    assert.equal(lanes[0].params.find((p) => p.name === 'duration_ms')?.max, 300_000);

    await assert.rejects(() => engine.submit(DEV_USER_ID, 'nope'), BadRequestError);
    await assert.rejects(
      () => engine.submit(DEV_USER_ID, 'scrape', { duration_ms: 300_001 }),
      BadRequestError,
    );
    await assert.rejects(
      () => engine.submit(DEV_USER_ID, 'scrape', { fail: 'maybe' }),
      BadRequestError,
    );

    // Numeric strings are coerced rather than rejected, and declared defaults are applied.
    const task = await engine.submit(DEV_USER_ID, 'scrape', { duration_ms: '250' });
    assert.equal(task.params.duration_ms, 250);
    assert.equal(task.params.fail, false);
  });

  it('keeps working when its methods are pulled off the instance', async () => {
    // The engine is a class, so `this` is now something that can be lost. Every public method is
    // an arrow-function property precisely so it cannot be: a caller may destructure the engine,
    // or hand `engine.submit` straight to a route handler, without binding anything. This test is
    // here so that turning any one of them back into an ordinary method fails the suite instead of
    // failing in production.
    const engine = harness.create({ workers: gate.descriptors('scrape') });
    const { submit, get, list, lanes, subscribe, cancel, start, stop } = engine;

    const seen: EngineEvent[] = [];
    const unsubscribe = subscribe(DEV_USER_ID, (event) => seen.push(event));

    const task = await submit(DEV_USER_ID, 'scrape');
    assert.equal(task.handle, 'scrape-1');
    assert.equal((await get(DEV_USER_ID, 'scrape-1')).id, task.id);
    assert.equal((await list(DEV_USER_ID)).length, 1);
    assert.deepEqual(
      lanes().map((lane) => lane.lane),
      ['scrape'],
    );
    assert.equal(seen.filter((e) => e.type === 'accepted').length, 1);

    // The closure `subscribe` returned is detached too, and must still cancel the subscription.
    unsubscribe();
    assert.equal((await cancel(DEV_USER_ID, 'scrape-1')).status, 'cancelled');
    assert.equal(seen.filter((e) => e.type === 'cancelled').length, 0, 'unsubscribe took effect');

    // `start`/`stop` reach the runner's own arrow properties, including the interval callbacks.
    await start();
    await stop();
  });

  it('replays events from a cursor, in order, scoped to one user', async () => {
    await ensureUser(SECOND_USER_ID, 'second@example.com');
    // No `start()`: three queued submits produce exactly three `accepted` events and nothing
    // else, so the cursor arithmetic below is not racing a claim loop.
    const engine = harness.create({ workers: gate.descriptors('scrape') });

    for (let i = 0; i < 3; i++) {
      await engine.submit(DEV_USER_ID, 'scrape');
    }
    await engine.submit(SECOND_USER_ID, 'scrape');

    const all = await engine.eventsSince(DEV_USER_ID, 0);
    assert.equal(all.length, 3, 'another user’s events are not in this user’s replay');
    assert.deepEqual(
      all.map((e) => e.id),
      [...all.map((e) => e.id)].sort((a, b) => a - b),
      'ascending by id — a client replays forwards',
    );

    // The cursor is exclusive: a client that has already seen `all[0]` must not receive it twice.
    const afterFirst = await engine.eventsSince(DEV_USER_ID, all[0].id);
    assert.deepEqual(
      afterFirst.map((e) => e.id),
      all.slice(1).map((e) => e.id),
    );

    // A cursor past the end is the steady state of a live client: nothing missed, nothing sent.
    assert.deepEqual(await engine.eventsSince(DEV_USER_ID, all[2].id), []);

    // The limit takes the oldest first, so paging forward cannot skip an event.
    const page = await engine.eventsSince(DEV_USER_ID, 0, 2);
    assert.deepEqual(
      page.map((e) => e.id),
      all.slice(0, 2).map((e) => e.id),
    );
  });
});
