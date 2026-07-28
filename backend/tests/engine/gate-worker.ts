import { setTimeout as delay } from 'node:timers/promises';
import { getDb } from '#src/db.ts';
import { createEngine, type Engine } from '#src/engine/index.ts';
import type { EngineOptions, Worker, WorkerDescriptor, WorkerResult } from '#src/engine/types.ts';

/**
 * Test scaffolding for the engine.
 *
 * The centrepiece is the **gate worker**: a worker that starts, records that it started, and then
 * blocks until the test explicitly releases it. Every timing question the engine raises — "did the
 * third job wait for a slot?", "did cancelling actually stop the work?" — becomes a question about
 * an event the test itself caused, instead of a race against `setTimeout`. Assertions built on
 * sleeps are the classic source of a suite that passes on a laptop and fails in CI; there are
 * none here.
 */

export const SECOND_USER_ID = '00000000-0000-4000-8000-000000000002';

export async function ensureUser(id: string, email: string): Promise<void> {
  await getDb()`
    INSERT INTO users (id, email, name) VALUES (${id}, ${email}, 'Test User')
    ON CONFLICT (id) DO NOTHING`;
}

const WAIT_TIMEOUT_MS = 10_000;
const WAIT_POLL_MS = 5;

/** Polls `predicate` until it holds, or fails the test with a message naming what never happened. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  what = 'condition',
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await delay(WAIT_POLL_MS);
  }
}

/** Lets the engine turn its claim loop a few times, for "prove it does NOT do X" assertions. */
export const settleFor = (ms: number): Promise<void> => delay(ms);

export interface Gate {
  /** Descriptors registering the gate under each of `lanes`. */
  descriptors(...lanes: string[]): WorkerDescriptor[];
  /** Handles in the order the worker began running them. Includes re-runs after a requeue. */
  readonly started: string[];
  readonly finished: string[];
  readonly aborted: string[];
  /** Jobs executing right now, and the high-water mark since the gate was created. */
  active(): number;
  peak(): number;
  /** Resolves a blocked job. Waits for it to reach the gate first, so it cannot fire too early. */
  release(handle: string, result?: WorkerResult): Promise<void>;
  releaseAll(result?: WorkerResult): void;
  /** From now on, every job that starts completes immediately with `result`. */
  auto(result?: WorkerResult): void;
}

const READY: WorkerResult = { status: 'ready', result: { ok: true } };

export function createGate(): Gate {
  const pending = new Map<string, (result: WorkerResult) => void>();
  const started: string[] = [];
  const finished: string[] = [];
  const aborted: string[] = [];
  let active = 0;
  let peak = 0;
  let autoResult: WorkerResult | null = null;

  const block = (handle: string, signal: AbortSignal): Promise<WorkerResult> =>
    new Promise<WorkerResult>((resolve, reject) => {
      const onAbort = () => {
        pending.delete(handle);
        aborted.push(handle);
        reject(new Error('aborted'));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      pending.set(handle, resolve);
      signal.addEventListener('abort', onAbort, { once: true });
    });

  const handler: Worker = async (job, ctx) => {
    started.push(job.handle);
    active += 1;
    peak = Math.max(peak, active);
    try {
      // `delay(1)` in auto mode keeps the job genuinely asynchronous, so it still occupies a slot
      // for at least one turn of the loop and the concurrency accounting stays meaningful.
      const result = autoResult ? await delay(1, autoResult) : await block(job.handle, ctx.signal);
      finished.push(job.handle);
      return result;
    } finally {
      active -= 1;
    }
  };

  const releaseAll = (result: WorkerResult = READY): void => {
    for (const [handle, resolve] of [...pending]) {
      pending.delete(handle);
      resolve(result);
    }
  };

  return {
    started,
    finished,
    aborted,
    releaseAll,
    active: () => active,
    peak: () => peak,
    descriptors: (...lanes) =>
      lanes.map((lane) => ({
        lane,
        kind: 'inline' as const,
        handler,
        // No declared params: the gate is a test double, and undeclared params pass through
        // untouched, which is what the jsonb round-trip test needs.
        params: [],
        description: `Test gate for lane ${lane}`,
      })),
    /**
     * Releases a blocked job, waiting for it to arrive first.
     *
     * The wait is not optional. `claim` writes `status = 'running'` before the worker function is
     * ever entered, so a test that polls the database until it sees `running` can reach this call
     * a tick before the handler has blocked. Waiting here removes that race for every caller
     * rather than making each test remember to wait on `gate.started` as well.
     */
    async release(handle, result = READY) {
      await waitFor(
        () => pending.has(handle),
        `the worker for "${handle}" to block (started: ${started.join(', ') || 'nothing'})`,
      );
      const resolve = pending.get(handle);
      pending.delete(handle);
      resolve?.(result);
    },
    auto(result = READY) {
      autoResult = result;
      releaseAll(result);
    },
  };
}

/**
 * Tracks every engine a test creates so `afterEach` can shut them all down.
 *
 * This matters more than it looks: an engine left running would keep claiming rows the next test
 * inserts, and its in-flight workers would try to write to a table that has since been truncated.
 * Draining aborts them, and an aborted worker never transitions, so nothing leaks across tests.
 *
 * `workers` is required by `EngineOptions`, so every test below has to say out loud which lanes it
 * is registering. That is the point: it is also the worked example of how a consumer wires one up.
 */
export function engineHarness() {
  const engines: Engine[] = [];

  const create = (options: EngineOptions): Engine => {
    const engine = createEngine(options);
    engines.push(engine);
    return engine;
  };

  return {
    create,
    async start(options: EngineOptions): Promise<Engine> {
      const engine = create(options);
      await engine.start();
      return engine;
    },
    async stopAll(): Promise<void> {
      for (const engine of engines.splice(0)) {
        await engine.stop({ drain: true });
      }
    },
  };
}
