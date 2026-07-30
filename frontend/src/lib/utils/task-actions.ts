import type { TaskResponse } from '@/lib/api/model';

type TaskState = Pick<TaskResponse, 'status' | 'collected'>;

/** On a failed task this dismisses it, which is what releases its handle number. */
export function canCancel(task: TaskState): boolean {
  return task.status === 'queued' || task.status === 'running' || task.status === 'failed';
}

export function canRetry(task: TaskState): boolean {
  return task.status === 'failed';
}

export function canCollect(task: TaskState): boolean {
  return task.status === 'ready' && !task.collected;
}
