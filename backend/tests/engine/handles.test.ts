import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { allocateHandleAndInsert } from '#src/engine/handles.ts';
import {
  createGate,
  engineHarness,
  ensureUser,
  SECOND_USER_ID,
  waitFor,
} from '#tests/engine/gate-worker.ts';
import { closeDb, DEV_USER_ID, ensureDevUser, truncateAll } from '#tests/helpers.ts';

/**
 * Handle allocation. `lane-N`, where N is the lowest number not held by an active task of that
 * user and lane, and where retiring a task hands its number back.
 *
 * Requires Postgres: `docker compose up -d postgres && pnpm db:migrate`.
 */
describe('engine — handle allocation', () => {
  const harness = engineHarness();
  let gate = createGate();

  const lanes = () => gate.descriptors('scrape', 'report');

  before(truncateAll);
  beforeEach(async () => {
    await truncateAll();
    await ensureDevUser();
    gate = createGate();
  });
  afterEach(() => harness.stopAll());
  after(closeDb);

  it('numbers each lane independently', async () => {
    // No `start()` anywhere in this test: allocation happens at submit time and owes nothing to
    // the claim loop, so the tasks sit in `queued` and the assertions cannot race a worker.
    const engine = harness.create({ workers: lanes() });

    const scrape = await engine.submit(DEV_USER_ID, 'scrape');
    const report = await engine.submit(DEV_USER_ID, 'report');

    assert.equal(scrape.handle, 'scrape-1');
    assert.equal(report.handle, 'report-1');
  });

  it('gives the second active task on a lane the next number', async () => {
    const engine = harness.create({ workers: lanes() });

    assert.equal((await engine.submit(DEV_USER_ID, 'scrape')).handle, 'scrape-1');
    assert.equal((await engine.submit(DEV_USER_ID, 'scrape')).handle, 'scrape-2');
  });

  it('recycles a number once its task is collected', async () => {
    const engine = await harness.start({ workers: lanes(), pollIntervalMs: 20 });

    const first = await engine.submit(DEV_USER_ID, 'scrape');
    await waitFor(() => gate.started.includes('scrape-1'), 'scrape-1 to start');
    await gate.release('scrape-1');
    await waitFor(
      async () => (await engine.get(DEV_USER_ID, 'scrape-1')).status === 'ready',
      'scrape-1 to be ready',
    );
    await engine.collect(DEV_USER_ID, 'scrape-1');

    const second = await engine.submit(DEV_USER_ID, 'scrape');
    assert.equal(second.handle, 'scrape-1');
    assert.notEqual(second.id, first.id, 'a recycled handle is a genuinely new task');
  });

  it('allocates 1..20 with no collisions under 20 concurrent submits', async () => {
    const engine = harness.create({ workers: lanes() });

    const tasks = await Promise.all(
      Array.from({ length: 20 }, () => engine.submit(DEV_USER_ID, 'scrape')),
    );

    const numbers = tasks.map((task) => task.handleNum).sort((a, b) => a - b);
    assert.deepEqual(
      numbers,
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    assert.equal(new Set(tasks.map((task) => task.handle)).size, 20);
    assert.equal(new Set(tasks.map((task) => task.id)).size, 20);
  });

  it('recovers through the 23505 retry loop when the lane lock is disabled', async () => {
    // The only white-box test in the suite, and it reaches past `Engine` on purpose.
    //
    // `lockLane` serialises allocation per (userId, lane), so with it in play two transactions in
    // one database can no longer pick the same number — which means the `23505` retry loop in
    // `handles.ts` never runs, despite being the thing that actually guarantees "no two active
    // tasks share a handle". `useLaneLock: false` puts the race back so the recovery path is
    // exercised: every loser re-reads a snapshot containing the winner's committed row and takes
    // the next number.
    //
    // The assertion is on the outcome, not on the number of retries, because "how many times did
    // it collide" is genuinely timing-dependent and asserting on it would be a flake. Measured
    // with a temporary probe in the loop, three racers collide three times and settle by the third
    // attempt — comfortably inside MAX_ALLOCATION_ATTEMPTS, and zero collisions with the lock on.
    const allocate = () =>
      allocateHandleAndInsert(DEV_USER_ID, 'scrape', {}, { maxAttempts: 3, useLaneLock: false });

    const allocations = await Promise.all([allocate(), allocate(), allocate()]);
    const tasks = allocations.map(({ task }) => task);

    assert.deepEqual(
      tasks.map((task) => task.handleNum).sort((a, b) => a - b),
      [1, 2, 3],
      'three racing allocations landed on distinct consecutive numbers',
    );
    assert.equal(new Set(tasks.map((task) => task.id)).size, 3);
    // Each task still got its own `accepted` event, so nothing was half-written on the way.
    assert.equal(new Set(allocations.map(({ event }) => event.id)).size, 3);

    // And the unique index — the real invariant — agrees that only these three are active.
    const engine = harness.create({ workers: lanes() });
    assert.deepEqual((await engine.list(DEV_USER_ID)).map((task) => task.handle).sort(), [
      'scrape-1',
      'scrape-2',
      'scrape-3',
    ]);
  });

  it('keeps a failed task holding its number', async () => {
    // maxAttempts 1 so the first failure is terminal and the test does not wait out a backoff.
    const engine = await harness.start({ workers: lanes(), pollIntervalMs: 20, maxAttempts: 1 });

    await engine.submit(DEV_USER_ID, 'scrape');
    await waitFor(() => gate.started.includes('scrape-1'), 'scrape-1 to start');
    await gate.release('scrape-1', {
      status: 'failed',
      error: { reason: 'nope', retryable: false },
    });
    await waitFor(
      async () => (await engine.get(DEV_USER_ID, 'scrape-1')).status === 'failed',
      'scrape-1 to fail',
    );

    assert.equal((await engine.submit(DEV_USER_ID, 'scrape')).handle, 'scrape-2');
  });

  it('releases a number when its task is cancelled', async () => {
    const engine = harness.create({ workers: lanes() });

    await engine.submit(DEV_USER_ID, 'scrape');
    await engine.cancel(DEV_USER_ID, 'scrape-1');

    assert.equal((await engine.submit(DEV_USER_ID, 'scrape')).handle, 'scrape-1');
  });

  it('fills the gap left in the middle of a range', async () => {
    const engine = harness.create({ workers: lanes() });

    await engine.submit(DEV_USER_ID, 'scrape'); // scrape-1
    await engine.submit(DEV_USER_ID, 'scrape'); // scrape-2
    await engine.cancel(DEV_USER_ID, 'scrape-1');

    // The naive "max + 1" allocator would say 3 here.
    assert.equal((await engine.submit(DEV_USER_ID, 'scrape')).handle, 'scrape-1');
  });

  it('does not let one user see or collide with another user’s handles', async () => {
    await ensureUser(SECOND_USER_ID, 'second@example.com');
    const engine = harness.create({ workers: lanes() });

    const mine = await engine.submit(DEV_USER_ID, 'scrape');
    const theirs = await engine.submit(SECOND_USER_ID, 'scrape');

    assert.equal(mine.handle, 'scrape-1');
    assert.equal(theirs.handle, 'scrape-1');
    assert.notEqual(mine.id, theirs.id);

    // Same handle string, and each user resolves it to their own row.
    assert.equal((await engine.get(DEV_USER_ID, 'scrape-1')).id, mine.id);
    assert.equal((await engine.get(SECOND_USER_ID, 'scrape-1')).id, theirs.id);
    assert.equal((await engine.list(DEV_USER_ID)).length, 1);
  });

  it('resolves a recycled handle to the task that currently holds it', async () => {
    const engine = harness.create({ workers: lanes() });

    // Three different tasks have owned `scrape-1` over time. Only the last still does.
    const first = await engine.submit(DEV_USER_ID, 'scrape');
    await engine.cancel(DEV_USER_ID, 'scrape-1');
    const second = await engine.submit(DEV_USER_ID, 'scrape');
    await engine.cancel(DEV_USER_ID, 'scrape-1');
    const active = await engine.submit(DEV_USER_ID, 'scrape');

    assert.equal(new Set([first.id, second.id, active.id]).size, 3, 'three distinct rows');

    // A number can only be reallocated once no active task holds it, so the newest row for a
    // handle is always the live one — which is what makes `ORDER BY "createdAt" DESC LIMIT 1`
    // the right resolution rule. Ordering the other way would return `first`, cancelled two
    // allocations ago.
    const resolved = await engine.get(DEV_USER_ID, 'scrape-1');
    assert.equal(resolved.id, active.id);
    assert.equal(resolved.status, 'queued');
  });

  it('resolves a fully retired handle to its most recent owner', async () => {
    const engine = harness.create({ workers: lanes() });

    const first = await engine.submit(DEV_USER_ID, 'scrape');
    await engine.cancel(DEV_USER_ID, 'scrape-1');
    const last = await engine.submit(DEV_USER_ID, 'scrape');
    await engine.cancel(DEV_USER_ID, 'scrape-1');

    // Nothing holds the number now, but the handle still has to resolve to something, and the
    // only defensible answer is whoever held it last: a dashboard following a link to `scrape-1`
    // should not land on history from two owners ago.
    const resolved = await engine.get(DEV_USER_ID, 'scrape-1');
    assert.equal(resolved.id, last.id);
    assert.notEqual(resolved.id, first.id);
    assert.equal(resolved.status, 'cancelled');
  });
});
