import { setTimeout as delay } from 'node:timers/promises';
import { withTransaction } from '#src/db.ts';
import { handleOf, toEngineEvent } from '#src/engine/events.ts';
import * as repo from '#src/engine/repository.ts';
import {
  type EngineConfig,
  type Job,
  type StopOptions,
  type TaskError,
  type TaskEventRow,
  TaskEventType,
  type TaskRow,
  TaskStatus,
  type WorkerResult,
} from '#src/engine/types.ts';
import type { WorkerRegistry } from '#src/engine/workers/registry.ts';

export type { StopOptions } from '#src/engine/types.ts';

/** How long `stop({ drain: true })` waits for in-flight work to settle before giving up. */
const DRAIN_TIMEOUT_MS = 5000; // 5 sec
const IDLE_POLL_MS = 5;
/** Up to 20% added on top of the computed backoff, so retries of a burst do not re-synchronise. */
const JITTER = 0.2;

export interface TransitionInput {
  taskId: string;
  patch: repo.TaskPatch;
  guard?: repo.TaskGuard;
  type: TaskEventType;
  detail?: Record<string, unknown>;
}

/**
 * The executor loop.
 *
 * The governing idea: **Postgres is the state machine, this process is a stateless executor.**
 * The only thing the runner keeps in memory is `#inFlight` — a map of task id to the
 * AbortController cancelling it — and that map is safely discardable. Kill the process and every
 * fact about what was happening is still in the `tasks` table; a fresh process rebuilds its world
 * from the boot sweep and carries on.
 *
 * This is a class because it owns exactly the kind of thing a class is for here: mutable state
 * (`#inFlight`, the non-reentrant tick guard) and a lifecycle (`start`/`stop`, timers).
 *
 * `start`, `stop`, `tick`, `transition` and `abort` are arrow-function properties: `tick` and its
 * siblings are handed to `setInterval`, and `transition` is reached through the engine. An
 * ordinary method would lose `this` at every one of those hand-offs. Everything else is a private
 * method, only ever called through `this.`
 */
export class TaskRunner {
  readonly #config: EngineConfig;
  readonly #registry: WorkerRegistry;
  readonly #inFlight = new Map<string, AbortController>();
  readonly #timers: NodeJS.Timeout[] = [];
  #ticking = false;
  #stopped = true;

  constructor(config: EngineConfig, registry: WorkerRegistry) {
    this.#config = config;
    this.#registry = registry;
  }

  start = async (): Promise<void> => {
    if (!this.#stopped) {
      return;
    }
    this.#stopped = false;

    // Boot sweep FIRST, before a single timer starts. Anything still marked `running` belongs to
    // a process that is gone; if the claim loop were already turning we would be handing out new
    // work while yesterday's crash was still stranded.
    //
    // Gated because it is only sound for a single-runner deployment: see `bootSweep` in
    // `EngineConfig` for what a multi-runner deployment does instead.
    if (this.#config.bootSweep) {
      const requeued = await this.#requeue(
        (tx) => repo.reclaimOrphans(this.#config.runnerId, tx),
        TaskEventType.requeued_on_restart,
      );
      // Only when it actually found something. A clean boot is the common case and must be silent;
      // a boot that inherits work is the evidence that the last process died mid-flight, and an
      // operator should be able to see that in the log without querying the database.
      if (requeued.length > 0) {
        this.#config.logger.info(
          { count: requeued.length, runnerId: this.#config.runnerId },
          'engine: boot sweep requeued tasks abandoned by a previous runner',
        );
      }
    }

    // `this.tick` is handed over unbound on purpose — it is an arrow property, so it survives.
    // `#beat`/`#reap` are ordinary private methods and are called through `this.`
    this.#every(this.#config.pollIntervalMs, this.tick, 'claim loop');
    this.#every(this.#config.heartbeatMs, () => this.#beat(), 'heartbeat');
    // The reaper shares the heartbeat cadence: a lease cannot then lapse unnoticed for longer
    // than the interval that was supposed to be renewing it.
    this.#every(this.#config.heartbeatMs, () => this.#reap(), 'lease reaper');
    this.#scheduleTick();
  };

