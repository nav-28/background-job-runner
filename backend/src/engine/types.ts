export const TaskStatus = {
  queued: 'queued',
  running: 'running',
  ready: 'ready',
  failed: 'failed',
  cancelled: 'cancelled',
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

/**
 * Every row written to `task_events`. The first four are also the public wire contract
 * (see `EngineEvent`); the rest are informational and clients may ignore them.
 */
export const TaskEventType = {
  accepted: 'accepted',
  started: 'started',
  ready: 'ready',
  failed: 'failed',
  cancelled: 'cancelled',
  // -- informational --
  retry_scheduled: 'retry_scheduled',
  requeued_on_restart: 'requeued_on_restart',
  lease_expired: 'lease_expired',
  collected: 'collected',
  retry_requested: 'retry_requested',
} as const;
export type TaskEventType = (typeof TaskEventType)[keyof typeof TaskEventType];

/**
 * A stored failure.
 *
 * `retryable` describes **the nature of the error**, not whether the engine will auto-retry it.
 * A transient failure that exhausts its attempt budget stays `retryable: true` with a reason that
 * names the exhaustion, so an operator looking at a dead task can tell "this might work if you
 * press retry" apart from "this will never work".
 */
export interface TaskError {
  reason: string;
  retryable: boolean;
}

/** A `tasks` row, timestamps as `Date`. `handle` is derived, never stored. */
export interface TaskRow {
  id: string;
  userId: string;
  lane: string;
  handleNum: number;
  params: Record<string, unknown>;
  status: TaskStatus;
  result: unknown;
  error: TaskError | null;
  attempts: number;
  maxAttempts: number;
  runAfter: Date;
  leaseUntil: Date | null;
  runnerId: string | null;
  collected: boolean;
  collectedAt: Date | null;
  isSeed: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** A `TaskRow` with its derived handle attached. This is what the public surface returns. */
export interface Task extends TaskRow {
  handle: string;
}

/** A `task_events` row. `id` is a bigserial, narrowed to `number` (see repository). */
export interface TaskEventRow {
  id: number;
  taskId: string;
  userId: string;
  type: TaskEventType;
  detail: Record<string, unknown>;
  at: Date;
}

/**
 * An event joined to its task's lane/handleNum. Events are queried per user across many tasks,
 * so the handle has to come along for the ride — otherwise every consumer would need a second
 * round trip just to render the event.
 */
export interface TaskEventWithTask extends TaskEventRow {
  lane: string;
  handleNum: number;
}

/**
 * The filters `list()` accepts.
 *
 * Declared here rather than in the repository on purpose: `list()` is part of the public `Engine`
 * surface, and a public signature that names a repository type drags persistence into the
 * contract. The repository imports this instead.
 */
export interface TaskFilters {
  status?: TaskStatus;
  lane?: string;
  createdAfter?: Date;
  createdBefore?: Date;
  sort?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

/** What a worker is handed. */
export interface Job {
  handle: string;
  lane: string;
  params: Record<string, unknown>;
}

export interface WorkerResult {
  status: 'ready' | 'failed';
  result?: unknown;
  error?: { reason: string; retryable: boolean };
}

export interface WorkerContext {
  signal: AbortSignal;
}

/**
 *
 * This deviates from the spec as we added a ctx. This is required to
 * cancel the Job using an `AbortSignal`.
 */
export type Worker = (job: Job, ctx: WorkerContext) => Promise<WorkerResult>;

/**
 * Describes one parameter a worker understands. Used for validation and for `lanes()`, which is
 * how a UI can render a form without hard-coding anything about a lane.
 *
 * `min`/`max` are a small addition over the spec's field list: the mock worker has to cap
 * `duration_ms` at 300000, and a bound that lives in the descriptor is discoverable by `lanes()`
 * whereas one buried in the handler is not.
 */
export interface ParamDescriptor {
  name: string;
  type: 'number' | 'boolean' | 'string';
  required: boolean;
  default?: unknown;
  description?: string;
  min?: number;
  max?: number;
}

export interface WorkerDescriptor {
  lane: string;
  /**
   * A union of one member today. Everything dispatches on the event loop; 'thread' | 'external'
   * land here later, and the registry already switches on this field rather than assuming.
   */
  kind: 'inline';
  handler: Worker;
  params: ParamDescriptor[];
  description?: string;
}

/** `lanes()` output — the descriptor minus the handler, which is not serialisable. */
export type LaneInfo = Omit<WorkerDescriptor, 'handler'>;

export interface EngineEventBase {
  /** `task_events.id`. Monotonic per database, so a client can replay from a cursor. */
  id: number;
  task_id: string;
  /**
   * Routing only — the bus fans out per user and `publish()` takes no separate userId. The HTTP
   * layer strips this before it reaches a client, which already knows who it is.
   */
  user_id: string;
  handle: string;
  lane: string;
}

/** Informational event types: on the bus, but not part of the fixed four-shape contract used for the client. */
export type InformationalEventType = Exclude<
  TaskEventType,
  'accepted' | 'ready' | 'failed' | 'cancelled'
>;

/**
 * The wire event.
 * Informational events carry their raw `detail` and clients may ignore them.
 */
export type EngineEvent =
  | (EngineEventBase & { type: 'accepted'; summary: string })
  | (EngineEventBase & { type: 'ready'; summary: string })
  | (EngineEventBase & { type: 'failed'; reason: string; retryable: boolean })
  | (EngineEventBase & { type: 'cancelled' })
  | (EngineEventBase & {
      type: InformationalEventType;
      detail: Record<string, unknown>;
    });

export interface EventBus {
  publish(e: EngineEvent): void;
  subscribe(userId: string, cb: (e: EngineEvent) => void): () => void;
}

export interface StopOptions {
  /**
   * `true` (the default) drains: stop claiming, abort what is running, wait for it to settle.
   * `false` simulates a hard kill and writes nothing.
   */
  drain?: boolean;
}

/**
 * One log level's function.
 *
 * This interface is similar to pino's logger to maintain compatibility
 */
export interface EngineLogFn {
  (obj: unknown, msg?: string, ...args: unknown[]): void;
  (msg: string, ...args: unknown[]): void;
}

/**
 * Where the engine reports what it could not report to a caller.
 *
 * Four levels, no more. `fatal` and `trace` exist on pino but the engine has nothing to say at
 * either: it never decides the process should die, and anything worth tracing is worth `debug`.
 *
 * Everything logged here is a background failure — a rejected timer callback, a subscriber that
 * threw, a lease reclaimed, a job that timed out. Foreground failures reach the caller as a thrown
 * `AppError` and are the HTTP layer's business to log, not this one's.
 */
export interface EngineLogger {
  debug: EngineLogFn;
  info: EngineLogFn;
  warn: EngineLogFn;
  error: EngineLogFn;
}

export interface EngineConfig {
  /** Maximum jobs in flight in this process at once. */
  concurrency: number;
  /** How often the claim loop runs when idle. */
  pollIntervalMs: number;
  /** How long a claimed row stays owned before another runner may steal it. */
  leaseMs: number;
  /** How often in-flight leases are bumped — must be comfortably below `leaseMs`. */
  heartbeatMs: number;
  /** Attempts a freshly submitted task gets before it is declared failed. */
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /**
   * Requeue every `running` row this process does not own, once, at `start()`.
   *
   * Correct for the single-process deployment this engine targets: at boot such a row can only be
   * the residue of a runner that died. A MULTI-RUNNER DEPLOYMENT MUST SET THIS `false` — a second
   * process booting would otherwise yank the live, actively-heartbeated work of its peers straight
   * out from under them. With the sweep off, crashed work is recovered by `reclaimExpiredLeases`
   * instead, at the cost of waiting one `leaseMs` before it is picked up again.
   */
  bootSweep: boolean;
  /**
   * A LIVENESS BACKSTOP, not a per-job SLA.
   *
   * Without it a worker that hangs holds its slot forever — and because the heartbeat keeps
   * renewing the lease of anything in flight, the reaper never rescues it either. Concurrency
   * would silently drop by one, permanently, with no error and no event.
   *
   * The default (5 minutes) deliberately matches the mock worker's own `duration_ms` cap: it is
   * long enough that no legitimate job in this engine can reach it, which is the point. A number
   * tuned to what a job "should" take belongs on the lane, not here.
   */
  jobTimeoutMs: number;
  workers: WorkerDescriptor[];
  bus: EventBus;
  logger: EngineLogger;
  /** Identifies this process in `tasks.runnerId`. A restart must produce a new one. */
  runnerId: string;
}

/**
 * What `createEngine()` accepts.
 *
 * Everything is optional except `workers`. The numeric knobs and the bus have obvious defaults and
 * are implementation detail; workers are domain content. An engine that defaulted them would ship
 * knowing that a lane called `scrape` exists, which is exactly the coupling `src/engine/` is meant
 * not to have.
 */
export type EngineOptions = Partial<Omit<EngineConfig, 'workers'>> & Pick<EngineConfig, 'workers'>;

export interface Engine {
  /**
   * Accepts work. Validates the lane and its params, allocates the next free handle, and returns —
   * before any worker runs. The returned task is `queued`; the claim loop picks it up.
   *
   * Throws `BadRequestError` for an unknown lane or a parameter that fails its descriptor.
   */
  submit(userId: string, lane: string, params?: Record<string, unknown>): Promise<Task>;

  /**
   * Resolves `lane-N` for one user. Throws `BadRequestError` on a malformed handle and
   * `NotFoundError` when that user has no such task.
   */
  get(userId: string, handle: string): Promise<Task>;

  /** Same, by task id. Another user's id is a `NotFoundError`, not a window into their data. */
  getById(userId: string, id: string): Promise<Task>;

  /** One user's tasks, newest first unless `filters.sort` says otherwise. */
  list(userId: string, filters?: TaskFilters): Promise<Task[]>;

  /**
   * Every transition one task went through, oldest first. Preconditions are `get`'s: the handle
   * must parse and must belong to `userId`.
   *
   * Resolves the handle to whichever task holds it *now*, so a retired task whose number has been
   * reused answers with the new holder's history. Use `historyById` when identity matters.
   */
  history(userId: string, handle: string): Promise<TaskEventWithTask[]>;

  /** Same, by task id — the only form that keeps answering for a retired task. */
  historyById(userId: string, id: string): Promise<TaskEventWithTask[]>;

  /**
   * Takes delivery of a finished task. Only a `ready`, not-yet-collected task can be collected —
   * anything else is a `ConflictError`. Collecting frees the handle number for reuse, which is why
   * it is an explicit step and not implied by `ready`.
   */
  collect(userId: string, handle: string): Promise<Task>;

  /**
   * Cancels a task, and actually stops its worker if one is running here. Valid from `queued`,
   * `running` and `failed`; from any other state, or if the task finished in the gap between the
   * read and the write, it is a `ConflictError`.
   */
  cancel(userId: string, handle: string): Promise<Task>;

  /**
   * Requeues a `failed` task by hand with a fresh attempt budget. Any other state is a
   * `ConflictError`. `attempts` is a lifetime counter and is deliberately not reset.
   */
  retry(userId: string, handle: string): Promise<Task>;

  /** What this engine can run, and the params each lane takes. Enough to render a form. */
  lanes(): LaneInfo[];

  /** Task counts per status for one user. Every status is present, zeroed when it has no rows. */
  stats(userId: string): Promise<Record<TaskStatus, number>>;

  /**
   * Live events for one user. Returns the unsubscribe function, which is safe to call more than
   * once. A subscriber that throws is isolated — it cannot take down a transition mid-flight.
   */
  subscribe(userId: string, cb: (e: EngineEvent) => void): () => void;

  /**
   * Replay from a cursor. A client that reconnects passes the last `id` it saw and gets everything
   * it missed, in the same shape the live bus would have delivered. `sinceId` is exclusive.
   */
  eventsSince(userId: string, sinceId: number, limit?: number): Promise<EngineEvent[]>;

  /**
   * Runs the boot sweep (unless `config.bootSweep` is false) and then starts the claim loop, the
   * heartbeat and the lease reaper. Idempotent: starting a running engine does nothing.
   */
  start(): Promise<void>;

  /**
   * Stops the timers. `drain: true` (the default) aborts in-flight work and waits for it to
   * settle; `drain: false` abandons it, leaving the database exactly as a `SIGKILL` would.
   */
  stop(opts?: StopOptions): Promise<void>;

  /** The resolved configuration. Handy in tests and for a future `/debug` route. */
  readonly config: EngineConfig;
}
