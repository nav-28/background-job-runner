import type postgres from 'postgres';
import { getDb, joinConditions } from '#src/db.ts';
import type {
  TaskError,
  TaskEventRow,
  TaskEventType,
  TaskEventWithTask,
  TaskFilters,
  TaskRow,
  TaskStatus,
} from '#src/engine/types.ts';
import { ConflictError, DatabaseError } from '#src/lib/errors.ts';

/**
 * Every statement the engine issues. No business rules live here — this file decides how to talk
 * to Postgres, never when.
 *
 * Functions that can participate in a caller's transaction take an optional `tx`. Passing it is
 * what makes "write the task row and its event atomically" possible; omitting it runs on the pool.
 */

/**
 * Accepts either the pooled handle or a transaction handle. postgres.js does not make
 * `TransactionSql` a structural subtype of `Sql` (it drops `END`, `CLOSE` and friends), so this
 * has to be a union rather than the more obvious single type.
 */
export type Executor = postgres.Sql | postgres.TransactionSql;

/** postgres.js types its `json()` helper against `JSONValue`; our payloads are `unknown`. */
const asJson = (value: unknown): postgres.JSONValue => value as postgres.JSONValue;

const UNIQUE_VIOLATION = '23505'; // https://www.postgresql.org/docs/current/errcodes-appendix.html
const CAUSE_CHAIN_LIMIT = 5;

/**
 * True when `err` — or anything it wraps — is a Postgres unique-constraint violation.
 *
 * House rules say a repository must never leak a driver error, so the functions below translate
 * `23505` into `ConflictError`. But `handles.ts` genuinely needs to tell a lost handle race apart
 * from any other conflict in order to retry, so we expose the predicate instead of swallowing the
 * distinction. It walks `cause` because the translation preserves the original error there.
 */
export function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < CAUSE_CHAIN_LIMIT && current instanceof Error; depth++) {
    if ('code' in current && current.code === UNIQUE_VIOLATION) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/** Runs a query, translating driver errors at this boundary so callers only see `AppError`s. */
async function guarded<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error: unknown) {
    const cause = error instanceof Error ? error : new Error(String(error));
    if (isUniqueViolation(error)) {
      throw new ConflictError(`${what}: unique constraint violated`, cause);
    }
    throw new DatabaseError(`${what} failed`, cause);
  }
}

// ---------------------------------------------------------------------------
// Handle allocation
// ---------------------------------------------------------------------------

/**
 * Serialises handle allocation for one `(userId, lane)` pair for the rest of the transaction.
 *
 * ADDITION over the brief. Without it the gap query below is a pure race: under READ COMMITTED
 * every concurrent submitter reads the same snapshot, every one of them picks the same number, and
 * exactly one wins the unique index — so N concurrent submits on a lane need O(N) retries and the
 * spec's bound of 5 is blown by ~10 concurrent submits (postgres.js pools 10 connections, so that
 * is not a hypothetical). The advisory lock turns that into one attempt each.
 *
 * It is an optimisation, not the invariant: `tasks_active_handle_uniq` is still the thing that
 * makes a collision impossible, and the retry loop in `handles.ts` is still the recovery path.
 * Two different `(user, lane)` pairs whose hashes collide merely queue behind each other, which
 * costs a little throughput and nothing else. The lock is released automatically on commit or
 * rollback because it is an *xact* lock — nothing to leak.
 */
