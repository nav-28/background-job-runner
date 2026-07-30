import type { ListTasksParams, TaskStatus } from '@/lib/api/model';

export interface TaskFilterState {
  status?: TaskStatus;
  lane?: string;
  /** `YYYY-MM-DD`, straight off a native date input. */
  from?: string;
  to?: string;
  sort: 'asc' | 'desc';
}

export const DEFAULT_FILTERS: TaskFilterState = { sort: 'desc' };

export const INITIAL_LIMIT = 20;
export const LIMIT_STEP = 20;
/** `GET /tasks` rejects a larger `limit` outright. */
export const MAX_LIMIT = 100;

export function isFiltered(filters: TaskFilterState): boolean {
  return (
    filters.status !== undefined ||
    filters.lane !== undefined ||
    filters.from !== undefined ||
    filters.to !== undefined ||
    filters.sort !== DEFAULT_FILTERS.sort
  );
}

/** No timezone suffix, so this resolves in the zone the date input picked the day in. */
function dayBoundary(day: string, time: string): string | undefined {
  const at = new Date(`${day}T${time}`);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

export function toListTasksParams(filters: TaskFilterState, limit: number): ListTasksParams {
  return {
    status: filters.status,
    lane: filters.lane,
    from: filters.from ? dayBoundary(filters.from, '00:00:00.000') : undefined,
    // `to` matches `createdAt <=`, so a bare date would end the range at midnight
    // and hide everything submitted during the day the user picked.
    to: filters.to ? dayBoundary(filters.to, '23:59:59.999') : undefined,
    sort: filters.sort,
    limit,
  };
}
