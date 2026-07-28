import { handleOf, toEngineEvent } from '#src/engine/events.ts';
import { allocateAndInsert } from '#src/engine/handles.ts';
import * as repo from '#src/engine/repository.ts';
import type { TaskRunner } from '#src/engine/runner.ts';
import {
  type Engine,
  type EngineConfig,
  type EngineEvent,
  type EventBus,
  type LaneInfo,
  type StopOptions,
  type Task,
  TaskEventType,
  type TaskEventWithTask,
  type TaskFilters,
  type TaskRow,
  TaskStatus,
} from '#src/engine/types.ts';
import type { WorkerRegistry } from '#src/engine/workers/registry.ts';
import { BadRequestError, ConflictError, NotFoundError } from '#src/lib/errors.ts';

/**
 * The `Engine` implementation. `src/engine/types.ts`
 *
 */
export class OrchestrationEngine implements Engine {
  readonly config: EngineConfig;
  readonly #registry: WorkerRegistry;
  readonly #runner: TaskRunner;
  readonly #bus: EventBus;

  constructor(config: EngineConfig, registry: WorkerRegistry, runner: TaskRunner, bus: EventBus) {
    this.config = config;
    this.#registry = registry;
    this.#runner = runner;
    this.#bus = bus;
  }

  submit = async (
    userId: string,
    lane: string,
    params: Record<string, unknown> = {},
  ): Promise<Task> => {
    const normalised = this.#registry.validateParams(lane, params);
    const { task, event } = await allocateAndInsert(userId, lane, normalised, {
      maxAttempts: this.config.maxAttempts,
    });
    // After the allocation transaction has committed, never before.
    this.#bus.publish(toEngineEvent({ ...event, lane: task.lane, handleNum: task.handleNum }));
    return toTask(task);
  };

