import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { getDb, joinConditions, withTransaction } from '#src/db.ts';
import type {
  AllocateHandleInput,
  NewEvent,
  TaskGuard,
  TaskPatch,
  TaskRepository,
  TaskWithEvent,
  TransitionInput,
} from '#src/engine/repository.types.ts';
import {
  type TaskEventRow,
  TaskEventType,
  type TaskEventWithTask,
  type TaskFilters,
  type TaskRow,
  type TaskStatus,
} from '#src/engine/types.ts';
import { ConflictError, DatabaseError } from '#src/lib/errors.ts';

export type { NewEvent, TaskGuard, TaskPatch } from '#src/engine/repository.types.ts';

export type Executor = postgres.Sql | postgres.TransactionSql;

/** postgres.js types its `json()` helper against `JSONValue`; our payloads are `unknown`. */
function asJson(value: unknown): postgres.JSONValue {
  return value as postgres.JSONValue;
}

const UNIQUE_VIOLATION = '23505'; // https://www.postgresql.org/docs/current/errcodes-appendix.html
const CAUSE_CHAIN_LIMIT = 5;

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

function mapEvents(rows: readonly TaskEventWithTask[]): TaskEventWithTask[] {
  return rows.map((row) => ({ ...row, id: Number(row.id) }));
}

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

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------
//
// The functions above are statements; the ones below are the units of work `TaskRepository`
// promises. Each owns its transaction, so `withTransaction` and every `Executor` stay in this file.

/** One attempt at the allocation. The retry loop that recovers a lost race lives in `handles.ts`. */
async function allocateHandle(input: AllocateHandleInput): Promise<TaskWithEvent> {
  return withTransaction(async (tx) => {
    if (input.useLaneLock !== false) {
      await lockLane(input.userId, input.lane, tx);
    }
    const handleNum = await nextHandleNum(input.userId, input.lane, tx);
    const task = await insertTask(
      {
        id: randomUUID(),
        userId: input.userId,
        lane: input.lane,
        handleNum,
        params: input.params,
        maxAttempts: input.maxAttempts,
      },
      tx,
    );
    const event = await insertEvent(
      {
        taskId: task.id,
        userId: input.userId,
        type: TaskEventType.accepted,
        detail: { summary: `${input.lane}-${handleNum} accepted` },
      },
      tx,
    );
    return { task, event };
  });
}

async function transition(input: TransitionInput): Promise<TaskWithEvent | null> {
  return withTransaction(async (tx) => {
    const task = await updateTask(input.taskId, input.patch, input.guard, tx);
    if (!task) {
      return null;
    }
    const event = await insertEvent(
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
}

/**
 * Requeues a set of rows and records each one, in a single transaction so a crash mid-sweep cannot
 * leave a requeued row without its event.
 */
async function sweep(
  reclaim: (tx: Executor) => Promise<TaskRow[]>,
  runnerId: string,
  type: TaskEventType,
): Promise<TaskWithEvent[]> {
  return withTransaction(async (tx) => {
    const rows = await reclaim(tx);
    const out: TaskWithEvent[] = [];
    for (const task of rows) {
      const event = await insertEvent(
        {
          taskId: task.id,
          userId: task.userId,
          type,
          detail: { attempts: task.attempts, reclaimedBy: runnerId },
        },
        tx,
      );
      out.push({ task, event });
    }
    return out;
  });
}

/**
 * The Postgres store. `createEngine()` defaults `EngineConfig.repository` to this; nothing else
 * needs to name it.
 */
export const postgresTaskRepository: TaskRepository = {
  allocateHandle,
  isHandleConflict: isUniqueViolation,
  transition,
  claim: (runnerId, leaseMs, limit) => claim(runnerId, leaseMs, limit),
  heartbeat: (runnerId, taskIds, leaseMs) => heartbeat(runnerId, taskIds, leaseMs),
  recordEvent: (event) => insertEvent(event),
  requeueOrphans: (runnerId) =>
    sweep((tx) => reclaimOrphans(runnerId, tx), runnerId, TaskEventType.requeued_on_restart),
  requeueExpiredLeases: (runnerId, excludeIds) =>
    sweep((tx) => reclaimExpiredLeases(excludeIds, tx), runnerId, TaskEventType.lease_expired),
  findByHandle: (userId, lane, handleNum) => findByHandle(userId, lane, handleNum),
  findById: (userId, id) => findById(userId, id),
  list,
  history: (userId, taskId) => history(userId, taskId),
  eventsSince: (userId, sinceId, limit) => eventsSince(userId, sinceId, limit),
  statsByStatus: (userId) => statsByStatus(userId),
};
