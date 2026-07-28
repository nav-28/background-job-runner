import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { Worker, WorkerDescriptor } from '#src/engine/types.ts';
import { createGate, engineHarness, settleFor, waitFor } from '#tests/engine/gate-worker.ts';
import { closeDb, DEV_USER_ID, ensureDevUser, truncateAll } from '#tests/helpers.ts';

/**
 * The per-job timeout: the liveness backstop that stops one bad worker from costing the pool a
 * slot forever.
 *
 * The scenario the engine could not survive before is the `stuck` worker below — one that never
 * returns and never looks at its `AbortSignal`. Aborting such a worker achieves nothing, and the
 * heartbeat happily renews its lease for as long as it is "in flight", so the reaper never rescues
 * it either. Concurrency drops by one, silently and permanently.
 *
 * Requires Postgres: `docker compose up -d postgres && pnpm db:migrate`.
 */
describe('engine — job timeout', () => {
  const harness = engineHarness();
  let gate = createGate();

  before(truncateAll);
  beforeEach(async () => {
    await truncateAll();
    await ensureDevUser();
    gate = createGate();
  });
  afterEach(() => harness.stopAll());
  after(closeDb);

  /**
   * A worker that hangs forever and ignores cancellation entirely.
   *
   * Deliberately worse behaved than the gate: the gate rejects when its signal fires, so an
   * implementation that merely called `abort()` and waited would still look correct against it.
   * Nothing this worker is told makes it return, so the only thing that can free its slot is the
   * engine giving up on it.
   */
  function stuckWorker() {
    const signals: AbortSignal[] = [];
    const handler: Worker = (_job, ctx) => {
      signals.push(ctx.signal);
      return new Promise(() => {
        // Never settles. That is the entire point.
      });
    };
    return {
      signals,
      descriptors: (lane: string): WorkerDescriptor[] => [
        { lane, kind: 'inline', handler, params: [], description: `Hangs forever (${lane})` },
      ],
    };
  }

  it('fails a job that never returns, and gives its slot back', async () => {
    const stuck = stuckWorker();
    const engine = await harness.start({
      workers: [...stuck.descriptors('stuck'), ...gate.descriptors('scrape')],
      // One slot, so "did the slot come back?" is answerable without sampling anything: the
      // second job simply cannot run until the first stops occupying it.
      concurrency: 1,
      // One attempt: a timeout is retryable, and with the default budget the stuck job would
      // requeue and grab the slot straight back, drowning out what is under test.
      maxAttempts: 1,
      pollIntervalMs: 20,
      jobTimeoutMs: 150,
    });

    await engine.submit(DEV_USER_ID, 'stuck');
    await waitFor(() => stuck.signals.length === 1, 'the stuck worker to start');

    // Queued behind the only slot, which the stuck job is holding.
    await engine.submit(DEV_USER_ID, 'scrape');
    assert.equal((await engine.get(DEV_USER_ID, 'scrape-1')).status, 'queued');

    await waitFor(
      async () => (await engine.get(DEV_USER_ID, 'stuck-1')).status === 'failed',
      'the stuck job to be timed out',
    );

    const failed = await engine.get(DEV_USER_ID, 'stuck-1');
    assert.match(failed.error?.reason ?? '', /timed out after 150ms/);
    assert.equal(failed.error?.retryable, true, 'a timeout is transient in nature');
    assert.equal(failed.runnerId, null, 'the row was released, not left owned by this runner');
    assert.equal(failed.leaseUntil, null);
    assert.equal(stuck.signals[0]?.aborted, true, 'the worker’s own cancellation path was fired');

    // The bug this whole feature exists for: the slot came back.
    gate.auto();
    await waitFor(
      async () => (await engine.get(DEV_USER_ID, 'scrape-1')).status === 'ready',
      'the next job to run in the freed slot',
    );

    const events = await engine.history(DEV_USER_ID, 'stuck-1');
    assert.deepEqual(
      events.map((event) => event.type),
      ['accepted', 'started', 'failed'],
      'a timeout is recorded as a failure — no new event type, and no spurious cancellation',
    );

    // Why it failed is visible in history, not just in the log.
    const failure = events.at(-1);
    assert.equal(failure?.detail.timedOut, true);
    assert.equal(failure?.detail.timeoutMs, 150);
  });

  it('never spuriously fails a job that finishes inside its budget, and leaks no timer', async () => {
    const engine = await harness.start({
      workers: gate.descriptors('scrape'),
      concurrency: 1,
      pollIntervalMs: 20,
      // Far longer than this test can possibly run, so a timer that outlives its job is still
      // pending — and therefore countable — when the assertions run.
      jobTimeoutMs: 60_000,
    });

    /** Runs one job start-to-finish, then reports how many timers the process is holding. */
    const roundTrip = async (handle: string): Promise<number> => {
      await engine.submit(DEV_USER_ID, 'scrape');
      await gate.release(handle, { status: 'ready', result: { rows: 1 } });
      await waitFor(
        async () => (await engine.get(DEV_USER_ID, handle)).status === 'ready',
        `${handle} to be ready`,
      );
      await settleFor(120);
      return process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
    };

    // Two identical rounds. Whatever timers the engine and the driver hold steadily, they hold in
    // both counts — so the comparison isolates exactly the per-job timer. A `clearTimeout` missing
    // from `#runOne`'s `finally` shows up here as one extra pending 60s timer, and nowhere else.
    const afterFirst = await roundTrip('scrape-1');
    const afterSecond = await roundTrip('scrape-2');
    assert.ok(
      afterSecond <= afterFirst,
      `a finished job left a timer behind (${afterFirst} → ${afterSecond})`,
    );

    for (const handle of ['scrape-1', 'scrape-2']) {
      const task = await engine.get(DEV_USER_ID, handle);
      assert.equal(task.status, 'ready', `${handle} completed normally`);
      assert.equal(task.error, null);
      assert.deepEqual(
        (await engine.history(DEV_USER_ID, handle)).map((event) => event.type),
        ['accepted', 'started', 'ready'],
      );
    }
  });

  it('does not turn a cancellation into a timeout failure', async () => {
    // The two paths both abort, and only the timeout owes the task a terminal state. If `#runOne`
    // confused them, this cancelled task would be overwritten with `failed`.
    const engine = await harness.start({
      workers: gate.descriptors('scrape'),
      pollIntervalMs: 20,
      jobTimeoutMs: 60_000,
    });

    await engine.submit(DEV_USER_ID, 'scrape');
    await waitFor(() => gate.started.includes('scrape-1'), 'scrape-1 to start');

    assert.equal((await engine.cancel(DEV_USER_ID, 'scrape-1')).status, 'cancelled');
    await waitFor(() => gate.aborted.includes('scrape-1'), 'the worker to observe the abort');
    await settleFor(200);

    const task = await engine.get(DEV_USER_ID, 'scrape-1');
    assert.equal(task.status, 'cancelled', 'the terminal state survived the worker unwinding');
    assert.equal(task.error, null, 'and no timeout error was recorded against it');
    assert.deepEqual(
      (await engine.history(DEV_USER_ID, 'scrape-1')).map((event) => event.type),
      ['accepted', 'started', 'cancelled'],
    );
  });
});