  get = async (userId: string, handle: string): Promise<Task> => {
    return toTask(await this.#find(userId, handle));
  };

  getById = async (userId: string, id: string): Promise<Task> => {
    const row = await repo.findById(userId, id);
    if (!row) {
      throw new NotFoundError(`No task with id "${id}"`);
    }
    return toTask(row);
  };

  list = async (userId: string, filters: TaskFilters = {}): Promise<Task[]> => {
    return (await repo.list(userId, filters)).map(toTask);
  };

  history = async (userId: string, handle: string): Promise<TaskEventWithTask[]> => {
    const task = await this.#find(userId, handle);
    return repo.history(userId, task.id);
  };

  /**
   * Only a `ready` task can be collected; collecting frees the handle number for reuse, which is
   * why it is an explicit step and not implied by `ready`.
   */
  collect = async (userId: string, handle: string): Promise<Task> => {
    const task = await this.#find(userId, handle);
    const updated = await this.#runner.transition({
      taskId: task.id,
      patch: { collected: true, collectedAt: new Date() },
      guard: { userId, status: TaskStatus.ready, collected: false },
      type: TaskEventType.collected,
    });
    if (!updated) {
      throw new ConflictError(
        task.collected
          ? `Task "${handle}" has already been collected`
          : `Task "${handle}" is ${task.status}; only a ready task can be collected`,
      );
    }
    return toTask(updated);
  };

  /**
   * Cancels a task.
   *
   * Three conditional updates rather than one, because the correct follow-up differs per state
   * and we must know which one actually matched:
   *
   *  1. `queued` — we beat the claim loop to it; nothing is running, nothing to abort.
   *  2. `running` — write the terminal state FIRST, then abort. The other order lets the worker
   *     reject, reach `#runOne`'s error path before the update lands, and overwrite `cancelled`
   *     with `failed`.
   *  3. `failed` — The spec recycles a handle number on collect or cancel only, so without this a failed
   *     task holds `scrape-3` forever and there is no way to ever get that number back. Cancel
   *     doubles as "dismiss".
   *
   * If none matched, the task finished in the gap between the read and the write.
   */
  cancel = async (userId: string, handle: string): Promise<Task> => {
    const task = await this.#find(userId, handle);
    const cancellable = [TaskStatus.queued, TaskStatus.running, TaskStatus.failed] as const;

    for (const from of cancellable) {
      const updated = await this.#runner.transition({
        taskId: task.id,
        patch: {
          status: TaskStatus.cancelled,
          runnerId: null,
          leaseUntil: null,
        },
        guard: { userId, status: from },
        type: TaskEventType.cancelled,
        detail: { from },
      });
      if (updated) {
        if (from === TaskStatus.running) {
          this.#runner.abort(task.id);
        }
        return toTask(updated);
      }
    }

    const current = await repo.findById(userId, task.id);
    throw new ConflictError(
      `Task "${handle}" is ${current?.status ?? 'gone'} and can no longer be cancelled`,
    );
  };

  /**
   * Requeues a failed task by hand.
   *
   * `attempts` is a lifetime counter and stays where it is — resetting it would make a task that
   * has burned nine attempts report one, which is the number an operator most needs to trust.
   * The budget is extended instead: `maxAttempts = attempts + configured maxAttempts`, so the
   * retry gets a full fresh allowance while the displayed history stays honest.
   */
  retry = async (userId: string, handle: string): Promise<Task> => {
    const task = await this.#find(userId, handle);
    const maxAttempts = task.attempts + this.config.maxAttempts;
    const updated = await this.#runner.transition({
      taskId: task.id,
      patch: {
        status: TaskStatus.queued,
        error: null,
        result: null,
        runAfter: new Date(),
        runnerId: null,
        leaseUntil: null,
        maxAttempts,
      },
      guard: { userId, status: TaskStatus.failed },
      type: TaskEventType.retry_requested,
      detail: { attempts: task.attempts, maxAttempts },
    });
    if (!updated) {
      throw new ConflictError(
        `Task "${handle}" is ${task.status}; only a failed task can be retried`,
      );
    }
    return toTask(updated);
  };

  lanes = (): LaneInfo[] => this.#registry.list();

  stats = async (userId: string): Promise<Record<TaskStatus, number>> => {
    const rows = await repo.statsByStatus(userId);
    const zeroed = Object.fromEntries(
      Object.values(TaskStatus).map((status) => [status, 0]),
    ) as Record<TaskStatus, number>;
    for (const row of rows) {
      zeroed[row.status] = row.count;
    }
    return zeroed;
  };

  subscribe = (userId: string, cb: (e: EngineEvent) => void): (() => void) =>
    this.#bus.subscribe(userId, cb);

  eventsSince = async (userId: string, sinceId: number, limit?: number): Promise<EngineEvent[]> => {
    return (await repo.eventsSince(userId, sinceId, limit)).map(toEngineEvent);
  };

  start = (): Promise<void> => this.#runner.start();

  stop = (opts?: StopOptions): Promise<void> => this.#runner.stop(opts);

  async #find(userId: string, handle: string): Promise<TaskRow> {
    const { lane, handleNum } = parseHandle(handle);
    const row = await repo.findByHandle(userId, lane, handleNum);
    if (!row) {
      throw new NotFoundError(`No task with handle "${handle}"`);
    }
    return row;
  }
}

/** Derives `handle` from the row. It is never stored — two columns cannot disagree. */
const toTask = (row: TaskRow): Task => ({
  ...row,
  handle: handleOf(row.lane, row.handleNum),
});

/**
 * Splits `lane-N`. The last hyphen wins, so a lane name may itself contain hyphens
 * (`page-scrape-4` is `page-scrape` #4).
 */
function parseHandle(handle: string): { lane: string; handleNum: number } {
  const cut = handle.lastIndexOf('-');
  const lane = cut > 0 ? handle.slice(0, cut) : '';
  const handleNum = Number(handle.slice(cut + 1));
  if (lane === '' || !Number.isInteger(handleNum) || handleNum < 1) {
    throw new BadRequestError(`Malformed handle "${handle}"; expected "<lane>-<number>"`);
  }
  return { lane, handleNum };
}
