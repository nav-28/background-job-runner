import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { EngineEvent } from '#src/engine/types.ts';
import { ConflictError } from '#src/lib/errors.ts';
import { createGate, engineHarness, settleFor, waitFor } from '#tests/engine/gate-worker.ts';
import { closeDb, DEV_USER_ID, ensureDevUser, truncateAll } from '#tests/helpers.ts';

/**
 * Cancellation, in all four states it can find a task in.
 *
 * The interesting one is `running`: it is not enough to write `cancelled` to a row, the worker has
 * to actually stop — otherwise a cancelled 15-minute job still occupies a slot for 15 minutes.
 * That is what `gate.aborted` proves.
 *
 * Requires Postgres: `docker compose up -d postgres && pnpm db:migrate`.
 */
describe('engine — cancellation', () => {
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

  it('stops a running job and never reports it ready', async () => {
    const engine = await harness.start({ workers: gate.descriptors('scrape'), pollIntervalMs: 20 });

    const seen: EngineEvent[] = [];
    engine.subscribe(DEV_USER_ID, (event) => seen.push(event));

    await engine.submit(DEV_USER_ID, 'scrape');
    await waitFor(() => gate.started.includes('scrape-1'), 'scrape-1 to start');

    const cancelled = await engine.cancel(DEV_USER_ID, 'scrape-1');
    assert.equal(cancelled.status, 'cancelled');

    // The abort actually reached the worker.
    await waitFor(() => gate.aborted.includes('scrape-1'), 'the worker to observe the abort');
    assert.ok(!gate.finished.includes('scrape-1'), 'the worker never completed normally');

    // And nothing overwrote the terminal state afterwards.
    await settleFor(200);
    assert.equal((await engine.get(DEV_USER_ID, 'scrape-1')).status, 'cancelled');
    assert.equal(engine.config.concurrency, 4);

    const forHandle = seen.filter((e) => e.handle === 'scrape-1');
    assert.ok(!forHandle.some((e) => e.type === 'ready'), 'no ready event was ever published');
    assert.ok(!forHandle.some((e) => e.type === 'failed'), 'and it was not recorded as a failure');

    const event = forHandle.find((e) => e.type === 'cancelled');
    assert.ok(event);
    assert.deepEqual(Object.keys(event).sort(), [
      'handle',
      'id',
      'lane',
      'task_id',
      'type',
      'user_id',
    ]);
    assert.equal(event.lane, 'scrape');

    const types = (await engine.history(DEV_USER_ID, 'scrape-1')).map((e) => e.type);
    assert.deepEqual(types, ['accepted', 'started', 'cancelled']);
  });

  it('cancels a queued job before its worker ever starts', async () => {
    // One slot, two jobs: the second is provably still in the queue when it is cancelled.
    const engine = await harness.start({
      workers: gate.descriptors('scrape'),
      concurrency: 1,
      pollIntervalMs: 20,
    });

    await engine.submit(DEV_USER_ID, 'scrape'); // scrape-1 takes the only slot
    await engine.submit(DEV_USER_ID, 'scrape'); // scrape-2 waits behind it
    await waitFor(() => gate.started.includes('scrape-1'), 'scrape-1 to occupy the slot');
    assert.equal((await engine.get(DEV_USER_ID, 'scrape-2')).status, 'queued');

    const cancelled = await engine.cancel(DEV_USER_ID, 'scrape-2');
    assert.equal(cancelled.status, 'cancelled');

    // Free the slot; the claim loop must skip the cancelled row rather than pick it up.
    await gate.release('scrape-1');
    await settleFor(200);

    assert.ok(!gate.started.includes('scrape-2'), 'the cancelled job never ran');
    assert.equal((await engine.get(DEV_USER_ID, 'scrape-2')).status, 'cancelled');
    assert.deepEqual(
      (await engine.history(DEV_USER_ID, 'scrape-2')).map((e) => e.type),
      ['accepted', 'cancelled'],
    );
  });

  it('refuses to cancel a task that finished in the gap, and leaves it intact', async () => {
    const engine = await harness.start({ workers: gate.descriptors('scrape'), pollIntervalMs: 20 });

    await engine.submit(DEV_USER_ID, 'scrape');
    await waitFor(() => gate.started.includes('scrape-1'), 'scrape-1 to start');
    await gate.release('scrape-1', { status: 'ready', result: { rows: 7 } });
    await waitFor(
      async () => (await engine.get(DEV_USER_ID, 'scrape-1')).status === 'ready',
      'scrape-1 to be ready',
    );

    await assert.rejects(() => engine.cancel(DEV_USER_ID, 'scrape-1'), ConflictError);

    // No half-applied state: the task is exactly as it was, with no cancelled event.
    const task = await engine.get(DEV_USER_ID, 'scrape-1');
    assert.equal(task.status, 'ready');
    assert.deepEqual(task.result, { rows: 7 });
    const types = (await engine.history(DEV_USER_ID, 'scrape-1')).map((e) => e.type);
    assert.deepEqual(types, ['accepted', 'started', 'ready']);
  });

  it('dismisses a failed task, releasing its handle number', async () => {
    // The addition beyond the spec: without failed → cancelled, a failed task holds its number
    // forever, because the spec only recycles on collect or cancel.
    const engine = await harness.start({
      workers: gate.descriptors('scrape'),
      pollIntervalMs: 20,
      maxAttempts: 1,
    });

    await engine.submit(DEV_USER_ID, 'scrape');
    await waitFor(() => gate.started.includes('scrape-1'), 'scrape-1 to start');
    await gate.release('scrape-1', {
      status: 'failed',
      error: { reason: 'boom', retryable: false },
    });
    await waitFor(
      async () => (await engine.get(DEV_USER_ID, 'scrape-1')).status === 'failed',
      'scrape-1 to fail',
    );

    // While it is failed it still owns the number.
    assert.equal((await engine.submit(DEV_USER_ID, 'scrape')).handle, 'scrape-2');

    const dismissed = await engine.cancel(DEV_USER_ID, 'scrape-1');
    assert.equal(dismissed.status, 'cancelled');

    // Now the number is free again, and the gap-filling allocator hands it straight back.
    assert.equal((await engine.submit(DEV_USER_ID, 'scrape')).handle, 'scrape-1');
  });
});
