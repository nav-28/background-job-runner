import type { TaskStatus } from '@/lib/api/model';

export const TASK_STATUSES: TaskStatus[] = ['queued', 'running', 'ready', 'failed', 'cancelled'];

export const STATUS_COLOR: Record<
  TaskStatus,
  'default' | 'info' | 'success' | 'error' | 'warning'
> = {
  queued: 'default',
  running: 'info',
  ready: 'success',
  failed: 'error',
  cancelled: 'warning',
};

/** `STATUS_COLOR` speaks Chip palette names, and `default.main` is not a theme path. */
export function statusDotColor(status: TaskStatus): string {
  const color = STATUS_COLOR[status];
  return color === 'default' ? 'text.disabled' : `${color}.main`;
}
