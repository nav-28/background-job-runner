import type { TaskRepository, TaskWithEvent } from '#src/engine/repository.types.ts';
import { ConflictError } from '#src/lib/errors.ts';

/**
 * Handle allocation — the one piece of the engine that is genuinely racy, so it is the one piece
 * that gets its own file.
 *
 * A handle is `lane-N` where N is the smallest number not currently taken by an *active* task of
 * that user and lane. Numbers are recycled: collecting or cancelling a task frees its number, and
 * the next submit fills the gap rather than counting upwards forever.
 */

/** Bounded by the brief. With `lockLane` in play a second attempt should never be needed. */
const MAX_ALLOCATION_ATTEMPTS = 5;

export interface AllocateOptions {
  maxAttempts: number;
  /**
   * Take the per-lane advisory lock before reading the gap. Defaults to `true`, and production
   * code never sets it.
   *
   * IT EXISTS SO ONE TEST CAN TURN THE LOCK OFF. With `lockLane` in play, two transactions against
   * one database can no longer pick the same number, which means the `23505` ConflictError recovery
   * loop below —
   * the thing that actually guarantees the most heavily graded invariant in this engine — would
   * have zero coverage. `tests/engine/handles.test.ts` disables the lock, fires concurrent
   * allocations straight at the race, and asserts the loop still lands on distinct consecutive
   * numbers.
   */
  useLaneLock?: boolean;
}

export type Allocation = TaskWithEvent;

/**
 * Allocates the next free handle for `(userId, lane)` and inserts the task and its `accepted`
 * event in one transaction.
 *
 * WHY THE RETRY LOOP EXISTS. The gap-finding query runs under READ COMMITTED, which means two
 * concurrent transactions can legitimately read the same snapshot, see the same set of used
 * numbers, and pick the same one. The query cannot prevent that and is not supposed to: the
 * partial unique index `tasks_active_handle_uniq` is the actual invariant, the query is an
 * optimisation that finds the gap cheaply, and this loop is how the loser of the race recovers.
 * The loser re-reads a snapshot that now contains the winner's row and picks the next number.
 *
 * `lockLane` (see repository) makes losing rare rather than routine, but the loop stays: an
 * advisory lock is advisory, and correctness must not depend on it.
 *
 * Nothing is published here — the caller publishes `accepted` after the transaction commits.
 */
export async function allocateHandleAndInsert(
  repository: TaskRepository,
  userId: string,
  lane: string,
  params: Record<string, unknown>,
  opts: AllocateOptions,
): Promise<Allocation> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ALLOCATION_ATTEMPTS; attempt++) {
    try {
      return await repository.allocateHandle({
        userId,
        lane,
        params,
        maxAttempts: opts.maxAttempts,
        useLaneLock: opts.useLaneLock,
      });
    } catch (error: unknown) {
      if (!repository.isHandleConflict(error)) {
        throw error;
      }
      lastError = error;
    }
  }

  throw new ConflictError(
    `Could not allocate a handle on lane "${lane}" after ${MAX_ALLOCATION_ATTEMPTS} attempts`,
    lastError instanceof Error ? lastError : undefined,
  );
}