  /**
   * `drain: true` (the default) is a graceful shutdown: stop claiming, abort what is running, wait
   * for it to settle. Aborted work is left `running` in the database on purpose — it is genuinely
   * unfinished, and requeueing it is recovery's job rather than this process guessing an outcome.
   *
   * Which recovery path picks it up depends on who restarts. Those rows still carry *this*
   * runner's id, and `reclaimOrphans` skips rows it owns (`runnerId IS DISTINCT FROM`), so a real
   * process restart sweeps them — `createEngine` mints a fresh `runnerId` every time — but calling
   * `start()` again on this same instance will not. In that case they wait out `leaseMs` and the
   * reaper collects them. Nothing is lost either way; only the delay differs.
   *
   * `drain: false` simulates a hard kill: clear the timers, abandon everything in flight, write
   * nothing. Note that it also aborts the controllers, which the brief does not ask for — that is
   * a test-hygiene concession, because an abandoned worker's `setTimeout` would otherwise fire
   * minutes later and try to write to a table the test has since truncated. Since `#runOne` returns
   * without transitioning whenever the signal is aborted, the database sees exactly what a
   * `SIGKILL` produces: rows frozen in `running` with a stale lease.
   */
  stop = async (opts: StopOptions = {}): Promise<void> => {
    this.#stopped = true;
    for (const timer of this.#timers.splice(0)) {
      clearInterval(timer);
    }
    for (const ac of this.#inFlight.values()) {
      ac.abort();
    }

    if (opts.drain === false) {
      this.#inFlight.clear();
      return;
    }

    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (this.#inFlight.size > 0 && Date.now() < deadline) {
      await delay(IDLE_POLL_MS);
    }
    this.#inFlight.clear();
  };