export async function lockLane(userId: string, lane: string, tx: Executor): Promise<void> {
  await guarded('lock lane', async () => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${userId}), hashtext(${lane}))`;
  });
}

/**
 * Lowest free handle number for `(userId, lane)`, filling gaps left by retired tasks.
 *
 * "Active" here is exactly the predicate of `tasks_active_handle_uniq`: queued, running, failed,
 * or ready-but-uncollected. Collected and cancelled tasks release their number for reuse.
 */
export async function nextHandleNum(userId: string, lane: string, tx?: Executor): Promise<number> {
  const db = tx ?? getDb();
  return guarded('find next handle number', async () => {
    const [row] = await db<{ n: number }[]>`
      WITH used AS (
        SELECT "handleNum" AS n FROM tasks
        WHERE "userId" = ${userId} AND lane = ${lane}
          AND (status IN ('queued','running','failed') OR (status = 'ready' AND NOT collected))
      )
      SELECT COALESCE(MIN(s.n), 1) AS n
      FROM generate_series(1, (SELECT COALESCE(MAX(n), 0) + 1 FROM used)) AS s(n)
      WHERE NOT EXISTS (SELECT 1 FROM used WHERE used.n = s.n)
    `;
    return row?.n ?? 1;
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface NewTask {
  id: string;
  userId: string;
  lane: string;
  handleNum: number;
  params: Record<string, unknown>;
  maxAttempts: number;
}

export async function insertTask(task: NewTask, tx?: Executor): Promise<TaskRow> {
  const db = tx ?? getDb();
  return guarded('insert task', async () => {
    const [row] = await db<TaskRow[]>`
      INSERT INTO tasks (id, "userId", lane, "handleNum", params, status, "maxAttempts")
      VALUES (
        ${task.id}, ${task.userId}, ${task.lane}, ${task.handleNum},
        ${db.json(asJson(task.params))}, 'queued', ${task.maxAttempts}
      )
      RETURNING *
    `;
    if (!row) {
      throw new DatabaseError('insert task returned no row');
    }
    return row;
  });
}

export interface NewEvent {
  taskId: string;
  userId: string;
  type: TaskEventType;
  detail?: Record<string, unknown>;
}

export async function insertEvent(event: NewEvent, tx?: Executor): Promise<TaskEventRow> {
  const db = tx ?? getDb();
  return guarded('insert task event', async () => {
    const [row] = await db<TaskEventRow[]>`
      INSERT INTO task_events ("taskId", "userId", type, detail)
      VALUES (${event.taskId}, ${event.userId}, ${event.type}, ${db.json(asJson(event.detail ?? {}))})
      RETURNING *
    `;
    if (!row) {
      throw new DatabaseError('insert task event returned no row');
    }
    // bigserial arrives as a string from the driver; the engine treats event ids as cursors.
    return { ...row, id: Number(row.id) };
  });
}

/** Columns `updateTask` is allowed to write. `status` transitions belong to the runner. */
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

/**
 * Applies `patch` to task `id` when every condition in `guard` holds. Returns the updated row, or
 * `null` when the guard did not match — the caller decides whether that is a conflict.
 */
export async function updateTask(
  id: string,
  patch: TaskPatch,
  guard: TaskGuard = {},
  tx?: Executor,
): Promise<TaskRow | null> {
  const db = tx ?? getDb();
  const values: Record<string, unknown> = { ...patch, updatedAt: new Date() };
  // `undefined` means "leave this column alone"; `null` means "write SQL NULL", so only the
  // former is filtered out. postgres.js serialises plain objects into jsonb columns for us.
  const columns = Object.keys(values).filter((key) => values[key] !== undefined);
  const statuses = guard.status === undefined ? undefined : [guard.status].flat();

  const where = joinConditions([
    db`id = ${id}`,
    guard.userId !== undefined && db`"userId" = ${guard.userId}`,
    statuses !== undefined && db`status IN ${db(statuses)}`,
    guard.runnerId !== undefined && db`"runnerId" = ${guard.runnerId}`,
    guard.collected !== undefined && db`collected = ${guard.collected}`,
  ]);

  return guarded('update task', async () => {
    const [row] = await db<TaskRow[]>`
      UPDATE tasks SET ${db(values, ...columns)} ${where} RETURNING *
    `;
    return row ?? null;
  });
}

// ---------------------------------------------------------------------------
// The claim
// ---------------------------------------------------------------------------

/**
 * Atomically takes up to `limit` runnable tasks for this runner.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes this safe to run from many processes at once: a row
 * another runner is already claiming is skipped rather than waited on, so N runners claim N
 * disjoint sets with no coordination. `isSeed` rows are fixtures that must never execute.
 *
 * This is the one place other than `transition()` that writes `status`, because acquisition has to
 * be a single atomic statement — the runner writes the matching `started` event immediately after.
 */
export async function claim(
  runnerId: string,
  leaseMs: number,
  limit: number,
  tx?: Executor,
): Promise<TaskRow[]> {
  const db = tx ?? getDb();
  return guarded('claim tasks', async () => {
    const rows = await db<TaskRow[]>`
      UPDATE tasks t SET
        status = 'running', attempts = t.attempts + 1, "runnerId" = ${runnerId},
        "leaseUntil" = now() + ${leaseMs} * interval '1 millisecond', "updatedAt" = now()
      WHERE t.id IN (
        SELECT id FROM tasks
        WHERE status = 'queued' AND NOT "isSeed" AND "runAfter" <= now()
        ORDER BY "createdAt"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING t.*
    `;
    return [...rows];
  });
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

/**
 * Boot sweep: everything still marked `running` that this process does not own is, by definition,
 * the residue of a runner that died — nobody is heartbeating it. Put it back on the queue.
 *
 * `runnerId IS DISTINCT FROM` is what keeps this honest: at boot our own id owns nothing, so the
 * clause is a no-op then, but it means the sweep can never yank a row out from under this process.
 *
 * KNOWN LIMITATION: with several runner processes alive at once, a *new* process booting would
 * requeue the live work of its peers, which are still heartbeating it. Correct for the
 * single-process deployment this engine targets; the multi-process fix is to skip this sweep
 * entirely and rely on `reclaimExpiredLeases`, at the cost of waiting one lease after a crash.
 * That is what `EngineConfig.bootSweep: false` does — the runner then never calls this.
 */
export async function reclaimOrphans(runnerId: string, tx?: Executor): Promise<TaskRow[]> {
  const db = tx ?? getDb();
  return guarded('reclaim orphaned tasks', async () => {
    const rows = await db<TaskRow[]>`
      UPDATE tasks SET
        status = 'queued', "runnerId" = NULL, "leaseUntil" = NULL,
        "runAfter" = now(), "updatedAt" = now()
      WHERE status = 'running' AND NOT "isSeed" AND "runnerId" IS DISTINCT FROM ${runnerId}
      RETURNING *
    `;
    return [...rows];
  });
}

/**
 * Steady-state recovery: a `running` row whose lease lapsed has no live owner, so requeue it.
 *
 * `excludeIds` is the set this process currently has in flight. They are heartbeated, so their
 * lease should never lapse — but if the event loop stalls past a lease, reclaiming our own
 * in-flight row would run it twice concurrently. Cheap belt and braces.
 */
export async function reclaimExpiredLeases(
  excludeIds: string[],
  tx?: Executor,
): Promise<TaskRow[]> {
  const db = tx ?? getDb();
  return guarded('reclaim expired leases', async () => {
    const rows = await db<TaskRow[]>`
      UPDATE tasks SET
        status = 'queued', "runnerId" = NULL, "leaseUntil" = NULL,
        "runAfter" = now(), "updatedAt" = now()
      WHERE status = 'running' AND NOT "isSeed"
        AND "leaseUntil" IS NOT NULL AND "leaseUntil" < now()
        AND id <> ALL(${db.array(excludeIds)}::uuid[])
      RETURNING *
    `;
    return [...rows];
  });
}

/** Pushes the lease out for tasks this runner is still working on. */
export async function heartbeat(
  runnerId: string,
  taskIds: string[],
  leaseMs: number,
  tx?: Executor,
): Promise<number> {
  if (taskIds.length === 0) {
    return 0;
  }
  const db = tx ?? getDb();
  return guarded('heartbeat leases', async () => {
    const result = await db`
      UPDATE tasks SET
        "leaseUntil" = now() + ${leaseMs} * interval '1 millisecond', "updatedAt" = now()
      WHERE status = 'running' AND "runnerId" = ${runnerId}
        AND id = ANY(${db.array(taskIds)}::uuid[])
    `;
    return result.count;
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Resolves `lane-N` to a row.
 *
 * There can be many historical rows for one `(userId, lane, handleNum)` triple, because a number
 * is recycled once its task is collected or cancelled. Only one of them can be active at a time —
 * a new `scrape-1` cannot be allocated while another `scrape-1` is active, that is precisely what
 * the partial unique index enforces. So the newest row for the triple is the active one whenever
 * any is active, and is the most useful answer when none is. Hence `ORDER BY "createdAt" DESC`.
 */
export async function findByHandle(
  userId: string,
  lane: string,
  handleNum: number,
  tx?: Executor,
): Promise<TaskRow | null> {
  const db = tx ?? getDb();
  return guarded('find task by handle', async () => {
    const [row] = await db<TaskRow[]>`
      SELECT * FROM tasks
      WHERE "userId" = ${userId} AND lane = ${lane} AND "handleNum" = ${handleNum}
      ORDER BY "createdAt" DESC
      LIMIT 1
    `;
    return row ?? null;
  });
}

export async function findById(userId: string, id: string, tx?: Executor): Promise<TaskRow | null> {
  const db = tx ?? getDb();
  return guarded('find task by id', async () => {
    const [row] = await db<TaskRow[]>`
      SELECT * FROM tasks WHERE id = ${id} AND "userId" = ${userId}
    `;
    return row ?? null;
  });
}

const DEFAULT_LIST_LIMIT = 100;

export async function list(userId: string, filters: TaskFilters = {}): Promise<TaskRow[]> {
  const db = getDb();
  const where = joinConditions([
    db`"userId" = ${userId}`,
    filters.status !== undefined && db`status = ${filters.status}`,
    filters.lane !== undefined && db`lane = ${filters.lane}`,
    filters.createdAfter !== undefined && db`"createdAt" >= ${filters.createdAfter}`,
    filters.createdBefore !== undefined && db`"createdAt" <= ${filters.createdBefore}`,
  ]);
  // A direction cannot be a bind parameter, and pagination without ORDER BY is nondeterministic;
  // `id` breaks ties because `createdAt` is not unique under concurrent inserts.
  const order =
    filters.sort === 'asc'
      ? db`ORDER BY "createdAt" ASC, id ASC`
      : db`ORDER BY "createdAt" DESC, id DESC`;

  const limit = Math.min(filters.limit ?? DEFAULT_LIST_LIMIT, DEFAULT_LIST_LIMIT);

  return guarded('list tasks', async () => {
    const rows = await db<TaskRow[]>`
      SELECT * FROM tasks ${where} ${order}
      LIMIT ${limit} OFFSET ${filters.offset ?? 0}
    `;
    return [...rows];
  });
}

const mapEvents = (rows: readonly TaskEventWithTask[]): TaskEventWithTask[] =>
  rows.map((row) => ({ ...row, id: Number(row.id) }));

/** Full transition log for one task, oldest first. Ordering by the serial id, not `at`. */
export async function history(
  userId: string,
  taskId: string,
  tx?: Executor,
): Promise<TaskEventWithTask[]> {
  const db = tx ?? getDb();
  return guarded('read task history', async () => {
    const rows = await db<TaskEventWithTask[]>`
      SELECT e.*, t.lane, t."handleNum"
      FROM task_events e JOIN tasks t ON t.id = e."taskId"
      WHERE e."taskId" = ${taskId} AND e."userId" = ${userId}
      ORDER BY e.id ASC
    `;
    return mapEvents(rows);
  });
}

const DEFAULT_EVENT_LIMIT = 500;

/** Replay window for a client that holds a cursor. `sinceId` is exclusive. */
export async function eventsSince(
  userId: string,
  sinceId: number,
  limit = DEFAULT_EVENT_LIMIT,
  tx?: Executor,
): Promise<TaskEventWithTask[]> {
  const db = tx ?? getDb();
  return guarded('read events since cursor', async () => {
    const rows = await db<TaskEventWithTask[]>`
      SELECT e.*, t.lane, t."handleNum"
      FROM task_events e JOIN tasks t ON t.id = e."taskId"
      WHERE e."userId" = ${userId} AND e.id > ${sinceId}
      ORDER BY e.id ASC
      LIMIT ${limit}
    `;
    return mapEvents(rows);
  });
}

/** Task counts per status for one user. Statuses with no rows are absent — callers fill zeros. */
export async function statsByStatus(
  userId: string,
  tx?: Executor,
): Promise<{ status: TaskStatus; count: number }[]> {
  const db = tx ?? getDb();
  return guarded('read task stats', async () => {
    const rows = await db<{ status: TaskStatus; count: number }[]>`
      SELECT status, COUNT(*)::int AS count FROM tasks
      WHERE "userId" = ${userId}
      GROUP BY status
    `;
    return [...rows];
  });
}
