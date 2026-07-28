import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { getDb } from '#src/db.ts';
import type { EngineEvent, EngineLogFn, EngineLogger } from '#src/engine/types.ts';
import { createGate, engineHarness, settleFor, waitFor } from '#tests/engine/gate-worker.ts';
import { closeDb, DEV_USER_ID, ensureDevUser, truncateAll } from '#tests/helpers.ts';

/**
 * The engine's logger: failures the engine cannot hand back to a caller must land somewhere.
 *
 * Everything in here happens on a background timer or inside a fan-out, so there is nobody to
 * throw at. Before the logger these were three `catch(noop)`s and one bare `catch {}` — Postgres
 * could blip, the claim loop could stop turning, and the only symptom anywhere would have been a
 * queue that quietly stopped draining.
 *
 * Requires Postgres: `docker compose up -d postgres && pnpm db:migrate`.
 */

/**
 * The compatibility requirement, checked by `tsc` rather than at runtime.
 *
 * `src/engine/` must never import Fastify — the plugin that will construct the engine has to be
 * able to pass `app.log` straight into `EngineConfig.logger` with no adapter and no cast, and that
 * is only true if `EngineLogger` is structurally satisfied by a pino logger. Asserting it here
 * keeps the dependency pointing the right way: the test knows about Fastify, the engine does not.
 *
 * `Satisfies` fails to compile the moment the shapes diverge — for instance if `EngineLogFn` lost
 * pino's `(obj, msg?)` overload and kept only `(msg, ...args)`.
 */
type Satisfies<Sub extends Super, Super> = Sub;
export type PinoSatisfiesEngineLogger = Satisfies<FastifyBaseLogger, EngineLogger>;
export type AppLogSatisfiesEngineLogger = Satisfies<FastifyInstance['log'], EngineLogger>;

interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  fields: Record<string, unknown>;
  msg: string;
}

/** Records every line, in pino's own `(obj, msg)` calling convention. */
function createCapturingLogger(): { lines: LogLine[]; logger: EngineLogger } {
  const lines: LogLine[] = [];
  // One implementation covering both of `EngineLogFn`'s overloads, which is the point of the
  // exercise: a real pino logger is written the same way.
  const at =
    (level: LogLine['level']): EngineLogFn =>
    (first: unknown, ...rest: unknown[]) => {
      const objectFirst = typeof first === 'object' && first !== null;
      lines.push({
        level,
        fields: objectFirst ? (first as Record<string, unknown>) : {},
        msg: objectFirst ? String(rest[0] ?? '') : String(first),
      });
    };
  return {
    lines,
    logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
  };
}

