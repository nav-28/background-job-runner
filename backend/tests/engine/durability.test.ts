import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { getDb } from '#src/db.ts';
import { createGate, engineHarness, settleFor, waitFor } from '#tests/engine/gate-worker.ts';
import { closeDb, DEV_USER_ID, ensureDevUser, truncateAll } from '#tests/helpers.ts';

/**
 * Engine state survives a process restart.
 *
 * `stop({ drain: false })` abandons in-flight work without transitioning anything, which leaves
 * the database in exactly the state a `SIGKILL` leaves it in: rows frozen in `running`, owned by a
 * runner id that no longer exists, with a lease nobody is renewing. A fresh engine then recovers
 * them through the same two paths a real crash would exercise — the boot sweep and the lease
 * reaper. What is NOT covered here is literally killing the OS process; that check belongs at the
 * API level once there is a server to kill, and it exercises this same reclaim code.
 *
 * Requires Postgres: `docker compose up -d postgres && pnpm db:migrate`.
 */
describe('engine — durability across restarts', () => {
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

  it('recovers work abandoned by a dead runner and finishes all of it', async () => {
    const engineA = await harness.start({
      workers: gate.descriptors('scrape'),
      concurrency: 2,
      pollIntervalMs: 20,
      runnerId: randomUUID(),
    });

    for (let i = 0; i < 5; i++) {
      await engineA.submit(DEV_USER_ID, 'scrape');
    }
    await waitFor(() => gate.active() === 2, 'two jobs to be in flight');
    const orphaned = [...gate.started];

    // Hard kill: no draining, no cleanup writes.
    await engineA.stop({ drain: false });
    const stranded = await engineA.list(DEV_USER_ID, { status: 'running' });
    assert.equal(
      stranded.length,
      2,
      'two rows are stranded in running, as a crash would leave them',
    );

    // A brand new process, with a different runner id, against the same database.
    // Zero slots on purpose: `start()` performs the boot sweep and then the claim loop would
    // immediately re-claim what it just requeued, so a runner that cannot claim is the only way to
    // observe the post-sweep state without racing it.
    const engineB = await harness.start({
      workers: gate.descriptors('scrape'),
      concurrency: 0,
      pollIntervalMs: 20,
      runnerId: randomUUID(),
    });

    for (const handle of orphaned) {
      const task = await engineB.get(DEV_USER_ID, handle);
      assert.equal(task.status, 'queued', `${handle} was put back on the queue`);
      assert.equal(task.runnerId, null, `${handle} no longer belongs to the dead runner`);
      assert.equal(task.leaseUntil, null);

      const requeues = (await engineB.history(DEV_USER_ID, handle)).filter(
        (event) => event.type === 'requeued_on_restart',
      );
      assert.equal(requeues.length, 1, `${handle} has exactly one requeued_on_restart event`);
    }

    const afterSweep = await engineB.stats(DEV_USER_ID);
    assert.deepEqual(
      afterSweep,
      { queued: 5, running: 0, ready: 0, failed: 0, cancelled: 0 },
      'nothing was lost and nothing was duplicated',
    );
    await engineB.stop();

    // A third process picks the work up and carries it to completion.
    gate.auto();
    const engineC = await harness.start({
      workers: gate.descriptors('scrape'),
      concurrency: 3,
      pollIntervalMs: 20,
      runnerId: randomUUID(),
    });

    await waitFor(async () => (await engineC.stats(DEV_USER_ID)).ready === 5, 'all five to finish');
    await settleFor(150);

    const done = await engineC.stats(DEV_USER_ID);
    assert.deepEqual(done, { queued: 0, running: 0, ready: 5, failed: 0, cancelled: 0 });

    const all = await engineC.list(DEV_USER_ID);
    assert.deepEqual(all.map((task) => task.handle).sort(), [
      'scrape-1',
      'scrape-2',
      'scrape-3',
      'scrape-4',
      'scrape-5',
    ]);

    for (const task of all) {
      const types = (await engineC.history(DEV_USER_ID, task.handle)).map((event) => event.type);
      assert.equal(types.filter((t) => t === 'ready').length, 1, `${task.handle} succeeded once`);
      // The two orphans ran twice in total; the other three ran once. Either way `attempts`
      // matches the number of `started` events exactly — the counter never drifts.
      assert.equal(types.filter((t) => t === 'started').length, task.attempts);
    }

    const reran = all.filter((task) => orphaned.includes(task.handle));
    assert.equal(reran.length, 2);
    for (const task of reran) {
      assert.equal(task.attempts, 2, 'a recovered task is on its second attempt, not its first');
    }
  });

  it('leaves other runners’ work alone when the boot sweep is switched off', async () => {
    // `bootSweep: false` is what a multi-runner deployment sets. The sweep requeues every
    // `running` row this process does not own, which is right when there is only ever one runner
    // and catastrophic when there are two: a booting process would yank the live, still
    // heartbeated work of its peer. With the flag off, only lease expiry may reclaim a row.
    const id = randomUUID();
    const otherRunner = randomUUID();
    await getDb()`
      INSERT INTO tasks (id, "userId", lane, "handleNum", params, status, "runnerId", "leaseUntil")
      VALUES (${id}, ${DEV_USER_ID}, 'scrape', 1, '{}'::jsonb, 'running', ${otherRunner},
              now() + interval '1 hour')`;

    // Zero slots and a live lease: nothing else in the engine can touch this row, so if it moves
    // it moved because of the sweep.
    const engine = await harness.start({
      workers: gate.descriptors('scrape'),
      concurrency: 0,
      pollIntervalMs: 20,
      heartbeatMs: 20,
      bootSweep: false,
      runnerId: randomUUID(),
    });
    await settleFor(150);

    const task = await engine.get(DEV_USER_ID, 'scrape-1');
    assert.equal(task.status, 'running', 'the peer’s in-flight row was not requeued');
    assert.equal(task.runnerId, otherRunner, 'and it still belongs to the peer');
    assert.deepEqual(
      (await engine.history(DEV_USER_ID, 'scrape-1')).map((event) => event.type),
      [],
      'no requeued_on_restart event was written',
    );
  });

  it('reclaims a row whose lease lapsed, recording why', async () => {
    const runnerId = randomUUID();
    const engine = harness.create({
      workers: gate.descriptors('scrape'),
      pollIntervalMs: 40,
      // The reaper runs on the heartbeat cadence, so a short heartbeat makes this quick.
      heartbeatMs: 40,
      leaseMs: 100,
      runnerId,
    });

    // A running row whose lease already expired, stamped with THIS runner's id. The boot sweep
    // deliberately skips rows it owns, so the only thing that can rescue this one is the reaper —
    // which is exactly the path under test.
    const id = randomUUID();
    await getDb()`
      INSERT INTO tasks (id, "userId", lane, "handleNum", params, status, "runnerId", "leaseUntil")
      VALUES (${id}, ${DEV_USER_ID}, 'scrape', 1, '{}'::jsonb, 'running', ${runnerId},
              now() - interval '1 second')`;

    gate.auto();
    await engine.start();

    await waitFor(
      async () =>
        (await engine.history(DEV_USER_ID, 'scrape-1')).some((e) => e.type === 'lease_expired'),
      'a lease_expired event',
    );

    // Having been requeued, it is then claimed and run like any other queued task.
    await waitFor(
      async () => (await engine.get(DEV_USER_ID, 'scrape-1')).status === 'ready',
      'the reclaimed task to complete',
    );

    const types = (await engine.history(DEV_USER_ID, 'scrape-1')).map((event) => event.type);
    assert.deepEqual(types, ['lease_expired', 'started', 'ready']);

    const task = await engine.get(DEV_USER_ID, 'scrape-1');
    assert.equal(task.attempts, 1);
    assert.equal(task.leaseUntil, null);
  });

  it('does not reclaim the leases of work it is actively running', async () => {
    // The other side of the reaper: a healthy in-flight job must be heartbeated, not stolen.
    // Eight heartbeats fit inside one lease, so this is not a stopwatch race — but the test still
    // outlives three whole lease periods, which is impossible unless the lease is being renewed.
    const engine = await harness.start({
      workers: gate.descriptors('scrape'),
      concurrency: 1,
      pollIntervalMs: 20,
      heartbeatMs: 25,
      leaseMs: 200,
      runnerId: randomUUID(),
    });

    await engine.submit(DEV_USER_ID, 'scrape');
    await waitFor(() => gate.started.includes('scrape-1'), 'scrape-1 to start');

    await settleFor(600);

    assert.equal((await engine.get(DEV_USER_ID, 'scrape-1')).status, 'running');
    assert.equal(gate.started.length, 1, 'the job was never started a second time');
    const types = (await engine.history(DEV_USER_ID, 'scrape-1')).map((event) => event.type);
    assert.deepEqual(types, ['accepted', 'started']);
  });
});
