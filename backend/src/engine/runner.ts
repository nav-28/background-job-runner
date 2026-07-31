import { setTimeout as delay } from 'node:timers/promises';
import { handleOf, toEngineEvent } from '#src/engine/events.ts';
import type {
  TaskGuard,
  TaskRepository,
  TaskWithEvent,
  TransitionInput,
} from '#src/engine/repository.types.ts';
import {
  type EngineConfig,
  type StopOptions,
  type TaskError,
  type TaskEventRow,
  TaskEventType,
  type TaskRow,
  TaskStatus,
} from '#src/engine/types.ts';
import type { WorkerRegistry } from '#src/engine/workers/registry.ts';
import type { Job, WorkerResult } from '#src/engine/workers/types.ts';

export type { TransitionInput } from '#src/engine/repository.types.ts';
export type { StopOptions } from '#src/engine/types.ts';

/** How long `stop({ drain: true })` waits for in-flight work to settle before giving up. */
const DRAIN_TIMEOUT_MS = 5000; // 5 sec
const IDLE_POLL_MS = 5;
/** Up to 20% added on top of the computed backoff, so retries of a burst do not re-synchronise. */
const JITTER = 0.2;

/**
 * The executor loop.
 *
 * The governing idea: **Repository is the state machine, this process is a stateless executor.**
 * The only thing the runner keeps in memory is `inFlight` — a map of task id to the
 * AbortController cancelling it — and that map is safely discardable. Kill the process and every
 * fact about what was happening is still in the `tasks` table; a fresh process rebuilds its world
 * from the boot sweep and carries on.
 *
 * This is a class because it owns exactly the kind of thing a class is for here: mutable state
 * (`inFlight`, the non-reentrant tick guard) and a lifecycle (`start`/`stop`, timers).
 *
 */
export class TaskRunner {
  private readonly config: EngineConfig;
  private readonly registry: WorkerRegistry;
  private readonly repository: TaskRepository;
  private readonly inFlight = new Map<string, AbortController>();
  private readonly timers: NodeJS.Timeout[] = [];
  private ticking = false;
  private stopped = true;

  constructor(config: EngineConfig, registry: WorkerRegistry, repository: TaskRepository) {
    this.config = config;
    this.registry = registry;
    this.repository = repository;
  }

  start = async (): Promise<void> => {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;

    // Boot sweep FIRST, before a single timer starts. Anything still marked `running` belongs to
    // a process that is gone; if the claim loop were already turning we would be handing out new
    // work while yesterday's crash was still stranded.
    //
    // Gated because it is only sound for a single-runner deployment: see `bootSweep` in
    // `EngineConfig` for what a multi-runner deployment does instead.
    if (this.config.bootSweep) {
      const requeued = this.announce(await this.repository.requeueOrphans(this.config.runnerId));
      // Only when it actually found something. A clean boot is the common case and must be silent;
      // a boot that inherits work is the evidence that the last process died mid-flight, and an
      // operator should be able to see that in the log without querying the database.
      if (requeued.length > 0) {
        this.config.logger.info(
          { count: requeued.length, runnerId: this.config.runnerId },
          'engine: boot sweep requeued tasks abandoned by a previous runner',
        );
      }
    }

    this.every(this.config.pollIntervalMs, this.tick, 'claim loop');
    this.every(this.config.heartbeatMs, () => this.beat(), 'heartbeat');
    // The reaper shares the heartbeat cadence: a lease cannot then lapse unnoticed for longer
    // than the interval that was supposed to be renewing it.
    this.every(this.config.heartbeatMs, () => this.reap(), 'lease reaper');
    this.scheduleTick();
  };

