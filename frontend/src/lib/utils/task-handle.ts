import type { TaskResponse, TaskStatus } from '@/lib/api/model';

/** The predicate of the `tasks_active_handle_uniq` partial index. */
const HANDLE_HOLDING_STATUSES: readonly TaskStatus[] = ['queued', 'running', 'failed'];

export function holdsHandle(task: Pick<TaskResponse, 'status' | 'collected'>): boolean {
  if (HANDLE_HOLDING_STATUSES.includes(task.status)) return true;
  return task.status === 'ready' && !task.collected;
}

export type HandleOwnership = 'owned' | 'reclaimed' | 'unverified';

export interface HandleHolderProbe {
  /** UUID of the task */
  holderId?: string;
  /** HTTP status when that probe failed. */
  errorStatus?: number;
}

/**
 * Whether `task` is still the task its own handle addresses.
 */
export function handleOwnership(task: TaskResponse, probe: HandleHolderProbe): HandleOwnership {
  if (holdsHandle(task)) return 'owned';
  if (probe.holderId !== undefined) return probe.holderId === task.id ? 'owned' : 'reclaimed';
  if (probe.errorStatus === 404) return 'reclaimed';
  return 'unverified';
}