describe('engine — logging', () => {
  const harness = engineHarness();
  let gate = createGate();
  let captured = createCapturingLogger();

  before(truncateAll);
  beforeEach(async () => {
    await truncateAll();
    await ensureDevUser();
    gate = createGate();
    captured = createCapturingLogger();
  });
  afterEach(() => harness.stopAll());
  after(closeDb);

  const linesAt = (level: LogLine['level']): LogLine[] =>
    captured.lines.filter((line) => line.level === level);

  it('reports a subscriber that throws, and still delivers to the others', async () => {
    const engine = await harness.start({
      workers: gate.descriptors('scrape'),
      pollIntervalMs: 20,
      logger: captured.logger,
    });

    // Registered FIRST, so a throw that was not contained would stop the second one ever running.
    engine.subscribe(DEV_USER_ID, () => {
      throw new Error('subscriber blew up');
    });
    const received: EngineEvent[] = [];
    engine.subscribe(DEV_USER_ID, (event) => received.push(event));

    // `submit` publishes `accepted` synchronously once its transaction has committed, so both
    // subscribers have already been called by the time it returns.
    await engine.submit(DEV_USER_ID, 'scrape');

    assert.ok(
      received.some((event) => event.type === 'accepted'),
      'the healthy subscriber was not starved by its neighbour throwing',
    );

    const errors = linesAt('error');
    assert.equal(errors.length, 1, 'the throw was reported exactly once');
    assert.match(errors[0].msg, /subscriber threw/);
    assert.equal((errors[0].fields.err as Error).message, 'subscriber blew up');
    assert.equal(errors[0].fields.userId, DEV_USER_ID);
    assert.equal(errors[0].fields.eventType, 'accepted');

    // And the transition the subscriber was notified of still ran to completion underneath it.
    gate.auto();
    await waitFor(
      async () => (await engine.get(DEV_USER_ID, 'scrape-1')).status === 'ready',
      'the task to finish despite the broken subscriber',
    );
  });

  it('logs at info when the boot sweep requeues abandoned work', async () => {
    // A `running` row owned by a runner id that no longer exists: what a crash leaves behind, and
    // the same shape the durability suite builds by hard-killing an engine. Constructed directly
    // here so the assertion is about the log line and nothing else.
    await getDb()`
      INSERT INTO tasks (id, "userId", lane, "handleNum", params, status, "runnerId", "leaseUntil")
      VALUES (${randomUUID()}, ${DEV_USER_ID}, 'scrape', 1, '{}'::jsonb, 'running',
              ${randomUUID()}, now() + interval '1 hour')`;

    // Zero slots: `start()` sweeps and then the claim loop would immediately re-claim what it just
    // requeued, which would add a `started` event and muddy the counts.
    const engine = await harness.start({
      workers: gate.descriptors('scrape'),
      concurrency: 0,
      pollIntervalMs: 20,
      logger: captured.logger,
    });

    // `start()` awaits the sweep, so the line is already there — nothing to wait for.
    const infos = linesAt('info');
    assert.equal(infos.length, 1, 'one line, summarising the sweep');
    assert.match(infos[0].msg, /boot sweep/);
    assert.equal(infos[0].fields.count, 1, 'and it says how much it requeued');
    assert.equal(infos[0].fields.runnerId, engine.config.runnerId);
    assert.equal((await engine.get(DEV_USER_ID, 'scrape-1')).status, 'queued');
  });

  it('warns when the reaper reclaims a lapsed lease', async () => {
    const runnerId = randomUUID();
    const engine = harness.create({
      workers: gate.descriptors('scrape'),
      // Zero slots so the reclaimed row is not immediately re-run; the reaper still runs on the
      // heartbeat cadence, which is the only thing that can rescue a row this runner owns.
      concurrency: 0,
      pollIntervalMs: 40,
      heartbeatMs: 40,
      leaseMs: 100,
      runnerId,
      logger: captured.logger,
    });

    await getDb()`
      INSERT INTO tasks (id, "userId", lane, "handleNum", params, status, "runnerId", "leaseUntil")
      VALUES (${randomUUID()}, ${DEV_USER_ID}, 'scrape', 1, '{}'::jsonb, 'running', ${runnerId},
              now() - interval '1 second')`;

    await engine.start();
    await waitFor(() => linesAt('warn').length > 0, 'a warning about the reclaimed lease');

    const [warning] = linesAt('warn');
    assert.match(warning.msg, /lease had expired/);
    assert.equal(warning.fields.count, 1);
    assert.deepEqual(warning.fields.handles, ['scrape-1']);
    assert.equal(linesAt('error').length, 0, 'a recovered lease is not an error');
  });

  it('says nothing above debug while it is healthy', async () => {
    // A logger that chatters once per tick is a logger nobody reads. This engine polls and
    // heartbeats every 10ms for a fifth of a second — roughly sixty background passes — around a
    // job that succeeds, and all of it must be silent.
    const engine = await harness.start({
      workers: gate.descriptors('scrape'),
      pollIntervalMs: 10,
      heartbeatMs: 10,
      logger: captured.logger,
    });

    gate.auto();
    await engine.submit(DEV_USER_ID, 'scrape');
    await waitFor(
      async () => (await engine.get(DEV_USER_ID, 'scrape-1')).status === 'ready',
      'the job to finish',
    );
    await settleFor(200);

    assert.deepEqual(
      captured.lines.filter((line) => line.level !== 'debug'),
      [],
      'a healthy engine logs nothing above debug',
    );
  });
});