  /**
   * `drain: true` (the default) is a graceful shutdown: stop claiming, abort what is running, wait
   * for it to settle. Aborted work is left `running` in the database on purpose — it is genuinely
   * unfinished, and requeueing it is recovery's job rather than this process guessing an outcome.
   */
  stop = async (opts: StopOptions = {}): Promise<void> => {
    this.stopped = true;
    for (const timer of this.timers.splice(0)) {
      clearInterval(timer);
    }
    for (const ac of this.inFlight.values()) {
      ac.abort();
    }

    if (opts.drain === false) {
      this.inFlight.clear();
      return;
    }

    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await delay(IDLE_POLL_MS);
    }
    this.inFlight.clear();
  };

  /**
   * One pass of the claim loop. Exposed so tests can drive the engine without waiting on timers.
   *
   * Non-reentrant by design. Two overlapping ticks would each compute slots from the same
   * `inFlight.size` and claim that many rows, so the pool would run at up to twice its
   * concurrency — and every subsequent tick would compound it.
   */
  tick = async (): Promise<void> => {
    if (this.ticking || this.stopped) {
      return;
    }
    this.ticking = true;
    try {
      const slots = this.config.concurrency - this.inFlight.size;
      if (slots <= 0) {
        return;
      }
      const claimed = await this.repository.claim(this.config.runnerId, this.config.leaseMs, slots);
      for (const task of claimed) {
        const ac = new AbortController();
        this.inFlight.set(task.id, ac);
        // Deliberately not awaited: awaiting here would serialise the pool down to one job. The
        // catch is what stops a rejection here from killing the process — `runOne` handles a
        // worker's own failure, so reaching this handler means the bookkeeping itself failed
        // (a transition could not commit), and the task is left for the reaper.
        void this.runOne(task, ac).catch((error: unknown) => {
          this.config.logger.error(
            { err: error, taskId: task.id, handle: handleOf(task.lane, task.handleNum) },
            'engine: failed to record the outcome of a task; leaving it for the lease reaper',
          );
        });
      }
    } finally {
      this.ticking = false;
    }
  };

  /**
   * The only writer of `tasks.status` outside `claim`.
   *
   * The repository writes a task's new state and the event recording it in one transaction and
   * commits; only then does this publish.
   */
  transition = async (input: TransitionInput): Promise<TaskRow | null> => {
    const outcome = await this.repository.transition(input);
    if (!outcome) {
      return null;
    }
    this.publish(outcome.task, outcome.event);
    return outcome.task;
  };

  /** Cancels a task this process is currently executing. Returns false if it is not ours. */
  abort = (taskId: string): boolean => {
    const ac = this.inFlight.get(taskId);
    ac?.abort();
    return ac !== undefined;
  };

  /** How many jobs this process is executing right now. Introspection only. */
  inFlightCount = (): number => this.inFlight.size;

  private publish(task: TaskRow, event: TaskEventRow): void {
    this.config.bus.publish(
      toEngineEvent({ ...event, lane: task.lane, handleNum: task.handleNum }),
    );
  }

  /** Publishes everything a recovery sweep wrote, after its transaction has committed. */
  private announce(swept: TaskWithEvent[]): TaskRow[] {
    for (const { task, event } of swept) {
      this.publish(task, event);
    }
    return swept.map(({ task }) => task);
  }

  private backoffFor(attempts: number): number {
    const exponential = this.config.backoffBaseMs * 2 ** Math.max(0, attempts - 1);
    const capped = Math.min(this.config.backoffMaxMs, exponential);
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
  private async fail(
    task: TaskRow,
    error: TaskError,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    const guard: TaskGuard = {
      status: TaskStatus.running,
      runnerId: this.config.runnerId,
    };

    if (error.retryable && task.attempts < task.maxAttempts) {
      const backoffMs = this.backoffFor(task.attempts);
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
  private async failTimeout(task: TaskRow): Promise<void> {
    const timeoutMs = this.config.jobTimeoutMs;
    this.config.logger.warn(
      {
        taskId: task.id,
        handle: handleOf(task.lane, task.handleNum),
        lane: task.lane,
        attempt: task.attempts,
        timeoutMs,
      },
      'engine: job exceeded jobTimeoutMs; aborted and failed the attempt',
    );
    await this.fail(
      task,
      { reason: `timed out after ${timeoutMs}ms`, retryable: true },
      { timedOut: true, timeoutMs },
    );
  }

  private async succeed(task: TaskRow, result: unknown): Promise<void> {
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
      guard: { status: TaskStatus.running, runnerId: this.config.runnerId },
      type: TaskEventType.ready,
      detail: { summary: `${handleOf(task.lane, task.handleNum)} ready` },
    });
  }

  private async settle(task: TaskRow, result: WorkerResult): Promise<void> {
    if (result.status === 'ready') {
      await this.succeed(task, result.result);
      return;
    }
    await this.fail(
      task,
      result.error ?? {
        reason: 'worker reported a failure with no reason',
        retryable: false,
      },
    );
  }

  /**
   * Executes one claimed task, under a time bound.
   */
  private async runOne(task: TaskRow, ac: AbortController): Promise<void> {
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    try {
      await this.recordStarted(task);

      if (!this.registry.has(task.lane)) {
        // Not retryable: no amount of waiting registers a worker for a lane that has none.
        await this.fail(task, {
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
          reject(new Error(`timed out after ${this.config.jobTimeoutMs}ms`));
        }, this.config.jobTimeoutMs);
      });

      // Cleared the instant either side settles, not merely in the `finally`. Otherwise the timer
      // stays armed while the transitions below await Postgres, and a job that finished a
      // millisecond inside its budget could still be recorded as having timed out.
      const result = await Promise.race([
        this.registry.get(task.lane).handler(toJob(task), { signal: ac.signal }),
        expiry,
      ]).finally(() => clearTimeout(timer));

      if (timedOut) {
        await this.failTimeout(task);
        return;
      }
      if (ac.signal.aborted) {
        return;
      }
      await this.settle(task, result);
    } catch (error: unknown) {
      if (timedOut) {
        // Reached when the worker DOES honour the abort: its own rejection wins the race ahead of
        // the expiry's. Which error arrived is irrelevant; the flag is the source of truth.
        await this.failTimeout(task);
        return;
      }
      if (ac.signal.aborted) {
        return;
      }
      // A worker that throws told us nothing about whether the failure is permanent, so assume
      // the friendlier answer and let the attempt budget decide.
      await this.fail(task, { reason: messageOf(error), retryable: true });
    } finally {
      clearTimeout(timer);
      this.inFlight.delete(task.id);
      this.scheduleTick();
    }
  }

  private async recordStarted(task: TaskRow): Promise<void> {
    const event = await this.repository.recordEvent({
      taskId: task.id,
      userId: task.userId,
      type: TaskEventType.started,
      detail: { attempt: task.attempts, runnerId: this.config.runnerId },
    });
    this.publish(task, event);
  }

  private scheduleTick(): void {
    if (this.stopped) {
      return;
    }
    setImmediate(() => {
      void this.tick().catch((error: unknown) => {
        this.config.logger.error(
          { err: error, runnerId: this.config.runnerId },
          'engine: claim loop tick failed',
        );
      });
    });
  }

  private async beat(): Promise<void> {
    await this.repository.heartbeat(
      this.config.runnerId,
      [...this.inFlight.keys()],
      this.config.leaseMs,
    );
  }

  /** Steady-state recovery for rows whose owner stopped heartbeating. */
  private async reap(): Promise<void> {
    const reclaimed = this.announce(
      await this.repository.requeueExpiredLeases(this.config.runnerId, [...this.inFlight.keys()]),
    );
    // `warn`, not `info`: a lapsed lease means a runner died or stalled long enough to miss its
    // heartbeats. The work is recovered, so it is not an error — but it is never routine.
    if (reclaimed.length > 0) {
      this.config.logger.warn(
        {
          count: reclaimed.length,
          runnerId: this.config.runnerId,
          handles: reclaimed.map((task) => handleOf(task.lane, task.handleNum)),
        },
        'engine: reclaimed tasks whose lease had expired',
      );
    }
  }

  /**
   * A periodic background loop.
   *
   */
  private every(ms: number, fn: () => Promise<void>, what: string): void {
    const timer = setInterval(() => {
      void fn().catch((error: unknown) => {
        this.config.logger.error(
          { err: error, loop: what, runnerId: this.config.runnerId },
          'engine: background loop failed; it will run again on the next interval',
        );
      });
    }, ms);
    // The engine must never be the reason a process refuses to exit.
    timer.unref();
    this.timers.push(timer);
  }
}

function toJob(task: TaskRow): Job {
  return {
    handle: handleOf(task.lane, task.handleNum),
    lane: task.lane,
    params: task.params,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