  /**
   * One pass of the claim loop. Exposed so tests can drive the engine without waiting on timers.
   *
   * Non-reentrant by design. Two overlapping ticks would each compute slots from the same
   * `#inFlight.size` and claim that many rows, so the pool would run at up to twice its
   * concurrency — and every subsequent tick would compound it.
   */
  tick = async (): Promise<void> => {
    if (this.#ticking || this.#stopped) {
      return;
    }
    this.#ticking = true;
    try {
      const slots = this.#config.concurrency - this.#inFlight.size;
      if (slots <= 0) {
        return;
      }
      const claimed = await repo.claim(this.#config.runnerId, this.#config.leaseMs, slots);
      for (const task of claimed) {
        const ac = new AbortController();
        this.#inFlight.set(task.id, ac);
        // Deliberately not awaited: awaiting here would serialise the pool down to one job. The
        // catch is what stops a rejection here from killing the process — `#runOne` handles a
        // worker's own failure, so reaching this handler means the bookkeeping itself failed
        // (a transition could not commit), and the task is left for the reaper.
        void this.#runOne(task, ac).catch((error: unknown) => {
          this.#config.logger.error(
            { err: error, taskId: task.id, handle: handleOf(task.lane, task.handleNum) },
            'engine: failed to record the outcome of a task; leaving it for the lease reaper',
          );
        });
      }
    } finally {
      this.#ticking = false;
    }
  };

  /**
   * The only writer of `tasks.status` outside `claim`.
   *
   * Writes a task's new state and the event recording it in one transaction, commits, and only
   * then publishes.
   *
   * The ordering is not cosmetic. Publishing before the commit lets a subscriber receive `ready`,
   * immediately `GET` the task, and be told it is still `running` — the event would be a promise
   * the database has not made yet. Worse, if the transaction then rolls back the client has been
   * told about a state that never existed. Commit first, always.
   *
   * Returning `null` when the guard does not match is the whole concurrency story: "mark it ready
   * only if it is still running and still mine" is one statement, and losing that race is a
   * no-op rather than a corruption.
   */
  transition = async (input: TransitionInput): Promise<TaskRow | null> => {
    const outcome = await withTransaction(async (tx) => {
      const task = await repo.updateTask(input.taskId, input.patch, input.guard, tx);
      if (!task) {
        return null;
      }
      const event = await repo.insertEvent(
        {
          taskId: task.id,
          userId: task.userId,
          type: input.type,
          detail: input.detail ?? {},
        },
        tx,
      );
      return { task, event };
    });

    if (!outcome) {
      return null;
    }
    this.#publish(outcome.task, outcome.event);
    return outcome.task;
  };

  /** Cancels a task this process is currently executing. Returns false if it is not ours. */
  abort = (taskId: string): boolean => {
    const ac = this.#inFlight.get(taskId);
    ac?.abort();
    return ac !== undefined;
  };

  /** How many jobs this process is executing right now. Introspection only. */
  inFlightCount = (): number => this.#inFlight.size;

  #publish(task: TaskRow, event: TaskEventRow): void {
    this.#config.bus.publish(
      toEngineEvent({ ...event, lane: task.lane, handleNum: task.handleNum }),
    );
  }

  /**
   * Requeues a set of rows and announces each one, in a single transaction so a crash mid-sweep
   * cannot leave a requeued row without its event.
   */
  async #requeue(
    reclaim: (tx: repo.Executor) => Promise<TaskRow[]>,
    type: TaskEventType,
  ): Promise<TaskRow[]> {
    const announced = await withTransaction(async (tx) => {
      const rows = await reclaim(tx);
      const out: { task: TaskRow; event: TaskEventRow }[] = [];
      for (const task of rows) {
        const event = await repo.insertEvent(
          {
            taskId: task.id,
            userId: task.userId,
            type,
            detail: { attempts: task.attempts, reclaimedBy: this.#config.runnerId },
          },
          tx,
        );
        out.push({ task, event });
      }
      return out;
    });

    for (const { task, event } of announced) {
      this.#publish(task, event);
    }
    return announced.map(({ task }) => task);
  }

  #backoffFor(attempts: number): number {
    const exponential = this.#config.backoffBaseMs * 2 ** Math.max(0, attempts - 1);
    const capped = Math.min(this.#config.backoffMaxMs, exponential);
    return Math.round(capped * (1 + Math.random() * JITTER));
  }

  /**
   * Terminal-or-retry decision for a failed attempt.
   *
   * Note what is stored on a retryable error that ran out of attempts: `retryable` stays `true`
   * and the reason names the exhaustion. `retryable` describes the nature of the error, not
   * whether we will auto-retry — flipping it to `false` here would tell an operator "this can
   * never work" when the truth is "this kept timing out and we stopped trying", which is exactly
   * the case where a manual `retry()` is worth a shot.
   */
  async #fail(
    task: TaskRow,
    error: TaskError,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    const guard: repo.TaskGuard = {
      status: TaskStatus.running,
      runnerId: this.#config.runnerId,
    };

    if (error.retryable && task.attempts < task.maxAttempts) {
      const backoffMs = this.#backoffFor(task.attempts);
      const runAfter = new Date(Date.now() + backoffMs);
      await this.transition({
        taskId: task.id,
        patch: {
          status: TaskStatus.queued,
          error,
          runnerId: null,
          leaseUntil: null,
          runAfter,
        },
        guard,
        type: TaskEventType.retry_scheduled,
        detail: {
          ...detail,
          attempt: task.attempts,
          maxAttempts: task.maxAttempts,
          reason: error.reason,
          retryable: error.retryable,
          backoffMs,
          runAfter: runAfter.toISOString(),
        },
      });
      return;
    }

    const exhausted = error.retryable && task.attempts >= task.maxAttempts;
    const stored: TaskError = {
      reason: exhausted
        ? `worker failed after ${task.attempts} attempts: ${error.reason}`
        : error.reason,
      retryable: error.retryable,
    };
    await this.transition({
      taskId: task.id,
      patch: {
        status: TaskStatus.failed,
        error: stored,
        runnerId: null,
        leaseUntil: null,
      },
      guard,
      type: TaskEventType.failed,
      detail: { ...detail, ...stored, attempts: task.attempts },
    });
  }

  /**
   * The timeout's terminal path.
   *
   * `retryable: true` is the honest answer: a job that ran out of time usually did so because
   * something downstream was slow, which is transient. The attempt budget — not this decision —
   * is what stops a job that always times out from retrying forever.
   *
   * `timedOut` rides along on the event `detail` rather than becoming a new `TaskEventType`. The
   * four contract event shapes are fixed, and history should still say "this failed"; *why* it
   * failed is exactly what `detail` is for.
   */
  async #failTimeout(task: TaskRow): Promise<void> {
    const timeoutMs = this.#config.jobTimeoutMs;
    this.#config.logger.warn(
      {
        taskId: task.id,
        handle: handleOf(task.lane, task.handleNum),
        lane: task.lane,
        attempt: task.attempts,
        timeoutMs,
      },
      'engine: job exceeded jobTimeoutMs; aborted and failed the attempt',
    );
    await this.#fail(
      task,
      { reason: `timed out after ${timeoutMs}ms`, retryable: true },
      { timedOut: true, timeoutMs },
    );
  }

  async #succeed(task: TaskRow, result: unknown): Promise<void> {
    await this.transition({
      taskId: task.id,
      // `?? null` matters: `undefined` in a patch means "leave the column alone".
      patch: {
        status: TaskStatus.ready,
        result: result ?? null,
        error: null,
        runnerId: null,
        leaseUntil: null,
      },
      guard: { status: TaskStatus.running, runnerId: this.#config.runnerId },
      type: TaskEventType.ready,
      detail: { summary: `${handleOf(task.lane, task.handleNum)} ready` },
    });
  }

  async #settle(task: TaskRow, result: WorkerResult): Promise<void> {
    if (result.status === 'ready') {
      await this.#succeed(task, result.result);
      return;
    }
    await this.#fail(
      task,
      result.error ?? {
        reason: 'worker reported a failure with no reason',
        retryable: false,
      },
    );
  }

  /**
   * Executes one claimed task, under a time bound.
   *
   * Both exits check `ac.signal.aborted`. That check is what makes cancellation safe: `cancel()`
   * writes the terminal `cancelled` row *and then* aborts, so by the time the worker's promise
   * rejects the task already has its final state and anything we wrote here would be overwriting
   * it with a lie. (The `guard` on every transition would catch it anyway; this makes the intent
   * explicit rather than relying on a WHERE clause.)
   *
   * A TIMEOUT ALSO ABORTS, and that is the trap. Unlike a cancellation it has written no terminal
   * state — this frame still owes the task one — so `timedOut` is tracked separately and checked
   * *before* every `aborted` early-return. Get that wrong and a timed-out task silently disappears
   * from `#inFlight` while staying `running` in the database until the reaper stumbles on it.
   */
  async #runOne(task: TaskRow, ac: AbortController): Promise<void> {
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    try {
      await this.#recordStarted(task);

      if (!this.#registry.has(task.lane)) {
        // Not retryable: no amount of waiting registers a worker for a lane that has none.
        await this.#fail(task, {
          reason: `No worker registered for lane "${task.lane}"`,
          retryable: false,
        });
        return;
      }

      // Racing, rather than only aborting, is the point. `abort()` is a request the worker is free
      // to ignore — and a worker that ignores it (or that is blocked somewhere it cannot observe a
      // signal, which is every `fetch` without one wired through) would hold its slot forever.
      // Losing the race frees the slot whether or not the worker ever unwinds.
      const expiry = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          ac.abort();
          reject(new Error(`timed out after ${this.#config.jobTimeoutMs}ms`));
        }, this.#config.jobTimeoutMs);
      });

      // Cleared the instant either side settles, not merely in the `finally`. Otherwise the timer
      // stays armed while the transitions below await Postgres, and a job that finished a
      // millisecond inside its budget could still be recorded as having timed out.
      const result = await Promise.race([
        this.#registry.get(task.lane).handler(toJob(task), { signal: ac.signal }),
        expiry,
      ]).finally(() => clearTimeout(timer));

      if (timedOut) {
        await this.#failTimeout(task);
        return;
      }
      if (ac.signal.aborted) {
        return;
      }
      await this.#settle(task, result);
    } catch (error: unknown) {
      if (timedOut) {
        // Reached when the worker DOES honour the abort: its own rejection wins the race ahead of
        // the expiry's. Which error arrived is irrelevant; the flag is the source of truth.
        await this.#failTimeout(task);
        return;
      }
      if (ac.signal.aborted) {
        return;
      }
      // A worker that throws told us nothing about whether the failure is permanent, so assume
      // the friendlier answer and let the attempt budget decide.
      await this.#fail(task, { reason: messageOf(error), retryable: true });
    } finally {
      // Belt and braces: `clearTimeout` is idempotent, and the early returns above (an unregistered
      // lane, a `#recordStarted` that threw) leave by paths the race never reached. A five-minute
      // timer left pending after a fifty-millisecond job would keep the event loop alive for five
      // minutes — every process embedding the engine would hang on exit.
      clearTimeout(timer);
      this.#inFlight.delete(task.id);
      // A slot just freed. Do not await — this runs inside the finally of the job that freed it.
      this.#scheduleTick();
    }
  }

  async #recordStarted(task: TaskRow): Promise<void> {
    const event = await repo.insertEvent({
      taskId: task.id,
      userId: task.userId,
      type: TaskEventType.started,
      detail: { attempt: task.attempts, runnerId: this.#config.runnerId },
    });
    this.#publish(task, event);
  }

  #scheduleTick(): void {
    if (this.#stopped) {
      return;
    }
    setImmediate(() => {
      void this.tick().catch((error: unknown) => {
        this.#config.logger.error(
          { err: error, runnerId: this.#config.runnerId },
          'engine: claim loop tick failed',
        );
      });
    });
  }

  async #beat(): Promise<void> {
    await repo.heartbeat(this.#config.runnerId, [...this.#inFlight.keys()], this.#config.leaseMs);
  }

  /** Steady-state recovery for rows whose owner stopped heartbeating. */
  async #reap(): Promise<void> {
    const reclaimed = await this.#requeue(
      (tx) => repo.reclaimExpiredLeases([...this.#inFlight.keys()], tx),
      TaskEventType.lease_expired,
    );
    // `warn`, not `info`: a lapsed lease means a runner died or stalled long enough to miss its
    // heartbeats. The work is recovered, so it is not an error — but it is never routine.
    if (reclaimed.length > 0) {
      this.#config.logger.warn(
        {
          count: reclaimed.length,
          runnerId: this.#config.runnerId,
          handles: reclaimed.map((task) => handleOf(task.lane, task.handleNum)),
        },
        'engine: reclaimed tasks whose lease had expired',
      );
    }
  }

  /**
   * A periodic background loop.
   *
   * `what` exists only so the failure below can name which loop stopped. A rejection here is the
   * quiet killer this logging is for: the claim loop silently stops making progress, the queue
   * stops draining, and without a line in the log there is nothing anywhere to explain it.
   */
  #every(ms: number, fn: () => Promise<void>, what: string): void {
    const timer = setInterval(() => {
      void fn().catch((error: unknown) => {
        this.#config.logger.error(
          { err: error, loop: what, runnerId: this.#config.runnerId },
          'engine: background loop failed; it will run again on the next interval',
        );
      });
    }, ms);
    // The engine must never be the reason a process refuses to exit.
    timer.unref();
    this.#timers.push(timer);
  }
}

/** Pure projections, so they stay outside the class — it owns state, not namespacing. */
const toJob = (task: TaskRow): Job => ({
  handle: handleOf(task.lane, task.handleNum),
  lane: task.lane,
  params: task.params,
});

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
