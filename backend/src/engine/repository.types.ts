import type {
  TaskError,
  TaskEventRow,
  TaskEventType,
  TaskEventWithTask,
  TaskFilters,
  TaskRow,
  TaskStatus,
} from '#src/engine/types.ts';

/** Columns a patch is allowed to write. `status` transitions belong to `transition()`. */
export interface TaskPatch {
  status?: TaskStatus;
  result?: unknown;
  error?: TaskError | null;
  attempts?: number;
  maxAttempts?: number;
  runAfter?: Date;
  leaseUntil?: Date | null;
  runnerId?: string | null;
  collected?: boolean;
  collectedAt?: Date | null;
}

/**
 * Preconditions the row must still satisfy for the patch to apply. This is what makes the whole
 * engine race-free without a single application-level lock: "cancel it only if it is still
 * queued" is one statement, and losing the race simply matches zero rows.
 */
export interface TaskGuard {
  userId?: string;
  status?: TaskStatus | TaskStatus[];
  runnerId?: string;
  collected?: boolean;
}

/** A task and the event that recorded the write to it, both from the same transaction. */
export interface TaskWithEvent {
  task: TaskRow;
  event: TaskEventRow;
}

export interface AllocateHandleInput {
  userId: string;
  lane: string;
  params: Record<string, unknown>;
  maxAttempts: number;
  /** Defaults to `true`. See `AllocateOptions.useLaneLock` in `handles.ts`. */
  useLaneLock?: boolean;
}

export interface TransitionInput {
  taskId: string;
  patch: TaskPatch;
  guard?: TaskGuard;
  type: TaskEventType;
  detail?: Record<string, unknown>;
}

export interface NewEvent {
  taskId: string;
  userId: string;
  type: TaskEventType;
  detail?: Record<string, unknown>;
}

export interface TaskRepository {
  /**
   * Allocates the lowest free handle number for `(userId, lane)` and inserts the task and its
   * `accepted` event. One transaction: nothing publishes until it commits.
   *
   * Concurrent callers may legitimately pick the same number; the loser throws something
   * `isHandleConflict` recognises and `handles.ts` retries.
   */
  allocateHandle(input: AllocateHandleInput): Promise<TaskWithEvent>;

  /** True when `error` is the lost-handle-race failure `allocateHandle` throws. */
  isHandleConflict(error: unknown): boolean;

  /**
   * Applies `patch` to a task when every condition in `guard` still holds, and writes the event
   * recording it, in one transaction. Resolves `null` when the guard matched nothing — the caller
   * decides whether that is a conflict.
   */
  transition(input: TransitionInput): Promise<TaskWithEvent | null>;

  /**
   * Atomically takes up to `limit` runnable tasks for `runnerId`, flipping them to `running`,
   * bumping `attempts` and stamping a lease `leaseMs` out. Must skip rows another runner is
   * already claiming rather than wait on them.
   */
  claim(runnerId: string, leaseMs: number, limit: number): Promise<TaskRow[]>;

  /** Pushes the lease out for tasks this runner still owns. Returns how many rows moved. */
  heartbeat(runnerId: string, taskIds: string[], leaseMs: number): Promise<number>;

  /** Writes one unguarded event — the `started` record, which no state change accompanies. */
  recordEvent(event: NewEvent): Promise<TaskEventRow>;

  /**
   * Boot sweep: requeue every `running` row `runnerId` does not own, writing a
   * `requeued_on_restart` event for each, in one transaction.
   */
  requeueOrphans(runnerId: string): Promise<TaskWithEvent[]>;

  /**
   * Steady-state recovery: requeue every `running` row whose lease has lapsed, except `excludeIds`
   * (this runner's in-flight set), writing a `lease_expired` event for each, in one transaction.
   */
  requeueExpiredLeases(runnerId: string, excludeIds: string[]): Promise<TaskWithEvent[]>;

  /** Resolves `lane-N` for one user to whichever row holds it most recently. */
  findByHandle(userId: string, lane: string, handleNum: number): Promise<TaskRow | null>;

  findById(userId: string, id: string): Promise<TaskRow | null>;

  list(userId: string, filters?: TaskFilters): Promise<TaskRow[]>;

  /** Full transition log for one task, oldest first. */
  history(userId: string, taskId: string): Promise<TaskEventWithTask[]>;

  /** Replay window for a client holding a cursor. `sinceId` is exclusive. */
  eventsSince(userId: string, sinceId: number, limit?: number): Promise<TaskEventWithTask[]>;

  /** Counts per status. Statuses with no rows are absent — callers fill zeros. */
  statsByStatus(userId: string): Promise<{ status: TaskStatus; count: number }[]>;
}
