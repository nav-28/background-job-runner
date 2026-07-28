import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { EngineEvent } from '#src/engine/types.ts';
import { mockWorkers } from '#src/workers/mock-worker.ts';
import { createGate, engineHarness, settleFor, waitFor } from '#tests/engine/gate-worker.ts';
import { closeDb, DEV_USER_ID, ensureDevUser, truncateAll } from '#tests/helpers.ts';

/**
 * The pool honours its concurrency limit, and nothing gets stuck or run twice.
 *
 * The limit is asserted from inside the worker — the gate counts how many of its invocations
 * overlap and keeps the high-water mark — rather than by sampling `stats()` from outside. A
 * sampler can only prove "I never happened to see three"; the counter proves three never existed.
 *
 * Requires Postgres: `docker compose up -d postgres && pnpm db:migrate`.
 */
describe('engine — concurrency', () => {
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

  it('never runs more than `concurrency` jobs at once, and starts the rest as slots free', async () => {
    const engine = await harness.start({
      workers: gate.descriptors('scrape'),
      concurrency: 2,
      pollIntervalMs: 20,
    });

    for (let i = 0; i < 5; i++) {
      await engine.submit(DEV_USER_ID, 'scrape');
    }

    await waitFor(() => gate.active() === 2, 'two jobs to be running');
    // Ten poll cycles' worth of opportunity to over-claim.
    await settleFor(200);

    assert.equal(gate.peak(), 2, 'the pool never exceeded its concurrency');
    assert.equal(gate.started.length, 2, 'only two jobs have started at all');

    const busy = await engine.stats(DEV_USER_ID);
    assert.equal(busy.running, 2);
    assert.equal(busy.queued, 3, 'the other three are waiting, not lost');

    // Free exactly one slot and watch exactly one more job start.
    const firstStarted = gate.started[0];
    await gate.release(firstStarted);
    await waitFor(() => gate.started.length === 3, 'a third job to start once a slot frees');
    await settleFor(100);
    assert.equal(gate.started.length, 3, 'freeing one slot started one job, not two');
    assert.equal(gate.peak(), 2);

    // Let the rest through and confirm the queue drains completely.
    gate.auto();
    await waitFor(async () => (await engine.stats(DEV_USER_ID)).ready === 5, 'all five to finish');

    const done = await engine.stats(DEV_USER_ID);
    assert.deepEqual(done, { queued: 0, running: 0, ready: 5, failed: 0, cancelled: 0 });
    assert.equal(gate.peak(), 2, 'the limit held for the whole run, not just at the start');
  });

  it('runs three short jobs to completion with exactly one ready event each', async () => {
    // Real mock workers here, not the gate: this is the "does it work end to end on wall-clock
    // time" case, and 50ms of simulated work is long enough to overlap.
    const engine = await harness.start({
      workers: mockWorkers,
      pollIntervalMs: 20,
      concurrency: 3,
    });

    const readyEvents: EngineEvent[] = [];
    engine.subscribe(DEV_USER_ID, (event) => {
      if (event.type === 'ready') {
        readyEvents.push(event);
      }
    });

    const handles = [];
    for (let i = 0; i < 3; i++) {
      handles.push((await engine.submit(DEV_USER_ID, 'scrape', { duration_ms: 50 })).handle);
    }

    await waitFor(async () => (await engine.stats(DEV_USER_ID)).ready === 3, 'all three ready');
    // Nothing should arrive after this point; give a straggler a chance to prove otherwise.
    await settleFor(200);

    assert.deepEqual(handles, ['scrape-1', 'scrape-2', 'scrape-3']);
    assert.equal(readyEvents.length, 3, 'exactly three ready events, no duplicates');
    assert.deepEqual(readyEvents.map((e) => e.handle).sort(), handles);

    const stats = await engine.stats(DEV_USER_ID);
    assert.deepEqual(stats, { queued: 0, running: 0, ready: 3, failed: 0, cancelled: 0 });

    // And the durable log agrees: one execution, one ready, per task.
    for (const handle of handles) {
      const types = (await engine.history(DEV_USER_ID, handle)).map((e) => e.type);
      assert.deepEqual(types, ['accepted', 'started', 'ready']);
    }
  });
});
